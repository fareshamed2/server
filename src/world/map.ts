import { readFileSync } from 'node:fs';

export type Rect = { x: number; y: number; w: number; h: number };
export type Building = {
  id: number; type: string; name: string; rect: Rect; door: { x: number; y: number; side: string };
  roof: string; roofStyle: string; height: number; zone: string; interactive: boolean;
};
export type WorldData = {
  tileSize: number; width: number; height: number; rows: string[];
  buildings: Building[]; solids: (Rect & { kind: string })[];
  props: { parkingSpots: { x: number; y: number; rot: number; kind: string }[]; pumps: { x: number; y: number }[]; [k: string]: unknown };
  pois: { type: string; name: string; x: number; y: number; radius?: number }[];
  spawns: Record<string, { x: number; y: number }>;
  roads: { centers: number[]; halfWidth: number; extent: { min: number; max: number } };
  pedGraph: { nodes: { x: number; y: number }[]; edges: [number, number][] };
};

const CELL = 256;

/** Spatially hashed world geometry used for collision, line-of-sight and validation. */
export class WorldMap {
  readonly data: WorldData;
  readonly widthUnits: number;
  readonly heightUnits: number;
  private grid = new Map<number, Rect[]>();
  readonly pedNeighbors: number[][];

  constructor(data: WorldData) {
    this.data = data;
    this.widthUnits = data.width * data.tileSize;
    this.heightUnits = data.height * data.tileSize;
    for (const s of data.solids) {
      for (let cx = Math.floor(s.x / CELL); cx <= Math.floor((s.x + s.w) / CELL); cx++)
        for (let cy = Math.floor(s.y / CELL); cy <= Math.floor((s.y + s.h) / CELL); cy++) {
          const k = cx * 10007 + cy;
          (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(s);
        }
    }
    this.pedNeighbors = data.pedGraph.nodes.map(() => []);
    for (const [a, b] of data.pedGraph.edges) { this.pedNeighbors[a].push(b); this.pedNeighbors[b].push(a); }
  }

  static load(path: string): WorldMap { return new WorldMap(JSON.parse(readFileSync(path, 'utf8'))); }

  private nearby(x: number, y: number, r: number): Set<Rect> {
    const out = new Set<Rect>();
    for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++)
      for (let cy = Math.floor((y - r) / CELL); cy <= Math.floor((y + r) / CELL); cy++)
        for (const s of this.grid.get(cx * 10007 + cy) ?? []) out.add(s);
    return out;
  }

  inBounds(x: number, y: number, margin = 0): boolean {
    return x >= margin && y >= margin && x <= this.widthUnits - margin && y <= this.heightUnits - margin;
  }

  /** True if a circle of radius r at (x,y) overlaps any solid. */
  circleBlocked(x: number, y: number, r: number): boolean {
    if (!this.inBounds(x, y, r)) return true;
    for (const s of this.nearby(x, y, r)) {
      const nx = Math.max(s.x, Math.min(x, s.x + s.w)), ny = Math.max(s.y, Math.min(y, s.y + s.h));
      if ((x - nx) ** 2 + (y - ny) ** 2 < r * r) return true;
    }
    return false;
  }

  /**
   * Distance along the segment from (x0,y0) toward (x1,y1) at which it first enters a solid,
   * or null if the segment is clear. Uses slab intersection on axis-aligned rects.
   */
  raycast(x0: number, y0: number, x1: number, y1: number): number | null {
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
    if (len === 0) return null;
    const minX = Math.min(x0, x1), minY = Math.min(y0, y1);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    let best: number | null = null;
    for (const s of this.nearby(cx, cy, len / 2 + 1)) {
      if (s.x > Math.max(x0, x1) || s.x + s.w < minX || s.y > Math.max(y0, y1) || s.y + s.h < minY) continue;
      let tmin = 0, tmax = 1;
      for (const [o, d, lo, hi] of [[x0, dx, s.x, s.x + s.w], [y0, dy, s.y, s.y + s.h]] as const) {
        if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) { tmin = 2; break; } continue; }
        let t1 = (lo - o) / d, t2 = (hi - o) / d;
        if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
        if (tmin > tmax) { tmin = 2; break; }
      }
      if (tmin <= 1 && (best === null || tmin * len < best)) best = tmin * len;
    }
    return best;
  }

  buildingById(id: number): Building | undefined { return this.data.buildings.find(b => b.id === id); }
  buildingsOfType(type: string): Building[] { return this.data.buildings.filter(b => b.type === type); }

  /** Interactive building whose door is within radius of (x,y). */
  buildingAtDoor(x: number, y: number, radius = 70): Building | undefined {
    let best: Building | undefined, bd = radius;
    for (const b of this.data.buildings) {
      if (!b.interactive) continue;
      const d = Math.hypot(b.door.x - x, b.door.y - y);
      if (d <= bd) { bd = d; best = b; }
    }
    return best;
  }

  poiNear(type: string, x: number, y: number, radius = 80) {
    return this.data.pois.find(p => p.type === type && Math.hypot(p.x - x, p.y - y) <= (p.radius ?? radius));
  }

  isRoad(x: number, y: number): boolean {
    const t = this.data.tileSize, tx = Math.floor(x / t), ty = Math.floor(y / t);
    return this.data.rows[ty]?.[tx] === '1';
  }
}

export const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);

/** Distance from point p to segment ab, and the parameter t of the closest point. */
export function pointSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return { d: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t };
}
