import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, ROOT } from '../config.ts';
import { createPool, type Db } from './pool.ts';

/** Applies every migrations/*.sql file not yet recorded in schema_migrations, in name order. */
export async function migrate(db: Db, log = console.log): Promise<void> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const dir = resolve(ROOT, 'migrations');
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const done = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = readFileSync(resolve(dir, f), 'utf8');
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
      await c.query('COMMIT');
      log(`migrated ${f}`);
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally { c.release(); }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = createPool(config.databaseUrl);
  migrate(db).then(() => db.end()).catch(e => { console.error(e); process.exit(1); });
}
