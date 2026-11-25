import type { GameWorld } from './world.ts';
import type { Player, Vehicle } from './types.ts';
import { SHOPS, ITEMS, LICENSES, VEHICLES, ECONOMY, JOBS, WEAPONS } from './content.ts';
import { GameError, validateAppearance } from './repo.ts';
import { dist } from '../world/map.ts';
import * as combat from './combat.ts';
import { tr } from './i18n.ts';

const DOOR_RANGE = 90;
const isQty = (n: unknown, max = 100): n is number => Number.isInteger(n) && (n as number) > 0 && (n as number) <= max;

/** Interactive building of one of `types` whose door is near the player. */
function nearBuilding(w: GameWorld, p: Player, types: string[]) {
  return w.map.data.buildings.find(b => types.includes(b.type) && dist(b.door.x, b.door.y, p.x, p.y) <= DOOR_RANGE);
}
function requireNear(w: GameWorld, p: Player, types: string[], what: string) {
  const b = nearBuilding(w, p, types);
  if (!b) throw new GameError(tr('You need to be at {0}', what));
  return b;
}
const nearAtm = (w: GameWorld, p: Player) => !!w.map.poiNear('atm', p.x, p.y, 60);

export function onInteract(w: GameWorld, p: Player, m: any) {
  if (!w.canAct(p)) return;
  if (m.poi === 'atm') {
    if (!nearAtm(w, p)) return w.toast(p, 'No ATM nearby', 'bad');
    return sendBankPanel(w, p, true);
  }
  const b = w.map.buildingById(Number(m.building));
  if (!b || !b.interactive || dist(b.door.x, b.door.y, p.x, p.y) > DOOR_RANGE) return w.toast(p, 'Too far from the entrance', 'bad');
  w.broadcastNear(b.door.x, b.door.y, 500, { t: 'sfx', k: 'door', x: b.door.x, y: b.door.y });
  const shop = SHOPS.find(s => s.buildingType === b.type);
  const jobsHere = Object.values(JOBS).filter(j => j.building === b.type && j.id !== 'unemployed').map(j => j.id);
  const licensesHere = Object.entries(LICENSES).filter(([, l]) => l.building === b.type).map(([id]) => id);
  const base = { t: 'panel', building: { id: b.id, type: b.type, name: b.name }, jobs: jobsHere, licenses: licensesHere };
  if (b.property) return w.housing.sendPanel(p, b);
  switch (b.type) {
    case 'realestate': return w.housing.sendListings(p, b);
    case 'bank': return sendBankPanel(w, p, false, b);
    case 'dealership': return p.session.send({ ...base, kind: 'dealership', vehicles: Object.values(VEHICLES).filter(v => v.price > 0).map(v => v.id) });
    case 'clothing': return p.session.send({ ...base, kind: 'clothing', price: 120, appearance: p.appearance });
    case 'police':
      return p.session.send({ ...base, kind: 'police_station', fine: p.wanted > 0 ? p.wanted * 800 : 0 });
    case 'hospital': return p.session.send({ ...base, kind: 'hospital', healPrice: 150 });
    case 'mechanic': return p.session.send({ ...base, kind: 'mechanic' });
    default:
      if (shop) return p.session.send({ ...base, kind: 'shop', shop });
      if (jobsHere.length || licensesHere.length) return p.session.send({ ...base, kind: 'office' });
      return w.toast(p, tr('{0} is closed right now', b.name));
  }
}

function sendBankPanel(w: GameWorld, p: Player, atm: boolean, b?: { id: number; type: string; name: string }) {
  w.repo.recentTransactions(p.charId, 15).then(history => {
    p.session.send({ t: 'panel', kind: 'bank', atm, building: b ? { id: b.id, type: b.type, name: b.name } : { id: 0, type: 'atm', name: 'ATM' }, cash: p.cash, bank: p.bank, history });
  }).catch(() => {});
}

export function onBuy(w: GameWorld, p: Player, m: any) {
  return w.exclusive(p, async () => {
    if (!w.canAct(p)) throw new GameError('You cannot do that now');
    const shop = SHOPS.find(s => s.id === m.shop);
    if (!shop) throw new GameError('Unknown shop');
    requireNear(w, p, [shop.buildingType], shop.name);
    const entry = shop.items.find(i => i.item === m.item);
    const qty = Number(m.qty ?? 1);
    if (!entry || !isQty(qty, 500)) throw new GameError('Invalid purchase');
    if (entry.requires && !p.licenses.includes(entry.requires)) throw new GameError(tr('Requires a {0}', LICENSES[entry.requires].name));
    const total = entry.price * qty;
    const pay = m.pay === 'bank' ? { bank: -total } : { cash: -total };
    const r = await w.repo.mutate(p.charId, { ...pay, items: { [entry.item]: qty } }, 'purchase', `${qty}x ${ITEMS[entry.item].name} @ ${shop.name}`);
    w.applyMoney(p, r);
    w.broadcastNear(p.x, p.y, 400, { t: 'sfx', k: 'register', x: p.x, y: p.y });
    w.toast(p, tr('Bought {0}x {1} for ${2}', qty, ITEMS[entry.item].name, total), 'good');
  });
}

export function onSell(w: GameWorld, p: Player, m: any) {
  return w.exclusive(p, async () => {
    const shop = SHOPS.find(s => s.id === m.shop);
    const entry = shop?.sells?.find(i => i.item === m.item);
    const qty = Number(m.qty ?? 1);
    if (!shop || !entry || !isQty(qty, 500)) throw new GameError('They are not buying that');
    requireNear(w, p, [shop.buildingType], shop.name);
    const total = entry.price * qty;
    const r = await w.repo.mutate(p.charId, { cash: total, items: { [entry.item]: -qty } }, 'sale', `${qty}x ${ITEMS[entry.item].name} @ ${shop.name}`);
    w.applyMoney(p, r);
    w.toast(p, tr('Sold {0}x {1} for ${2}', qty, ITEMS[entry.item].name, total), 'good');
  });
}

export function onBank(w: GameWorld, p: Player, m: any) {
  return w.exclusive(p, async () => {
    if (!nearBuilding(w, p, ['bank']) && !nearAtm(w, p)) throw new GameError('You need to be at a bank or ATM');
    const amount = Number(m.amount);
    if (!Number.isInteger(amount) || amount <= 0 || amount > ECONOMY.maxTransfer) throw new GameError('Invalid amount');
    if (m.op === 'deposit') w.applyMoney(p, await w.repo.mutate(p.charId, { cash: -amount, bank: amount }, 'deposit'));
    else if (m.op === 'withdraw') w.applyMoney(p, await w.repo.mutate(p.charId, { cash: amount, bank: -amount }, 'withdraw'));
    else if (m.op === 'transfer') {
      const target = await w.repo.lookupCitizen(String(m.to ?? '').slice(0, 40));
      if (!target) throw new GameError('No citizen with that name or ID');
      const r = await w.repo.transfer(p.charId, target.id, amount, typeof m.memo === 'string' ? m.memo.slice(0, 80) : null);
      w.applyMoney(p, r.from);
      const other = w.players.get(`p${target.id}`);
      if (other) { w.applyMoney(other, r.to); w.toast(other, tr('{0} sent you ${1}', p.name, amount), 'good'); }
      w.toast(p, tr('Transferred ${0} to {1}', amount, target.name), 'good');
    } else throw new GameError('Unknown bank operation');
    w.broadcastNear(p.x, p.y, 300, { t: 'sfx', k: 'register', x: p.x, y: p.y });
    sendBankPanel(w, p, !nearBuilding(w, p, ['bank']));
  });
}

export function onHistory(w: GameWorld, p: Player) {
  w.repo.recentTransactions(p.charId, 25).then(h => p.session.send({ t: 'history', items: h })).catch(() => {});
}

export function onBuyLicense(w: GameWorld, p: Player, m: any) {
  return w.exclusive(p, async () => {
    const lic = LICENSES[m.license];
    if (!lic) throw new GameError('Unknown license');
    requireNear(w, p, [lic.building], 'the licensing office');
    if (p.licenses.includes(m.license)) throw new GameError('You already hold this license');
    if (m.license === 'firearms' && p.wanted > 0) throw new GameError('Wanted persons cannot obtain a firearms license');
    const pay = p.cash >= lic.price ? { cash: -lic.price } : { bank: -lic.price };
    w.applyMoney(p, await w.repo.mutate(p.charId, { ...pay, licenses: [m.license] }, 'license', lic.name));
    w.toast(p, tr('{0} issued', lic.name), 'good');
  });
}

export function freeSpotNear(w: GameWorld, x: number, y: number, r: number) {
  for (let ring = 0; ring < 8; ring++)
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2, d = ring * 40;
      const sx = x + Math.cos(a) * d, sy = y + Math.sin(a) * d;
      const occupied = [...w.vehicles.values()].some(v => dist(v.x, v.y, sx, sy) < 70);
      if (!w.map.circleBlocked(sx, sy, r) && !occupied) return { x: sx, y: sy };
    }
  return { x, y };
}

export function onBuyVehicle(w: GameWorld, p: Player, m: any) {
  return w.exclusive(p, async () => {
    requireNear(w, p, ['dealership'], 'Prestige Motors');
    const def = VEHICLES[m.model];
    if (!def || def.price <= 0) throw new GameError('Not for sale');
    if (!p.licenses.includes('driving')) throw new GameError('You need a Driving License (City Hall)');
    const color = typeof m.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(m.color) ? m.color : '#2c3e50';
    const lot = w.map.poiNear('vehicle_delivery', p.x, p.y, 800) ?? { x: p.x, y: p.y - 80 };
    const spot = freeSpotNear(w, lot.x, lot.y, def.length / 2);
    const r = await w.repo.buyVehicle(p.charId, def.id, def.price, color, { ...spot, rot: 0 });
    w.applyMoney(p, r.money);
    const v = w.addOwnedVehicle(r.vehicle);
    v.fuel = def.fuelCapacity; v.locked = false;
    w.toast(p, tr('Congratulations on your new {0}! Plate {1}', def.name, v.plate), 'good');
    p.session.send({ t: 'waypoint', x: v.x, y: v.y, label: def.name });
    sendGarage(w, p);
  });
}

async function sendGarage(w: GameWorld, p: Player) {
  const rows = await w.repo.ownedVehicles(p.charId);
  const homeName = (id: number | null) => { const pr = id ? w.housing.props.get(id) : null; const b = pr ? w.map.buildingById(pr.building_id) : null; return b?.name ?? null; };
  p.session.send({ t: 'garage', vehicles: rows.map(r => ({ id: r.id, model: r.model, plate: r.plate, color: r.color, stored: r.stored, fuel: r.fuel, engine: r.engine, home: homeName(r.garage_property_id) })) });
}

export function onGarage(w: GameWorld, p: Player, m: any) {
  return w.exclusive(p, async () => {
    const garageTypes = ['mechanic', 'apartments', 'house', 'mansion', 'realestate', 'dealership'];
    if (m.op === 'list') return sendGarage(w, p);
    const gb = requireNear(w, p, garageTypes, 'a garage (home, apartments, mechanic or dealership)');
    // House and mansion garages are private: only the owner and key holders can use them.
    if (!w.housing.canUseGarage(p, gb)) throw new GameError('This is a private garage');
    if (m.op === 'store') {
      const v = [...w.vehicles.values()].find(v => v.dbId === Number(m.id) && v.ownerCharId === p.charId);
      if (!v) throw new GameError('Vehicle not found');
      if (v.driver) throw new GameError('Vehicle is in use');
      if (dist(v.x, v.y, p.x, p.y) > 300) throw new GameError('Bring the vehicle closer');
      await w.repo.saveVehicle({ dbId: v.dbId!, x: v.x, y: v.y, rot: v.rot, fuel: v.fuel, engine: v.engine, locked: true, stored: true });
      w.vehicles.delete(v.id);
      w.toast(p, tr('{0} stored', VEHICLES[v.model].name), 'good');
    } else if (m.op === 'retrieve') {
      const rows = await w.repo.ownedVehicles(p.charId);
      const row = rows.find(r => r.id === Number(m.id));
      if (!row || !row.stored) throw new GameError('That vehicle is not in storage');
      if (row.garage_property_id) {
        const pr = w.housing.props.get(row.garage_property_id);
        throw new GameError(tr('This car is parked at {0}', (pr && w.map.buildingById(pr.building_id)?.name) ?? 'home'));
      }
      const spot = freeSpotNear(w, p.x, p.y - 60, VEHICLES[row.model].length / 2);
      row.x = spot.x; row.y = spot.y; row.stored = false; row.locked = false;
      await w.repo.saveVehicle({ dbId: row.id, x: spot.x, y: spot.y, rot: row.rot, fuel: row.fuel, engine: row.engine, locked: false, stored: false });
      w.addOwnedVehicle(row);
      w.toast(p, tr('{0} retrieved', VEHICLES[row.model].name), 'good');
    } else throw new GameError('Unknown garage operation');
    await sendGarage(w, p);
  });
}

export function onRefuel(w: GameWorld, p: Player) {
  return w.exclusive(p, async () => {
    const v = p.vehicleId ? w.vehicles.get(p.vehicleId) : null;
    if (!v) throw new GameError('You need to be in a vehicle');
    if (!w.map.poiNear('fuel', v.x, v.y)) throw new GameError('Drive up to a fuel pump');
    const def = VEHICLES[v.model];
    const liters = Math.max(0, def.fuelCapacity - v.fuel);
    if (liters < 0.5) throw new GameError('Tank is already full');
    const cost = Math.ceil(liters * ECONOMY.fuelPricePerLiter);
    const pay = p.cash >= cost ? { cash: -cost } : { bank: -cost };
    w.applyMoney(p, await w.repo.mutate(p.charId, pay, 'fuel', `${liters.toFixed(1)}L ${def.name}`));
    v.fuel = def.fuelCapacity;
    p.session.send({ t: 'vstat', id: v.id, fuel: v.fuel, engine: v.engine });
    w.broadcastNear(v.x, v.y, 400, { t: 'sfx', k: 'refuel', x: v.x, y: v.y });
    w.toast(p, tr('Filled {0}L for ${1}', liters.toFixed(1), cost), 'good');
  });
}

function nearestVehicle(w: GameWorld, p: Player, r = 90): Vehicle | null {
  let best: Vehicle | null = null, bd = r;
  for (const v of w.vehicles.values()) { const d = dist(v.x, v.y, p.x, p.y); if (d < bd) { bd = d; best = v; } }
  return best;
}

export function onRepair(w: GameWorld, p: Player) {
  return w.exclusive(p, async () => {
    const inside = p.vehicleId ? w.vehicles.get(p.vehicleId) : null;
    if (inside && w.map.poiNear('repair', inside.x, inside.y)) {
      const cost = Math.ceil((100 - inside.engine) * ECONOMY.repairCostPerPoint);
      if (cost <= 0) throw new GameError('Vehicle is in perfect condition');
      const pay = p.cash >= cost ? { cash: -cost } : { bank: -cost };
      w.applyMoney(p, await w.repo.mutate(p.charId, pay, 'repair', VEHICLES[inside.model].name));
      inside.engine = 100; inside.wreckedAt = 0;
      p.session.send({ t: 'vstat', id: inside.id, fuel: inside.fuel, engine: inside.engine });
      w.toast(p, tr('Repaired for ${0}', cost), 'good');
      return;
    }
    if (p.vehicleId) throw new GameError('Drive into the repair bay at Wrench & Sons');
    const v = nearestVehicle(w, p);
    if (!v) throw new GameError('No vehicle nearby');
    if ((p.inventory.repairkit ?? 0) <= 0) throw new GameError('You need a Repair Kit');
    w.applyMoney(p, await w.repo.mutate(p.charId, { items: { repairkit: -1 } }, 'items'));
    const amount = p.job === 'mechanic' ? 100 : 50;
    v.engine = Math.min(100, v.engine + amount); v.wreckedAt = 0;
    w.broadcastNear(v.x, v.y, 500, { t: 'sfx', k: 'repair', x: v.x, y: v.y });
    w.toast(p, tr('Vehicle repaired to {0}%', Math.round(v.engine)), 'good');
    if (p.job === 'mechanic') {
      // Mechanics are paid by the city's roadside assistance program.
      w.applyMoney(p, await w.repo.mutate(p.charId, { bank: 180 }, 'job_pay', 'Roadside repair'));
      p.jobXp += 1;
    }
  });
}

export function onUse(w: GameWorld, p: Player, m: any) {
  return w.exclusive(p, async () => {
    if (!w.canAct(p)) throw new GameError('You cannot do that now');
    const def = ITEMS[m.item];
    if (!def || (p.inventory[def.id] ?? 0) <= 0) throw new GameError("You don't have that");
    if (def.weapon) { combat.onEquip(w, p, { weapon: def.weapon }); return; }
    if (def.id === 'repairkit') { p.busy = false; await onRepair(w, p); return; }
    if (def.id === 'jerrycan') {
      const v = (p.vehicleId && w.vehicles.get(p.vehicleId)) || nearestVehicle(w, p);
      if (!v) throw new GameError('No vehicle nearby');
      w.applyMoney(p, await w.repo.mutate(p.charId, { items: { jerrycan: -1 } }, 'items'));
      v.fuel = Math.min(VEHICLES[v.model].fuelCapacity, v.fuel + 20);
      w.toast(p, 'Added 20L of fuel', 'good');
      return;
    }
    if (!def.use) throw new GameError(tr('{0} can\'t be used', def.name));
    w.applyMoney(p, await w.repo.mutate(p.charId, { items: { [def.id]: -1 } }, 'items'));
    p.hunger = Math.min(100, p.hunger + (def.use.hunger ?? 0));
    p.thirst = Math.min(100, p.thirst + (def.use.thirst ?? 0));
    p.health = Math.min(100, p.health + (def.use.health ?? 0));
    w.broadcastNear(p.x, p.y, 300, { t: 'sfx', k: def.category === 'drink' ? 'drink' : def.category === 'medical' ? 'bandage' : 'eat', x: p.x, y: p.y });
    w.sendStats(p);
  });
}

export function onDrop(w: GameWorld, p: Player, m: any) {
  return w.exclusive(p, async () => {
    const def = ITEMS[m.item];
    const qty = Number(m.qty ?? 1);
    if (!def || !isQty(qty, 500) || def.category === 'document') throw new GameError('Cannot drop that');
    const r = await w.repo.mutate(p.charId, { items: { [def.id]: -qty } }, 'items');
    w.applyMoney(p, r);
    if (def.weapon && p.weapon === def.weapon && !(r.inventory[def.id] > 0)) { await combat.returnClipsToInventory(w, p); p.weapon = 'fists'; w.sendStats(p); }
    const id = w.nextId('i');
    w.pickups.set(id, { id, x: p.x + Math.cos(p.rot) * 24, y: p.y + Math.sin(p.rot) * 24, item: def.id, qty, expiresAt: Date.now() + 10 * 60_000 });
  });
}

/** Walking over a pickup collects it. The pickup is removed before the await so it can't be claimed twice. */
export function autoPickup(w: GameWorld, p: Player) {
  if (p.busy || p.deadUntil) return;
  for (const it of w.pickups.values()) {
    if (dist(it.x, it.y, p.x, p.y) > 26) continue;
    w.pickups.delete(it.id);
    w.exclusive(p, async () => {
      try {
        const change = it.item === 'cash' ? { cash: it.qty } : { items: { [it.item]: it.qty } };
        w.applyMoney(p, await w.repo.mutate(p.charId, change, it.item === 'cash' ? 'pickup' : 'items'));
        w.broadcastNear(p.x, p.y, 300, { t: 'sfx', k: 'pickup', x: p.x, y: p.y });
        w.toast(p, it.item === 'cash' ? tr('Picked up ${0}', it.qty) : tr('Picked up {0}x {1}', it.qty, ITEMS[it.item].name), 'good');
      } catch (e) {
        w.pickups.set(it.id, { ...it, x: it.x + 30 });  // put it back, slightly away so we don't retry instantly
        throw e;
      }
    });
    return;
  }
}

export function onGive(w: GameWorld, p: Player, m: any) {
  return w.exclusive(p, async () => {
    const q = w.players.get(String(m.to));
    if (!q || q === p || dist(q.x, q.y, p.x, p.y) > 120) throw new GameError('Nobody close enough');
    if (q.busy) throw new GameError('They are busy');
    if (m.item === 'cash') {
      const amount = Number(m.qty);
      if (!isQty(amount, ECONOMY.maxTransfer)) throw new GameError('Invalid amount');
      const r = await w.repo.exchange(p.charId, q.charId, { cash: amount }, {}, 'give_cash');
      w.applyMoney(p, r.a); w.applyMoney(q, r.b);
      w.toast(q, tr('{0} gave you ${1}', p.name, amount), 'good');
      w.toast(p, tr('You gave {0} ${1}', q.name, amount), 'good');
      return;
    }
    const def = ITEMS[m.item];
    const qty = Number(m.qty ?? 1);
    if (!def || !isQty(qty, 500) || def.category === 'document') throw new GameError('Cannot give that');
    const r = await w.repo.exchange(p.charId, q.charId, { items: { [def.id]: qty } }, {}, 'give_item');
    w.applyMoney(p, r.a); w.applyMoney(q, r.b);
    if (def.weapon && p.weapon === def.weapon && !(r.a.inventory[def.id] > 0)) { p.weapon = 'fists'; w.sendStats(p); }
    w.toast(q, tr('{0} gave you {1}x {2}', p.name, qty, def.name), 'good');
    w.toast(p, tr('You gave {0} {1}x {2}', q.name, qty, def.name), 'good');
  });
}

export function onClothing(w: GameWorld, p: Player, m: any) {
  return w.exclusive(p, async () => {
    requireNear(w, p, ['clothing'], 'Threads Apparel');
    const next = validateAppearance({ ...p.appearance, ...m.appearance, gender: p.appearance.gender, skin: p.appearance.skin });
    w.applyMoney(p, await w.repo.mutate(p.charId, { cash: -120 }, 'purchase', 'New outfit'));
    await w.repo.db.query('UPDATE characters SET appearance=$2 WHERE id=$1', [p.charId, next]);
    p.appearance = next;
    w.broadcast({ t: 'pinfo', players: [w.playerInfo(p)] });
    w.toast(p, 'Looking sharp!', 'good');
  });
}

export function onHeal(w: GameWorld, p: Player) {
  return w.exclusive(p, async () => {
    requireNear(w, p, ['hospital'], 'the hospital');
    if (p.health >= 100) throw new GameError("You're perfectly healthy");
    w.applyMoney(p, await w.repo.mutate(p.charId, p.cash >= 150 ? { cash: -150 } : { bank: -150 }, 'medical', 'Outpatient treatment'));
    p.health = 100; w.sendStats(p);
    w.toast(p, 'Fully healed', 'good');
  });
}

export async function paySalaries(w: GameWorld) {
  for (const p of w.players.values()) {
    if (p.jailUntil || p.deadUntil) continue;
    const job = JOBS[p.job] ?? JOBS.unemployed;
    const gross = job.ranks[Math.min(p.jobRank, job.ranks.length - 1)].salary;
    if (gross <= 0) continue;
    const tax = Math.round(gross * ECONOMY.incomeTaxRate);
    try {
      w.applyMoney(p, await w.repo.mutate(p.charId, { bank: gross - tax }, 'salary', `${job.name} paycheck ($${gross} - $${tax} tax)`));
      w.toast(p, tr('Paycheck: ${0} deposited (tax ${1})', gross - tax, tax), 'good');
    } catch (e) { w.log('salary failed', p.name, e); }
  }
}

export { WEAPONS };
