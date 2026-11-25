import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GameWorld } from '../game/world.ts';
import { WorldMap } from '../world/map.ts';
import { Repo, GameError } from '../game/repo.ts';
import { catalog } from '../game/content.ts';
import { createPool, type Db } from '../db/pool.ts';
import { migrate } from '../db/migrate.ts';
import type { Session } from '../game/types.ts';
import { wire } from '../game/i18n.ts';

export const PROTOCOL_VERSION = 2;
const MAX_MESSAGE_BYTES = 8 * 1024;
const RATE_PER_SEC = 60;
const RATE_BURST = 120;

export type ServerOptions = {
  databaseUrl: string; port: number; worldPath: string;
  npcs?: number; traffic?: number; adminUsernames?: string[]; sessionTtlHours?: number; log?: (...a: unknown[]) => void;
  authAttemptsPerMinute?: number;
};

export type RunningServer = { port: number; world: GameWorld; db: Db; close(): Promise<void> };

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const log = opts.log ?? console.log;
  const db = createPool(opts.databaseUrl);
  await migrate(db, log);
  const repo = new Repo(db);
  const world = new GameWorld(WorldMap.load(opts.worldPath), repo);
  world.log = log;
  await world.init({ npcs: opts.npcs, traffic: opts.traffic });
  world.start();

  const http: Server = createHttpServer((req, res) => {
    // Health endpoint for load balancers / uptime checks.
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, players: world.players.size, tick: world.tick }));
      return;
    }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({ server: http, maxPayload: MAX_MESSAGE_BYTES });
  let nextSession = 1;
  const admins = (opts.adminUsernames ?? []).map(a => a.trim().toLowerCase()).filter(Boolean);
  const authAttempts = new Map<string, number[]>();

  wss.on('connection', (ws: WebSocket, req) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    let tokens = RATE_BURST, lastRefill = Date.now();
    const session: Session = {
      id: nextSession++, account: null, player: null,
      send(msg) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); },
      close(code = 1000, reason = '') { try { ws.close(code, reason); } catch { /* already closed */ } },
    };
    session.send({ t: 'welcome', version: PROTOCOL_VERSION, catalog: catalog(), world: { name: 'Utopia City', district: 'district1', version: world.map.data.version ?? 1 }, serverTime: Date.now() });

    const authLimited = () => {
      const now = Date.now();
      const list = (authAttempts.get(ip) ?? []).filter(t => now - t < 60_000);
      list.push(now); authAttempts.set(ip, list);
      return list.length > (opts.authAttemptsPerMinute ?? 10);
    };

    const finishAuth = async (account: { id: number; username: string; role: any }, token?: string) => {
      // ADMIN_USERNAMES applies on every login, so it works no matter when the account was created.
      if (account.role !== 'admin' && admins.includes(account.username.toLowerCase())) {
        await repo.promoteAdmins([account.username.toLowerCase()]);
        account = { ...account, role: 'admin' };
        log(`granted admin to ${account.username} (ADMIN_USERNAMES)`);
      }
      const ban = await repo.activeBan(account.id);
      if (ban) throw new GameError(`Account banned${ban.expires_at ? ` until ${new Date(ban.expires_at).toISOString()}` : ''}: ${ban.reason}`);
      session.account = account;
      const t = token ?? await repo.createSession(account.id, opts.sessionTtlHours ?? 168);
      session.send({ t: 'auth_ok', token: t, account });
      session.send({ t: 'chars', list: await repo.listCharacters(account.id) });
    };

    const handle = async (m: any) => {
      switch (m.t) {
        case 'ping': return session.send({ t: 'pong', ts: m.ts, serverTime: Date.now() });
        case 'register':
          if (authLimited()) throw new GameError('Too many attempts, wait a minute');
          return finishAuth(await repo.register(m.username, m.password));
        case 'login':
          if (authLimited()) throw new GameError('Too many attempts, wait a minute');
          return finishAuth(await repo.login(m.username, m.password));
        case 'resume':
          if (authLimited()) throw new GameError('Too many attempts, wait a minute');
          return finishAuth(await repo.resumeSession(m.token), m.token);
        case 'logout':
          if (session.account) await repo.revokeSessions(session.account.id);
          if (session.player) await world.removePlayer(session.player, 'logout');
          session.account = null; session.player = null;
          return session.send({ t: 'logged_out' });
      }
      if (!session.account) throw new GameError('Not logged in');
      switch (m.t) {
        case 'chars': return session.send({ t: 'chars', list: await repo.listCharacters(session.account.id) });
        case 'char_create': {
          // Spread new arrivals along the sidewalk so characters don't spawn stacked.
          const base = world.map.data.spawns.default;
          let spawn = base;
          for (let i = 0; i < 10; i++) {
            const c = { x: base.x, y: base.y + (Math.random() - 0.5) * 240 };
            if (!world.map.circleBlocked(c.x, c.y, 12)) { spawn = c; break; }
          }
          await repo.createCharacter(session.account.id, m.name, m.appearance, spawn);
          return session.send({ t: 'chars', list: await repo.listCharacters(session.account.id) });
        }
        case 'char_select': {
          if (session.player) await world.removePlayer(session.player, 'switch');
          const row = await repo.loadCharacter(Number(m.id), session.account.id);
          await world.spawnPlayer(session, row);
          return;
        }
      }
      if (!session.player) throw new GameError('No character selected');
      return world.handle(session.player, m);
    };

    ws.on('message', (raw, isBinary) => {
      const now = Date.now();
      tokens = Math.min(RATE_BURST, tokens + ((now - lastRefill) / 1000) * RATE_PER_SEC); lastRefill = now;
      if (tokens < 1) return; // drop excess silently (flood protection)
      tokens--;
      if (isBinary) return;
      let m: any;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
      Promise.resolve().then(() => handle(m)).catch(e => {
        if (e instanceof GameError) session.send({ t: 'error', ctx: m.t, ...wire(e.text) });
        else { log('handler error', m.t, e); session.send({ t: 'error', ctx: m.t, msg: 'Server error' }); }
      });
    });

    ws.on('close', () => {
      // Reconnection: the character is saved and removed; resuming with the token restores it.
      if (session.player && session.player.session === session) world.removePlayer(session.player).catch(e => log(e));
    });
    ws.on('error', () => {});
  });

  // Heartbeat: drop dead TCP connections.
  const alive = new WeakMap<WebSocket, boolean>();
  wss.on('connection', ws => { alive.set(ws, true); ws.on('pong', () => alive.set(ws, true)); });
  const hb = setInterval(() => {
    for (const ws of wss.clients) { if (!alive.get(ws)) { ws.terminate(); continue; } alive.set(ws, false); ws.ping(); }
  }, 15_000);

  if (admins.length) {
    const found = await repo.promoteAdmins(admins);
    const missing = admins.filter(a => !found.includes(a));
    log(`admin accounts: ${found.join(', ') || '(none yet)'}${missing.length ? ` — not registered yet: ${missing.join(', ')} (promoted when they log in)` : ''}`);
  } else {
    log('ADMIN_USERNAMES is not set — no admin accounts configured');
  }
  await new Promise<void>(r => http.listen(opts.port, r));
  const port = (http.address() as AddressInfo).port;
  log(`Utopia server listening on :${port} (${world.vehicles.size} vehicles, ${world.npcs.size} pedestrians)`);

  return {
    port, world, db,
    async close() {
      clearInterval(hb);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>(r => wss.close(() => r()));
      await new Promise<void>(r => http.close(() => r()));
      for (const p of [...world.players.values()]) await world.removePlayer(p, 'shutdown');
      await world.stop();
      await db.end();
    },
  };
}
