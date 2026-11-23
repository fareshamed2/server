import type { GameWorld } from './world.ts';
import type { Player, Vehicle, Mission } from './types.ts';
import { JOBS, ITEMS, VEHICLES, LICENSES } from './content.ts';
import { GameError } from './repo.ts';
import { dist } from '../world/map.ts';
import * as combat from './combat.ts';
import * as chat from './chat.ts';
import { tr, wire } from './i18n.ts';

const MAX_WANTED = 5;
const robberyCooldown = new Map<number, number>(); // building id -> available at
const breakdowns = new Map<string, string>();      // vehicle id -> mechanic player id

const onDuty = (w: GameWorld, job: string) => [...w.players.values()].filter(p => p.job === job && !p.deadUntil);

function districtAt(w: GameWorld, x: number, y: number) {
  const d = (w.map.data as any).districts.find((d: any) => x >= d.rect.x - 160 && x <= d.rect.x + d.rect.w + 160 && y >= d.rect.y - 160 && y <= d.rect.y + d.rect.h + 160);
  return d?.name ?? 'the city';
}

/** Raises a player's wanted level and alerts police (throttled). stars=0 only alerts. */
export function commitCrime(w: GameWorld, p: Player, stars: number, offense: string, alertOnly = false) {
  const now = Date.now();
  if (stars > 0 && !alertOnly) {
    p.wanted = Math.min(MAX_WANTED, p.wanted + stars);
    if (!p.charges.includes(offense)) p.charges.push(offense);
    p.dirtyStats = true;
  }
  p.lastCrimeAt = now;
  if (now - p.lastDispatchAt > 20_000 && (stars > 0 || alertOnly)) {
    p.lastDispatchAt = now;
    const text = p.wanted ? tr('{0} reported in {1} — suspect {2} ({3}★)', offense, districtAt(w, p.x, p.y), p.name, p.wanted) : tr('{0} reported in {1}', offense, districtAt(w, p.x, p.y));
    for (const cop of onDuty(w, 'police')) cop.session.send({ t: 'dispatch', ...wire(text, 'text'), x: Math.round(p.x), y: Math.round(p.y), suspect: p.id });
  }
}

// ---- careers ---------------------------------------------------------------------------------
export function onJoin(w: GameWorld, p: Player, m: any) {
  return w.exclusive(p, async () => {
    const job = JOBS[m.job];
    if (!job || job.id === 'unemployed') throw new GameError('Unknown job');
    const b = w.map.data.buildings.find(b => b.type === job.building && dist(b.door.x, b.door.y, p.x, p.y) < 100);
    if (!b) throw new GameError(tr('Apply in person at the {0}', w.map.buildingsOfType(job.building)[0]?.name ?? 'job office'));
    if (p.job === job.id) throw new GameError(tr('You already work as {0}', job.name));
    if (job.requiresLicense && !p.licenses.includes(job.requiresLicense)) throw new GameError(tr('Application rejected: requires a {0}', LICENSES[job.requiresLicense].name));
    if (job.requiresClean) {
      if (p.wanted > 0) throw new GameError('Application rejected: you are currently wanted');
      const record = await w.repo.criminalRecord(p.charId);
      if (record.length > 0) throw new GameError('Application rejected: background check found a criminal record');
    }
    if (job.category === 'criminal' && (p.job === 'police' || p.job === 'paramedic')) throw new GameError('They don\'t trust you…');
    await leaveJob(w, p, false);
    await w.repo.setJob(p.charId, job.id, 0);
    p.job = job.id; p.jobRank = 0; p.jobXp = 0;
    // Issue job equipment the player doesn't already carry.
    const items: Record<string, number> = {};
    for (const e of job.equipment) if (!(p.inventory[e] > 0)) items[e] = ITEMS[e].category === 'ammo' ? 48 : 1;
    if (Object.keys(items).length) w.applyMoney(p, await w.repo.mutate(p.charId, { items }, 'items'));
    w.sendStats(p);
    w.broadcast({ t: 'pinfo', players: [w.playerInfo(p)] });
    w.toast(p, tr('Hired: {0}, {1}. Salary ${2}/paycheck', job.ranks[0].name, job.name, job.ranks[0].salary), 'good');
  });
}

async function leaveJob(w: GameWorld, p: Player, persist = true) {
  if (p.jobVehicleId) {
    const v = w.vehicles.get(p.jobVehicleId);
    if (v) { for (const q of w.players.values()) if (q.vehicleId === v.id) w.exitVehicle(q); w.vehicles.delete(v.id); }
    p.jobVehicleId = null;
  }
  if (p.mission) { p.mission = null; p.session.send({ t: 'mission', mission: null }); }
  if (persist) { await w.repo.setJob(p.charId, 'unemployed', 0); p.job = 'unemployed'; p.jobRank = 0; p.jobXp = 0; }
}

export function onQuit(w: GameWorld, p: Player) {
  return w.exclusive(p, async () => {
    if (p.job === 'unemployed') throw new GameError('You have no job');
    const name = JOBS[p.job].name;
    await leaveJob(w, p);
    w.sendStats(p);
    w.broadcast({ t: 'pinfo', players: [w.playerInfo(p)] });
    w.toast(p, tr('You resigned as {0}', name));
  });
}

export function onJobVehicle(w: GameWorld, p: Player) {
  const job = JOBS[p.job];
  if (!job?.vehicle) return w.toast(p, 'Your job has no vehicle', 'bad');
  const b = w.map.data.buildings.find(b => b.type === job.building && dist(b.door.x, b.door.y, p.x, p.y) < 260);
  if (!b) return w.toast(p, tr('Collect it at {0}', w.map.buildingsOfType(job.building)[0]?.name), 'bad');
  if (p.jobVehicleId) {
    const old = w.vehicles.get(p.jobVehicleId);
    if (old?.driver && old.driver !== p.id) return w.toast(p, 'Your job vehicle is in use', 'bad');
    if (old) { if (old.driver) w.exitVehicle(p); w.vehicles.delete(old.id); }
  }
  const kindMap: Record<string, string> = { police: 'police', ambulance: 'ambulance', taxi: 'taxi', van: 'van', truck: 'truck' };
  const spots = w.map.data.props.parkingSpots.filter(s => s.kind === kindMap[job.vehicle!]);
  const spot = spots.sort((a, c) => dist(a.x, a.y, p.x, p.y) - dist(c.x, c.y, p.x, p.y))
    .find(s => ![...w.vehicles.values()].some(v => dist(v.x, v.y, s.x, s.y) < 60)) ?? { x: b.door.x, y: b.door.y - 70, rot: 0 };
  const v = w.addVehicle({ kind: 'job', model: job.vehicle, x: spot.x, y: spot.y, rot: spot.rot, locked: false });
  v.jobOwner = p.id; v.fuel = VEHICLES[v.model].fuelCapacity;
  p.jobVehicleId = v.id;
  p.session.send({ t: 'waypoint', x: v.x, y: v.y, label: VEHICLES[v.model].name });
  w.toast(p, tr('Your {0} is ready ({1})', VEHICLES[v.model].name, v.plate), 'good');
}

// ---- missions ---------------------------------------------------------------------------------
const DESTINATION_TYPES: Record<string, string[]> = {
  taxi: ['house', 'apartments', 'restaurant', 'supermarket', 'hospital', 'bank', 'cityhall', 'clothing', 'shop', 'office'],
  delivery: ['house', 'shop', 'office', 'apartments', 'restaurant', 'convenience'],
  trucker: ['warehouse', 'factory', 'supermarket', 'gasstation', 'convenience'],
};

function randomDestination(w: GameWorld, types: string[], fromX: number, fromY: number, minDist = 900) {
  const cands = w.map.data.buildings.filter(b => types.includes(b.type) && dist(b.door.x, b.door.y, fromX, fromY) > minDist);
  const b = cands[Math.floor(Math.random() * cands.length)] ?? w.map.data.buildings[0];
  return { x: b.door.x, y: b.door.y, name: b.name };
}

export function onMission(w: GameWorld, p: Player, m: any) {
  if (m.op === 'cancel') { p.mission = null; p.session.send({ t: 'mission', mission: null }); return; }
  if (p.mission) return w.toast(p, 'Finish your current job first', 'bad');
  const job = JOBS[p.job];
  const v = p.vehicleId ? w.vehicles.get(p.vehicleId) : null;
  if (['taxi', 'delivery', 'trucker'].includes(p.job)) {
    if (!v || v.model !== job.vehicle) return w.toast(p, tr('Get in your {0} first', VEHICLES[job.vehicle!].name), 'bad');
    let mission: Mission;
    if (p.job === 'taxi') {
      const nodes = w.map.data.pedGraph.nodes.filter(n => dist(n.x, n.y, p.x, p.y) > 400 && dist(n.x, n.y, p.x, p.y) < 1600);
      const pick = nodes[Math.floor(Math.random() * nodes.length)] ?? w.map.data.pedGraph.nodes[0];
      mission = { kind: 'taxi', stage: 0, target: { x: pick.x, y: pick.y, name: 'Passenger pickup' }, reward: 0, xp: 1, startedAt: Date.now() };
    } else {
      const dest = randomDestination(w, DESTINATION_TYPES[p.job], p.x, p.y);
      const reward = Math.round((p.job === 'trucker' ? 1.6 : 1) * (90 + dist(dest.x, dest.y, p.x, p.y) * 0.09));
      mission = { kind: p.job, stage: 1, target: dest, reward, xp: 1, startedAt: Date.now() };
    }
    p.mission = mission;
    p.session.send({ t: 'mission', mission });
    return;
  }
  if (p.job === 'mechanic') {
    // A broken-down civilian car appears somewhere on the road network.
    const roads = w.map.data.roads.centers;
    const c = roads[1 + Math.floor(Math.random() * (roads.length - 2))];
    const along = (roads[0] + 6 + Math.random() * (roads[roads.length - 1] - roads[0] - 12)) * 32;
    const pos = Math.random() < 0.5 ? { x: (c + 1) * 32, y: along, rot: Math.PI / 2 } : { x: along, y: (c - 1) * 32, rot: 0 };
    const car = w.addVehicle({ kind: 'public', model: Math.random() < 0.5 ? 'sedan' : 'hatch', ...pos, locked: true });
    car.engine = 8;
    breakdowns.set(car.id, p.id);
    p.mission = { kind: 'mechanic', stage: 1, target: { x: pos.x, y: pos.y, name: 'Broken-down vehicle' }, reward: 320, xp: 1, startedAt: Date.now(), data: { vehicle: car.id } };
    p.session.send({ t: 'mission', mission: p.mission });
    return;
  }
  w.toast(p, 'No missions for your job here', 'bad');
}

async function completeMission(w: GameWorld, p: Player, reward: number, memo: string) {
  const mission = p.mission!;
  p.mission = null;
  p.session.send({ t: 'mission', mission: null });
  await w.exclusive(p, async () => {
    w.applyMoney(p, await w.repo.mutate(p.charId, { bank: reward }, 'job_pay', memo));
    p.jobXp += mission.xp;
    const job = JOBS[p.job];
    if (job && p.jobRank < job.ranks.length - 1 && p.jobXp >= (p.jobRank + 1) * 5) {
      p.jobRank++; p.jobXp = 0;
      await w.repo.setJob(p.charId, p.job, p.jobRank);
      w.toast(p, tr('Promoted to {0}!', job.ranks[p.jobRank].name), 'good');
      w.broadcast({ t: 'pinfo', players: [w.playerInfo(p)] });
    }
    w.sendStats(p);
    w.toast(p, tr('{0}: +${1}', memo, reward), 'good');
  });
}

export function checkMissionArrival(w: GameWorld, p: Player) {
  const m = p.mission;
  if (!m || p.busy) return;
  if (m.kind === 'robbery' || m.kind === 'mechanic') return;
  if (dist(p.x, p.y, m.target.x, m.target.y) > 110) return;
  const v = p.vehicleId ? w.vehicles.get(p.vehicleId) : null;
  if (!v || v.speed > 60) return; // must stop at the destination in a vehicle
  if (m.kind === 'taxi' && m.stage === 0) {
    const dest = randomDestination(w, DESTINATION_TYPES.taxi, p.x, p.y);
    p.mission = { ...m, stage: 1, target: dest, reward: Math.round(60 + dist(dest.x, dest.y, p.x, p.y) * 0.11) };
    p.session.send({ t: 'mission', mission: p.mission });
    w.toast(p, tr('Passenger: "Take me to {0}, please."', dest.name));
    return;
  }
  if (m.kind === 'chop') {
    const veh = v;
    p.mission = null;
    p.session.send({ t: 'mission', mission: null });
    w.exitVehicle(p);
    const payout = Math.round(VEHICLES[veh.model].price * 0.08 * (p.job === 'gang' ? 1.25 : 1));
    if (veh.home) { Object.assign(veh, veh.home); veh.engine = 100; veh.locked = true; }
    else w.vehicles.delete(veh.id);
    w.exclusive(p, async () => { w.applyMoney(p, await w.repo.mutate(p.charId, { cash: payout }, 'illegal_sale', 'Chop shop')); w.toast(p, tr('Chop shop paid ${0} cash', payout), 'good'); });
    return;
  }
  const label = { taxi: 'Taxi fare', delivery: 'Delivery completed', trucker: 'Freight delivered' }[m.kind] ?? 'Job completed';
  completeMission(w, p, m.reward, label);
}

/** Per-tick job logic: robberies in progress and mechanic breakdowns. */
export function update(w: GameWorld) {
  if (w.tick % 5 !== 0) return;
  const now = Date.now();
  for (const p of w.players.values()) {
    const m = p.mission;
    if (!m) continue;
    if (m.kind === 'robbery') {
      if (p.deadUntil || p.cuffedBy || dist(p.x, p.y, m.target.x, m.target.y) > 160) {
        p.mission = null; p.session.send({ t: 'mission', mission: null });
        w.toast(p, 'Robbery failed — you left the scene', 'bad');
      } else if (now >= (m.data!.endsAt as number)) {
        p.mission = null; p.session.send({ t: 'mission', mission: null });
        const take = m.reward;
        w.exclusive(p, async () => { w.applyMoney(p, await w.repo.mutate(p.charId, { cash: take }, 'robbery', m.target.name)); w.toast(p, tr('You got away with ${0}!', take), 'good'); });
      }
    } else if (m.kind === 'mechanic') {
      const car = w.vehicles.get(m.data!.vehicle as string);
      if (!car) { p.mission = null; p.session.send({ t: 'mission', mission: null }); continue; }
      if (car.engine >= 50) {
        breakdowns.delete(car.id);
        car.kind = 'public'; car.home = { x: car.x, y: car.y, rot: car.rot };
        completeMission(w, p, m.reward, 'Breakdown repaired');
      }
    }
  }
}

// ---- crime ------------------------------------------------------------------------------------
export function onCrime(w: GameWorld, p: Player, m: any) {
  if (!w.canAct(p) || p.jailUntil) return;
  if (m.op === 'rob') {
    const b = w.map.buildingById(Number(m.building));
    const robbable: Record<string, [number, number, number]> = { convenience: [600, 1400, 20], gasstation: [500, 1200, 20], supermarket: [900, 2200, 30], restaurant: [400, 900, 15], gunstore: [1200, 2600, 35], bank: [6000, 14000, 60] };
    if (!b || !robbable[b.type] || dist(b.door.x, b.door.y, p.x, p.y) > 100) return w.toast(p, 'Nothing to rob here', 'bad');
    const weapon = combat.ownsWeapon(p, p.weapon) ? p.weapon : 'fists';
    if (weapon === 'fists' || ['bat', 'knife'].includes(weapon)) return w.toast(p, 'You need a firearm to rob this place', 'bad');
    if ((robberyCooldown.get(b.id) ?? 0) > Date.now()) return w.toast(p, 'This place was robbed recently — the register is empty', 'bad');
    if (p.mission) return w.toast(p, 'Finish what you are doing first', 'bad');
    const [lo, hi, secs] = robbable[b.type];
    if (onDuty(w, 'police').length === 0 && b.type === 'bank') return w.toast(p, 'The vault is on a time lock (no police on duty)', 'bad');
    robberyCooldown.set(b.id, Date.now() + 10 * 60_000);
    p.mission = { kind: 'robbery', stage: 1, target: { x: b.door.x, y: b.door.y, name: b.name }, reward: lo + Math.floor(Math.random() * (hi - lo)), xp: 0, startedAt: Date.now(), data: { endsAt: Date.now() + secs * 1000, building: b.id } };
    p.session.send({ t: 'mission', mission: p.mission });
    p.lastDispatchAt = 0;
    commitCrime(w, p, 3, 'Armed robbery');
    w.broadcastNear(b.door.x, b.door.y, 1200, { t: 'sfx', k: 'alarm', x: b.door.x, y: b.door.y });
    w.toast(p, tr('Robbery started — hold the area for {0}s', secs), 'bad');
    return;
  }
  if (m.op === 'chop') {
    const v = p.vehicleId ? w.vehicles.get(p.vehicleId) : null;
    if (!v || v.kind === 'owned' || v.kind === 'job') return w.toast(p, 'Bring a stolen civilian vehicle', 'bad');
    const dest = w.map.buildingsOfType('warehouse').find(b => b.interactive)!;
    p.mission = { kind: 'chop', stage: 1, target: { x: dest.door.x, y: dest.door.y, name: dest.name }, reward: 0, xp: 0, startedAt: Date.now() };
    p.session.send({ t: 'mission', mission: p.mission });
    return;
  }
}

// ---- police -----------------------------------------------------------------------------------
export function onPolice(w: GameWorld, p: Player, m: any) {
  if (p.job !== 'police') return w.toast(p, 'Police only', 'bad');
  if (!w.canAct(p)) return;
  return w.exclusive(p, async () => {
    const target = m.target ? w.players.get(String(m.target)) : null;
    const near = (r: number) => { if (!target || target === p || dist(target.x, target.y, p.x, p.y) > r) throw new GameError('Suspect is not close enough'); return target; };
    switch (m.op) {
      case 'cuff': {
        const t = near(60);
        if (t.vehicleId) throw new GameError('Get them out of the vehicle first');
        t.cuffedBy = t.cuffedBy ? null : p.id;
        t.dirtyStats = true;
        w.broadcastNear(t.x, t.y, 400, { t: 'sfx', k: 'cuffs', x: t.x, y: t.y });
        w.toast(p, t.cuffedBy ? tr('{0} restrained', t.name) : tr('{0} released', t.name), 'good');
        w.toast(t, t.cuffedBy ? tr('You have been handcuffed by Officer {0}', p.name) : 'Your handcuffs were removed');
        return;
      }
      case 'search': {
        const t = near(60);
        if (!t.cuffedBy) throw new GameError('Restrain the suspect first');
        p.session.send({ t: 'search_result', target: t.id, name: t.name, items: t.inventory, cash: t.cash });
        return;
      }
      case 'seize': {
        const t = near(60);
        if (!t.cuffedBy) throw new GameError('Restrain the suspect first');
        const illegal = Object.fromEntries(Object.entries(t.inventory).filter(([id]) => ITEMS[id] && !ITEMS[id].legal).map(([id, q]) => [id, -q]));
        if (!Object.keys(illegal).length) throw new GameError('No contraband found');
        w.applyMoney(t, await w.repo.mutate(t.charId, { items: illegal }, 'items'));
        await w.repo.addCriminalRecord(t.charId, `Possession of contraband: ${Object.keys(illegal).map(i => ITEMS[i].name).join(', ')}`, p.charId, 0, 0);
        if (illegal[t.weapon]) t.weapon = 'fists';
        w.toast(p, 'Contraband seized and logged as evidence', 'good');
        w.toast(t, 'Your contraband was confiscated', 'bad');
        return;
      }
      case 'arrest': {
        const t = near(80);
        if (!t.cuffedBy) throw new GameError('Restrain the suspect first');
        const stars = Math.max(1, t.wanted);
        const jailS = stars * 60;
        let fine = stars * 500;
        fine = Math.min(fine, t.cash + t.bank);
        const fromCash = Math.min(fine, t.cash);
        if (fine > 0) w.applyMoney(t, await w.repo.mutate(t.charId, { cash: -fromCash, bank: -(fine - fromCash) }, 'fine', `Arrest: ${t.charges.join(', ') || 'Obstruction'}`, p.charId));
        await w.repo.addCriminalRecord(t.charId, t.charges.join(', ') || 'Obstruction of justice', p.charId, fine, jailS);
        const until = Date.now() + jailS * 1000;
        await w.repo.setJail(t.charId, new Date(until));
        t.jailUntil = until; t.cuffedBy = null; t.wanted = 0; t.charges = []; t.mission = null;
        if (t.vehicleId) w.exitVehicle(t);
        Object.assign(t, w.map.data.spawns.jailCell);
        t.session.send({ t: 'correct', x: t.x, y: t.y });
        t.session.send({ t: 'mission', mission: null });
        w.sendStats(t);
        w.toast(t, tr('You were sentenced to {0}s and fined ${1}', jailS, fine), 'bad');
        w.applyMoney(p, await w.repo.mutate(p.charId, { bank: 150 * stars }, 'job_pay', `Arrest bonus: ${t.name}`));
        p.jobXp += stars;
        w.toast(p, tr('{0} booked: {1}s, ${2} fine. Bonus ${3}', t.name, jailS, fine, 150 * stars), 'good');
        chat.radio(w, 'police', 'Dispatch', tr('{0} has been booked by {1}.', t.name, p.name));
        return;
      }
      case 'fine': {
        const t = near(100);
        const amount = Number(m.amount);
        if (!Number.isInteger(amount) || amount <= 0 || amount > 5000) throw new GameError('Fines must be $1–$5000');
        const reason = String(m.reason ?? 'Traffic violation').slice(0, 80);
        const pay = t.bank >= amount ? { bank: -amount } : { cash: -amount };
        w.applyMoney(t, await w.repo.mutate(t.charId, pay, 'fine', reason, p.charId));
        await w.repo.addCriminalRecord(t.charId, `Citation: ${reason}`, p.charId, amount, 0);
        w.toast(t, tr('Officer {0} fined you ${1}: {2}', p.name, amount, reason), 'bad');
        w.toast(p, tr('Citation issued to {0}', t.name), 'good');
        return;
      }
      case 'lookup': {
        const c = await w.repo.lookupCitizen(String(m.query ?? '').slice(0, 40));
        if (!c) throw new GameError('No record found');
        const online = w.players.get(`p${c.id}`);
        const record = await w.repo.criminalRecord(c.id);
        p.session.send({ t: 'police_result', kind: 'citizen', citizen: { name: c.name, citizenId: c.citizen_id, job: c.job, licenses: c.licenses, wanted: online?.wanted ?? c.wanted, charges: online?.charges ?? [], record } });
        return;
      }
      case 'plate': {
        const v = await w.repo.vehicleByPlate(String(m.plate ?? '').slice(0, 12));
        const live = [...w.vehicles.values()].find(x => x.plate.toUpperCase() === String(m.plate ?? '').toUpperCase());
        if (!v && !live) throw new GameError('Plate not registered');
        p.session.send({ t: 'police_result', kind: 'vehicle', vehicle: v ? { plate: v.plate, model: VEHICLES[v.model]?.name, owner: v.owner_name, ownerId: v.owner_cid, color: v.color } : { plate: live!.plate, model: VEHICLES[live!.model].name, owner: live!.kind === 'job' ? 'City of Utopia (fleet)' : 'Unregistered / civilian', ownerId: null, color: live!.color } });
        return;
      }
      case 'promote': case 'demote': {
        const t = target;
        if (!t || t.job !== 'police') throw new GameError('Target must be a police officer');
        if (p.jobRank < 2) throw new GameError('Only Sergeants and above can manage ranks');
        const next = t.jobRank + (m.op === 'promote' ? 1 : -1);
        if (next < 0 || next >= p.jobRank) throw new GameError('You can only manage ranks below your own');
        t.jobRank = next; await w.repo.setJob(t.charId, 'police', next);
        w.sendStats(t); w.broadcast({ t: 'pinfo', players: [w.playerInfo(t)] });
        w.toast(t, tr('You are now {0}', JOBS.police.ranks[next].name), 'good');
        w.toast(p, tr('{0} is now {1}', t.name, JOBS.police.ranks[next].name), 'good');
        return;
      }
      default: throw new GameError('Unknown police action');
    }
  });
}

export function onMedic(w: GameWorld, p: Player, m: any) {
  if (p.job !== 'paramedic') return w.toast(p, 'Paramedics only', 'bad');
  return w.exclusive(p, async () => {
    const t = w.players.get(String(m.target));
    if (!t || t === p || dist(t.x, t.y, p.x, p.y) > 70) throw new GameError('Patient is not close enough');
    if (m.op === 'revive') {
      if (!t.deadUntil) throw new GameError('Patient is conscious');
      combat.revive(w, t, 50);
      w.applyMoney(p, await w.repo.mutate(p.charId, { bank: 250 }, 'job_pay', `Revived ${t.name}`));
      p.jobXp++;
      w.toast(t, tr('Paramedic {0} revived you', p.name), 'good');
      w.toast(p, 'Patient stabilised: +$250', 'good');
    } else if (m.op === 'heal') {
      if (t.deadUntil || t.health >= 100) throw new GameError('Patient does not need treatment');
      if (!(p.inventory.medkit > 0)) throw new GameError('You need a First-Aid Kit');
      w.applyMoney(p, await w.repo.mutate(p.charId, { items: { medkit: -1 }, bank: 80 }, 'job_pay', `Treated ${t.name}`));
      t.health = Math.min(100, t.health + 60); w.sendStats(t);
      w.toast(t, tr('Paramedic {0} treated your wounds', p.name), 'good');
    } else throw new GameError('Unknown medic action');
  });
}

export function onCalls(w: GameWorld, p: Player) {
  const svc = p.job === 'police' ? 'police' : p.job === 'paramedic' ? 'ems' : null;
  if (!svc) return w.toast(p, 'Emergency services only', 'bad');
  p.session.send({ t: 'calls', calls: w.calls.filter(c => c.service === svc && Date.now() - c.at < 15 * 60_000).slice(-20) });
}

export function vehicleOf(w: GameWorld, p: Player): Vehicle | null { return p.vehicleId ? w.vehicles.get(p.vehicleId) ?? null : null; }
