import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, TestClient, sleep } from './helpers.ts';
import type { RunningServer } from '../src/net/server.ts';

let srv: RunningServer;
before(async () => { srv = await startTestServer({ adminUsernames: ['Boss'] }); });
after(async () => { await sleep(100); await srv.close(); });

test('ADMIN_USERNAMES applies to accounts registered after the server started', async () => {
  const c = await TestClient.connect(srv.port);
  const ok = await c.request({ t: 'register', username: 'boss', password: 'boss-password-1' }, m => m.t === 'auth_ok');
  assert.equal(ok.account.role, 'admin');
  const row = (await srv.db.query(`SELECT role FROM accounts WHERE username = 'boss'`)).rows[0];
  assert.equal(row.role, 'admin');
  c.close();
});

test('other accounts stay players', async () => {
  const c = await TestClient.connect(srv.port);
  const ok = await c.request({ t: 'register', username: 'someone', password: 'someone-pass-1' }, m => m.t === 'auth_ok');
  assert.equal(ok.account.role, 'player');
  c.close();
});
