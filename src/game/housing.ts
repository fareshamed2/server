// Housing: buying, renting, selling and trading homes; stash storage; keys; property tax.
//
// Every property change runs in one DB transaction with the property row locked (FOR UPDATE),
// so two players can never buy the same unit and stash items can't be duplicated. The in-memory
// cache (`props`) is only updated from rows returned by committed transactions.
import type { GameWorld } from './world.ts';
import type { Player } from './types.ts';
import type { Building } from '../world/map.ts';
import { HOUSING, ITEMS, DECOR } from './content.ts';
import * as chat from './chat.ts';
import { freeSpotNear } from './economy.ts';
import { VEHICLES } from './content.ts';
import { GameError, validateAppearance, inventoryWeight, type Inventory } from './repo.ts';
import { withTx, type Tx } from '../db/pool.ts';
import { dist } from '../world/map.ts';
import { tr } from './i18n.ts';

export type Prop = {
  id: number; building_id: number; unit: number; kind: string; price: number; rent: number;
  owner_id: number | null; tenure: 'owned' | 'rented' | null; acquired_at: Date | null;
  lease_until: Date | null; tax_paid_until: Date | null; tax_debt: number; locked: boolean;
  decor: Record<string, string>; party_until: Date | null;
};
type Offer = { id: string; propertyId: number; sellerCharId: number; buyerCharId: number; price: number; expiresAt: number };

const DOOR_RANGE = 90;
const DAY_MS = 86_400_000;

export class Housing {
  readonly props = new Map<number, Prop>();
  readonly keys = new Map<number, Set<number>>();        // property id -> character ids
  readonly names = new Map<number, string>();            // character id -> name (for "Owned by …")
  readonly offers = new Map<string, Offer>();
  readonly inside = new Map<number, Set<string>>();      // property id -> player ids currently inside
  private snacked = new Map<number, Set<number>>();      // property id -> characters who used this party's snack bar
  private lastPartyCheck = 0;
  private partiesSent = '';
  private w: GameWorld;
  private lastTickAt = 0;
  private ticking = false;
  private offerSeq = 1;

  constructor(w: GameWorld) { this.w = w; }

  /** Seeds one row per unit from the world file, then loads everything into the cache. */
  async init() {
    const db = this.w.repo.db;
    const rows: (string | number)[][] = [];
    for (const b of this.w.map.data.buildings) {
      if (!b.property) continue;
      for (let u = 1; u <= b.property.units; u++) rows.push([b.id, u, b.property.kind, b.property.price, b.property.rent]);
    }
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const values = chunk.map((_, k) => `($${k * 5 + 1}, $${k * 5 + 2}, $${k * 5 + 3}, $${k * 5 + 4}, $${k * 5 + 5})`).join(',');
      await db.query(`INSERT INTO properties(building_id, unit, kind, price, rent) VALUES ${values}
        ON CONFLICT (building_id, unit) DO UPDATE SET kind = EXCLUDED.kind, price = EXCLUDED.price, rent = EXCLUDED.rent`, chunk.flat());
    }
    for (const r of (await db.query('SELECT * FROM properties')).rows) this.props.set(r.id, r);
    for (const r of (await db.query('SELECT property_id, character_id FROM property_keys')).rows) this.keySet(r.property_id).add(r.character_id);
    const owners = [...new Set([...this.props.values()].map(p => p.owner_id).filter((x): x is number => x !== null))];
    if (owners.length) for (const r of (await db.query('SELECT id, name FROM characters WHERE id = ANY($1)', [owners])).rows) this.names.set(r.id, r.name);
    const valid = new Set(rows.map(r => `${r[0]}:${r[1]}`));
    const orphans = [...this.props.values()].filter(p => !valid.has(`${p.building_id}:${p.unit}`));
    if (orphans.length) this.w.log(`housing: ${orphans.length} properties no longer exist in the world file (kept in the database)`);
  }

  private keySet(id: number) { let s = this.keys.get(id); if (!s) { s = new Set(); this.keys.set(id, s); } return s; }
  private store(row: Prop) { this.props.set(row.id, row); }
  building(prop: Prop) { return this.w.map.buildingById(prop.building_id); }

  isOwner(p: Player, prop: Prop) { return prop.owner_id === p.charId; }
  hasAccess(p: Player, prop: Prop) { return this.isOwner(p, prop) || (prop.owner_id !== null && this.keySet(prop.id).has(p.charId)); }
  taxLocked(prop: Prop) { return prop.tax_debt > prop.price * HOUSING.taxLockoutRatio; }
  mine(charId: number) { return [...this.props.values()].filter(p => p.owner_id === charId); }

  /** Private garages (houses, mansions) need access to that home; others are public. */
  canUseGarage(p: Player, b: Building) {
    if (b.type !== 'house' && b.type !== 'mansion') return true;
    return [...this.props.values()].some(pr => pr.building_id === b.id && this.hasAccess(p, pr));
  }

  /** What a player sees about one unit. */
  view(prop: Prop, p: Player) {
    const b = this.building(prop);
    const status = prop.owner_id === null ? 'available' : this.isOwner(p, prop) ? 'mine' : this.hasAccess(p, prop) ? 'key' : 'taken';
    return {
      id: prop.id, buildingId: prop.building_id, unit: prop.unit, kind: prop.kind, price: prop.price, rent: prop.rent,
      status, tenure: prop.tenure, owner: prop.owner_id !== null ? this.names.get(prop.owner_id) ?? null : null,
      leaseUntil: prop.lease_until ? new Date(prop.lease_until).getTime() : null,
      taxDebt: prop.tax_debt, taxLocked: this.taxLocked(prop), locked: prop.locked,
      storage: HOUSING.storageKg[prop.kind], garage: HOUSING.garageSlots[prop.kind],
      sellPrice: Math.max(0, Math.round(prop.price * HOUSING.sellBackRatio) - prop.tax_debt),
      name: b?.name ?? '', district: b ? this.districtOf(b) : '', door: b ? { x: b.door.x, y: b.door.y } : null,
      keyHolders: this.isOwner(p, prop) ? [...this.keySet(prop.id)].map(id => ({ id, name: this.names.get(id) ?? '?' })) : [],
      decor: prop.decor ?? {}, partyUntil: this.partyActive(prop) ? new Date(prop.party_until!).getTime() : null,
    };
  }

  private districtOf(b: Building) {
    const d = (this.w.map.data as any).districts?.find((d: any) => b.rect.x >= d.rect.x - 200 && b.rect.x <= d.rect.x + d.rect.w + 200 && b.rect.y >= d.rect.y - 200 && b.rect.y <= d.rect.y + d.rect.h + 200);
    return d?.name ?? '';
  }

  near(p: Player, prop: Prop) {
    const b = this.building(prop);
    return !!b && dist(b.door.x, b.door.y, p.x, p.y) <= DOOR_RANGE;
  }
  atRealty(p: Player) {
    return this.w.map.data.buildings.some(b => b.type === 'realestate' && dist(b.door.x, b.door.y, p.x, p.y) <= DOOR_RANGE);
  }

  // ---- messages to the client ------------------------------------------------------------
  sendPanel(p: Player, b: Building) {
    const units = [...this.props.values()].filter(pr => pr.building_id === b.id).sort((a, c) => a.unit - c.unit).map(pr => this.view(pr, p));
    p.session.send({ t: 'panel', kind: 'property', building: { id: b.id, type: b.type, name: b.name }, units, meta: b.property });
  }

  sendListings(p: Player, b: Building) {
    const byBuilding = new Map<number, { buildingId: number; name: string; kind: string; district: string; price: number; rent: number; available: number; door: { x: number; y: number } }>();
    // Identical homes (same kind, district, price and name without "#n") are grouped into one
    // listing, so 60 trailers don't bury the houses. The route points to the nearest one.
    const groups = new Map<string, { buildingId: number; name: string; kind: string; district: string; price: number; rent: number; available: number; door: { x: number; y: number } }>();
    for (const pr of this.props.values()) {
      if (pr.owner_id !== null) continue;
      const bb = this.building(pr);
      if (!bb) continue;
      const baseName = bb.name.replace(/ #\d+$/, '');
      const district = this.districtOf(bb);
      const key = `${pr.kind}|${district}|${pr.price}|${baseName}`;
      const e = groups.get(key) ?? { buildingId: bb.id, name: baseName, kind: pr.kind, district, price: pr.price, rent: pr.rent, available: 0, door: { x: bb.door.x, y: bb.door.y } };
      e.available++;
      if (dist(bb.door.x, bb.door.y, p.x, p.y) < dist(e.door.x, e.door.y, p.x, p.y)) { e.door = { x: bb.door.x, y: bb.door.y }; e.buildingId = bb.id; }
      groups.set(key, e);
    }
    for (const [k, v] of groups) byBuilding.set(byBuilding.size, v), groups.delete(k);
    const listings = [...byBuilding.values()].sort((a, c) => a.price - c.price);
    p.session.send({ t: 'panel', kind: 'realestate', building: { id: b.id, type: b.type, name: b.name }, listings, homes: this.mine(p.charId).map(pr => this.view(pr, p)) });
  }

  sendHomes(p: Player) {
    const list = [...this.props.values()].filter(pr => pr.owner_id !== null && this.hasAccess(p, pr)).map(pr => this.view(pr, p));
    p.session.send({ t: 'homes', homes: list });
  }

  private async stashOf(propId: number, tx?: Tx, container: 'safe' | 'armory' | 'all' = 'safe'): Promise<Inventory> {
    const r = container === 'all'
      ? await (tx ?? this.w.repo.db).query('SELECT item_id, sum(qty)::int AS qty FROM property_storage WHERE property_id = $1 GROUP BY item_id', [propId])
      : await (tx ?? this.w.repo.db).query('SELECT item_id, qty FROM property_storage WHERE property_id = $1 AND container = $2', [propId, container]);
    return Object.fromEntries(r.rows.map(x => [x.item_id, x.qty]));
  }

  partyActive(prop: Prop) { return !!prop.party_until && new Date(prop.party_until).getTime() > Date.now(); }
  private isArmoryItem(item: string) { const c = ITEMS[item]?.category; return c === 'weapon' || c === 'ammo'; }

  /** Gun locker usage: weapons count against slots, ammo against slots × rounds-per-slot. */
  private armoryUse(armory: Inventory) {
    let weapons = 0, ammo = 0;
    for (const [id, q] of Object.entries(armory)) { if (ITEMS[id]?.category === 'weapon') weapons += q; else ammo += q; }
    return { weapons, ammo };
  }

  private async homeGarage(prop: Prop) {
    const rows = (await this.w.repo.db.query('SELECT v.id, v.model, v.plate, v.color, v.fuel, v.engine, v.owner_id, c.name AS owner_name FROM vehicles v LEFT JOIN characters c ON c.id = v.owner_id WHERE v.garage_property_id = $1 AND v.stored ORDER BY v.id', [prop.id])).rows;
    return rows.map(r => ({ id: r.id, model: r.model, plate: r.plate, color: r.color, fuel: r.fuel, engine: r.engine, owner: r.owner_name, ownerId: r.owner_id }));
  }

  async sendHome(p: Player, prop: Prop) {
    const full = this.hasAccess(p, prop);
    const open = full && !this.taxLocked(prop);
    const stash = open ? await this.stashOf(prop.id) : null;
    const armory = open ? await this.stashOf(prop.id, undefined, 'armory') : null;
    const guests = [...(this.inside.get(prop.id) ?? [])].map(id => this.w.players.get(id)?.name).filter((n): n is string => !!n);
    p.session.send({ t: 'home', home: {
      ...this.view(prop, p), visitor: !full, stash, stashWeight: stash ? inventoryWeight(stash) : 0,
      armory, armorySlots: HOUSING.armorySlots[prop.kind], guests,
      garageVehicles: full ? await this.homeGarage(prop) : [],
      snackUsed: this.snacked.get(prop.id)?.has(p.charId) ?? false,
    } });
  }

  /** Re-sends the interior to everyone currently inside (after decor/party/guest changes). */
  private async refreshInside(prop: Prop) {
    for (const id of this.inside.get(prop.id) ?? []) { const q = this.w.players.get(id); if (q) await this.sendHome(q, prop); }
  }

  /** Active parties, for every player's map. */
  sendParties(to?: Player) {
    const parties = [...this.props.values()].filter(pr => this.partyActive(pr)).map(pr => {
      const b = this.building(pr);
      return { id: pr.id, name: this.label(pr), host: pr.owner_id ? this.names.get(pr.owner_id) ?? '' : '', door: b ? { x: b.door.x, y: b.door.y } : null, until: new Date(pr.party_until!).getTime(), guests: this.inside.get(pr.id)?.size ?? 0 };
    });
    const msg = { t: 'parties', parties };
    if (to) to.session.send(msg);
    else { this.partiesSent = JSON.stringify(parties.map(x => x.id)); this.w.broadcast(msg); }
  }

  /** A player left the game or walked away: drop them from any home they were inside. */
  leaveAll(p: Player) {
    for (const [propId, set] of this.inside) if (set.delete(p.id)) { const pr = this.props.get(propId); if (pr) this.refreshInside(pr).catch(() => {}); }
  }

  // ---- request handling ----------------------------------------------------------------------
  handle(p: Player, m: any) {
    const w = this.w;
    if (m.op === 'listings' || m.op === 'mine') return this.sendHomes(p);
    if (m.op === 'accept' || m.op === 'decline') return w.exclusive(p, () => this.answerOffer(p, String(m.offer), m.op === 'accept'));
    const prop = this.props.get(Number(m.id));
    if (!prop) return w.toast(p, 'Property not found', 'bad');
    return w.exclusive(p, async () => {
      if (!w.canAct(p)) throw new GameError('You cannot do that now');
      switch (m.op) {
        case 'buy': return this.buy(p, prop);
        case 'rent': return this.rent(p, prop, Number(m.days));
        case 'sell': return this.sell(p, prop);
        case 'end_lease': return this.endLease(p, prop);
        case 'enter': return this.enter(p, prop);
        case 'lock': return this.toggleLock(p, prop);
        case 'stash': return this.stash(p, prop, m.dir === 'in' ? 1 : -1, String(m.item), Number(m.qty));
        case 'rest': return this.rest(p, prop);
        case 'wardrobe': return this.wardrobe(p, prop, m.appearance);
        case 'key_give': return this.giveKey(p, prop, String(m.to));
        case 'key_revoke': return this.revokeKey(p, prop, Number(m.character));
        case 'offer': return this.offer(p, prop, String(m.to), Number(m.price));
        case 'pay_tax': return this.payTax(p, prop);
        case 'doorbell': return this.doorbell(p, prop);
        case 'leave': { this.inside.get(prop.id)?.delete(p.id); await this.refreshInside(prop); return; }
        case 'armory': return this.armory(p, prop, m.dir === 'in' ? 1 : -1, String(m.item), Number(m.qty));
        case 'decorate': return this.decorate(p, prop, String(m.slot), String(m.option));
        case 'party_start': return this.startParty(p, prop);
        case 'party_snack': return this.partySnack(p, prop);
        case 'garage_park': return this.garagePark(p, prop, Number(m.vehicle));
        case 'garage_take': return this.garageTake(p, prop, Number(m.vehicle));
        default: throw new GameError('Unknown housing action');
      }
    });
  }

  private requireNearOrRealty(p: Player, prop: Prop) {
    if (!this.near(p, prop) && !this.atRealty(p)) throw new GameError('Go to the property or a real estate office');
  }
  private requireNear(p: Player, prop: Prop) {
    if (!this.near(p, prop)) throw new GameError('You need to be at the front door');
  }
  private label(prop: Prop) {
    const b = this.building(prop);
    return prop.kind === 'apartment' ? tr('{0}, apt {1}', b?.name ?? '', prop.unit) : (b?.name ?? '');
  }

  private async buy(p: Player, prop: Prop) {
    this.requireNearOrRealty(p, prop);
    if (prop.owner_id !== null) throw new GameError('This property is not for sale');
    if (this.mine(p.charId).length >= HOUSING.maxPerCharacter) throw new GameError(tr('You can own or rent at most {0} homes', HOUSING.maxPerCharacter));
    const row = await withTx(this.w.repo.db, async tx => {
      const cur = (await tx.query('SELECT owner_id FROM properties WHERE id = $1 FOR UPDATE', [prop.id])).rows[0];
      if (cur.owner_id !== null) throw new GameError('Someone just bought this property');
      const money = await this.w.repo.mutate(p.charId, { bank: -prop.price }, 'property_purchase', this.building(prop)?.name ?? 'Property', null, tx);
      const r = (await tx.query(`UPDATE properties SET owner_id = $2, tenure = 'owned', acquired_at = now(), lease_until = NULL,
        tax_paid_until = now() + interval '1 day', tax_debt = 0, locked = true WHERE id = $1 RETURNING *`, [prop.id, p.charId])).rows[0];
      await tx.query('DELETE FROM property_keys WHERE property_id = $1', [prop.id]);
      return { money, r };
    });
    this.keys.delete(prop.id);
    this.names.set(p.charId, p.name);
    this.store(row.r);
    this.w.applyMoney(p, row.money);
    this.w.broadcastNear(p.x, p.y, 400, { t: 'sfx', k: 'register', x: p.x, y: p.y });
    this.w.toast(p, tr('Welcome home! You bought {0}', this.label(row.r)), 'good');
    this.afterChange(p, row.r);
  }

  private async rent(p: Player, prop: Prop, days: number) {
    this.requireNearOrRealty(p, prop);
    if (prop.rent <= 0) throw new GameError('This property cannot be rented');
    if (!HOUSING.rentDays.includes(days)) throw new GameError('Invalid lease length');
    const extending = prop.owner_id === p.charId && prop.tenure === 'rented';
    if (prop.owner_id !== null && !extending) throw new GameError('This property is not available');
    if (!extending && this.mine(p.charId).length >= HOUSING.maxPerCharacter) throw new GameError(tr('You can own or rent at most {0} homes', HOUSING.maxPerCharacter));
    const cost = prop.rent * days;
    const row = await withTx(this.w.repo.db, async tx => {
      const cur = (await tx.query('SELECT owner_id, tenure FROM properties WHERE id = $1 FOR UPDATE', [prop.id])).rows[0];
      if (cur.owner_id !== null && !(cur.owner_id === p.charId && cur.tenure === 'rented')) throw new GameError('Someone just rented this property');
      const money = await this.w.repo.mutate(p.charId, { bank: -cost }, 'rent', `${this.building(prop)?.name ?? 'Apartment'} (${days} days)`, null, tx);
      const r = (await tx.query(`UPDATE properties SET owner_id = $2, tenure = 'rented', acquired_at = COALESCE(acquired_at, now()),
        lease_until = GREATEST(COALESCE(lease_until, now()), now()) + ($3 || ' days')::interval, locked = true WHERE id = $1 RETURNING *`, [prop.id, p.charId, String(days)])).rows[0];
      return { money, r };
    });
    this.names.set(p.charId, p.name);
    this.store(row.r);
    this.w.applyMoney(p, row.money);
    this.w.toast(p, extending ? tr('Lease extended by {0} days', days) : tr('You rented {0} for {1} days', this.label(row.r), days), 'good');
    this.afterChange(p, row.r);
  }

  private async requireEmptyStash(prop: Prop, tx: Tx) {
    const n = (await tx.query('SELECT count(*)::int AS n FROM property_storage WHERE property_id = $1', [prop.id])).rows[0].n;
    if (n > 0) throw new GameError('Empty the stash first');
  }

  private async sell(p: Player, prop: Prop) {
    this.requireNearOrRealty(p, prop);
    if (!this.isOwner(p, prop) || prop.tenure !== 'owned') throw new GameError('You don\'t own this property');
    const row = await withTx(this.w.repo.db, async tx => {
      const cur = (await tx.query('SELECT * FROM properties WHERE id = $1 FOR UPDATE', [prop.id])).rows[0];
      if (cur.owner_id !== p.charId) throw new GameError('You don\'t own this property');
      await this.requireEmptyStash(prop, tx);
      const payout = Math.max(0, Math.round(cur.price * HOUSING.sellBackRatio) - cur.tax_debt);
      const money = await this.w.repo.mutate(p.charId, { bank: payout }, 'property_sale', this.building(prop)?.name ?? 'Property', null, tx);
      const r = (await tx.query(`UPDATE properties SET owner_id = NULL, tenure = NULL, acquired_at = NULL, lease_until = NULL,
        tax_paid_until = NULL, tax_debt = 0, locked = true WHERE id = $1 RETURNING *`, [prop.id])).rows[0];
      await tx.query('DELETE FROM property_keys WHERE property_id = $1', [prop.id]);
      return { money, r, payout };
    });
    this.keys.delete(prop.id);
    this.store(row.r);
    this.w.applyMoney(p, row.money);
    this.w.toast(p, tr('Sold to the city for ${0}', row.payout), 'good');
    this.afterChange(p, row.r);
  }

  private async endLease(p: Player, prop: Prop) {
    if (!this.isOwner(p, prop) || prop.tenure !== 'rented') throw new GameError('You are not renting this property');
    const r = await withTx(this.w.repo.db, async tx => {
      await tx.query('SELECT id FROM properties WHERE id = $1 FOR UPDATE', [prop.id]);
      await this.requireEmptyStash(prop, tx);
      await tx.query('DELETE FROM property_keys WHERE property_id = $1', [prop.id]);
      return (await tx.query(`UPDATE properties SET owner_id = NULL, tenure = NULL, acquired_at = NULL, lease_until = NULL, locked = true WHERE id = $1 RETURNING *`, [prop.id])).rows[0];
    });
    this.keys.delete(prop.id);
    this.store(r);
    this.w.toast(p, 'Lease ended', 'info');
    this.afterChange(p, r);
  }

  private async enter(p: Player, prop: Prop) {
    this.requireNear(p, prop);
    if (prop.owner_id === null) throw new GameError('This home is empty — buy or rent it first');
    if (!this.hasAccess(p, prop) && prop.locked && !this.partyActive(prop)) throw new GameError('The door is locked');
    this.w.broadcastNear(p.x, p.y, 400, { t: 'sfx', k: 'door', x: p.x, y: p.y });
    for (const set of this.inside.values()) set.delete(p.id);
    let set = this.inside.get(prop.id); if (!set) { set = new Set(); this.inside.set(prop.id, set); }
    set.add(p.id);
    await this.refreshInside(prop);
    if (this.partyActive(prop)) this.sendParties();
  }

  private async toggleLock(p: Player, prop: Prop) {
    if (!this.hasAccess(p, prop)) throw new GameError('You don\'t have a key');
    const r = (await this.w.repo.db.query('UPDATE properties SET locked = NOT locked WHERE id = $1 RETURNING *', [prop.id])).rows[0];
    this.store(r);
    this.w.broadcastNear(p.x, p.y, 400, { t: 'sfx', k: r.locked ? 'lock' : 'unlock', x: p.x, y: p.y });
    this.w.toast(p, r.locked ? 'Front door locked' : 'Front door unlocked', 'good');
    await this.sendHome(p, r);
  }

  /** Moves items between the player's bag and the home stash atomically. dir 1 = into stash. */
  private async stash(p: Player, prop: Prop, dir: 1 | -1, item: string, qty: number) {
    this.requireNear(p, prop);
    if (!this.hasAccess(p, prop)) throw new GameError('You don\'t have a key');
    if (this.taxLocked(prop)) throw new GameError('Pay the overdue property tax to use the stash');
    const def = ITEMS[item];
    if (!def || !Number.isInteger(qty) || qty <= 0 || qty > 1000) throw new GameError('Invalid quantity');
    const res = await withTx(this.w.repo.db, async tx => {
      await tx.query('SELECT id FROM properties WHERE id = $1 FOR UPDATE', [prop.id]);
      const stash = await this.stashOf(prop.id, tx);
      const next = (stash[item] ?? 0) + dir * qty;
      if (next < 0) throw new GameError(tr('Not enough {0}', def.name));
      const after = { ...stash, [item]: next };
      if (dir === 1 && inventoryWeight(after) > HOUSING.storageKg[prop.kind]) throw new GameError('The stash is full');
      const money = await this.w.repo.mutate(p.charId, { items: { [item]: -dir * qty } }, 'items', null, null, tx);
      if (next === 0) await tx.query(`DELETE FROM property_storage WHERE property_id = $1 AND container = 'safe' AND item_id = $2`, [prop.id, item]);
      else await tx.query(`INSERT INTO property_storage(property_id, container, item_id, qty) VALUES ($1,'safe',$2,$3)
        ON CONFLICT (property_id, container, item_id) DO UPDATE SET qty = EXCLUDED.qty`, [prop.id, item, next]);
      return money;
    });
    this.w.applyMoney(p, res);
    if (def.weapon && dir === 1 && !(res.inventory[def.weapon] > 0) && p.weapon === def.weapon) { p.weapon = 'fists'; this.w.sendStats(p); }
    await this.sendHome(p, prop);
  }

  /** Gun locker: weapons and ammo only, limited by slots. dir 1 = into the locker. */
  private async armory(p: Player, prop: Prop, dir: 1 | -1, item: string, qty: number) {
    this.requireNear(p, prop);
    if (!this.hasAccess(p, prop)) throw new GameError('You don\'t have a key');
    if (this.taxLocked(prop)) throw new GameError('Pay the overdue property tax to use the stash');
    const def = ITEMS[item];
    if (!def || !Number.isInteger(qty) || qty <= 0 || qty > 2000) throw new GameError('Invalid quantity');
    if (!this.isArmoryItem(item)) throw new GameError('The gun locker only holds weapons and ammunition');
    const res = await withTx(this.w.repo.db, async tx => {
      await tx.query('SELECT id FROM properties WHERE id = $1 FOR UPDATE', [prop.id]);
      const armory = await this.stashOf(prop.id, tx, 'armory');
      const next = (armory[item] ?? 0) + dir * qty;
      if (next < 0) throw new GameError(tr('Not enough {0}', def.name));
      if (dir === 1) {
        const use = this.armoryUse({ ...armory, [item]: next });
        const slots = HOUSING.armorySlots[prop.kind];
        if (use.weapons > slots) throw new GameError(tr('The gun locker holds {0} weapons', slots));
        if (use.ammo > slots * HOUSING.armoryAmmoPerSlot) throw new GameError(tr('The gun locker holds {0} rounds', slots * HOUSING.armoryAmmoPerSlot));
      }
      const money = await this.w.repo.mutate(p.charId, { items: { [item]: -dir * qty } }, 'items', null, null, tx);
      if (next === 0) await tx.query(`DELETE FROM property_storage WHERE property_id = $1 AND container = 'armory' AND item_id = $2`, [prop.id, item]);
      else await tx.query(`INSERT INTO property_storage(property_id, container, item_id, qty) VALUES ($1,'armory',$2,$3)
        ON CONFLICT (property_id, container, item_id) DO UPDATE SET qty = EXCLUDED.qty`, [prop.id, item, next]);
      return money;
    });
    this.w.applyMoney(p, res);
    if (def.weapon && dir === 1 && !(res.inventory[def.weapon] > 0) && p.weapon === def.weapon) { p.weapon = 'fists'; this.w.sendStats(p); }
    this.w.broadcastNear(p.x, p.y, 300, { t: 'sfx', k: 'equip', x: p.x, y: p.y });
    await this.sendHome(p, prop);
  }

  /** Buys a decoration option for one slot (owner only). Re-choosing an owned default is free. */
  private async decorate(p: Player, prop: Prop, slot: string, option: string) {
    if (!this.isOwner(p, prop)) throw new GameError('Only the owner can decorate');
    const s = DECOR[slot];
    const opt = s?.options.find(o => o.id === option);
    if (!s || !opt) throw new GameError('Unknown decoration');
    if ((prop.decor?.[slot] ?? s.options[0].id) === option) throw new GameError('Already installed');
    const res = await withTx(this.w.repo.db, async tx => {
      await tx.query('SELECT id FROM properties WHERE id = $1 FOR UPDATE', [prop.id]);
      const money = opt.price > 0 ? await this.w.repo.mutate(p.charId, { bank: -opt.price }, 'decoration', `${s.name}: ${opt.name}`, null, tx) : null;
      const r = (await tx.query(`UPDATE properties SET decor = decor || jsonb_build_object($2::text, $3::text) WHERE id = $1 RETURNING *`, [prop.id, slot, option])).rows[0];
      return { money, r };
    });
    this.store(res.r);
    if (res.money) this.w.applyMoney(p, res.money);
    this.w.toast(p, tr('{0} installed', opt.name), 'good');
    await this.refreshInside(res.r);
    if (!this.inside.get(prop.id)?.has(p.id)) await this.sendHome(p, res.r);
  }

  /** Throws a 15-minute party: the host pays for catering, every player is invited. */
  private async startParty(p: Player, prop: Prop) {
    if (!this.isOwner(p, prop)) throw new GameError('Only the owner can host a party');
    if (this.partyActive(prop)) throw new GameError('A party is already going on');
    const last = prop.party_until ? new Date(prop.party_until).getTime() : 0;
    const wait = last + HOUSING.party.cooldownMs - HOUSING.party.durationMs - Date.now();
    if (last && wait > 0) throw new GameError(tr('You can host another party in {0} min', Math.ceil(wait / 60000)));
    const res = await withTx(this.w.repo.db, async tx => {
      await tx.query('SELECT id FROM properties WHERE id = $1 FOR UPDATE', [prop.id]);
      const pay = p.cash >= HOUSING.party.cost ? { cash: -HOUSING.party.cost } : { bank: -HOUSING.party.cost };
      const money = await this.w.repo.mutate(p.charId, pay, 'party', 'Party catering', null, tx);
      const r = (await tx.query(`UPDATE properties SET party_until = now() + ($2 || ' milliseconds')::interval WHERE id = $1 RETURNING *`, [prop.id, String(HOUSING.party.durationMs)])).rows[0];
      return { money, r };
    });
    this.store(res.r);
    this.snacked.set(prop.id, new Set());
    this.w.applyMoney(p, res.money);
    chat.system(this.w, tr('🎉 {0} is throwing a party at {1}! Everyone is invited.', p.name, this.label(prop)));
    this.sendParties();
    this.w.toast(p, 'Party started! Guests can come in for the next 15 minutes.', 'good');
    await this.refreshInside(res.r);
  }

  private async partySnack(p: Player, prop: Prop) {
    if (!this.partyActive(prop)) throw new GameError('There is no party right now');
    if (!this.inside.get(prop.id)?.has(p.id)) throw new GameError('You need to be inside');
    const used = this.snacked.get(prop.id) ?? new Set<number>();
    if (used.has(p.charId)) throw new GameError('You already had snacks at this party');
    used.add(p.charId); this.snacked.set(prop.id, used);
    p.hunger = 100; p.thirst = 100;
    this.w.sendStats(p);
    this.w.broadcastNear(p.x, p.y, 300, { t: 'sfx', k: 'eat', x: p.x, y: p.y });
    this.w.toast(p, 'Delicious! Hunger and thirst restored', 'good');
    await this.sendHome(p, prop);
  }

  /** Parks one of your cars in this home's garage. It must be near the front door. */
  private async garagePark(p: Player, prop: Prop, dbId: number) {
    if (!this.hasAccess(p, prop)) throw new GameError('You don\'t have a key');
    const slots = HOUSING.garageSlots[prop.kind];
    if (slots <= 0) throw new GameError('This home has no garage');
    const v = [...this.w.vehicles.values()].find(x => x.dbId === dbId && x.ownerCharId === p.charId);
    if (!v) throw new GameError('Vehicle not found');
    if (v.driver) throw new GameError('Vehicle is in use');
    const b = this.building(prop)!;
    if (dist(v.x, v.y, b.door.x, b.door.y) > HOUSING.garageRange) throw new GameError('Drive the car up to the house first');
    await withTx(this.w.repo.db, async tx => {
      await tx.query('SELECT id FROM properties WHERE id = $1 FOR UPDATE', [prop.id]);
      const n = (await tx.query('SELECT count(*)::int AS n FROM vehicles WHERE garage_property_id = $1 AND stored', [prop.id])).rows[0].n;
      if (n >= slots) throw new GameError(tr('The garage is full ({0} cars)', slots));
      await tx.query('UPDATE vehicles SET x=$2, y=$3, rot=$4, fuel=$5, engine=$6, locked=true, stored=true, garage_property_id=$7 WHERE id=$1',
        [dbId, v.x, v.y, v.rot, v.fuel, v.engine, prop.id]);
    });
    this.w.vehicles.delete(v.id);
    this.w.broadcastNear(b.door.x, b.door.y, 500, { t: 'sfx', k: 'lock', x: b.door.x, y: b.door.y });
    this.w.toast(p, tr('{0} parked in the garage', VEHICLES[v.model].name), 'good');
    await this.sendHome(p, prop);
  }

  /** Takes one of your cars out of this home's garage onto the driveway. */
  private async garageTake(p: Player, prop: Prop, dbId: number) {
    this.requireNear(p, prop);
    if (!this.hasAccess(p, prop)) throw new GameError('You don\'t have a key');
    const b = this.building(prop)!;
    const row = (await this.w.repo.db.query('SELECT * FROM vehicles WHERE id = $1 AND owner_id = $2 AND garage_property_id = $3 AND stored', [dbId, p.charId, prop.id])).rows[0];
    if (!row) throw new GameError('That car is not in this garage');
    const spot = freeSpotNear(this.w, b.door.x, b.door.y - 50, VEHICLES[row.model].length / 2);
    await this.w.repo.db.query('UPDATE vehicles SET x=$2, y=$3, stored=false, locked=false, garage_property_id=NULL WHERE id=$1', [dbId, spot.x, spot.y]);
    this.w.addOwnedVehicle({ ...row, x: spot.x, y: spot.y, stored: false, locked: false });
    this.w.toast(p, tr('{0} is on the driveway', VEHICLES[row.model].name), 'good');
    p.session.send({ t: 'waypoint', x: spot.x, y: spot.y, label: VEHICLES[row.model].name });
    await this.sendHome(p, prop);
  }

  private async rest(p: Player, prop: Prop) {
    this.requireNear(p, prop);
    if (!this.hasAccess(p, prop)) throw new GameError('You don\'t have a key');
    const now = Date.now();
    const wait = (p.lastRestAt ?? 0) + HOUSING.restCooldownMs - now;
    if (wait > 0) throw new GameError(tr('You are not tired yet ({0} min)', Math.ceil(wait / 60000)));
    if (p.hunger < 15 || p.thirst < 15) throw new GameError('You are too hungry or thirsty to sleep');
    p.lastRestAt = now;
    p.health = 100; p.stamina = 100;
    this.w.sendStats(p);
    this.w.toast(p, 'You slept well: health and stamina restored', 'good');
  }

  private async wardrobe(p: Player, prop: Prop, appearanceIn: unknown) {
    this.requireNear(p, prop);
    if (!this.hasAccess(p, prop)) throw new GameError('You don\'t have a key');
    const next = validateAppearance({ ...p.appearance, ...(appearanceIn as object), gender: p.appearance.gender, skin: p.appearance.skin });
    await this.w.repo.db.query('UPDATE characters SET appearance = $2 WHERE id = $1', [p.charId, next]);
    p.appearance = next;
    this.w.broadcast({ t: 'pinfo', players: [this.w.playerInfo(p)] });
    this.w.toast(p, 'Outfit changed', 'good');
  }

  private nearbyPlayer(p: Player, id: string) {
    const q = this.w.players.get(id);
    if (!q || q === p || dist(q.x, q.y, p.x, p.y) > 150) throw new GameError('Nobody close enough');
    return q;
  }

  private async giveKey(p: Player, prop: Prop, to: string) {
    if (!this.isOwner(p, prop)) throw new GameError('Only the owner can give keys');
    const q = this.nearbyPlayer(p, to);
    const keys = this.keySet(prop.id);
    if (keys.has(q.charId)) throw new GameError('They already have a key');
    if (keys.size >= HOUSING.maxKeys) throw new GameError(tr('At most {0} spare keys', HOUSING.maxKeys));
    await this.w.repo.db.query('INSERT INTO property_keys(property_id, character_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [prop.id, q.charId]);
    keys.add(q.charId);
    this.names.set(q.charId, q.name);
    this.w.toast(p, tr('Gave a key to {0}', q.name), 'good');
    this.w.toast(q, tr('{0} gave you a key to {1}', p.name, this.label(prop)), 'good');
    this.sendHomes(q);
    this.afterChange(p, prop);
  }

  private async revokeKey(p: Player, prop: Prop, charId: number) {
    if (!this.isOwner(p, prop)) throw new GameError('Only the owner can change the locks');
    await this.w.repo.db.query('DELETE FROM property_keys WHERE property_id = $1 AND character_id = $2', [prop.id, charId]);
    this.keySet(prop.id).delete(charId);
    const q = this.w.players.get(`p${charId}`);
    if (q) { this.w.toast(q, tr('Your key to {0} no longer works', this.label(prop)), 'bad'); this.sendHomes(q); }
    this.w.toast(p, 'Key revoked', 'good');
    this.afterChange(p, prop);
  }

  private async offer(p: Player, prop: Prop, to: string, price: number) {
    if (!this.isOwner(p, prop) || prop.tenure !== 'owned') throw new GameError('You can only sell homes you own');
    if (prop.tax_debt > 0) throw new GameError('Pay the overdue property tax first');
    if (!Number.isInteger(price) || price < 1 || price > 50_000_000) throw new GameError('Invalid amount');
    const q = this.nearbyPlayer(p, to);
    for (const [id, o] of this.offers) if (o.propertyId === prop.id) this.offers.delete(id);
    const o: Offer = { id: `o${this.offerSeq++}`, propertyId: prop.id, sellerCharId: p.charId, buyerCharId: q.charId, price, expiresAt: Date.now() + HOUSING.offerTtlMs };
    this.offers.set(o.id, o);
    q.session.send({ t: 'property_offer', offer: { id: o.id, from: p.name, property: this.view(prop, q), price, expiresAt: o.expiresAt } });
    this.w.toast(p, tr('Offer sent to {0}', q.name), 'info');
  }

  private async answerOffer(p: Player, offerId: string, accept: boolean) {
    const o = this.offers.get(offerId);
    if (!o || o.buyerCharId !== p.charId) throw new GameError('This offer is no longer available');
    this.offers.delete(offerId);
    const seller = this.w.players.get(`p${o.sellerCharId}`);
    if (!accept) { if (seller) this.w.toast(seller, tr('{0} declined your offer', p.name), 'bad'); return; }
    if (Date.now() > o.expiresAt) throw new GameError('This offer has expired');
    if (this.mine(p.charId).length >= HOUSING.maxPerCharacter) throw new GameError(tr('You can own or rent at most {0} homes', HOUSING.maxPerCharacter));
    const prop = this.props.get(o.propertyId)!;
    const res = await withTx(this.w.repo.db, async tx => {
      await tx.query('SELECT id FROM characters WHERE id = ANY($1) ORDER BY id FOR UPDATE', [[o.sellerCharId, o.buyerCharId]]);
      const cur = (await tx.query('SELECT owner_id, tenure, tax_debt FROM properties WHERE id = $1 FOR UPDATE', [prop.id])).rows[0];
      if (cur.owner_id !== o.sellerCharId || cur.tenure !== 'owned' || cur.tax_debt > 0) throw new GameError('This offer is no longer available');
      const buyer = await this.w.repo.mutate(o.buyerCharId, { bank: -o.price }, 'property_purchase', this.building(prop)?.name ?? 'Property', o.sellerCharId, tx);
      const sellerMoney = await this.w.repo.mutate(o.sellerCharId, { bank: o.price }, 'property_sale', this.building(prop)?.name ?? 'Property', o.buyerCharId, tx);
      await tx.query('DELETE FROM property_keys WHERE property_id = $1', [prop.id]);
      // The stash moves with the house.
      const r = (await tx.query(`UPDATE properties SET owner_id = $2, acquired_at = now(), tax_paid_until = now() + interval '1 day', locked = true WHERE id = $1 RETURNING *`, [prop.id, o.buyerCharId])).rows[0];
      return { buyer, sellerMoney, r };
    });
    this.keys.delete(prop.id);
    this.names.set(p.charId, p.name);
    this.store(res.r);
    this.w.applyMoney(p, res.buyer);
    this.w.toast(p, tr('Welcome home! You bought {0}', this.label(res.r)), 'good');
    if (seller) { this.w.applyMoney(seller, res.sellerMoney); this.w.toast(seller, tr('{0} bought your home for ${1}', p.name, o.price), 'good'); this.sendHomes(seller); }
    this.afterChange(p, res.r);
  }

  private async payTax(p: Player, prop: Prop) {
    if (!this.isOwner(p, prop)) throw new GameError('You don\'t own this property');
    if (prop.tax_debt <= 0) throw new GameError('No tax is due');
    const res = await withTx(this.w.repo.db, async tx => {
      const cur = (await tx.query('SELECT tax_debt FROM properties WHERE id = $1 FOR UPDATE', [prop.id])).rows[0];
      const money = await this.w.repo.mutate(p.charId, { bank: -cur.tax_debt }, 'property_tax', this.building(prop)?.name ?? 'Property', null, tx);
      const r = (await tx.query('UPDATE properties SET tax_debt = 0 WHERE id = $1 RETURNING *', [prop.id])).rows[0];
      return { money, r };
    });
    this.store(res.r);
    this.w.applyMoney(p, res.money);
    this.w.toast(p, 'Property tax paid', 'good');
    this.afterChange(p, res.r);
  }

  private async doorbell(p: Player, prop: Prop) {
    this.requireNear(p, prop);
    if (prop.owner_id === null) throw new GameError('Nobody lives here');
    this.w.broadcastNear(p.x, p.y, 500, { t: 'sfx', k: 'doorbell', x: p.x, y: p.y });
    const owner = this.w.players.get(`p${prop.owner_id}`);
    if (owner) this.w.toast(owner, tr('{0} rang the doorbell at {1}', p.name, this.label(prop)), 'info');
    this.w.toast(p, 'Ding-dong!', 'info');
  }

  /** Refreshes the owner's list and any open panel for this building. */
  private afterChange(p: Player, prop: Prop) {
    this.sendHomes(p);
    const b = this.building(prop);
    if (b && this.near(p, prop)) this.sendPanel(p, b);
  }

  // ---- background: leases and property tax -------------------------------------------------
  update() {
    const now = Date.now();
    if (now - this.lastPartyCheck > 5000) {
      this.lastPartyCheck = now;
      const active = JSON.stringify([...this.props.values()].filter(pr => this.partyActive(pr)).map(pr => pr.id));
      if (active !== this.partiesSent) this.sendParties();
    }
    if (this.ticking || now - this.lastTickAt < 60_000) return;
    this.lastTickAt = now;
    this.ticking = true;
    this.process().catch(e => this.w.log('housing tick', e)).finally(() => { this.ticking = false; });
    for (const [id, o] of this.offers) if (now > o.expiresAt + 5000) this.offers.delete(id);
  }

  /** Expires leases and charges property tax. Public so tests can run it directly. */
  async process() {
    const db = this.w.repo.db;
    // Expired leases: return the stash to the tenant's bag, then free the unit.
    for (const lease of (await db.query(`SELECT * FROM properties WHERE tenure = 'rented' AND lease_until < now()`)).rows as Prop[]) {
      const tenant = lease.owner_id!;
      const r = await withTx(db, async tx => {
        const cur = (await tx.query('SELECT * FROM properties WHERE id = $1 FOR UPDATE', [lease.id])).rows[0];
        if (cur.tenure !== 'rented' || new Date(cur.lease_until).getTime() >= Date.now()) return null;
        const stash = await this.stashOf(lease.id, tx, 'all');
        let money = null;
        if (Object.keys(stash).length) money = await this.w.repo.mutate(tenant, { items: stash, force: true }, 'items', null, null, tx);
        await tx.query('DELETE FROM property_storage WHERE property_id = $1', [lease.id]);
        await tx.query('DELETE FROM property_keys WHERE property_id = $1', [lease.id]);
        const row = (await tx.query(`UPDATE properties SET owner_id = NULL, tenure = NULL, acquired_at = NULL, lease_until = NULL, locked = true WHERE id = $1 RETURNING *`, [lease.id])).rows[0];
        return { row, money };
      });
      if (!r) continue;
      this.keys.delete(lease.id);
      this.store(r.row);
      const online = this.w.players.get(`p${tenant}`);
      if (online) {
        if (r.money) this.w.applyMoney(online, r.money);
        this.w.toast(online, tr('Your lease at {0} ended. Stored items were returned to your bag.', this.label(lease)), 'info');
        this.sendHomes(online);
      }
    }
    // Property tax: charge every full day; anything the bank can't cover becomes debt.
    for (const prop of (await db.query(`SELECT * FROM properties WHERE tenure = 'owned' AND tax_paid_until < now()`)).rows as Prop[]) {
      const days = Math.ceil((Date.now() - new Date(prop.tax_paid_until!).getTime()) / DAY_MS);
      const due = Math.round(prop.price * HOUSING.taxRatePerDay) * days;
      const r = await withTx(db, async tx => {
        const cur = (await tx.query('SELECT * FROM properties WHERE id = $1 FOR UPDATE', [prop.id])).rows[0];
        if (cur.tenure !== 'owned' || new Date(cur.tax_paid_until).getTime() >= Date.now()) return null;
        let money = null, debt = 0;
        await tx.query('SAVEPOINT tax');
        try { money = await this.w.repo.mutate(cur.owner_id, { bank: -due }, 'property_tax', this.building(prop)?.name ?? 'Property', null, tx); }
        catch (e) { if (!(e instanceof GameError)) throw e; await tx.query('ROLLBACK TO SAVEPOINT tax'); debt = due; }
        const row = (await tx.query(`UPDATE properties SET tax_paid_until = tax_paid_until + ($2 || ' days')::interval, tax_debt = tax_debt + $3 WHERE id = $1 RETURNING *`, [prop.id, String(days), debt])).rows[0];
        return { row, money, debt };
      });
      if (!r) continue;
      this.store(r.row);
      const online = this.w.players.get(`p${prop.owner_id}`);
      if (online) {
        if (r.money) { this.w.applyMoney(online, r.money); this.w.toast(online, tr('Property tax: ${0} for {1}', due, this.label(prop)), 'info'); }
        else this.w.toast(online, tr('Property tax of ${0} for {1} is overdue', r.debt, this.label(prop)), 'bad');
        this.sendHomes(online);
      }
    }
  }
}
