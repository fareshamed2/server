-- Utopia core schema. Applied by src/db/migrate.ts (tracked in schema_migrations).

CREATE TABLE accounts (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,              -- scrypt$N$r$p$salt$hash
  role          TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player','moderator','admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,             -- sha256(token); raw token never stored
  account_id  BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_account_idx ON sessions(account_id);

CREATE TABLE bans (
  id          BIGSERIAL PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL,
  banned_by   BIGINT REFERENCES accounts(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ                   -- NULL = permanent
);
CREATE INDEX bans_account_idx ON bans(account_id);

CREATE TABLE characters (
  id          BIGSERIAL PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL UNIQUE,
  citizen_id  TEXT NOT NULL UNIQUE,         -- in-world identification number
  appearance  JSONB NOT NULL,
  x           REAL NOT NULL,
  y           REAL NOT NULL,
  health      REAL NOT NULL DEFAULT 100,
  hunger      REAL NOT NULL DEFAULT 100,
  thirst      REAL NOT NULL DEFAULT 100,
  cash        BIGINT NOT NULL DEFAULT 0 CHECK (cash >= 0),
  bank        BIGINT NOT NULL DEFAULT 0 CHECK (bank >= 0),
  job         TEXT NOT NULL DEFAULT 'unemployed',
  job_rank    INT  NOT NULL DEFAULT 0,
  licenses    JSONB NOT NULL DEFAULT '[]',
  wanted      INT  NOT NULL DEFAULT 0,
  jail_until  TIMESTAMPTZ,
  playtime_s  BIGINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX characters_account_idx ON characters(account_id);

CREATE TABLE inventory_items (
  character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  item_id      TEXT NOT NULL,
  qty          INT NOT NULL CHECK (qty > 0),
  PRIMARY KEY (character_id, item_id)
);

CREATE TABLE vehicles (
  id           BIGSERIAL PRIMARY KEY,
  owner_id     BIGINT REFERENCES characters(id) ON DELETE SET NULL,
  model        TEXT NOT NULL,
  plate        TEXT NOT NULL UNIQUE,
  color        TEXT NOT NULL,
  x            REAL NOT NULL,
  y            REAL NOT NULL,
  rot          REAL NOT NULL DEFAULT 0,
  fuel         REAL NOT NULL DEFAULT 100,
  engine       REAL NOT NULL DEFAULT 100,  -- engine condition 0..100
  locked       BOOLEAN NOT NULL DEFAULT true,
  stored       BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX vehicles_owner_idx ON vehicles(owner_id);

-- Immutable money ledger. Every balance change writes one row.
CREATE TABLE transactions (
  id           BIGSERIAL PRIMARY KEY,
  character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,             -- purchase, salary, deposit, withdraw, transfer_in, ...
  cash_delta   BIGINT NOT NULL DEFAULT 0,
  bank_delta   BIGINT NOT NULL DEFAULT 0,
  counterparty BIGINT,
  memo         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX transactions_char_idx ON transactions(character_id, created_at DESC);

CREATE TABLE criminal_records (
  id           BIGSERIAL PRIMARY KEY,
  character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  offense      TEXT NOT NULL,
  officer_id   BIGINT REFERENCES characters(id),
  fine         BIGINT NOT NULL DEFAULT 0,
  jail_seconds INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX criminal_records_char_idx ON criminal_records(character_id);

CREATE TABLE admin_audit (
  id          BIGSERIAL PRIMARY KEY,
  admin_id    BIGINT NOT NULL REFERENCES accounts(id),
  action      TEXT NOT NULL,
  target      TEXT,
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
