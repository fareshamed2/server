import type { Account, Appearance, Inventory } from './repo.ts';

export interface Session {
  id: number;
  account: Account | null;
  player: Player | null;
  send(msg: object): void;
  close(code?: number, reason?: string): void;
}

export type Anim = 'idle' | 'walk' | 'run' | 'sit' | 'dead' | 'drive' | 'interact';

export interface Mission {
  kind: string;               // taxi | delivery | trucker | mechanic | robbery | chop
  stage: number;
  target: { x: number; y: number; name: string };
  reward: number;
  xp: number;
  startedAt: number;
  data?: Record<string, unknown>;
}

export interface Player {
  id: string;                 // "p<charId>"
  charId: number;
  accountId: number;
  role: Account['role'];
  name: string;
  citizenId: string;
  appearance: Appearance;
  session: Session;

  x: number; y: number; rot: number; anim: Anim;
  lastMoveAt: number;
  vehicleId: string | null;

  health: number; stamina: number; hunger: number; thirst: number;
  cash: number; bank: number;
  inventory: Inventory;
  licenses: string[];
  job: string; jobRank: number; jobXp: number;
  wanted: number; lastCrimeAt: number; charges: string[]; lastDispatchAt: number;

  weapon: string;             // equipped weapon id ('fists' default)
  clips: Record<string, number>;
  lastFireAt: number;
  reloadUntil: number;
  deadUntil: number;          // 0 = alive
  lastDamageAt: number;
  cuffedBy: string | null;
  jailUntil: number;          // epoch ms, 0 = free
  mission: Mission | null;
  jobVehicleId: string | null;

  joinedAt: number;
  lastSavedAt: number;
  violations: number;
  busy: boolean;              // serialises economy operations
  dirtyStats: boolean;
  lastChatAt: number;
  invulnerableUntil: number;
  lastRestAt?: number;
}

export type VehicleKind = 'owned' | 'job' | 'public' | 'traffic';

export interface Vehicle {
  id: string;                 // "v<n>"
  dbId: number | null;
  kind: VehicleKind;
  model: string;
  plate: string;
  color: string;
  ownerCharId: number | null;
  jobOwner: string | null;    // player id allowed to drive a job vehicle
  x: number; y: number; rot: number; speed: number;
  lastUpdateAt: number;
  driver: string | null;
  locked: boolean;
  fuel: number;               // liters
  engine: number;             // 0..100
  siren: boolean;
  wreckedAt: number;
  home: { x: number; y: number; rot: number } | null;
  /** Recent server-timestamped positions, used for jitter-proof speed estimates. */
  track?: { t: number; x: number; y: number }[];
  lastCrashAt?: number;
  traffic?: { dir: number; laneX: number; laneY: number; stuckFor: number; nextTurnAt: number };
}

export type NpcState = 'walk' | 'flee' | 'dead' | 'idle';

export interface Npc {
  id: string;                 // "n<n>"
  seed: number;               // client derives appearance from this
  x: number; y: number; rot: number;
  state: NpcState;
  health: number;
  from: number; to: number;   // ped graph edge
  speed: number;
  fleeFrom: { x: number; y: number } | null;
  stateUntil: number;
  respawnAt: number;
}

export interface Pickup {
  id: string;                 // "i<n>"
  x: number; y: number;
  item: string | 'cash';
  qty: number;
  expiresAt: number;
}

export interface EmergencyCall {
  id: number; from: string; fromName: string; x: number; y: number; text: string; service: 'police' | 'ems'; at: number;
}
