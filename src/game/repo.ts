import { randomBytes, scrypt as scryptCb, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { withTx, type Db, type Tx } from '../db/pool.ts';
import { ITEMS, MAX_CARRY_WEIGHT, ECONOMY } from './content.ts';
import { tr, render, type Text } from './i18n.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

/** Error whose message is safe to show to the player (translatable). */
export class GameError extends Error {
  readonly text: Text;
  constructor(t: Text) { super(render(t)); this.text = t; }
}

export type Account = { id: number; username: string; role: 'player' | 'moderator' | 'admin' };
export type Appearance = {
  gender: 'male' | 'female'; skin: number; hair: number; hairColor: string;
  top: number; topColor: string; pants: string; shoes: string; accessory: number;
};
export type CharacterRow = {
  id: number; account_id: number; name: string; citizen_id: string; appearance: Appearance;
  x: number; y: number; health: number; hunger: number; thirst: number; cash: number; bank: number;
  job: string; job_rank: number; licenses: string[]; wanted: number; jail_until: Date | null; playtime_s: number;
};
export type Inventory = Record<string, number>;

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const NAME_RE = /^[A-Z][a-zA-Z'-]{1,15} [A-Z][a-zA-Z'-]{1,15}$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const h = await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${h.toString('base64')}`;
}
async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const h = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return timingSafeEqual(h, expected);
}

export function validateAppearance(a: any): Appearance {
  if (!a || typeof a !== 'object') throw new GameError('Invalid appearance');
  const int = (v: any, max: number) => { if (!Number.isInteger(v) || v < 0 || v > max) throw new GameError('Invalid appearance'); return v; };
  const hex = (v: any) => { if (typeof v !== 'string' || !HEX_RE.test(v)) throw new GameError('Invalid appearance color'); return v; };
  if (a.gender !== 'male' && a.gender !== 'female') throw new GameError('Invalid gender');
  return {
    gender: a.gender, skin: int(a.skin, 7), hair: int(a.hair, 7), hairColor: hex(a.hairColor),
    top: int(a.top, 4), topColor: hex(a.topColor), pants: hex(a.pants), shoes: hex(a.shoes), accessory: int(a.accessory, 4),
  };
}

export function inventoryWeight(inv: Inventory): number {
  let w = 0;
  for (const [id, q] of Object.entries(inv)) w += (ITEMS[id]?.weight ?? 0) * q;
  return Math.round(w * 100) / 100;
}

export class Repo {
  readonly db: Db;
  constructor(db: Db) { this.db = db; }

  // ---- accounts & sessions ----------------------------------------------------
  async register(username: string, password: string): Promise<Account> {
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) throw new GameError('Username must be 3-20 letters, digits or _');
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw new GameError('Password must be 8-128 characters');
    const hash = await hashPassword(password);
    try {
      const r = await this.db.query('INSERT INTO accounts(username, password_hash) VALUES (lower($1), $2) RETURNING id, username, role', [username, hash]);
      return r.rows[0];
    } catch (e: any) {
      if (e.code === '23505') throw new GameError('Username already taken');
      throw e;
    }
  }

  async login(username: string, password: string): Promise<Account> {
    if (typeof username !== 'string' || typeof password !== 'string') throw new GameError('Invalid credentials');
    const r = await this.db.query('SELECT id, username, role, password_hash FROM accounts WHERE username = lower($1)', [username]);
    const row = r.rows[0];
    // Always run scrypt to avoid a username-existence timing oracle.
    const ok = await verifyPassword(password, row?.password_hash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64'));
    if (!row || !ok) throw new GameError('Invalid username or password');
    await this.db.query('UPDATE accounts SET last_login_at = now() WHERE id = $1', [row.id]);
    return { id: row.id, username: row.username, role: row.role };
  }

  async createSession(accountId: number, ttlHours: number): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.db.query(`INSERT INTO sessions(token_hash, account_id, expires_at) VALUES ($1, $2, now() + ($3 || ' hours')::interval)`, [sha256(token), accountId, String(ttlHours)]);
    return token;
  }

  async resumeSession(token: string): Promise<Account> {
    if (typeof token !== 'string' || token.length > 100) throw new GameError('Session expired');
    const r = await this.db.query(`SELECT a.id, a.username, a.role FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = $1 AND s.expires_at > now()`, [sha256(token)]);
    if (!r.rows[0]) throw new GameError('Session expired');
    return r.rows[0];
  }

  async revokeSessions(accountId: number) { await this.db.query('DELETE FROM sessions WHERE account_id = $1', [accountId]); }

  async activeBan(accountId: number): Promise<{ reason: string; expires_at: Date | null } | null> {
    const r = await this.db.query('SELECT reason, expires_at FROM bans WHERE account_id = $1 AND (expires_at IS NULL OR expires_at > now()) ORDER BY id DESC LIMIT 1', [accountId]);
    return r.rows[0] ?? null;
  }

  /** Grants admin to the configured usernames. Returns the usernames that exist. */
  async promoteAdmins(usernames: string[]): Promise<string[]> {
    if (!usernames.length) return [];
    const r = await this.db.query(`UPDATE accounts SET role = 'admin' WHERE username = ANY($1) RETURNING username`, [usernames]);
    return r.rows.map(x => x.username);
  }

  // ---- characters -----------------------------------------------------------------
  async listCharacters(accountId: number) {
    const r = await this.db.query('SELECT id, name, citizen_id, appearance, job, cash, bank FROM characters WHERE account_id = $1 ORDER BY id', [accountId]);
    return r.rows;
  }

  async createCharacter(accountId: number, name: string, appearanceIn: unknown, spawn: { x: number; y: number }): Promise<CharacterRow> {
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw new GameError('Name must be "Firstname Lastname" (capitalised, letters only)');
    const appearance = validateAppearance(appearanceIn);
    const count = (await this.db.query('SELECT count(*)::int AS n FROM characters WHERE account_id = $1', [accountId])).rows[0].n;
    if (count >= 3) throw new GameError('Maximum of 3 characters per account');
    return withTx(this.db, async tx => {
      let row;
      for (let attempt = 0; attempt < 5 && !row; attempt++) {
        const cid = 'UC-' + String(Math.floor(100000 + Math.random() * 900000));
        try {
          await tx.query('SAVEPOINT c');
          row = (await tx.query(
            `INSERT INTO characters(account_id, name, citizen_id, appearance, x, y, cash, bank) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [accountId, name, cid, appearance, spawn.x, spawn.y, ECONOMY.startingCash, ECONOMY.startingBank])).rows[0];
        } catch (e: any) {
          await tx.query('ROLLBACK TO SAVEPOINT c');
          if (e.code !== '23505') throw e;
          if (String(e.constraint).includes('name')) throw new GameError('That name is taken');
        }
      }
      if (!row) throw new GameError('Could not allocate citizen ID');
      await tx.query(`INSERT INTO transactions(character_id, kind, cash_delta, bank_delta, memo) VALUES ($1,'grant',$2,$3,'Welcome to Utopia')`, [row.id, ECONOMY.startingCash, ECONOMY.startingBank]);
      for (const [item, qty] of [['id_card', 1], ['water', 2], ['sandwich', 2]] as const)
        await tx.query('INSERT INTO inventory_items(character_id, item_id, qty) VALUES ($1,$2,$3)', [row.id, item, qty]);
      return row;
    });
  }

  async loadCharacter(id: number, accountId: number): Promise<CharacterRow> {
    const r = await this.db.query('SELECT * FROM characters WHERE id = $1 AND account_id = $2', [id, accountId]);
    if (!r.rows[0]) throw new GameError('Character not found');
    return r.rows[0];
  }

  async findCharacterByName(name: string) {
    return (await this.db.query('SELECT id, name, citizen_id, account_id FROM characters WHERE lower(name) = lower($1)', [name])).rows[0] ?? null;
  }

  async loadInventory(charId: number, tx: Db | Tx = this.db): Promise<Inventory> {
    const r = await tx.query('SELECT item_id, qty FROM inventory_items WHERE character_id = $1', [charId]);
    return Object.fromEntries(r.rows.map(x => [x.item_id, x.qty]));
  }

  /** Persists non-monetary state. Money and items are NEVER written here. */
  async saveCharacterState(c: { id: number; x: number; y: number; health: number; hunger: number; thirst: number; wanted: number; playtimeAdd: number }) {
    await this.db.query(
      `UPDATE characters SET x=$2, y=$3, health=$4, hunger=$5, thirst=$6, wanted=$7, playtime_s = playtime_s + $8, updated_at=now() WHERE id=$1`,
      [c.id, c.x, c.y, c.health, c.hunger, c.thirst, c.wanted, Math.round(c.playtimeAdd)]);
  }

  async setJob(charId: number, job: string, rank: number) { await this.db.query('UPDATE characters SET job=$2, job_rank=$3 WHERE id=$1', [charId, job, rank]); }
  async setJail(charId: number, until: Date | null) { await this.db.query('UPDATE characters SET jail_until=$2 WHERE id=$1', [charId, until]); }

  /**
   * The single path for changing money and items. Runs in one transaction with
   * row locks, so concurrent requests cannot double-spend or duplicate items.
   * Throws GameError (and changes nothing) if any balance or stack would go negative,
   * or if the resulting carry weight exceeds the limit (when items are added).
   */
  async mutate(charId: number, change: { cash?: number; bank?: number; items?: Record<string, number>; licenses?: string[] },
               kind: string, memo: string | null = null, counterparty: number | null = null, tx?: Tx) {
    const run = async (t: Tx) => {
      const cash = Math.trunc(change.cash ?? 0), bank = Math.trunc(change.bank ?? 0);
      const cur = (await t.query('SELECT cash, bank, licenses FROM characters WHERE id = $1 FOR UPDATE', [charId])).rows[0];
      if (!cur) throw new GameError('Character not found');
      if (cur.cash + cash < 0) throw new GameError('Not enough cash');
      if (cur.bank + bank < 0) throw new GameError('Insufficient bank funds');
      const inv = await this.loadInventory(charId, t);
      let adding = false;
      for (const [item, d] of Object.entries(change.items ?? {})) {
        const def = ITEMS[item];
        if (!def || !Number.isInteger(d)) throw new GameError('Unknown item');
        const next = (inv[item] ?? 0) + d;
        if (next < 0) throw new GameError(tr('Not enough {0}', def.name));
        if (next > def.stack) throw new GameError(tr('You can\'t carry more {0}', def.name));
        if (d > 0) adding = true;
        if (next === 0) { delete inv[item]; await t.query('DELETE FROM inventory_items WHERE character_id=$1 AND item_id=$2', [charId, item]); }
        else { inv[item] = next; await t.query('INSERT INTO inventory_items(character_id,item_id,qty) VALUES ($1,$2,$3) ON CONFLICT (character_id,item_id) DO UPDATE SET qty = EXCLUDED.qty', [charId, item, next]); }
      }
      if (adding && inventoryWeight(inv) > MAX_CARRY_WEIGHT) throw new GameError('Inventory too heavy');
      let licenses: string[] = cur.licenses;
      if (change.licenses?.length) {
        licenses = [...new Set([...cur.licenses, ...change.licenses])];
        await t.query('UPDATE characters SET licenses=$2 WHERE id=$1', [charId, JSON.stringify(licenses)]);
      }
      const upd = (await t.query('UPDATE characters SET cash = cash + $2, bank = bank + $3 WHERE id = $1 RETURNING cash, bank', [charId, cash, bank])).rows[0];
      if (cash !== 0 || bank !== 0 || kind !== 'items')
        await t.query('INSERT INTO transactions(character_id, kind, cash_delta, bank_delta, counterparty, memo) VALUES ($1,$2,$3,$4,$5,$6)', [charId, kind, cash, bank, counterparty, memo]);
      return { cash: upd.cash as number, bank: upd.bank as number, inventory: inv, licenses };
    };
    return tx ? run(tx) : withTx(this.db, run);
  }

  /** Bank-to-bank transfer between two characters, atomic. Locks in id order to avoid deadlocks. */
  async transfer(fromId: number, toId: number, amount: number, memo: string | null) {
    if (!Number.isInteger(amount) || amount <= 0 || amount > ECONOMY.maxTransfer) throw new GameError('Invalid amount');
    if (fromId === toId) throw new GameError('Cannot transfer to yourself');
    return withTx(this.db, async tx => {
      await tx.query('SELECT id FROM characters WHERE id = ANY($1) ORDER BY id FOR UPDATE', [[fromId, toId]]);
      const from = await this.mutate(fromId, { bank: -amount }, 'transfer_out', memo, toId, tx);
      const to = await this.mutate(toId, { bank: amount }, 'transfer_in', memo, fromId, tx);
      return { from, to };
    });
  }

  /** Moves items (and optionally cash) between two characters atomically (trades, gives). */
  async exchange(a: number, b: number, aGives: { cash?: number; items?: Record<string, number> }, bGives: { cash?: number; items?: Record<string, number> }, kind: string) {
    const neg = (o: Record<string, number> = {}) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, -v]));
    const merge = (x: Record<string, number>, y: Record<string, number>) => { const r = { ...x }; for (const [k, v] of Object.entries(y)) r[k] = (r[k] ?? 0) + v; return r; };
    for (const g of [aGives, bGives]) {
      if ((g.cash ?? 0) < 0 || !Number.isInteger(g.cash ?? 0)) throw new GameError('Invalid amount');
      for (const v of Object.values(g.items ?? {})) if (!Number.isInteger(v) || v <= 0) throw new GameError('Invalid quantity');
    }
    return withTx(this.db, async tx => {
      await tx.query('SELECT id FROM characters WHERE id = ANY($1) ORDER BY id FOR UPDATE', [[a, b]]);
      const ra = await this.mutate(a, { cash: (bGives.cash ?? 0) - (aGives.cash ?? 0), items: merge(neg(aGives.items), bGives.items ?? {}) }, kind, null, b, tx);
      const rb = await this.mutate(b, { cash: (aGives.cash ?? 0) - (bGives.cash ?? 0), items: merge(neg(bGives.items), aGives.items ?? {}) }, kind, null, a, tx);
      return { a: ra, b: rb };
    });
  }

  async recentTransactions(charId: number, limit = 25) {
    return (await this.db.query('SELECT kind, cash_delta, bank_delta, memo, created_at FROM transactions WHERE character_id = $1 ORDER BY id DESC LIMIT $2', [charId, limit])).rows;
  }

  // ---- vehicles -------------------------------------------------------------------------
  async ownedVehicles(charId: number) {
    return (await this.db.query('SELECT * FROM vehicles WHERE owner_id = $1 ORDER BY id', [charId])).rows;
  }
  async allPersistentVehicles() {
    return (await this.db.query('SELECT * FROM vehicles WHERE stored = false')).rows;
  }
  async buyVehicle(charId: number, model: string, price: number, color: string, pos: { x: number; y: number; rot: number }) {
    return withTx(this.db, async tx => {
      const money = await this.mutate(charId, { bank: -price }, 'vehicle_purchase', model, null, tx);
      let row;
      for (let i = 0; i < 5 && !row; i++) {
        const plate = randomPlate();
        try {
          await tx.query('SAVEPOINT p');
          row = (await tx.query('INSERT INTO vehicles(owner_id, model, plate, color, x, y, rot) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [charId, model, plate, color, pos.x, pos.y, pos.rot])).rows[0];
        } catch (e: any) { await tx.query('ROLLBACK TO SAVEPOINT p'); if (e.code !== '23505') throw e; }
      }
      if (!row) throw new GameError('Could not register plate');
      return { money, vehicle: row };
    });
  }
  async saveVehicle(v: { dbId: number; x: number; y: number; rot: number; fuel: number; engine: number; locked: boolean; stored?: boolean }) {
    await this.db.query('UPDATE vehicles SET x=$2, y=$3, rot=$4, fuel=$5, engine=$6, locked=$7, stored=COALESCE($8, stored) WHERE id=$1', [v.dbId, v.x, v.y, v.rot, v.fuel, v.engine, v.locked, v.stored ?? null]);
  }
  async vehicleByPlate(plate: string) {
    return (await this.db.query(`SELECT v.*, c.name AS owner_name, c.citizen_id AS owner_cid FROM vehicles v LEFT JOIN characters c ON c.id = v.owner_id WHERE upper(v.plate) = upper($1)`, [plate])).rows[0] ?? null;
  }

  // ---- police -----------------------------------------------------------------------------
  async addCriminalRecord(charId: number, offense: string, officerId: number | null, fine: number, jailSeconds: number) {
    await this.db.query('INSERT INTO criminal_records(character_id, offense, officer_id, fine, jail_seconds) VALUES ($1,$2,$3,$4,$5)', [charId, offense, officerId, fine, jailSeconds]);
  }
  async criminalRecord(charId: number) {
    return (await this.db.query('SELECT offense, fine, jail_seconds, created_at FROM criminal_records WHERE character_id=$1 ORDER BY id DESC LIMIT 20', [charId])).rows;
  }
  async lookupCitizen(query: string) {
    const r = await this.db.query('SELECT id, name, citizen_id, job, licenses, wanted FROM characters WHERE upper(citizen_id) = upper($1) OR lower(name) = lower($1)', [query]);
    return r.rows[0] ?? null;
  }

  // ---- admin ---------------------------------------------------------------------------------
  async audit(adminId: number, action: string, target: string | null, details: unknown) {
    await this.db.query('INSERT INTO admin_audit(admin_id, action, target, details) VALUES ($1,$2,$3,$4)', [adminId, action, target, JSON.stringify(details ?? null)]);
  }
  async ban(accountId: number, reason: string, bannedBy: number, hours: number | null) {
    await this.db.query(`INSERT INTO bans(account_id, reason, banned_by, expires_at) VALUES ($1,$2,$3, CASE WHEN $4::int IS NULL THEN NULL ELSE now() + ($4::int || ' hours')::interval END)`, [accountId, reason, bannedBy, hours]);
    await this.revokeSessions(accountId);
  }
  async economyStats() {
    return (await this.db.query(`SELECT count(*)::int AS characters, COALESCE(sum(cash),0)::bigint AS cash, COALESCE(sum(bank),0)::bigint AS bank FROM characters`)).rows[0];
  }
}

function randomPlate() {
  const L = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  const l = () => L[Math.floor(Math.random() * L.length)];
  return `${l()}${l()}${l()} ${Math.floor(1000 + Math.random() * 9000)}`;
}
