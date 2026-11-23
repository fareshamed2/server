import type { GameWorld } from './world.ts';
import type { Npc, Vehicle } from './types.ts';
import { VEHICLES } from './content.ts';

// ---- pedestrians -------------------------------------------------------------------------
const WALK_MIN = 45, WALK_MAX = 68, FLEE_SPEED = 160;

export function spawnPedestrians(w: GameWorld, count: number) {
  for (let i = 0; i < count; i++) spawnPed(w);
}

function spawnPed(w: GameWorld, at?: { x: number; y: number }) {
  const nodes = w.map.data.pedGraph.nodes;
  const from = Math.floor(Math.random() * nodes.length);
  const nb = w.map.pedNeighbors[from];
  const to = nb[Math.floor(Math.random() * nb.length)];
  const t = Math.random();
  const n: Npc = {
    id: w.nextId('n'), seed: Math.floor(Math.random() * 1e9),
    x: at?.x ?? nodes[from].x + (nodes[to].x - nodes[from].x) * t,
    y: at?.y ?? nodes[from].y + (nodes[to].y - nodes[from].y) * t,
    rot: 0, state: 'walk', health: 40, from, to,
    speed: WALK_MIN + Math.random() * (WALK_MAX - WALK_MIN), fleeFrom: null, stateUntil: 0, respawnAt: 0,
  };
  w.npcs.set(n.id, n);
  return n;
}

export function fleeFrom(n: Npc, x: number, y: number, ms = 5000) {
  if (n.state === 'dead') return;
  n.state = 'flee'; n.fleeFrom = { x, y }; n.stateUntil = Date.now() + ms;
}

/** Makes pedestrians within radius run away from (x, y). */
export function panic(w: GameWorld, x: number, y: number, radius: number) {
  for (const n of w.npcs.values()) if (n.state !== 'dead' && Math.hypot(n.x - x, n.y - y) < radius) fleeFrom(n, x, y);
}

export function killNpc(w: GameWorld, n: Npc) {
  n.state = 'dead'; n.health = 0; n.respawnAt = Date.now() + 25_000;
  w.broadcastNear(n.x, n.y, 900, { t: 'sfx', k: 'npc_die', x: n.x, y: n.y });
}

function nearestNode(w: GameWorld, x: number, y: number) {
  let best = 0, bd = Infinity;
  w.map.data.pedGraph.nodes.forEach((nd, i) => { const d = (nd.x - x) ** 2 + (nd.y - y) ** 2; if (d < bd) { bd = d; best = i; } });
  return best;
}

function updatePed(w: GameWorld, n: Npc, dt: number, now: number) {
  const nodes = w.map.data.pedGraph.nodes;
  if (n.state === 'dead') {
    if (now >= n.respawnAt) { w.npcs.delete(n.id); spawnPed(w); }
    return;
  }
  if (n.state === 'flee') {
    if (now >= n.stateUntil) {
      n.state = 'walk';
      const k = nearestNode(w, n.x, n.y);
      n.from = k; n.to = k;
      return;
    }
    let a = Math.atan2(n.y - n.fleeFrom!.y, n.x - n.fleeFrom!.x);
    for (let tries = 0; tries < 6; tries++) {
      const nx = n.x + Math.cos(a) * FLEE_SPEED * dt, ny = n.y + Math.sin(a) * FLEE_SPEED * dt;
      if (!w.map.circleBlocked(nx, ny, 9)) { n.x = nx; n.y = ny; break; }
      a += (tries % 2 ? -1 : 1) * 0.7 * (tries + 1);
    }
    n.rot = a;
    return;
  }
  const target = nodes[n.to];
  const dx = target.x - n.x, dy = target.y - n.y, d = Math.hypot(dx, dy);
  const step = n.speed * dt;
  if (d <= step) {
    n.x = target.x; n.y = target.y;
    const nb = w.map.pedNeighbors[n.to].filter(k => k !== n.from);
    const opts = nb.length ? nb : w.map.pedNeighbors[n.to];
    n.from = n.to; n.to = opts[Math.floor(Math.random() * opts.length)];
  } else {
    n.x += (dx / d) * step; n.y += (dy / d) * step;
    n.rot = Math.atan2(dy, dx);
  }
}

// ---- traffic ------------------------------------------------------------------------------------
// Right-hand traffic on a grid. Direction: 0=E, 1=N, 2=W, 3=S.
const T = 32;
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const HEADING = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
const CRUISE = 190;

/** Perpendicular lane coordinate for a car travelling `dir` on the road whose centre tile is `c`. */
function lane(dir: number, c: number) {
  return [c * T - 32, c * T + 32, c * T + 32, c * T - 32][dir];
}
const along = (v: Vehicle, dir: number) => (dir % 2 === 0 ? v.x : v.y);

type Plan = { at: number; newDir: number; newLane: number };

function planNext(w: GameWorld, v: Vehicle, dir: number): Plan | null {
  const C = w.map.data.roads.centers;
  const sign = dir === 0 || dir === 1 ? 1 : -1;
  const pos = along(v, dir);
  const perp = dir % 2 === 0 ? v.y : v.x;
  // Index of the road we're driving on (closest centre to our lane).
  const ci = C.reduce((b, c, i) => (Math.abs(c * T - perp) < Math.abs(C[b] * T - perp) ? i : b), 0);
  const crossings = C.map((r, i) => ({ r, i })).filter(({ r }) => sign * (r * T - pos) > 40).sort((a, b) => sign * (a.r - b.r));
  const next = crossings[0];
  if (!next) return null;
  const right = (dir + 3) % 4, left = (dir + 1) % 4;
  // A turn into direction d is possible if the cross road extends that way from our road.
  const canGo = (d: number) => {
    const s = d === 0 || d === 1 ? 1 : -1;
    return s > 0 ? ci < C.length - 1 : ci > 0;
  };
  const opts: number[] = [];
  if (crossings.length > 1) opts.push(dir, dir);  // weight straight
  if (canGo(right)) opts.push(right);
  if (canGo(left)) opts.push(left);
  const nd = opts[Math.floor(Math.random() * opts.length)] ?? (dir + 2) % 4;
  if (nd === dir) return { at: next.r * T + sign * 70, newDir: dir, newLane: lane(dir, C[ci]) };
  return { at: lane(nd, next.r), newDir: nd, newLane: lane(nd, next.r) };
}

export function spawnTraffic(w: GameWorld, count: number) {
  const C = w.map.data.roads.centers;
  const models = ['sedan', 'hatch', 'sedan', 'coupe', 'van', 'taxi', 'truck', 'hatch'];
  for (let k = 0; k < count; k++) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const dir = Math.floor(Math.random() * 4);
      const ci = 1 + Math.floor(Math.random() * (C.length - 2));
      const pos = (C[0] + 4 + Math.random() * (C[C.length - 1] - C[0] - 8)) * T;
      const laneC = lane(dir, C[ci]);
      const x = dir % 2 === 0 ? pos : laneC, y = dir % 2 === 0 ? laneC : pos;
      // Don't spawn inside an intersection or near another vehicle or player.
      if (C.some(r => Math.abs(r * T - pos) < 90)) continue;
      if ([...w.vehicles.values()].some(o => Math.hypot(o.x - x, o.y - y) < 120)) continue;
      if ([...w.players.values()].some(p => Math.hypot(p.x - x, p.y - y) < 500)) continue;
      const v = w.addVehicle({ kind: 'traffic', model: models[Math.floor(Math.random() * models.length)], x, y, rot: HEADING[dir], locked: false });
      v.driver = 'npc';
      v.traffic = { dir, laneX: x, laneY: y, stuckFor: 0, nextTurnAt: 0 };
      (v as any).plan = planNext(w, v, dir);
      break;
    }
  }
}

export function ejectTrafficDriver(w: GameWorld, v: Vehicle) {
  v.kind = 'public'; v.driver = null; v.traffic = undefined; v.home = null; (v as any).plan = undefined;
  const side = VEHICLES[v.model].width / 2 + 14;
  const n = spawnPed(w, { x: v.x + Math.cos(v.rot - Math.PI / 2) * side, y: v.y + Math.sin(v.rot - Math.PI / 2) * side });
  fleeFrom(n, v.x, v.y, 6000);
  w.broadcastNear(v.x, v.y, 600, { t: 'sfx', k: 'scream', x: v.x, y: v.y });
}

function blockedAhead(w: GameWorld, v: Vehicle, dir: number, ignoreVehicles: boolean) {
  const [dx, dy] = DIRS[dir];
  const len = VEHICLES[v.model].length / 2;
  const check = (x: number, y: number, r: number) => {
    const rx = x - v.x, ry = y - v.y;
    const fwd = rx * dx + ry * dy, lat = Math.abs(-rx * dy + ry * dx);
    return fwd > 0 && fwd < len + 60 + r && lat < 18 + r;
  };
  for (const p of w.players.values()) if (!p.vehicleId && !p.deadUntil && check(p.x, p.y, 8)) return true;
  for (const n of w.npcs.values()) if (n.state !== 'dead' && check(n.x, n.y, 6)) return true;
  if (!ignoreVehicles) for (const o of w.vehicles.values()) if (o !== v && check(o.x, o.y, VEHICLES[o.model].length / 2 - 6)) return true;
  return false;
}

function updateTraffic(w: GameWorld, v: Vehicle, dt: number) {
  const tr = v.traffic!;
  if (v.engine <= 0) { v.speed = 0; return; }
  const stuck = tr.stuckFor > 4;
  const blocked = blockedAhead(w, v, tr.dir, stuck && tr.stuckFor < 5.5);
  if (tr.stuckFor > 5.5) tr.stuckFor = 0;
  const target = blocked ? 0 : CRUISE;
  v.speed += Math.sign(target - v.speed) * Math.min(Math.abs(target - v.speed), (blocked ? 600 : 160) * dt);
  if (v.speed < 5) tr.stuckFor += dt; else tr.stuckFor = 0;
  const [dx, dy] = DIRS[tr.dir];
  const plan = (v as any).plan as Plan | null;
  const sign = tr.dir === 0 || tr.dir === 1 ? 1 : -1;
  let step = v.speed * dt;
  if (plan) {
    const remaining = sign * (plan.at - along(v, tr.dir));
    if (remaining <= step) {
      // Arrive at the turn point and switch lanes/direction.
      v.x += dx * Math.max(0, remaining); v.y += dy * Math.max(0, remaining);
      if (plan.newDir % 2 === 0) v.y = plan.newLane; else v.x = plan.newLane;
      tr.dir = plan.newDir;
      (v as any).plan = planNext(w, v, tr.dir);
      step = 0;
    }
  } else {
    (v as any).plan = planNext(w, v, tr.dir);
  }
  v.x += dx * step; v.y += dy * step;
  // Smoothly rotate toward heading.
  let da = HEADING[tr.dir] - v.rot;
  da = Math.atan2(Math.sin(da), Math.cos(da));
  v.rot += da * Math.min(1, dt * 8);
  // Keep in world bounds; despawn if something went wrong.
  if (!w.map.inBounds(v.x, v.y, 0)) { w.vehicles.delete(v.id); spawnTraffic(w, 1); }
}

export function update(w: GameWorld, dt: number) {
  const now = Date.now();
  for (const n of w.npcs.values()) updatePed(w, n, dt, now);
  for (const v of w.vehicles.values()) if (v.kind === 'traffic' && v.traffic) updateTraffic(w, v, dt);
}
