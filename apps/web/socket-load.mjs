import { io } from 'socket.io-client';

const API = 'http://127.0.0.1:3001';
const NS = `${API}/game`;
const ROOMS = parseInt(process.env.LOAD_ROOMS ?? '10', 10);
const PLAYERS = parseInt(process.env.LOAD_PLAYERS ?? '4', 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function createGuest(nickname) {
  const r = await fetch(`${API}/api/guest-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname }),
  });
  if (!r.ok) throw new Error(`guest ${nickname}: ${r.status}`);
  return r.json();
}

async function createRoom(token) {
  const r = await fetch(`${API}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ settings: { mode: 'CLASSIC', maxPlayers: PLAYERS, rounds: 1, turnDuration: 45 } }),
  });
  if (!r.ok) throw new Error(`room: ${r.status}`);
  return r.json();
}

function connect(token) {
  return io(NS, { auth: { token }, transports: ['websocket'] });
}

function once(socket, event, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${event}`)), timeout);
    socket.once(event, data => { clearTimeout(t); resolve(data); });
  });
}

function pct(arr, p) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

const joinLat = [];
const guessLat = [];
const strokeLat = [];
let errors = 0;

async function runRoom(idx) {
  const guests = [];
  for (let i = 0; i < PLAYERS; i++) {
    guests.push(await createGuest(`L${idx}P${i}`));
  }
  const room = await createRoom(guests[0].token);
  const sockets = guests.map(g => connect(g.token));

  for (let i = 0; i < sockets.length; i++) {
    const t0 = Date.now();
    sockets[i].emit('room:join', { roomCode: room.roomCode });
    await once(sockets[i], 'room:snapshot');
    joinLat.push(Date.now() - t0);
    if (i > 0) {
      await once(sockets[0], 'room:playerJoined');
      const rp = once(sockets[0], 'room:snapshot');
      sockets[i].emit('room:ready', true);
      await rp;
    }
  }

  const drawerP = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no drawer')), 30000);
    const hs = new Map();
    for (const s of sockets) {
      const h = d => {
        clearTimeout(t);
        for (const [sock, fn] of hs) sock.off('turn:youAreDrawer', fn);
        resolve({ drawer: s, guessers: sockets.filter(x => x !== s), data: d });
      };
      hs.set(s, h);
      s.on('turn:youAreDrawer', h);
    }
  });

  sockets[0].emit('match:start');
  const { drawer, guessers, data } = await drawerP;
  const wp = once(drawer, 'turn:yourWord');
  const pp = once(guessers[0], 'match:phaseChanged');
  drawer.emit('turn:chooseWord', data.words[0].id);
  const { word } = await wp;
  await pp;

  const strokeRecv = once(guessers[0], 'draw:chunk');
  const t0 = Date.now();
  drawer.emit('draw:strokeChunk', {
    turnId: data.turnId, strokeId: `load-${idx}`, seq: 0,
    points: [{ x: 0.2, y: 0.3 }, { x: 0.5, y: 0.5 }], color: '#1F2937', width: 4,
  });
  await strokeRecv;
  strokeLat.push(Date.now() - t0);

  await Promise.all(guessers.map(async g => {
    const tg = Date.now();
    const cp = once(g, 'guess:correct');
    g.emit('guess:submit', word);
    await cp;
    guessLat.push(Date.now() - tg);
  }));
  await once(drawer, 'turn:revealed');

  for (const s of sockets) s.close();
}

async function main() {
  const t0 = Date.now();
  const batch = 5;
  for (let i = 0; i < ROOMS; i += batch) {
    const group = [];
    for (let j = i; j < Math.min(i + batch, ROOMS); j++) {
      group.push(runRoom(j).catch(err => { errors++; console.error(`room ${j}: ${err.message}`); }));
    }
    await Promise.all(group);
  }
  const elapsed = Date.now() - t0;
  console.log(JSON.stringify({
    PASS: errors === 0,
    rooms: ROOMS,
    playersPerRoom: PLAYERS,
    totalSockets: ROOMS * PLAYERS,
    errors,
    elapsedMs: elapsed,
    joinP50: pct(joinLat, 50), joinP95: pct(joinLat, 95),
    guessAckP50: pct(guessLat, 50), guessAckP95: pct(guessLat, 95),
    strokePropP50: pct(strokeLat, 50), strokePropP95: pct(strokeLat, 95),
  }, null, 2));
  process.exit(errors === 0 ? 0 : 1);
}

main().catch(err => { console.error('FAIL:', err.message); process.exit(1); });
