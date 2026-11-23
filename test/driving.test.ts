import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, TestClient, sleep } from './helpers.ts';
import type { RunningServer } from '../src/net/server.ts';

let srv: RunningServer;
let c: TestClient;

before(async () => {
  srv = await startTestServer();
  c = await TestClient.connect(srv.port);
  await c.registerAndSpawn('driver', 'Dana Driver');
});
after(async () => { c?.close(); await sleep(100); await srv.close(); });

const player = () => srv.world.players.get(c.playerId!)!;

/** Enter a fresh sedan parked on the open avenue at x=2240 (north-south road). */
async function enterCar(y: number) {
  const v = srv.world.addVehicle({ kind: 'public', model: 'sedan', x: 2272, y, rot: Math.PI / 2, locked: false });
  const p = player(); p.x = v.x + 30; p.y = v.y; p.lastMoveAt = Date.now(); p.wanted = 0;
  await c.request({ t: 'veh_enter', id: v.id }, m => m.t === 'entered');
  return v;
}

test('steady driving with network jitter causes no damage', async () => {
  const v = await enterCar(1100);
  // Drive north at a constant 300 u/s. The client samples every 66 ms (15 Hz) but Wi-Fi delivery
  // is bursty: each packet is delayed 0–150 ms (order preserved), so several often arrive at once.
  let rnd = 42;
  const random = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let deliverAt = 0;
  const sends: Promise<void>[] = [];
  for (let i = 1; i <= 40; i++) {
    const sampleT = i * 66;
    deliverAt = Math.max(deliverAt, sampleT + random() * 150);
    const y = 1100 + (sampleT / 1000) * 300;
    sends.push(sleep(deliverAt).then(() => c.send({ t: 'drive', x: 2272, y, rot: Math.PI / 2 })));
  }
  await Promise.all(sends);
  await sleep(50);
  assert.equal(Math.round(v.engine), 100, `engine dropped to ${v.engine} from jitter alone`);
  await c.request({ t: 'veh_exit' }, m => m.t === 'exited');
});

test('reported crash damages the engine; a real stop from speed is detected', async () => {
  const v = await enterCar(1100);
  // Client physics reports an impact (e.g. hitting a wall at ~300 u/s).
  c.send({ t: 'crash', impact: 300 });
  await sleep(60);
  assert.ok(v.engine < 100 && v.engine > 70, `expected moderate damage, engine=${v.engine}`);
  // Impacts are capped and rate-limited: spam can't be used to grief, absurd values are clamped.
  const e = v.engine;
  for (let i = 0; i < 10; i++) c.send({ t: 'crash', impact: 99999 });
  await sleep(60);
  assert.ok(e - v.engine <= 35, `one capped hit at most, lost ${e - v.engine}`);
  await c.request({ t: 'veh_exit' }, m => m.t === 'exited');
});

/** Drives along x at `speed` for `ms`, then holds position for `holdMs`, at a steady 15 Hz. */
async function driveThenStop(x0: number, y: number, x1: number, holdMs: number) {
  const steps = 10;
  for (let i = 1; i <= steps; i++) { await sleep(66); c.send({ t: 'drive', x: x0 + ((x1 - x0) * i) / steps, y, rot: 0 }); }
  for (let t = 0; t < holdMs; t += 66) { await sleep(66); c.send({ t: 'drive', x: x1, y, rot: 0 }); }
  await sleep(50);
}

test('server safety net: an unreported crash into a wall still damages the car', async () => {
  const b = srv.world.map.data.buildings.find(b => b.type === 'police')!;
  const y = b.rect.y + b.rect.h / 2;
  const v = srv.world.addVehicle({ kind: 'public', model: 'sedan', x: b.rect.x - 220, y, rot: 0, locked: false });
  const p = player(); p.x = v.x; p.y = v.y + 30; p.lastMoveAt = Date.now();
  await c.request({ t: 'veh_enter', id: v.id }, m => m.t === 'entered');
  await driveThenStop(v.x, y, b.rect.x - 18, 700);   // ~300 u/s straight into the wall, no crash report
  assert.ok(v.engine < 100, 'wall impact should damage the engine');
  await c.request({ t: 'veh_exit' }, m => m.t === 'exited');
});

test('hard braking on an open road is not a crash', async () => {
  const v = srv.world.addVehicle({ kind: 'public', model: 'sedan', x: 1650, y: 2240, rot: 0, locked: false });
  const p = player(); p.x = v.x; p.y = v.y + 30; p.lastMoveAt = Date.now();
  await c.request({ t: 'veh_enter', id: v.id }, m => m.t === 'entered');
  assert.equal(srv.world.map.circleBlocked(2000, 2240, 30), false, 'test road must be open');
  await driveThenStop(1650, 2240, 1850, 700);
  assert.equal(Math.round(v.engine), 100);
  await c.request({ t: 'veh_exit' }, m => m.t === 'exited');
});
