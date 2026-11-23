import type { GameWorld } from './world.ts';
import type { Player, Npc } from './types.ts';
import { WEAPONS, VEHICLES, ECONOMY } from './content.ts';
import { pointSegDist, dist } from '../world/map.ts';
import * as jobs from './jobs.ts';
import * as npcs from './npc.ts';
import { tr } from './i18n.ts';

const HIT_RADIUS = 13;

/** Weapons the player may equip: fists plus any weapon item in inventory. */
export function ownsWeapon(p: Player, weapon: string) {
  return weapon === 'fists' || (p.inventory[weapon] ?? 0) > 0;
}

export function onEquip(w: GameWorld, p: Player, m: any) {
  const id = String(m.weapon);
  if (!WEAPONS[id] || !ownsWeapon(p, id)) return;
  p.weapon = id; p.reloadUntil = 0;
  w.sendStats(p);
  w.broadcastNear(p.x, p.y, 500, { t: 'sfx', k: 'equip', x: p.x, y: p.y });
}

export function onReload(w: GameWorld, p: Player) {
  const def = WEAPONS[p.weapon];
  if (!def?.ammo || !w.canAct(p) || p.reloadUntil > Date.now()) return;
  const clip = p.clips[def.id] ?? 0;
  const need = def.magazine - clip;
  const have = p.inventory[def.ammo] ?? 0;
  const take = Math.min(need, have);
  if (take <= 0) { if (have === 0) w.toast(p, 'No ammunition', 'bad'); return; }
  p.reloadUntil = Date.now() + def.reloadMs;
  w.broadcastNear(p.x, p.y, 700, { t: 'reload', id: p.id, w: def.id, ms: def.reloadMs, x: p.x, y: p.y });
  // Ammo moves from inventory into the magazine atomically on the server.
  w.exclusive(p, async () => {
    const r = await w.repo.mutate(p.charId, { items: { [def.ammo!]: -take } }, 'items');
    p.clips[def.id] = (p.clips[def.id] ?? 0) + take;
    w.applyMoney(p, r);
  });
}

/** On disconnect, rounds still in magazines go back to the inventory. */
export async function returnClipsToInventory(w: GameWorld, p: Player) {
  const items: Record<string, number> = {};
  for (const [wid, n] of Object.entries(p.clips)) {
    const ammo = WEAPONS[wid]?.ammo;
    if (ammo && n > 0) items[ammo] = (items[ammo] ?? 0) + n;
  }
  p.clips = {};
  if (Object.keys(items).length) await w.repo.mutate(p.charId, { items }, 'items').catch(() => {});
}

export function onFire(w: GameWorld, p: Player, m: any) {
  const now = Date.now();
  const def = WEAPONS[p.weapon];
  const angle = Number(m.a);
  if (!def || !Number.isFinite(angle) || !w.canAct(p) || p.jailUntil || p.vehicleId) return;
  if (now - p.lastFireAt < def.fireIntervalMs * 0.9 || now < p.reloadUntil) return;
  if (now < p.invulnerableUntil) p.invulnerableUntil = 0;
  if (def.ammo) {
    if ((p.clips[def.id] ?? 0) <= 0) { w.broadcastNear(p.x, p.y, 400, { t: 'sfx', k: 'dryfire', x: p.x, y: p.y }); return; }
    p.clips[def.id]--;
  }
  p.lastFireAt = now;
  p.rot = angle;
  const ox = p.x + Math.cos(angle) * 14, oy = p.y + Math.sin(angle) * 14;

  if (def.kind === 'melee') {
    const target = meleeTarget(w, p, angle, def.range);
    w.broadcastNear(p.x, p.y, 800, { t: 'shot', s: p.id, w: def.id, x: ox, y: oy, a: angle, e: [] });
    if (target?.kind === 'player') damagePlayer(w, target.p, def.damage, p, def.id);
    else if (target?.kind === 'npc') damageNpc(w, target.n, def.damage, p, ox, oy);
    return;
  }

  const ends: { x: number; y: number; h: number }[] = [];
  for (let i = 0; i < def.pellets; i++) {
    const a = angle + (Math.random() - 0.5) * 2 * def.spreadRad;
    const ex = ox + Math.cos(a) * def.range, ey = oy + Math.sin(a) * def.range;
    let best = w.map.raycast(ox, oy, ex, ey) ?? def.range;
    let hit: { kind: 'player'; p: Player } | { kind: 'npc'; n: Npc } | { kind: 'veh'; id: string } | null = null;
    for (const q of w.players.values()) {
      if (q === p || q.deadUntil || q.vehicleId) continue;
      const r = pointSegDist(q.x, q.y, ox, oy, ex, ey);
      if (r.d < HIT_RADIUS && r.t * def.range < best) { best = r.t * def.range; hit = { kind: 'player', p: q }; }
    }
    for (const n of w.npcs.values()) {
      if (n.state === 'dead' || n.state === 'idle') continue;
      const r = pointSegDist(n.x, n.y, ox, oy, ex, ey);
      if (r.d < HIT_RADIUS && r.t * def.range < best) { best = r.t * def.range; hit = { kind: 'npc', n }; }
    }
    for (const v of w.vehicles.values()) {
      const vr = Math.min(VEHICLES[v.model].length, VEHICLES[v.model].width * 1.6) / 2;
      const r = pointSegDist(v.x, v.y, ox, oy, ex, ey);
      if (r.d < vr && r.t * def.range < best) { best = Math.max(0, r.t * def.range - vr * 0.5); hit = { kind: 'veh', id: v.id }; }
    }
    ends.push({ x: Math.round(ox + Math.cos(a) * best), y: Math.round(oy + Math.sin(a) * best), h: hit ? (hit.kind === 'veh' ? 2 : 1) : 0 });
    // Damage falls off linearly to 50% at max range.
    const dmg = def.damage * (1 - 0.5 * (best / def.range));
    if (hit?.kind === 'player') damagePlayer(w, hit.p, dmg, p, def.id);
    else if (hit?.kind === 'npc') damageNpc(w, hit.n, dmg, p, ox, oy);
    else if (hit?.kind === 'veh') damageVehicle(w, hit.id, dmg * 0.5, p);
  }
  w.broadcastNear(p.x, p.y, 1600, { t: 'shot', s: p.id, w: def.id, x: Math.round(ox), y: Math.round(oy), a: +angle.toFixed(3), e: ends });
  npcs.panic(w, p.x, p.y, 420);
  // Discharging a firearm in public is a crime (police on duty are exempt).
  if (p.job !== 'police') jobs.commitCrime(w, p, 0, 'Discharging a firearm', true);
  if (def.ammo) p.dirtyStats = true;
}

function meleeTarget(w: GameWorld, p: Player, angle: number, range: number) {
  let best: { kind: 'player'; p: Player } | { kind: 'npc'; n: Npc } | null = null, bd = range + HIT_RADIUS;
  const inCone = (x: number, y: number) => {
    const d = dist(p.x, p.y, x, y);
    if (d > bd) return false;
    let da = Math.atan2(y - p.y, x - p.x) - angle;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    return Math.abs(da) < 0.9 ? d : false;
  };
  for (const q of w.players.values()) { if (q === p || q.deadUntil || q.vehicleId) continue; const d = inCone(q.x, q.y); if (d !== false) { bd = d; best = { kind: 'player', p: q }; } }
  for (const n of w.npcs.values()) { if (n.state === 'dead' || n.state === 'idle') continue; const d = inCone(n.x, n.y); if (d !== false) { bd = d; best = { kind: 'npc', n }; } }
  return best;
}

export function damagePlayer(w: GameWorld, q: Player, dmg: number, by: Player | null, cause: string) {
  if (q.deadUntil || dmg <= 0 || Date.now() < q.invulnerableUntil) return;
  if (q.jailUntil && by) return;
  q.health -= dmg; q.lastDamageAt = Date.now(); q.dirtyStats = true;
  if (by && cause !== 'starvation') {
    w.broadcastNear(q.x, q.y, 900, { t: 'hit', id: q.id, d: Math.round(dmg), x: Math.round(q.x), y: Math.round(q.y) });
    // Assault is a crime unless the victim is wanted and the attacker is police.
    if (!(by.job === 'police' && q.wanted > 0)) jobs.commitCrime(w, by, 1, 'Assault');
  }
  if (q.health <= 0) kill(w, q, by, cause);
}

function kill(w: GameWorld, q: Player, by: Player | null, cause: string) {
  q.health = 0;
  q.deadUntil = Date.now() + ECONOMY.respawnMs;
  q.anim = 'dead'; q.cuffedBy = null; q.reloadUntil = 0;
  if (q.vehicleId) w.exitVehicle(q);
  if (q.mission) { q.mission = null; q.session.send({ t: 'mission', mission: null }); }
  w.broadcast({ t: 'died', id: q.id, by: by?.id ?? null, cause, name: q.name, killer: by?.name ?? null });
  if (by && by !== q && !(by.job === 'police' && q.wanted > 0)) jobs.commitCrime(w, by, 3, 'Murder');
  w.sendStats(q);
}

export async function onRespawn(w: GameWorld, p: Player) {
  if (!p.deadUntil || Date.now() < p.deadUntil) return;
  await w.exclusive(p, async () => {
    const fee = ECONOMY.hospitalFee;
    const change = p.cash >= fee ? { cash: -fee } : p.bank >= fee ? { bank: -fee } : {};
    if (Object.keys(change).length) w.applyMoney(p, await w.repo.mutate(p.charId, change, 'hospital_fee', 'Medical treatment'));
    p.deadUntil = 0; p.health = 100; p.anim = 'idle'; p.invulnerableUntil = Date.now() + 5000;
    const s = w.map.data.spawns.hospital;
    p.x = s.x; p.y = s.y; p.lastMoveAt = Date.now();
    p.session.send({ t: 'respawned', x: p.x, y: p.y });
    w.toast(p, Object.keys(change).length ? tr('You were treated at St. Aurora Medical Center (${0})', fee) : 'You were treated at St. Aurora Medical Center', 'info');
    w.sendStats(p);
  });
}

/** Revive used by paramedics: brings a downed player back where they lie. */
export function revive(w: GameWorld, q: Player, hp = 40) {
  q.deadUntil = 0; q.health = hp; q.anim = 'idle'; q.invulnerableUntil = Date.now() + 3000;
  q.session.send({ t: 'respawned', x: q.x, y: q.y });
  w.sendStats(q);
}

export function damageNpc(w: GameWorld, n: Npc, dmg: number, by: Player | null, fx: number, fy: number) {
  if (n.state === 'dead') return;
  n.health -= dmg;
  w.broadcastNear(n.x, n.y, 900, { t: 'hit', id: n.id, d: Math.round(dmg), x: Math.round(n.x), y: Math.round(n.y) });
  if (n.health <= 0) {
    npcs.killNpc(w, n);
    if (by) jobs.commitCrime(w, by, 2, 'Manslaughter');
    const [lo, hi] = ECONOMY.npcCashDrop;
    const id = w.nextId('i');
    w.pickups.set(id, { id, x: n.x, y: n.y, item: 'cash', qty: lo + Math.floor(Math.random() * (hi - lo)), expiresAt: Date.now() + 120_000 });
  } else {
    npcs.fleeFrom(n, fx, fy);
    if (by) jobs.commitCrime(w, by, 1, 'Assault');
  }
}

export function damageVehicle(w: GameWorld, vid: string, dmg: number, by: Player | null) {
  const v = w.vehicles.get(vid);
  if (!v || v.engine <= 0) return;
  v.engine = Math.max(0, v.engine - dmg);
  if (v.engine <= 0) w.wreck(v, by);
}
