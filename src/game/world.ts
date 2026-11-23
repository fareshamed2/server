import { WorldMap, dist, pointSegDist } from '../world/map.ts';
import { Repo, GameError, inventoryWeight, type CharacterRow, type Inventory } from './repo.ts';
import { VEHICLES, WEAPONS, ITEMS, ECONOMY, JOBS, MAX_CARRY_WEIGHT } from './content.ts';
import type { Player, Vehicle, Npc, Pickup, Session, EmergencyCall, Anim } from './types.ts';
import { config } from '../config.ts';
import * as combat from './combat.ts';
import * as economy from './economy.ts';
import * as jobs from './jobs.ts';
import * as npcs from './npc.ts';
import * as chat from './chat.ts';
import * as admin from './admin.ts';
import { tr, wire, type Text } from './i18n.ts';

const WALK_SPEED = 150;
const RUN_SPEED = 250;
const PLAYER_RADIUS = 10;
const VALID_ANIMS = new Set<Anim>(['idle', 'walk', 'run', 'sit', 'interact']);

/** The authoritative simulation for one city instance. */
export class GameWorld {
  readonly map: WorldMap;
  readonly repo: Repo;
  readonly players = new Map<string, Player>();
  readonly vehicles = new Map<string, Vehicle>();
  readonly npcs = new Map<string, Npc>();
  readonly pickups = new Map<string, Pickup>();
  readonly calls: EmergencyCall[] = [];
  tick = 0;
  now = Date.now();
  private seq = 1;
  private lastSalaryAt = Date.now();
  private timers: NodeJS.Timeout[] = [];
  log: (...a: unknown[]) => void = console.log;

  constructor(map: WorldMap, repo: Repo) { this.map = map; this.repo = repo; }

  nextId(prefix: string) { return `${prefix}${this.seq++}`; }

  async init(opts: { npcs?: number; traffic?: number } = {}) {
    // Persistent player-owned vehicles that were left in the world.
    for (const row of await this.repo.allPersistentVehicles()) this.addOwnedVehicle(row);
    // Public parked cars & job vehicles at their depots.
    const civ = ['sedan', 'hatch', 'coupe', 'bike', 'sedan', 'hatch'];
    for (const s of this.map.data.props.parkingSpots) {
      if (s.kind !== 'street') continue;
      const model = civ[Math.floor(Math.random() * civ.length)];
      this.addVehicle({ kind: 'public', model, x: s.x, y: s.y, rot: s.rot, locked: Math.random() < 0.4, home: { x: s.x, y: s.y, rot: s.rot } });
    }
    npcs.spawnPedestrians(this, opts.npcs ?? 45);
    npcs.spawnTraffic(this, opts.traffic ?? 16);
  }

  start() {
    const dt = 1000 / config.tickRate;
    let last = Date.now();
    let snapAcc = 0;
    this.timers.push(setInterval(() => {
      const now = Date.now();
      const d = Math.min(0.25, (now - last) / 1000); last = now; this.now = now;
      this.update(d);
      snapAcc += d;
      if (snapAcc >= 1 / config.snapshotRate) { snapAcc = 0; this.broadcastSnapshots(); }
    }, dt));
    this.timers.push(setInterval(() => { this.saveAll().catch(e => this.log('save error', e)); }, config.saveIntervalMs));
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.saveAll();
  }

  // ---- players -----------------------------------------------------------------------
  async spawnPlayer(session: Session, row: CharacterRow): Promise<Player> {
    const id = `p${row.id}`;
    const existing = this.players.get(id);
    if (existing) {
      // Same character logged in elsewhere: take over (reconnection) and kick the old socket.
      if (existing.session !== session) { existing.session.send({ t: 'kicked', reason: 'Logged in from another device' }); existing.session.player = null; existing.session.close(4000, 'replaced'); }
      existing.session = session;
      session.player = existing;
      this.sendSpawn(existing);
      return existing;
    }
    const inventory = await this.repo.loadInventory(row.id);
    const jailUntil = row.jail_until ? new Date(row.jail_until).getTime() : 0;
    const p: Player = {
      id, charId: row.id, accountId: row.account_id, role: session.account!.role, name: row.name, citizenId: row.citizen_id,
      appearance: row.appearance, session,
      x: row.x, y: row.y, rot: 0, anim: 'idle', lastMoveAt: Date.now(), vehicleId: null,
      health: Math.max(1, row.health), stamina: 100, hunger: row.hunger, thirst: row.thirst,
      cash: row.cash, bank: row.bank, inventory, licenses: row.licenses ?? [],
      job: row.job, jobRank: row.job_rank, jobXp: 0, wanted: row.wanted, lastCrimeAt: Date.now(), charges: row.wanted > 0 ? ['Outstanding warrant'] : [], lastDispatchAt: 0,
      weapon: 'fists', clips: {}, lastFireAt: 0, reloadUntil: 0, deadUntil: 0, lastDamageAt: 0,
      cuffedBy: null, jailUntil: jailUntil > Date.now() ? jailUntil : 0, mission: null, jobVehicleId: null,
      joinedAt: Date.now(), lastSavedAt: Date.now(), violations: 0, busy: false, dirtyStats: true, lastChatAt: 0,
      invulnerableUntil: Date.now() + 3000,
    };
    if (this.map.circleBlocked(p.x, p.y, PLAYER_RADIUS)) Object.assign(p, this.map.data.spawns.default);
    if (p.jailUntil) Object.assign(p, this.map.data.spawns.jailCell);
    session.player = p;
    this.players.set(id, p);
    this.sendSpawn(p);
    this.broadcast({ t: 'pinfo', players: [this.playerInfo(p)] }, p.id);
    chat.system(this, tr('{0} arrived in the city.', p.name));
    return p;
  }

  playerInfo(p: Player) {
    return { id: p.id, name: p.name, appearance: p.appearance, job: p.job, rank: p.jobRank };
  }

  sendSpawn(p: Player) {
    p.session.send({
      t: 'spawn',
      you: { id: p.id, charId: p.charId, name: p.name, citizenId: p.citizenId, appearance: p.appearance, x: p.x, y: p.y, role: p.role },
      roster: [...this.players.values()].map(q => this.playerInfo(q)),
      serverTime: Date.now(),
    });
    this.sendStats(p); this.sendInventory(p);
    this.repo.ownedVehicles(p.charId).then(v => p.session.send({ t: 'garage', vehicles: v.map(r => ({ id: r.id, model: r.model, plate: r.plate, color: r.color, stored: r.stored, fuel: r.fuel, engine: r.engine })) })).catch(() => {});
    if (p.mission) p.session.send({ t: 'mission', mission: p.mission });
  }

  async removePlayer(p: Player, reason = 'disconnect') {
    if (this.players.get(p.id) !== p) return;
    if (p.vehicleId) this.exitVehicle(p, true);
    combat.returnClipsToInventory(this, p).catch(() => {});
    if (p.jobVehicleId) this.vehicles.delete(p.jobVehicleId);
    this.players.delete(p.id);
    await this.savePlayer(p).catch(e => this.log('save error', e));
    this.broadcast({ t: 'pleft', id: p.id });
    chat.system(this, tr('{0} left the city.', p.name));
    this.log(`player ${p.name} removed (${reason})`);
  }

  async savePlayer(p: Player) {
    const now = Date.now();
    await this.repo.saveCharacterState({ id: p.charId, x: p.x, y: p.y, health: p.deadUntil ? 100 : p.health, hunger: p.hunger, thirst: p.thirst, wanted: p.wanted, playtimeAdd: (now - p.lastSavedAt) / 1000 });
    p.lastSavedAt = now;
    if (p.vehicleId) { const v = this.vehicles.get(p.vehicleId); if (v?.dbId) await this.saveVehicle(v); }
  }

  async saveVehicle(v: Vehicle) {
    if (v.dbId) await this.repo.saveVehicle({ dbId: v.dbId, x: v.x, y: v.y, rot: v.rot, fuel: v.fuel, engine: v.engine, locked: v.locked });
  }

  async saveAll() {
    for (const p of this.players.values()) await this.savePlayer(p).catch(e => this.log('save', e));
    for (const v of this.vehicles.values()) if (v.dbId) await this.saveVehicle(v).catch(() => {});
  }

  // ---- messaging -----------------------------------------------------------------------
  broadcast(msg: object, exceptId?: string) {
    for (const p of this.players.values()) if (p.id !== exceptId) p.session.send(msg);
  }
  broadcastNear(x: number, y: number, radius: number, msg: object) {
    for (const p of this.players.values()) if (dist(p.x, p.y, x, y) <= radius) p.session.send(msg);
  }
  toast(p: Player, msg: Text, kind: 'info' | 'good' | 'bad' = 'info') { p.session.send({ t: 'toast', ...wire(msg), kind }); }

  sendStats(p: Player) {
    const w = WEAPONS[p.weapon];
    p.session.send({
      t: 'stats', hp: Math.round(p.health), st: Math.round(p.stamina), hu: Math.round(p.hunger), th: Math.round(p.thirst),
      cash: p.cash, bank: p.bank, wanted: p.wanted, job: p.job, rank: p.jobRank, xp: p.jobXp, licenses: p.licenses,
      weapon: p.weapon, clip: p.clips[p.weapon] ?? 0, reserve: w?.ammo ? (p.inventory[w.ammo] ?? 0) : 0,
      dead: p.deadUntil > 0, respawnAt: p.deadUntil, jailUntil: p.jailUntil, cuffed: !!p.cuffedBy, vehicle: p.vehicleId,
    });
    p.dirtyStats = false;
  }
  sendInventory(p: Player) {
    p.session.send({ t: 'inv', items: p.inventory, weight: inventoryWeight(p.inventory), max: MAX_CARRY_WEIGHT });
  }
  /** Apply the result of a committed Repo.mutate to the in-memory cache and notify the client. */
  applyMoney(p: Player, r: { cash: number; bank: number; inventory: Inventory; licenses?: string[] }) {
    p.cash = r.cash; p.bank = r.bank; p.inventory = r.inventory;
    if (r.licenses) p.licenses = r.licenses;
    this.sendStats(p); this.sendInventory(p);
  }

  /** Runs an economy operation exclusively for this player; converts GameErrors into toasts. */
  async exclusive(p: Player, fn: () => Promise<void>) {
    if (p.busy) { this.toast(p, 'Please wait…', 'bad'); return; }
    p.busy = true;
    try { await fn(); }
    catch (e) {
      if (e instanceof GameError) this.toast(p, e.text, 'bad');
      else { this.log('error', e); this.toast(p, 'Server error', 'bad'); }
    } finally { p.busy = false; }
  }

  // ---- message routing ------------------------------------------------------------------
  async handle(p: Player, m: any) {
    switch (m.t) {
      case 'move': return this.onMove(p, m);
      case 'drive': return this.onDrive(p, m);
      case 'crash': return this.onCrash(p, m);
      case 'veh_enter': return this.onEnterVehicle(p, m);
      case 'veh_exit': return this.exitVehicle(p);
      case 'veh_lock': return this.onLock(p, m);
      case 'horn': return this.onHorn(p);
      case 'siren': return this.onSiren(p, m);
      case 'fire': return combat.onFire(this, p, m);
      case 'reload': return combat.onReload(this, p);
      case 'equip': return combat.onEquip(this, p, m);
      case 'respawn': return combat.onRespawn(this, p);
      case 'chat': return chat.onChat(this, p, m);
      case 'interact': return economy.onInteract(this, p, m);
      case 'buy': return economy.onBuy(this, p, m);
      case 'sell': return economy.onSell(this, p, m);
      case 'bank': return economy.onBank(this, p, m);
      case 'buy_license': return economy.onBuyLicense(this, p, m);
      case 'buy_vehicle': return economy.onBuyVehicle(this, p, m);
      case 'garage': return economy.onGarage(this, p, m);
      case 'refuel': return economy.onRefuel(this, p);
      case 'repair': return economy.onRepair(this, p);
      case 'use': return economy.onUse(this, p, m);
      case 'drop': return economy.onDrop(this, p, m);
      case 'give': return economy.onGive(this, p, m);
      case 'history': return economy.onHistory(this, p);
      case 'clothing': return economy.onClothing(this, p, m);
      case 'heal': return economy.onHeal(this, p);
      case 'calls': return jobs.onCalls(this, p);
      case 'job_join': return jobs.onJoin(this, p, m);
      case 'job_quit': return jobs.onQuit(this, p);
      case 'job_vehicle': return jobs.onJobVehicle(this, p);
      case 'mission': return jobs.onMission(this, p, m);
      case 'police': return jobs.onPolice(this, p, m);
      case 'medic': return jobs.onMedic(this, p, m);
      case 'crime': return jobs.onCrime(this, p, m);
      case 'admin': return admin.onAdmin(this, p, m);
      default: p.session.send({ t: 'error', msg: `Unknown message ${String(m.t).slice(0, 20)}` });
    }
  }

  // ---- movement ------------------------------------------------------------------------
  canAct(p: Player) { return !p.deadUntil && !p.cuffedBy; }

  correct(p: Player) { p.session.send({ t: 'correct', x: p.x, y: p.y }); }

  onMove(p: Player, m: any) {
    const now = Date.now();
    if (p.vehicleId) return;
    const x = Number(m.x), y = Number(m.y), rot = Number(m.rot);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(rot)) return;
    if (p.deadUntil || p.cuffedBy) { p.lastMoveAt = now; if (Math.hypot(x - p.x, y - p.y) > 4) this.correct(p); return; }
    const dt = Math.min(1, Math.max(0.016, (now - p.lastMoveAt) / 1000));
    const d = Math.hypot(x - p.x, y - p.y);
    const maxSpeed = p.stamina > 1 ? RUN_SPEED : WALK_SPEED;
    const allowed = maxSpeed * (dt + 0.2) + 6;
    if (d > allowed || this.map.circleBlocked(x, y, PLAYER_RADIUS - 2) || (p.jailUntil && dist(x, y, this.map.data.spawns.jailCell.x, this.map.data.spawns.jailCell.y) > 70)) {
      p.violations++;
      p.lastMoveAt = now;
      this.correct(p);
      return;
    }
    const speed = d / dt;
    if (speed > WALK_SPEED + 15) p.stamina = Math.max(0, p.stamina - 14 * dt);
    p.x = x; p.y = y; p.rot = rot; p.lastMoveAt = now;
    p.anim = VALID_ANIMS.has(m.anim) ? m.anim : 'idle';
    economy.autoPickup(this, p);
    jobs.checkMissionArrival(this, p);
  }

  // ---- vehicles --------------------------------------------------------------------------
  addVehicle(o: { kind: Vehicle['kind']; model: string; x: number; y: number; rot: number; locked?: boolean; color?: string; home?: Vehicle['home']; plate?: string }): Vehicle {
    const def = VEHICLES[o.model];
    const palette = ['#c0392b', '#2c3e50', '#ecf0f1', '#16a085', '#8e44ad', '#d35400', '#2980b9', '#7f8c8d', '#1c1c1c', '#b7950b'];
    const color = o.color ?? (def.kind === 'taxi' ? '#f1c40f' : def.kind === 'police' ? '#1b2a4a' : def.kind === 'ambulance' ? '#f4f6f7' : palette[Math.floor(Math.random() * palette.length)]);
    const v: Vehicle = {
      id: this.nextId('v'), dbId: null, kind: o.kind, model: o.model, plate: o.plate ?? `UT ${Math.floor(1000 + Math.random() * 9000)}`, color,
      ownerCharId: null, jobOwner: null, x: o.x, y: o.y, rot: o.rot, speed: 0, lastUpdateAt: Date.now(), driver: null,
      locked: o.locked ?? false, fuel: def.fuelCapacity * (0.4 + Math.random() * 0.6), engine: 100, siren: false, wreckedAt: 0, home: o.home ?? null,
    };
    this.vehicles.set(v.id, v);
    return v;
  }

  addOwnedVehicle(row: any): Vehicle {
    const v = this.addVehicle({ kind: 'owned', model: row.model, x: row.x, y: row.y, rot: row.rot, locked: row.locked, color: row.color, plate: row.plate });
    v.dbId = row.id; v.ownerCharId = row.owner_id; v.fuel = Math.min(row.fuel, VEHICLES[row.model].fuelCapacity); v.engine = row.engine;
    return v;
  }

  hasKey(p: Player, v: Vehicle) {
    return (v.ownerCharId !== null && v.ownerCharId === p.charId) || v.jobOwner === p.id;
  }

  onEnterVehicle(p: Player, m: any) {
    if (!this.canAct(p) || p.vehicleId || p.jailUntil) return;
    const v = this.vehicles.get(String(m.id));
    if (!v) return;
    const def = VEHICLES[v.model];
    if (dist(p.x, p.y, v.x, v.y) > def.length / 2 + 40) return this.toast(p, 'Too far from the vehicle', 'bad');
    if (v.engine <= 0) return this.toast(p, 'This vehicle is wrecked', 'bad');
    if (def.job && v.kind === 'job' && v.jobOwner !== p.id) return this.toast(p, tr('Only {0}s can drive this', JOBS[def.job].name), 'bad');
    if (v.driver && v.kind !== 'traffic') return this.toast(p, 'Someone is driving', 'bad');
    if (v.locked && !this.hasKey(p, v)) {
      if ((p.inventory.lockpick ?? 0) > 0 && v.kind !== 'owned') {
        // Lockpicking public cars: consumes a pick, 60% success, always a crime.
        jobs.commitCrime(this, p, 1, 'Grand theft auto');
        this.exclusive(p, async () => {
          const r = await this.repo.mutate(p.charId, { items: { lockpick: -1 } }, 'items');
          this.applyMoney(p, r);
          if (Math.random() < 0.6) { v.locked = false; this.toast(p, 'Lock picked!', 'good'); this.broadcastNear(v.x, v.y, 600, { t: 'sfx', k: 'unlock', x: v.x, y: v.y }); }
          else this.toast(p, 'The lockpick snapped', 'bad');
        });
        return;
      }
      this.broadcastNear(v.x, v.y, 500, { t: 'sfx', k: 'locked', x: v.x, y: v.y });
      return this.toast(p, 'Vehicle is locked', 'bad');
    }
    if (v.kind === 'traffic') {
      // Carjacking: driver bails out and flees.
      npcs.ejectTrafficDriver(this, v);
      jobs.commitCrime(this, p, 1, 'Carjacking');
    } else if (v.kind === 'public' && !this.hasKey(p, v)) {
      jobs.commitCrime(this, p, 1, 'Vehicle theft');
    }
    v.driver = p.id; v.lastUpdateAt = Date.now(); v.speed = 0;
    p.vehicleId = v.id; p.anim = 'drive';
    this.broadcastNear(v.x, v.y, 700, { t: 'sfx', k: 'door', x: v.x, y: v.y });
    p.session.send({ t: 'entered', vehicle: this.vehicleView(v), fuel: v.fuel, engine: v.engine });
    this.sendStats(p);
  }

  exitVehicle(p: Player, force = false) {
    const v = p.vehicleId ? this.vehicles.get(p.vehicleId) : null;
    p.vehicleId = null; p.anim = 'idle';
    if (!v) return;
    v.driver = null; v.speed = 0; v.siren = false;
    // Place the player beside the driver door (left side), falling back to other sides.
    const def = VEHICLES[v.model];
    const side = def.width / 2 + 16;
    const cands = [Math.PI / 2, -Math.PI / 2, 0, Math.PI].map(a => ({ x: v.x + Math.cos(v.rot + a) * (a === 0 || a === Math.PI ? def.length / 2 + 14 : side), y: v.y + Math.sin(v.rot + a) * (a === 0 || a === Math.PI ? def.length / 2 + 14 : side) }));
    const spot = cands.find(c => !this.map.circleBlocked(c.x, c.y, PLAYER_RADIUS)) ?? { x: v.x, y: v.y };
    p.x = spot.x; p.y = spot.y; p.lastMoveAt = Date.now();
    if (!force) {
      p.session.send({ t: 'exited', x: p.x, y: p.y });
      this.broadcastNear(v.x, v.y, 700, { t: 'sfx', k: 'door', x: v.x, y: v.y });
      this.sendStats(p);
    }
    if (v.dbId) this.saveVehicle(v).catch(() => {});
  }

  onLock(p: Player, m: any) {
    const v = this.vehicles.get(String(m.id));
    if (!v || !this.hasKey(p, v)) return this.toast(p, "You don't have the keys", 'bad');
    if (dist(p.x, p.y, v.x, v.y) > 260) return this.toast(p, 'Too far away', 'bad');
    v.locked = !v.locked;
    this.broadcastNear(v.x, v.y, 600, { t: 'sfx', k: v.locked ? 'lock' : 'unlock', x: v.x, y: v.y });
    this.toast(p, v.locked ? 'Vehicle locked' : 'Vehicle unlocked', 'good');
    if (v.dbId) this.saveVehicle(v).catch(() => {});
  }

  onHorn(p: Player) {
    const v = p.vehicleId ? this.vehicles.get(p.vehicleId) : null;
    if (v) this.broadcastNear(v.x, v.y, 900, { t: 'sfx', k: VEHICLES[v.model].kind === 'truck' ? 'horn_truck' : 'horn', x: v.x, y: v.y, src: v.id });
  }

  onSiren(p: Player, m: any) {
    const v = p.vehicleId ? this.vehicles.get(p.vehicleId) : null;
    if (v && VEHICLES[v.model].siren) v.siren = !!m.on;
  }

  onDrive(p: Player, m: any) {
    const v = p.vehicleId ? this.vehicles.get(p.vehicleId) : null;
    if (!v || v.driver !== p.id) return;
    const x = Number(m.x), y = Number(m.y), rot = Number(m.rot);
    if (![x, y, rot].every(Number.isFinite)) return;
    const def = VEHICLES[v.model];
    const now = Date.now();
    const dt = Math.min(1, Math.max(0.016, (now - v.lastUpdateAt) / 1000));
    const d = Math.hypot(x - v.x, y - v.y);
    const canMove = v.fuel > 0 && v.engine > 0;
    const allowed = canMove ? def.maxSpeed * 1.15 * (dt + 0.2) + 8 : 6;
    if (d > allowed || this.map.circleBlocked(x, y, Math.min(def.width, def.length) / 2 - 4)) {
      p.violations++;
      v.lastUpdateAt = now;
      p.session.send({ t: 'vcorrect', id: v.id, x: v.x, y: v.y, rot: v.rot, speed: 0, fuel: v.fuel, engine: v.engine });
      return;
    }
    // Speed over a time window, so bursty packet delivery can't fake accelerations/decelerations.
    const track = (v.track ??= []);
    track.push({ t: now, x, y });
    while (track.length && now - track[0].t > 1200) track.shift();
    const windowSpeed = (from: number, to: number) => {
      const pts = track.filter(s => s.t >= now - from && s.t <= now - to);
      if (pts.length < 2) return null;
      const a = pts[0], b = pts[pts.length - 1];
      return b.t - a.t >= (from - to) * 0.4 ? Math.hypot(b.x - a.x, b.y - a.y) / ((b.t - a.t) / 1000) : null;
    };
    const recent = windowSpeed(350, 0);
    const earlier = windowSpeed(1100, 550);
    const newSpeed = recent ?? v.speed;
    // Safety net for clients that don't report crashes: a sudden stop from speed only counts as a
    // crash when the vehicle is actually touching something (braking on an open road never does).
    if (earlier !== null && recent !== null && earlier > 220 && recent < earlier * 0.3 && now - (v.lastCrashAt ?? 0) > 1500) {
      const r = def.width / 2 + 14;
      const touching = this.map.circleBlocked(x, y, r) || this.map.circleBlocked(x + Math.cos(rot) * def.length / 2, y + Math.sin(rot) * def.length / 2, r)
        || [...this.vehicles.values()].some(o => o !== v && Math.hypot(o.x - x, o.y - y) < (def.length + VEHICLES[o.model].length) / 2 + 6);
      if (touching) this.applyCrash(v, p, earlier - recent);
    }
    // Pedestrians / players run over.
    if (newSpeed > 110) {
      const hitR = def.width / 2 + 10;
      for (const n of this.npcs.values()) {
        if (n.state === 'dead') continue;
        if (pointSegDist(n.x, n.y, v.x, v.y, x, y).d < hitR) combat.damageNpc(this, n, newSpeed / 10, p, x, y);
      }
      for (const q of this.players.values()) {
        if (q === p || q.vehicleId || q.deadUntil) continue;
        if (pointSegDist(q.x, q.y, v.x, v.y, x, y).d < hitR) combat.damagePlayer(this, q, newSpeed / 12, p, 'vehicle');
      }
    }
    // Fuel: liters per 1000 world units travelled, more when accelerating hard.
    v.fuel = Math.max(0, v.fuel - (d / 1000) * def.fuelPerKm * (v.engine < 30 ? 1.5 : 1));
    v.x = x; v.y = y; v.rot = rot; v.speed = newSpeed; v.lastUpdateAt = now;
    p.x = x; p.y = y;
    if (this.tick % 10 === 0) p.session.send({ t: 'vstat', id: v.id, fuel: Math.round(v.fuel * 10) / 10, engine: Math.round(v.engine) });
    jobs.checkMissionArrival(this, p);
  }

  /** Applies collision damage for a hit of the given speed loss (world units/s). */
  applyCrash(v: Vehicle, p: Player, impact: number) {
    const def = VEHICLES[v.model];
    v.lastCrashAt = Date.now();
    const dmg = Math.min(35, impact / 18);
    v.engine = Math.max(0, v.engine - dmg);
    this.broadcastNear(v.x, v.y, 900, { t: 'sfx', k: 'crash', x: v.x, y: v.y, v: Math.min(1, impact / def.maxSpeed) });
    p.session.send({ t: 'vstat', id: v.id, fuel: Math.round(v.fuel * 10) / 10, engine: Math.round(v.engine) });
    if (v.engine <= 0) this.wreck(v, p);
  }

  /** Client physics reports an impact. Capped to what the model can physically do, rate-limited. */
  onCrash(p: Player, m: any) {
    const v = p.vehicleId ? this.vehicles.get(p.vehicleId) : null;
    if (!v || v.driver !== p.id || v.engine <= 0) return;
    const impact = Number(m.impact);
    if (!Number.isFinite(impact) || impact < 80) return;
    if (Date.now() - (v.lastCrashAt ?? 0) < 400) return;
    this.applyCrash(v, p, Math.min(impact, VEHICLES[v.model].maxSpeed * 1.3));
  }

  wreck(v: Vehicle, by: Player | null) {
    v.engine = 0; v.wreckedAt = Date.now(); v.speed = 0;
    this.broadcastNear(v.x, v.y, 1500, { t: 'sfx', k: 'explosion', x: v.x, y: v.y });
    for (const q of this.players.values()) {
      if (q.vehicleId === v.id) { this.exitVehicle(q); combat.damagePlayer(this, q, 35, by, 'explosion'); }
      else if (!q.deadUntil && dist(q.x, q.y, v.x, v.y) < 90) combat.damagePlayer(this, q, 30, by, 'explosion');
    }
  }

  vehicleView(v: Vehicle) {
    return { id: v.id, m: v.model, x: Math.round(v.x), y: Math.round(v.y), r: +v.rot.toFixed(3), s: Math.round(v.speed), d: v.driver, c: v.color, l: v.locked, hp: Math.round(v.engine), sir: v.siren, pl: v.plate, o: v.ownerCharId, k: v.kind };
  }

  // ---- simulation -----------------------------------------------------------------------
  update(dt: number) {
    this.tick++;
    const now = this.now;
    for (const p of this.players.values()) {
      // Survival stats
      const hu = p.hunger, th = p.thirst, hp = p.health;
      p.hunger = Math.max(0, p.hunger - dt * (100 / 3600));
      p.thirst = Math.max(0, p.thirst - dt * (100 / 2700));
      if (!p.deadUntil) {
        if (p.hunger <= 0 || p.thirst <= 0) combat.damagePlayer(this, p, dt * 0.5, null, 'starvation');
        else if (p.hunger > 50 && p.thirst > 50 && now - p.lastDamageAt > 10_000 && p.health < 100) p.health = Math.min(100, p.health + dt * 0.4);
        if (!p.vehicleId && now - p.lastMoveAt > 400) p.anim = p.anim === 'sit' ? 'sit' : 'idle';
        p.stamina = Math.min(100, p.stamina + dt * (p.anim === 'run' ? 0 : 10));
      }
      if (p.vehicleId) {
        const v = this.vehicles.get(p.vehicleId);
        if (v && now - v.lastUpdateAt > 500) v.speed = 0;
      }
      // Jail release
      if (p.jailUntil && now >= p.jailUntil) {
        p.jailUntil = 0; Object.assign(p, this.map.data.spawns.jail);
        this.repo.setJail(p.charId, null).catch(() => {});
        p.session.send({ t: 'correct', x: p.x, y: p.y });
        this.toast(p, 'You have been released from jail', 'good');
        p.dirtyStats = true;
      }
      // Wanted decay: one star per 90s without crime, unless cuffed.
      if (p.wanted > 0 && !p.cuffedBy && now - p.lastCrimeAt > 90_000) { p.wanted--; p.lastCrimeAt = now; p.dirtyStats = true; }
      if (Math.floor(hu) !== Math.floor(p.hunger) || Math.floor(th) !== Math.floor(p.thirst) || Math.floor(hp) !== Math.floor(p.health)) p.dirtyStats = true;
      if (p.dirtyStats && this.tick % 4 === 0) this.sendStats(p);
    }
    // Wrecked public vehicles respawn at their home spot after a minute.
    for (const v of this.vehicles.values()) {
      if (v.wreckedAt && !v.driver && now - v.wreckedAt > 60_000) {
        if (v.kind === 'public' && v.home) { Object.assign(v, v.home); v.engine = 100; v.wreckedAt = 0; v.fuel = VEHICLES[v.model].fuelCapacity * 0.6; }
        else if (v.kind === 'traffic') { this.vehicles.delete(v.id); npcs.spawnTraffic(this, 1); }
      }
    }
    for (const [id, it] of this.pickups) if (now > it.expiresAt) this.pickups.delete(id);
    npcs.update(this, dt);
    jobs.update(this);
    if (now - this.lastSalaryAt >= ECONOMY.salaryIntervalMs) { this.lastSalaryAt = now; economy.paySalaries(this).catch(e => this.log('salary', e)); }
  }

  broadcastSnapshots() {
    const R = config.interestRadius;
    const players = [...this.players.values()];
    const vehicles = [...this.vehicles.values()];
    const npcList = [...this.npcs.values()];
    const pick = [...this.pickups.values()];
    const now = Date.now();
    for (const viewer of players) {
      const near = (x: number, y: number) => Math.abs(x - viewer.x) < R && Math.abs(y - viewer.y) < R;
      viewer.session.send({
        t: 'snap', tick: this.tick, time: now,
        p: players.filter(q => !q.vehicleId && near(q.x, q.y)).map(q => ({ id: q.id, x: Math.round(q.x), y: Math.round(q.y), r: +q.rot.toFixed(3), a: q.deadUntil ? 'dead' : q.anim, w: q.weapon, hp: Math.round(q.health), wl: q.wanted, cf: !!q.cuffedBy, rl: q.reloadUntil > now })),
        v: vehicles.filter(v => near(v.x, v.y)).map(v => this.vehicleView(v)),
        n: npcList.filter(n => n.state !== 'idle' && near(n.x, n.y)).map(n => ({ id: n.id, s: n.seed, x: Math.round(n.x), y: Math.round(n.y), r: +n.rot.toFixed(3), st: n.state })),
        i: pick.filter(i => near(i.x, i.y)).map(i => ({ id: i.id, x: Math.round(i.x), y: Math.round(i.y), it: i.item, q: i.qty })),
      });
    }
  }
}
