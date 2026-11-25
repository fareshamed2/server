import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader (keeps secrets out of source control; .env is gitignored).
const envPath = resolve(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://localhost:5432/utopia',
  port: Number(process.env.PORT ?? 8080),
  adminUsernames: (process.env.ADMIN_USERNAMES ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 168),
  // Login/register attempts allowed per IP per minute (raise only for local load tests).
  authAttemptsPerMinute: Number(process.env.AUTH_RATE_PER_MIN ?? 10),
  // The server ships its own copy (server/world) so it can be deployed without the rest of the repo.
  worldPath: process.env.WORLD_PATH ?? (existsSync(resolve(ROOT, 'world', 'district1.json')) ? resolve(ROOT, 'world', 'district1.json') : resolve(ROOT, '..', 'shared', 'world', 'district1.json')),
  tickRate: 20,
  snapshotRate: 15,
  interestRadius: 1400,
  saveIntervalMs: 30_000,
};
