import type { GameWorld } from './world.ts';
import type { Player } from './types.ts';
import { dist } from '../world/map.ts';
import { tr, wire, type Text } from './i18n.ts';

const LOCAL_RADIUS = 520;
const MAX_LEN = 200;

export function system(w: GameWorld, text: Text) {
  w.broadcast({ t: 'chat', ch: 'system', from: 'City', ...wire(text, 'text') });
}

export function radio(w: GameWorld, service: 'police' | 'ems', from: string, text: Text) {
  const jobs = service === 'police' ? ['police'] : ['police', 'paramedic'];
  for (const p of w.players.values()) if (jobs.includes(p.job)) p.session.send({ t: 'chat', ch: service, from, ...wire(text, 'text') });
}

/** Strips control characters and trims to a sane length. */
export function sanitize(s: unknown): string {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_LEN);
}

export function onChat(w: GameWorld, p: Player, m: any) {
  const now = Date.now();
  if (now - p.lastChatAt < 800) return w.toast(p, 'You are sending messages too fast', 'bad');
  const text = sanitize(m.text);
  if (!text) return;
  p.lastChatAt = now;
  const msg = { t: 'chat', ch: m.ch, from: p.name, fromId: p.id, text };
  switch (m.ch) {
    case 'global': return w.broadcast(msg);
    case 'local':
      for (const q of w.players.values()) if (dist(q.x, q.y, p.x, p.y) <= LOCAL_RADIUS) q.session.send(msg);
      return;
    case 'pm': {
      const to = [...w.players.values()].find(q => q.id === m.to || q.name.toLowerCase() === String(m.to ?? '').toLowerCase());
      if (!to) return w.toast(p, 'Player not online', 'bad');
      to.session.send({ ...msg, to: to.name });
      if (to !== p) p.session.send({ ...msg, to: to.name });
      return;
    }
    case 'police':
      if (p.job !== 'police') return w.toast(p, 'Police radio is restricted', 'bad');
      return radio(w, 'police', p.name, text);
    case 'ems':
      if (p.job !== 'police' && p.job !== 'paramedic') return w.toast(p, 'Emergency radio is restricted', 'bad');
      return radio(w, 'ems', p.name, text);
    case '911': {
      const service: 'police' | 'ems' = m.service === 'ems' ? 'ems' : 'police';
      const call = { id: w.calls.length + 1, from: p.id, fromName: p.name, x: Math.round(p.x), y: Math.round(p.y), text, service, at: now };
      w.calls.push(call);
      if (w.calls.length > 200) w.calls.shift();
      const recipients = [...w.players.values()].filter(q => q.job === (service === 'police' ? 'police' : 'paramedic'));
      for (const q of recipients) q.session.send({ t: 'dispatch', ...wire(tr('911 ({0}) from {1}: {2}', service.toUpperCase(), p.name, text), 'text'), x: call.x, y: call.y, caller: p.id });
      return w.toast(p, recipients.length ? tr('Your call was received by {0} unit(s)', recipients.length) : 'No units are on duty — your call was logged', recipients.length ? 'good' : 'info');
    }
    default: return w.toast(p, 'Unknown channel', 'bad');
  }
}
