import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tr, render, wire } from '../src/game/i18n.ts';
import { GameError } from '../src/game/repo.ts';
import { startTestServer, TestClient, sleep } from './helpers.ts';
import type { RunningServer } from '../src/net/server.ts';

test('tr/render/wire', () => {
  const m = tr('Bought {0}x {1} for ${2}', 3, 'Water Bottle', 12);
  assert.equal(render(m), 'Bought 3x Water Bottle for $12');
  assert.deepEqual(wire(m), { msg: 'Bought 3x Water Bottle for $12', tpl: 'Bought {0}x {1} for ${2}', args: [3, 'Water Bottle', 12] });
  // Plain strings carry no template (clients translate them by key, never player chat).
  assert.deepEqual(wire('Vehicle is locked'), { msg: 'Vehicle is locked' });
  const e = new GameError(tr('Not enough {0}', 'Water Bottle'));
  assert.equal(e.message, 'Not enough Water Bottle');
});

let srv: RunningServer;
let c: TestClient;
before(async () => {
  srv = await startTestServer();
  c = await TestClient.connect(srv.port);
  await c.registerAndSpawn('linguist', 'Lina Haddad');
});
after(async () => { c?.close(); await sleep(100); await srv.close(); });

test('toasts and errors carry translatable templates over the wire', async () => {
  const shop = srv.world.map.data.buildings.find(b => b.type === 'supermarket')!;
  const p = srv.world.players.get(c.playerId!)!;
  p.x = shop.door.x; p.y = shop.door.y;
  const ok = await c.request({ t: 'buy', shop: 'supermarket', item: 'water', qty: 2 }, m => m.t === 'toast' && m.kind === 'good');
  assert.equal(ok.tpl, 'Bought {0}x {1} for ${2}');
  assert.deepEqual(ok.args, [2, 'Water Bottle', 8]);
  const bad = await c.request({ t: 'buy', shop: 'gunstore', item: 'p9', qty: 1 }, m => m.t === 'toast' && m.kind === 'bad');
  assert.equal(bad.tpl, 'You need to be at {0}');
  const err = await c.request({ t: 'login', username: 'nobody', password: 'whatever-123' }, m => m.t === 'error');
  assert.equal(err.msg, 'Invalid username or password');
  assert.equal(err.tpl, undefined);
});
