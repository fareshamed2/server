-- Home upgrades: gun locker (separate storage container), decoration, parties, home garages.

-- Storage gets a container: 'safe' (weight-limited, any item) or 'armory' (weapons and ammo, slot-limited).
ALTER TABLE property_storage ADD COLUMN container TEXT NOT NULL DEFAULT 'safe' CHECK (container IN ('safe', 'armory'));
ALTER TABLE property_storage DROP CONSTRAINT property_storage_pkey;
ALTER TABLE property_storage ADD PRIMARY KEY (property_id, container, item_id);

-- Purchased decoration choices, e.g. {"floor":"marble","sofa":"leather"}.
ALTER TABLE properties ADD COLUMN decor JSONB NOT NULL DEFAULT '{}';
-- A party is active while party_until is in the future.
ALTER TABLE properties ADD COLUMN party_until TIMESTAMPTZ;

-- A stored vehicle can be parked in a specific home's garage (NULL = public garage).
ALTER TABLE vehicles ADD COLUMN garage_property_id BIGINT REFERENCES properties(id) ON DELETE SET NULL;
CREATE INDEX vehicles_garage_property_idx ON vehicles(garage_property_id);
