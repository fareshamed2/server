import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, TestClient, sleep } from './helpers.ts';
import type { RunningServer } from '../src/net/server.ts';

let srv: RunningServer;
let a: TestClient, b: TestClient;

before(async () => {
  srv = await startTestServer();
  a = await TestClient.connect(srv.port);
  b = await TestClient.connect(srv.port);
  await a.registerAndSpawn('alice', 'Alice Walker');
  await b.registerAndSpawn('bob', 'Bob Stone');
});
after(async () => { a?.close(); b?.close(); await sleep(100); await srv.close(); });

const player = (c: TestClient) => srv.world.players.get(c.playerId!)!;
const place = (c: TestClient, x: number, y: number) => { const p = player(c); p.x = x; p.y = y; p.lastMoveAt = Date.now(); };
const building = (type: string) => srv.world.map.data.buildings.find(b => b.type === type)!;

test('auth: rejects bad credentials and duplicate usernames', async () => {
  const c = await TestClient.connect(srv.port);
  const e1 = await c.request({ t: 'login', username: 'alice', password: 'wrong-password' }, m => m.t === 'error');
  assert.match(e1.msg, /Invalid username or password/);
  const e2 = await c.request({ t: 'register', username: 'alice', password: 'whatever-123' }, m => m.t === 'error');
  assert.match(e2.msg, /taken/);
  const e3 = await c.request({ t: 'char_select', id: 1 }, m => m.t === 'error');
  assert.match(e3.msg, /Not logged in/);
  c.close();
});

test('auth: cannot select another account\'s character', async () => {
  const c = await TestClient.connect(srv.port);
  await c.request({ t: 'register', username: 'mallory', password: 'mallory-pass-1' }, m => m.t === 'chars');
  const aliceChar = player(a).charId;
  const e = await c.request({ t: 'char_select', id: aliceChar }, m => m.t === 'error');
  assert.match(e.msg, /not found/);
  c.close();
});

test('multiplayer: both clients see each other in snapshots', async () => {
  place(a, 2000, 1400); place(b, 2050, 1400);
  const snapA = await a.waitFor(m => m.t === 'snap' && m.p.some((p: any) => p.id === b.playerId), 3000, a.mark());
  const snapB = await b.waitFor(m => m.t === 'snap' && m.p.some((p: any) => p.id === a.playerId), 3000, b.mark());
  assert.ok(snapA && snapB);
});

test('movement: valid moves are accepted and broadcast, teleports are corrected', async () => {
  // x=2240 is the centre line of a north-south avenue (open road).
  place(a, 2240, 1400); place(b, 2260, 1400);
  a.send({ t: 'move', x: 2244, y: 1400, rot: 0, anim: 'walk' });
  await b.waitFor(m => m.t === 'snap' && m.p.some((p: any) => p.id === a.playerId && p.x === 2244), 3000, b.mark());
  await sleep(50);
  const c = await a.request({ t: 'move', x: 2240, y: 4000, rot: 0, anim: 'run' }, m => m.t === 'correct');
  assert.equal(Math.round(c.x), 2244);
  // Walking into a building is rejected too.
  const bank = building('bank');
  place(a, bank.rect.x - 20, bank.rect.y + bank.rect.h / 2);
  await sleep(60);
  await a.request({ t: 'move', x: bank.rect.x + 10, y: bank.rect.y + bank.rect.h / 2, rot: 0, anim: 'walk' }, m => m.t === 'correct');
});

test('economy: bank deposit/withdraw is server-validated and ledgered', async () => {
  const bank = building('bank');
  place(a, bank.door.x, bank.door.y);
  const before = { cash: player(a).cash, bank: player(a).bank };
  await a.request({ t: 'bank', op: 'deposit', amount: 200 }, m => m.t === 'stats' && m.cash === before.cash - 200);
  assert.equal(player(a).bank, before.bank + 200);
  const err = await a.request({ t: 'bank', op: 'withdraw', amount: 99_999 }, m => m.t === 'toast' && m.kind === 'bad');
  assert.match(err.msg, /Insufficient/);
  // Away from the bank the operation is refused.
  place(a, 2000, 1400);
  const far = await a.request({ t: 'bank', op: 'deposit', amount: 1 }, m => m.t === 'toast' && m.kind === 'bad');
  assert.match(far.msg, /bank or ATM/);
  const sums = (await srv.db.query('SELECT sum(cash_delta)::int c, sum(bank_delta)::int b FROM transactions WHERE character_id=$1', [player(a).charId])).rows[0];
  assert.equal(sums.c, player(a).cash);
  assert.equal(sums.b, player(a).bank);
});

test('economy: concurrent withdrawals cannot double-spend', async () => {
  const bank = building('bank');
  place(b, bank.door.x, bank.door.y);
  const p = player(b);
  const all = p.bank;
  // Fire the same withdrawal directly at the repository 8 times in parallel (bypassing the per-player lock).
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => srv.world.repo.mutate(p.charId, { bank: -all, cash: all }, 'withdraw')));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const row = (await srv.db.query('SELECT cash, bank FROM characters WHERE id=$1', [p.charId])).rows[0];
  assert.equal(row.bank, 0);
  const sums = (await srv.db.query('SELECT sum(cash_delta)::int c, sum(bank_delta)::int b FROM transactions WHERE character_id=$1', [p.charId])).rows[0];
  assert.equal(sums.c, row.cash); assert.equal(sums.b, row.bank);
  srv.world.applyMoney(p, { cash: row.cash, bank: row.bank, inventory: p.inventory });
});

test('shops: purchases add items, licenses are enforced, inventory persists', async () => {
  const shop = building('supermarket');
  place(a, shop.door.x, shop.door.y);
  await a.request({ t: 'buy', shop: 'supermarket', item: 'water', qty: 3 }, m => m.t === 'inv' && m.items.water === 5);
  const gun = building('gunstore');
  place(a, gun.door.x, gun.door.y);
  const e = await a.request({ t: 'buy', shop: 'gunstore', item: 'p9', qty: 1 }, m => m.t === 'toast' && m.kind === 'bad');
  assert.match(e.msg, /Firearms License/);
  const inv = await srv.world.repo.loadInventory(player(a).charId);
  assert.equal(inv.water, 5);
  // Using an item consumes it and restores thirst.
  player(a).thirst = 10;
  await a.request({ t: 'use', item: 'water' }, m => m.t === 'inv' && m.items.water === 4);
  assert.ok(player(a).thirst > 50);
});

test('combat: shots are validated, hit on the server, and kill/respawn works', async () => {
  await srv.world.repo.mutate(player(a).charId, { items: { p9: 1, ammo_9mm: 60 } }, 'items');
  player(a).inventory = await srv.world.repo.loadInventory(player(a).charId);
  // Firing an unowned weapon is impossible.
  a.send({ t: 'equip', weapon: 'ar7' });
  await sleep(50);
  assert.equal(player(a).weapon, 'fists');
  await a.request({ t: 'equip', weapon: 'p9' }, m => m.t === 'stats' && m.weapon === 'p9');
  await a.request({ t: 'reload' }, m => m.t === 'stats' && m.clip === 12);
  player(a).reloadUntil = 0;
  // Put B 100 units east of A in open street, A aims east.
  place(a, 2400, 2240); place(b, 2500, 2240);
  player(b).health = 100; player(b).invulnerableUntil = 0;
  assert.ok(!srv.world.map.raycast(2414, 2240, 2500, 2240), 'line of fire must be clear');
  const shot = await a.request({ t: 'fire', a: 0 }, m => m.t === 'shot');
  assert.equal(shot.e[0].h, 1);
  assert.ok(player(b).health < 100);
  // Fire-rate limit: an immediate second shot is ignored.
  const clip = player(a).clips.p9;
  a.send({ t: 'fire', a: 0 });
  await sleep(40);
  assert.equal(player(a).clips.p9, clip);
  // Shooting someone makes you wanted.
  assert.ok(player(a).wanted >= 1);
  // Kill and respawn with hospital fee.
  player(b).health = 1;
  await sleep(300);
  await a.request({ t: 'fire', a: 0 }, m => m.t === 'died' && m.id === b.playerId);
  assert.ok(player(b).deadUntil > 0);
  player(b).deadUntil = Date.now() - 1;
  const cashBefore = player(b).cash;
  await b.request({ t: 'respawn' }, m => m.t === 'respawned');
  assert.equal(player(b).health, 100);
  assert.ok(player(b).cash <= cashBefore);
});

test('chat: global reaches everyone, local only nearby', async () => {
  place(a, 2000, 1400); place(b, 4500, 4500);
  const mk = b.mark();
  await a.request({ t: 'chat', ch: 'global', text: 'hello city' }, m => m.t === 'chat' && m.text === 'hello city');
  await b.waitFor(m => m.t === 'chat' && m.text === 'hello city', 2000, mk);
  await sleep(900);
  const mk2 = b.mark();
  await a.request({ t: 'chat', ch: 'local', text: 'psst' }, m => m.t === 'chat' && m.text === 'psst');
  await sleep(200);
  assert.ok(!b.inbox.slice(mk2).some(m => m.t === 'chat' && m.text === 'psst'));
});

test('vehicles: enter, drive within limits, speed hacks corrected, exit', async () => {
  const v = srv.world.addVehicle({ kind: 'public', model: 'sedan', x: 2240, y: 3264, rot: 0, locked: false });
  place(b, v.x, v.y + 40);
  player(b).deadUntil = 0; player(b).wanted = 0;
  await b.request({ t: 'veh_enter', id: v.id }, m => m.t === 'entered');
  assert.equal(v.driver, b.playerId);
  await sleep(100);
  b.send({ t: 'drive', x: v.x + 20, y: v.y, rot: 0 });
  await sleep(50);
  assert.equal(Math.round(v.x), 2260);
  const c = await b.request({ t: 'drive', x: v.x + 2000, y: v.y, rot: 0 }, m => m.t === 'vcorrect');
  assert.equal(Math.round(c.x), 2260);
  await b.request({ t: 'veh_exit' }, m => m.t === 'exited');
  assert.equal(v.driver, null);
  // Stealing a public car is a crime.
  assert.ok(player(b).wanted >= 1);
});

test('police: officer cuffs and arrests a wanted player; record is written', async () => {
  const pa = player(a);
  await srv.world.repo.setJob(pa.charId, 'police', 1);
  pa.job = 'police'; pa.jobRank = 1;
  const pb = player(b);
  pb.wanted = 2; pb.charges = ['Assault'];
  place(a, 2000, 1400); place(b, 2030, 1400);
  await a.request({ t: 'police', op: 'cuff', target: b.playerId }, m => m.t === 'toast' && /restrained/.test(m.msg));
  assert.equal(pb.cuffedBy, a.playerId);
  await a.request({ t: 'police', op: 'arrest', target: b.playerId }, m => m.t === 'toast' && /booked/.test(m.msg));
  assert.ok(pb.jailUntil > Date.now());
  assert.equal(pb.wanted, 0);
  const rec = await srv.world.repo.criminalRecord(pb.charId);
  assert.equal(rec[0].offense, 'Assault');
  const lookup = await a.request({ t: 'police', op: 'lookup', query: 'Bob Stone' }, m => m.t === 'police_result');
  assert.equal(lookup.citizen.record.length, 1);
  // Non-police cannot use police actions.
  const e = await b.request({ t: 'police', op: 'lookup', query: 'Alice Walker' }, m => m.t === 'toast' && m.kind === 'bad');
  assert.match(e.msg, /Police only/);
});

test('reconnection: session token resumes and character state persists', async () => {
  const pa = player(a);
  const cash = pa.cash, charId = pa.charId, token = a.token!;
  pa.x = 2100; pa.y = 1400;
  a.close();
  await sleep(300);
  assert.equal(srv.world.players.has(`p${charId}`), false);
  const a2 = await TestClient.connect(srv.port);
  await a2.request({ t: 'resume', token }, m => m.t === 'chars');
  const spawn = await a2.request({ t: 'char_select', id: charId }, m => m.t === 'spawn');
  assert.equal(Math.round(spawn.you.x), 2100);
  await a2.waitFor(m => m.t === 'stats');
  assert.equal(a2.stats.cash, cash);
  a = a2;
});

test('admin: non-admins are refused, admin actions are audited', async () => {
  const e = await b.request({ t: 'admin', op: 'give_money', target: 'Alice Walker', amount: 1000 }, m => m.t === 'toast' && m.kind === 'bad');
  assert.match(e.msg, /Not authorised/);
  player(b).role = 'admin';
  const bankBefore = player(a).bank;
  await b.request({ t: 'admin', op: 'give_money', target: 'Alice Walker', amount: 1000 }, m => m.t === 'toast' && m.kind === 'good');
  assert.equal(player(a).bank, bankBefore + 1000);
  const audit = (await srv.db.query('SELECT action, target FROM admin_audit')).rows;
  assert.deepEqual(audit.map(r => r.action), ['give_money']);
});
