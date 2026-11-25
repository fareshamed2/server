-- v2: housing. One row per purchasable/rentable unit (a house is 1 unit; an apartment
-- building has several). Rows are seeded from the world file at startup.

CREATE TABLE properties (
  id            BIGSERIAL PRIMARY KEY,
  building_id   INT  NOT NULL,                 -- world building id
  unit          INT  NOT NULL DEFAULT 1,       -- apartment number within the building
  kind          TEXT NOT NULL CHECK (kind IN ('trailer','apartment','house','mansion')),
  price         BIGINT NOT NULL CHECK (price > 0),
  rent          BIGINT NOT NULL DEFAULT 0,     -- per real day; 0 = not rentable
  owner_id      BIGINT REFERENCES characters(id) ON DELETE SET NULL,
  tenure        TEXT CHECK (tenure IN ('owned','rented')),
  acquired_at   TIMESTAMPTZ,
  lease_until   TIMESTAMPTZ,                   -- rented units only
  tax_paid_until TIMESTAMPTZ,                  -- owned units: property tax is due daily
  tax_debt      BIGINT NOT NULL DEFAULT 0,
  locked        BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (building_id, unit),
  CHECK ((owner_id IS NULL) = (tenure IS NULL))
);
CREATE INDEX properties_owner_idx ON properties(owner_id);

-- Items stored in a home's stash.
CREATE TABLE property_storage (
  property_id BIGINT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  item_id     TEXT NOT NULL,
  qty         INT NOT NULL CHECK (qty > 0),
  PRIMARY KEY (property_id, item_id)
);

-- Spare keys: characters who may enter and use the stash (roommates).
CREATE TABLE property_keys (
  property_id  BIGINT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  PRIMARY KEY (property_id, character_id)
);
