// Authoritative game content. The server sends this catalog to clients in the
// `welcome` message, so balancing changes never require a client update.

export type WeaponDef = {
  id: string; name: string; kind: 'pistol' | 'revolver' | 'shotgun' | 'smg' | 'rifle' | 'sniper' | 'melee';
  damage: number; fireIntervalMs: number; range: number; magazine: number; reloadMs: number;
  pellets: number; spreadRad: number; ammo: string | null; automatic: boolean; license: string | null;
};

export const WEAPONS: Record<string, WeaponDef> = {
  fists:   { id: 'fists',   name: 'Fists',            kind: 'melee',    damage: 8,  fireIntervalMs: 450,  range: 34,  magazine: 0,  reloadMs: 0,    pellets: 1, spreadRad: 0,    ammo: null,        automatic: false, license: null },
  bat:     { id: 'bat',     name: 'Baseball Bat',     kind: 'melee',    damage: 22, fireIntervalMs: 650,  range: 44,  magazine: 0,  reloadMs: 0,    pellets: 1, spreadRad: 0,    ammo: null,        automatic: false, license: null },
  knife:   { id: 'knife',   name: 'Combat Knife',     kind: 'melee',    damage: 30, fireIntervalMs: 500,  range: 36,  magazine: 0,  reloadMs: 0,    pellets: 1, spreadRad: 0,    ammo: null,        automatic: false, license: null },
  p9:      { id: 'p9',      name: 'P9 Pistol',        kind: 'pistol',   damage: 18, fireIntervalMs: 260,  range: 520, magazine: 12, reloadMs: 1300, pellets: 1, spreadRad: 0.03, ammo: 'ammo_9mm',  automatic: false, license: 'firearms' },
  r44:     { id: 'r44',     name: 'R-44 Revolver',    kind: 'revolver', damage: 42, fireIntervalMs: 650,  range: 600, magazine: 6,  reloadMs: 2200, pellets: 1, spreadRad: 0.02, ammo: 'ammo_44',   automatic: false, license: 'firearms' },
  sg12:    { id: 'sg12',    name: 'SG-12 Shotgun',    kind: 'shotgun',  damage: 11, fireIntervalMs: 900,  range: 300, magazine: 6,  reloadMs: 2600, pellets: 7, spreadRad: 0.22, ammo: 'ammo_12g',  automatic: false, license: 'firearms' },
  vx9:     { id: 'vx9',     name: 'VX-9 SMG',         kind: 'smg',      damage: 12, fireIntervalMs: 85,   range: 460, magazine: 30, reloadMs: 1800, pellets: 1, spreadRad: 0.07, ammo: 'ammo_9mm',  automatic: true,  license: null },
  ar7:     { id: 'ar7',     name: 'AR-7 Rifle',       kind: 'rifle',    damage: 20, fireIntervalMs: 120,  range: 720, magazine: 30, reloadMs: 2100, pellets: 1, spreadRad: 0.04, ammo: 'ammo_556',  automatic: true,  license: null },
  ls50:    { id: 'ls50',    name: 'LS-50 Marksman',   kind: 'sniper',   damage: 85, fireIntervalMs: 1500, range: 1300,magazine: 5,  reloadMs: 3000, pellets: 1, spreadRad: 0.0,  ammo: 'ammo_308',  automatic: false, license: null },
};

export type ItemDef = {
  id: string; name: string; category: 'weapon' | 'ammo' | 'food' | 'drink' | 'medical' | 'document' | 'key' | 'material' | 'goods';
  weight: number; stack: number; legal: boolean;
  use?: { hunger?: number; thirst?: number; health?: number };
  weapon?: string;
};

export const ITEMS: Record<string, ItemDef> = {
  // Weapons (one item per weapon)
  bat:        { id: 'bat',   name: 'Baseball Bat',   category: 'weapon', weight: 1.2, stack: 1, legal: true,  weapon: 'bat' },
  knife:      { id: 'knife', name: 'Combat Knife',   category: 'weapon', weight: 0.4, stack: 1, legal: true,  weapon: 'knife' },
  p9:         { id: 'p9',    name: 'P9 Pistol',      category: 'weapon', weight: 1.0, stack: 1, legal: true,  weapon: 'p9' },
  r44:        { id: 'r44',   name: 'R-44 Revolver',  category: 'weapon', weight: 1.3, stack: 1, legal: true,  weapon: 'r44' },
  sg12:       { id: 'sg12',  name: 'SG-12 Shotgun',  category: 'weapon', weight: 3.4, stack: 1, legal: true,  weapon: 'sg12' },
  vx9:        { id: 'vx9',   name: 'VX-9 SMG',       category: 'weapon', weight: 2.6, stack: 1, legal: false, weapon: 'vx9' },
  ar7:        { id: 'ar7',   name: 'AR-7 Rifle',     category: 'weapon', weight: 3.8, stack: 1, legal: false, weapon: 'ar7' },
  ls50:       { id: 'ls50',  name: 'LS-50 Marksman', category: 'weapon', weight: 5.0, stack: 1, legal: false, weapon: 'ls50' },
  // Ammo
  ammo_9mm:   { id: 'ammo_9mm', name: '9mm Rounds',      category: 'ammo', weight: 0.01, stack: 500, legal: true },
  ammo_44:    { id: 'ammo_44',  name: '.44 Rounds',      category: 'ammo', weight: 0.02, stack: 200, legal: true },
  ammo_12g:   { id: 'ammo_12g', name: '12g Shells',      category: 'ammo', weight: 0.04, stack: 200, legal: true },
  ammo_556:   { id: 'ammo_556', name: '5.56 Rounds',     category: 'ammo', weight: 0.012, stack: 500, legal: false },
  ammo_308:   { id: 'ammo_308', name: '.308 Rounds',     category: 'ammo', weight: 0.025, stack: 200, legal: false },
  // Consumables
  burger:     { id: 'burger',   name: 'Burger',          category: 'food',  weight: 0.3, stack: 20, legal: true, use: { hunger: 40 } },
  sandwich:   { id: 'sandwich', name: 'Sandwich',        category: 'food',  weight: 0.2, stack: 20, legal: true, use: { hunger: 25 } },
  apple:      { id: 'apple',    name: 'Apple',           category: 'food',  weight: 0.1, stack: 30, legal: true, use: { hunger: 10, thirst: 5 } },
  water:      { id: 'water',    name: 'Water Bottle',    category: 'drink', weight: 0.5, stack: 20, legal: true, use: { thirst: 45 } },
  soda:       { id: 'soda',     name: 'Fizz Cola',       category: 'drink', weight: 0.35, stack: 20, legal: true, use: { thirst: 30 } },
  coffee:     { id: 'coffee',   name: 'Coffee',          category: 'drink', weight: 0.3, stack: 20, legal: true, use: { thirst: 20, hunger: 5 } },
  bandage:    { id: 'bandage',  name: 'Bandage',         category: 'medical', weight: 0.1, stack: 20, legal: true, use: { health: 20 } },
  medkit:     { id: 'medkit',   name: 'First-Aid Kit',   category: 'medical', weight: 1.0, stack: 5, legal: true, use: { health: 60 } },
  // Documents / tools / goods
  id_card:    { id: 'id_card',  name: 'Citizen ID Card', category: 'document', weight: 0, stack: 1, legal: true },
  lockpick:   { id: 'lockpick', name: 'Lockpick',        category: 'material', weight: 0.1, stack: 10, legal: false },
  repairkit:  { id: 'repairkit',name: 'Repair Kit',      category: 'material', weight: 2.0, stack: 5, legal: true },
  jerrycan:   { id: 'jerrycan', name: 'Jerry Can (20L)', category: 'material', weight: 4.0, stack: 3, legal: true },
  scrap:      { id: 'scrap',    name: 'Scrap Metal',     category: 'material', weight: 1.5, stack: 50, legal: true },
  electronics:{ id: 'electronics', name: 'Electronics',  category: 'goods', weight: 0.8, stack: 50, legal: true },
  jewelry:    { id: 'jewelry',  name: 'Stolen Jewelry',  category: 'goods', weight: 0.2, stack: 50, legal: false },
  package:    { id: 'package',  name: 'Delivery Parcel', category: 'goods', weight: 2.0, stack: 10, legal: true },
};

export const MAX_CARRY_WEIGHT = 40;

export type VehicleDef = {
  id: string; name: string; kind: 'car' | 'police' | 'ambulance' | 'motorcycle' | 'truck' | 'van' | 'taxi' | 'firetruck';
  price: number; maxSpeed: number; accel: number; turn: number; length: number; width: number;
  fuelCapacity: number; fuelPerKm: number; siren: boolean; seats: number; job: string | null;
};

export const VEHICLES: Record<string, VehicleDef> = {
  sedan:     { id: 'sedan',     name: 'Valor Sedan',       kind: 'car',        price: 18000, maxSpeed: 420, accel: 260, turn: 2.6, length: 60, width: 28, fuelCapacity: 50, fuelPerKm: 2.2, siren: false, seats: 4, job: null },
  coupe:     { id: 'coupe',     name: 'Stinger GT',        kind: 'car',        price: 64000, maxSpeed: 560, accel: 380, turn: 2.9, length: 58, width: 28, fuelCapacity: 45, fuelPerKm: 3.2, siren: false, seats: 2, job: null },
  hatch:     { id: 'hatch',     name: 'Pico Hatchback',    kind: 'car',        price: 9500,  maxSpeed: 360, accel: 230, turn: 3.0, length: 50, width: 26, fuelCapacity: 35, fuelPerKm: 1.6, siren: false, seats: 4, job: null },
  bike:      { id: 'bike',      name: 'Rapido 600',        kind: 'motorcycle', price: 12000, maxSpeed: 520, accel: 420, turn: 3.4, length: 36, width: 14, fuelCapacity: 15, fuelPerKm: 1.0, siren: false, seats: 2, job: null },
  van:       { id: 'van',       name: 'Hauler Van',        kind: 'van',        price: 26000, maxSpeed: 340, accel: 180, turn: 2.2, length: 68, width: 32, fuelCapacity: 70, fuelPerKm: 3.0, siren: false, seats: 2, job: null },
  truck:     { id: 'truck',     name: 'Ironline Box Truck',kind: 'truck',      price: 48000, maxSpeed: 300, accel: 130, turn: 1.8, length: 96, width: 36, fuelCapacity: 120,fuelPerKm: 4.5, siren: false, seats: 2, job: null },
  taxi:      { id: 'taxi',      name: 'Yellow Line Cab',   kind: 'taxi',       price: 0,     maxSpeed: 410, accel: 250, turn: 2.6, length: 60, width: 28, fuelCapacity: 50, fuelPerKm: 2.2, siren: false, seats: 4, job: 'taxi' },
  police:    { id: 'police',    name: 'Interceptor',       kind: 'police',     price: 0,     maxSpeed: 540, accel: 360, turn: 2.8, length: 62, width: 29, fuelCapacity: 60, fuelPerKm: 2.8, siren: true,  seats: 4, job: 'police' },
  ambulance: { id: 'ambulance', name: 'Medic Unit',        kind: 'ambulance',  price: 0,     maxSpeed: 400, accel: 220, turn: 2.2, length: 76, width: 34, fuelCapacity: 80, fuelPerKm: 3.4, siren: true,  seats: 4, job: 'paramedic' },
};

export type ShopDef = { id: string; buildingType: string; name: string; items: { item: string; price: number; requires?: string }[]; sells?: { item: string; price: number }[] };

export const SHOPS: ShopDef[] = [
  { id: 'supermarket', buildingType: 'supermarket', name: 'FreshMart', items: [
    { item: 'apple', price: 3 }, { item: 'sandwich', price: 8 }, { item: 'water', price: 4 }, { item: 'soda', price: 5 },
    { item: 'bandage', price: 25 }, { item: 'medkit', price: 120 }, { item: 'repairkit', price: 350 }, { item: 'jerrycan', price: 90 } ] },
  { id: 'convenience', buildingType: 'convenience', name: 'QuickStop 24/7', items: [
    { item: 'sandwich', price: 10 }, { item: 'water', price: 5 }, { item: 'soda', price: 6 }, { item: 'coffee', price: 4 }, { item: 'bandage', price: 30 } ] },
  { id: 'diner', buildingType: 'restaurant', name: "Rosie's Diner", items: [ { item: 'burger', price: 14 }, { item: 'coffee', price: 3 }, { item: 'soda', price: 4 } ] },
  { id: 'gasstation', buildingType: 'gasstation', name: 'Fuel Co. Kiosk', items: [ { item: 'jerrycan', price: 110 }, { item: 'water', price: 5 }, { item: 'repairkit', price: 400 } ] },
  { id: 'gunstore', buildingType: 'gunstore', name: 'Liberty Arms', items: [
    { item: 'bat', price: 60 }, { item: 'knife', price: 150 },
    { item: 'p9', price: 1400, requires: 'firearms' }, { item: 'r44', price: 2600, requires: 'firearms' }, { item: 'sg12', price: 3800, requires: 'firearms' },
    { item: 'ammo_9mm', price: 2, requires: 'firearms' }, { item: 'ammo_44', price: 4, requires: 'firearms' }, { item: 'ammo_12g', price: 5, requires: 'firearms' } ] },
  { id: 'blackmarket', buildingType: 'blackmarket', name: 'The Basement', items: [
    { item: 'p9', price: 2400 }, { item: 'vx9', price: 6500 }, { item: 'ar7', price: 14000 }, { item: 'ls50', price: 22000 },
    { item: 'ammo_9mm', price: 4 }, { item: 'ammo_556', price: 6 }, { item: 'ammo_308', price: 12 }, { item: 'lockpick', price: 250 } ],
    sells: [ { item: 'jewelry', price: 420 }, { item: 'electronics', price: 160 } ] },
  { id: 'scrap', buildingType: 'warehouse', name: 'Pier 9 Buyers', items: [], sells: [ { item: 'scrap', price: 35 }, { item: 'electronics', price: 110 } ] },
];

export const LICENSES: Record<string, { name: string; price: number; building: string }> = {
  driving:  { name: 'Driving License',  price: 500,  building: 'cityhall' },
  firearms: { name: 'Firearms License', price: 7500, building: 'police' },
  trucking: { name: 'Commercial Trucking License', price: 2500, building: 'cityhall' },
  business: { name: 'Business License', price: 15000, building: 'cityhall' },
};

export type JobDef = {
  id: string; name: string; category: 'civilian' | 'government' | 'criminal'; building: string;
  ranks: { name: string; salary: number }[]; vehicle: string | null; equipment: string[];
  requiresLicense?: string; requiresClean?: boolean;
};

export const JOBS: Record<string, JobDef> = {
  unemployed: { id: 'unemployed', name: 'Unemployed', category: 'civilian', building: 'cityhall', ranks: [{ name: 'Citizen', salary: 25 }], vehicle: null, equipment: [] },
  taxi:       { id: 'taxi', name: 'Taxi Driver', category: 'civilian', building: 'taxidepot', ranks: [{ name: 'Driver', salary: 60 }, { name: 'Senior Driver', salary: 90 }, { name: 'Dispatcher', salary: 130 }], vehicle: 'taxi', equipment: [], requiresLicense: 'driving' },
  delivery:   { id: 'delivery', name: 'Delivery Driver', category: 'civilian', building: 'deliveryhub', ranks: [{ name: 'Courier', salary: 55 }, { name: 'Route Lead', salary: 85 }], vehicle: 'van', equipment: [], requiresLicense: 'driving' },
  trucker:    { id: 'trucker', name: 'Truck Driver', category: 'civilian', building: 'truckdepot', ranks: [{ name: 'Hauler', salary: 75 }, { name: 'Long-Haul', salary: 110 }], vehicle: 'truck', equipment: [], requiresLicense: 'trucking' },
  mechanic:   { id: 'mechanic', name: 'Mechanic', category: 'civilian', building: 'mechanic', ranks: [{ name: 'Apprentice', salary: 60 }, { name: 'Mechanic', salary: 95 }, { name: 'Shop Foreman', salary: 140 }], vehicle: 'van', equipment: ['repairkit'] },
  police:     { id: 'police', name: 'Police Officer', category: 'government', building: 'police', ranks: [{ name: 'Cadet', salary: 90 }, { name: 'Officer', salary: 120 }, { name: 'Sergeant', salary: 160 }, { name: 'Lieutenant', salary: 210 }, { name: 'Captain', salary: 280 }], vehicle: 'police', equipment: ['p9', 'ammo_9mm', 'bandage'], requiresClean: true },
  paramedic:  { id: 'paramedic', name: 'Paramedic', category: 'government', building: 'hospital', ranks: [{ name: 'EMT', salary: 95 }, { name: 'Paramedic', salary: 130 }, { name: 'Doctor', salary: 200 }], vehicle: 'ambulance', equipment: ['medkit', 'bandage'], requiresClean: true },
  gang:       { id: 'gang', name: 'Street Crew', category: 'criminal', building: 'blackmarket', ranks: [{ name: 'Associate', salary: 0 }, { name: 'Soldier', salary: 0 }, { name: 'Lieutenant', salary: 0 }, { name: 'Boss', salary: 0 }], vehicle: null, equipment: ['lockpick'] },
};

export const ECONOMY = {
  startingCash: 500,
  startingBank: 2500,
  salaryIntervalMs: 5 * 60_000,
  incomeTaxRate: 0.08,
  hospitalFee: 350,
  respawnMs: 10_000,
  fuelPricePerLiter: 3,
  repairCostPerPoint: 12,
  maxTransfer: 1_000_000,
  npcCashDrop: [5, 60] as [number, number],
};

export function catalog() {
  return { weapons: WEAPONS, items: ITEMS, vehicles: VEHICLES, shops: SHOPS, licenses: LICENSES, jobs: JOBS, economy: ECONOMY, maxCarryWeight: MAX_CARRY_WEIGHT };
}
