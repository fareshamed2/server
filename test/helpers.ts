import WebSocket from 'ws';
import { resolve } from 'node:path';
import { ROOT } from '../src/config.ts';
import { startServer, type RunningServer } from '../src/net/server.ts';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/utopia_test';

export async function startTestServer(): Promise<RunningServer> {
  const srv = await startServer({
    databaseUrl: TEST_DB, port: 0, worldPath: resolve(ROOT, '..', 'shared', 'world', 'district1.json'),
    npcs: 10, traffic: 4, adminUsernames: [], log: () => {},
  });
  await srv.db.query('TRUNCATE accounts, sessions, bans, characters, inventory_items, vehicles, transactions, criminal_records, admin_audit RESTART IDENTITY CASCADE');
  // Vehicles loaded from a previous run were truncated; drop owned ones from memory too.
  for (const [id, v] of srv.world.vehicles) if (v.kind === 'owned') srv.world.vehicles.delete(id);
  return srv;
}

/** A real WebSocket game client used by tests and the load bot. */
export class TestClient {
  ws!: WebSocket;
  inbox: any[] = [];
  private waiters: { pred: (m: any) => boolean; resolve: (m: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  token: string | null = null;
  playerId: string | null = null;
  stats: any = null;
  inv: any = null;

  static async connect(port: number) {
    const c = new TestClient();
    c.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    c.ws.on('message', raw => c.onMessage(JSON.parse(raw.toString())));
    await new Promise<void>((res, rej) => { c.ws.once('open', () => res()); c.ws.once('error', rej); });
    await c.waitFor(m => m.t === 'welcome');
    return c;
  }

  private onMessage(m: any) {
    if (m.t === 'stats') this.stats = m;
    if (m.t === 'inv') this.inv = m;
    if (m.t === 'auth_ok') this.token = m.token;
    if (m.t === 'spawn') this.playerId = m.you.id;
    this.inbox.push(m);
    if (this.inbox.length > 2000) this.inbox.splice(0, 1000);
    for (const w of [...this.waiters]) if (w.pred(m)) { clearTimeout(w.timer); this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(m); }
  }

  send(m: object) { this.ws.send(JSON.stringify(m)); }

  /** Resolves with the first message (already received since `since`, or future) matching pred. */
  waitFor(pred: (m: any) => boolean, timeoutMs = 4000, since = 0): Promise<any> {
    const found = this.inbox.slice(since).find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters = this.waiters.filter(w => w.timer !== timer); reject(new Error('timeout waiting for message')); }, timeoutMs);
      this.waiters.push({ pred, resolve, reject, timer });
    });
  }
  mark() { return this.inbox.length; }
  async request(m: object, pred: (m: any) => boolean, timeoutMs = 4000) {
    const mk = this.mark();
    this.send(m);
    return this.waitFor(pred, timeoutMs, mk);
  }

  async registerAndSpawn(username: string, name: string) {
    await this.request({ t: 'register', username, password: 'correct-horse-9' }, m => m.t === 'chars');
    const chars = await this.request({ t: 'char_create', name, appearance: APPEARANCE }, m => m.t === 'chars' || m.t === 'error');
    if (chars.t === 'error') throw new Error(chars.msg);
    await this.request({ t: 'char_select', id: chars.list[0].id }, m => m.t === 'spawn');
    await this.waitFor(m => m.t === 'stats');
    return chars.list[0];
  }

  close() { this.ws.close(); }
}

export const APPEARANCE = { gender: 'female', skin: 2, hair: 3, hairColor: '#3b2314', top: 1, topColor: '#c0392b', pants: '#2c3e50', shoes: '#111111', accessory: 0 };

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
