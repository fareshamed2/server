// Headless bot player: a real WebSocket client that logs in, spawns and walks around.
// Used for multiplayer testing (second "player" next to a simulator) and load testing.
//   node tools/bot.ts [count=1] [ws://127.0.0.1:8080]
import WebSocket from 'ws';

const count = Number(process.argv[2] ?? 1);
const url = process.argv[3] ?? 'ws://127.0.0.1:8080';
const PASSWORD = 'bot-password-123';
/** 1 -> 'a', 27 -> 'ba' … (character names must be letters only). */
const letters = (n: number): string => (n >= 26 ? letters(Math.floor(n / 26)) : '') + 'abcdefghijklmnopqrstuvwxyz'[n % 26];

function runBot(i: number) {
  const ws = new WebSocket(url);
  const user = `bot${i}`;
  let me: any = null, phase = Math.random() * Math.PI * 2, x = 0, y = 0, t0 = Date.now();
  const send = (m: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
  ws.on('open', () => send({ t: 'login', username: user, password: PASSWORD }));
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString());
    if (m.t === 'error' && m.ctx === 'login') send({ t: 'register', username: user, password: PASSWORD });
    if (m.t === 'error' && m.ctx !== 'login') console.log(`[${user}] error: ${m.msg}`);
    if (m.t === 'chars') {
      if (m.list.length) send({ t: 'char_select', id: m.list[0].id });
      else send({ t: 'char_create', name: `Bot${letters(i)} Bravo`, appearance: { gender: i % 2 ? 'female' : 'male', skin: i % 8, hair: i % 8, hairColor: '#3b2314', top: i % 5, topColor: ['#c0392b', '#2980b9', '#27ae60', '#8e44ad'][i % 4], pants: '#2c3e50', shoes: '#111111', accessory: i % 5 } });
    }
    if (m.t === 'spawn') { me = m.you; x = m.you.x; y = m.you.y; t0 = Date.now(); console.log(`[${user}] spawned as ${me.name} at ${Math.round(x)},${Math.round(y)}`); }
    if (m.t === 'correct') { x = m.x; y = m.y; }
    if (m.t === 'toast') console.log(`[${user}] ${m.msg}`);
  });
  ws.on('close', () => { console.log(`[${user}] disconnected, retrying`); setTimeout(() => runBot(i), 2000); });
  ws.on('error', () => {});
  // Walk north/south along the sidewalk near spawn, punch occasionally, chat sometimes.
  let baseY = 0;
  const timer = setInterval(() => {
    if (!me) return;
    if (!baseY) baseY = y;
    const t = (Date.now() - t0) / 1000;
    const ny = baseY + Math.sin(t * 0.35 + phase) * 180;
    const rot = Math.cos(t * 0.35 + phase) >= 0 ? Math.PI / 2 : -Math.PI / 2;
    x = me.x; y = ny;
    send({ t: 'move', x, y, rot, anim: 'walk' });
    if (Math.random() < 0.004) send({ t: 'chat', ch: 'local', text: ['Nice day in Utopia.', 'Anyone hiring?', 'Watch the road!'][Math.floor(Math.random() * 3)] });
  }, 1000 / 15);
  ws.on('close', () => clearInterval(timer));
}

for (let i = 1; i <= count; i++) setTimeout(() => runBot(i), i * 150);
