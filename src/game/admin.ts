import type { GameWorld } from './world.ts';
import type { Player } from './types.ts';
import { ITEMS, JOBS } from './content.ts';
import { GameError } from './repo.ts';
import * as chat from './chat.ts';
import * as combat from './combat.ts';
import { tr } from './i18n.ts';

const ADMIN_ONLY = new Set(['give_money', 'give_item', 'set_job', 'ban', 'economy']);

/** Every admin action is permission-checked and written to admin_audit before it takes effect. */
export function onAdmin(w: GameWorld, p: Player, m: any) {
  if (p.role !== 'admin' && p.role !== 'moderator') return w.toast(p, 'Not authorised', 'bad');
  if (ADMIN_ONLY.has(m.op) && p.role !== 'admin') return w.toast(p, 'Administrators only', 'bad');
  return w.exclusive(p, async () => {
    const target = m.target ? [...w.players.values()].find(q => q.id === m.target || q.name.toLowerCase() === String(m.target).toLowerCase()) ?? null : null;
    const need = () => { if (!target) throw new GameError('Player not online'); return target; };
    const audit = (details: unknown) => w.repo.audit(p.accountId, m.op, target?.name ?? (m.target ? String(m.target) : null), details);
    switch (m.op) {
      case 'players':
        p.session.send({ t: 'admin_result', op: 'players', players: [...w.players.values()].map(q => ({ id: q.id, name: q.name, account: q.accountId, job: q.job, cash: q.cash, bank: q.bank, wanted: q.wanted, x: Math.round(q.x), y: Math.round(q.y), violations: q.violations })) });
        return;
      case 'economy':
        p.session.send({ t: 'admin_result', op: 'economy', stats: await w.repo.economyStats() });
        return;
      case 'announce': {
        const text = chat.sanitize(m.text);
        if (!text) throw new GameError('Empty announcement');
        await audit({ text });
        w.broadcast({ t: 'announce', text });
        return;
      }
      case 'kick': {
        const t = need();
        await audit({ reason: m.reason });
        t.session.send({ t: 'kicked', reason: String(m.reason ?? 'Kicked by staff').slice(0, 120) });
        t.session.close(4001, 'kicked');
        w.toast(p, tr('{0} kicked', t.name), 'good');
        return;
      }
      case 'ban': {
        const t = need();
        const hours = m.hours === null || m.hours === undefined ? null : Math.max(1, Math.min(24 * 365, Number(m.hours) | 0));
        const reason = String(m.reason ?? 'Rule violation').slice(0, 200);
        await audit({ hours, reason });
        await w.repo.ban(t.accountId, reason, p.accountId, hours);
        t.session.send({ t: 'kicked', reason: `Banned${hours ? ` for ${hours}h` : ''}: ${reason}` });
        t.session.close(4002, 'banned');
        w.toast(p, tr('{0} banned', t.name), 'good');
        return;
      }
      case 'tp': {
        const who = m.bring && target ? target : p;
        const dest = m.bring && target ? { x: p.x + 30, y: p.y } : target ? { x: target.x + 30, y: target.y } : { x: Number(m.x), y: Number(m.y) };
        if (!Number.isFinite(dest.x) || !Number.isFinite(dest.y) || w.map.circleBlocked(dest.x, dest.y, 10)) throw new GameError('Invalid destination');
        await audit({ who: who.name, ...dest });
        if (who.vehicleId) w.exitVehicle(who);
        who.x = dest.x; who.y = dest.y; who.lastMoveAt = Date.now();
        who.session.send({ t: 'correct', x: who.x, y: who.y });
        return;
      }
      case 'heal': {
        const t = target ?? p;
        await audit({});
        if (t.deadUntil) combat.revive(w, t, 100);
        else { t.health = 100; t.hunger = 100; t.thirst = 100; w.sendStats(t); }
        return;
      }
      case 'clear_wanted': {
        const t = need();
        await audit({ was: t.wanted });
        t.wanted = 0; t.charges = []; t.cuffedBy = null; w.sendStats(t);
        return;
      }
      case 'give_money': {
        const t = need(); const amount = Number(m.amount);
        if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 10_000_000) throw new GameError('Invalid amount');
        await audit({ amount });
        w.applyMoney(t, await w.repo.mutate(t.charId, { bank: amount }, 'admin_adjust', `By ${p.name}`));
        w.toast(p, tr('Adjusted {0}\'s bank by ${1}', t.name, amount), 'good');
        return;
      }
      case 'give_item': {
        const t = need(); const qty = Number(m.qty ?? 1);
        if (!ITEMS[m.item] || !Number.isInteger(qty) || qty === 0) throw new GameError('Invalid item');
        await audit({ item: m.item, qty });
        w.applyMoney(t, await w.repo.mutate(t.charId, { items: { [m.item]: qty } }, 'items'));
        w.toast(p, tr('Gave {0}x {1} to {2}', qty, ITEMS[m.item].name, t.name), 'good');
        return;
      }
      case 'set_job': {
        const t = need(); const job = JOBS[m.job]; const rank = Number(m.rank ?? 0);
        if (!job || !Number.isInteger(rank) || rank < 0 || rank >= job.ranks.length) throw new GameError('Invalid job/rank');
        await audit({ job: job.id, rank });
        await w.repo.setJob(t.charId, job.id, rank);
        t.job = job.id; t.jobRank = rank; w.sendStats(t);
        w.broadcast({ t: 'pinfo', players: [w.playerInfo(t)] });
        w.toast(p, tr('{0} is now {1} ({2})', t.name, job.ranks[rank].name, job.name), 'good');
        return;
      }
      case 'audit': {
        const rows = (await w.repo.db.query('SELECT a.action, a.target, a.details, a.created_at, ac.username FROM admin_audit a JOIN accounts ac ON ac.id = a.admin_id ORDER BY a.id DESC LIMIT 30')).rows;
        p.session.send({ t: 'admin_result', op: 'audit', rows });
        return;
      }
      default: throw new GameError('Unknown admin command');
    }
  });
}
