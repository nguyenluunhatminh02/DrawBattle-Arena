import { io } from 'socket.io-client';
import { writeFileSync, readFileSync } from 'fs';

const API = 'http://127.0.0.1:3001';
const NS = `${API}/game`;
const STATE = '/tmp/kilo/restart-state.json';
const phase = process.argv[2];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function createGuest(nickname) {
  const r = await fetch(`${API}/api/guest-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname }),
  });
  if (!r.ok) throw new Error(`guest: ${r.status}`);
  return r.json();
}

function connect(token) {
  return io(NS, { auth: { token }, transports: ['websocket'] });
}

function once(socket, event, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${event}`)), timeout);
    socket.once(event, data => { clearTimeout(t); resolve(data); });
  });
}

async function phase1() {
  const h = await createGuest('RestartHost');
  const g = await createGuest('RestartGuest');
  const r = await fetch(`${API}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}` },
    body: JSON.stringify({ settings: { mode: 'CLASSIC', maxPlayers: 4, rounds: 1, turnDuration: 45 } }),
  });
  const room = await r.json();
  const host = connect(h.token);
  const guest = connect(g.token);
  host.emit('room:join', { roomCode: room.roomCode });
  await once(host, 'room:snapshot');
  guest.emit('room:join', { roomCode: room.roomCode });
  await Promise.all([once(guest, 'room:snapshot'), once(host, 'room:playerJoined')]);

  const drawerP = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no drawer')), 20000);
    const hh = d => { clearTimeout(t); guest.off('turn:youAreDrawer', gh); resolve({ drawer: host, data: d }); };
    const gh = d => { clearTimeout(t); host.off('turn:youAreDrawer', hh); resolve({ drawer: guest, data: d }); };
    host.on('turn:youAreDrawer', hh);
    guest.on('turn:youAreDrawer', gh);
  });
  host.emit('match:start');
  const { drawer, data } = await drawerP;
  const wp = once(drawer, 'turn:yourWord');
  drawer.emit('turn:chooseWord', data.words[0].id);
  await wp;
  await sleep(500);

  writeFileSync(STATE, JSON.stringify({ roomCode: room.roomCode, hostToken: h.token, guestToken: g.token }));
  console.log(JSON.stringify({ phase1: 'match in progress, state saved', roomCode: room.roomCode }));
  host.close();
  guest.close();
  process.exit(0);
}

async function phase2() {
  const { roomCode, hostToken, guestToken } = JSON.parse(readFileSync(STATE, 'utf8'));
  const host = connect(hostToken);
  const cancelP = once(host, 'match:cancelled');
  host.emit('room:join', { roomCode });
  const snap = await once(host, 'room:snapshot');
  const cancelled = await cancelP;
  if (snap.status !== 'WAITING') throw new Error(`expected WAITING after restart, got ${snap.status}`);
  if (cancelled.reason !== 'SERVER_RESTART') throw new Error('wrong cancel reason');

  const guest = connect(guestToken);
  guest.emit('room:join', { roomCode });
  await Promise.all([once(guest, 'room:snapshot'), once(host, 'room:playerJoined')]);

  const drawerP = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no drawer after restart')), 20000);
    const hh = d => { clearTimeout(t); guest.off('turn:youAreDrawer', gh); resolve({ drawer: host, guesser: guest, data: d }); };
    const gh = d => { clearTimeout(t); host.off('turn:youAreDrawer', hh); resolve({ drawer: guest, guesser: host, data: d }); };
    host.on('turn:youAreDrawer', hh);
    guest.on('turn:youAreDrawer', gh);
  });
  host.emit('match:start');
  const { drawer, guesser, data } = await drawerP;
  const wp = once(drawer, 'turn:yourWord');
  const pp = once(guesser, 'match:phaseChanged');
  drawer.emit('turn:chooseWord', data.words[0].id);
  const { word } = await wp;
  await pp;
  const cp = once(guesser, 'guess:correct');
  guesser.emit('guess:submit', word);
  await cp;
  await once(drawer, 'turn:revealed');

  const d2 = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no turn2')), 20000);
    const hh = d => { clearTimeout(t); guest.off('turn:youAreDrawer', gh); resolve({ drawer: host, guesser: guest, data: d }); };
    const gh = d => { clearTimeout(t); host.off('turn:youAreDrawer', hh); resolve({ drawer: guest, guesser: host, data: d }); };
    host.on('turn:youAreDrawer', hh);
    guest.on('turn:youAreDrawer', gh);
  });
  const wp2 = once(d2.drawer, 'turn:yourWord');
  const pp2 = once(d2.guesser, 'match:phaseChanged');
  d2.drawer.emit('turn:chooseWord', d2.data.words[0].id);
  const { word: w2 } = await wp2;
  await pp2;
  const cp2 = once(d2.guesser, 'guess:correct');
  d2.guesser.emit('guess:submit', w2);
  await cp2;
  await once(d2.drawer, 'turn:revealed');
  const fin = await once(host, 'match:finished');

  host.close();
  guest.close();
  console.log(JSON.stringify({ PASS: true, restartRecovery: true, cancelReason: cancelled.reason, newMatchRankings: fin.rankings.length }, null, 2));
  process.exit(0);
}

if (phase === 'phase1') phase1().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
else if (phase === 'phase2') phase2().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
else { console.error('usage: node socket-restart-e2e.mjs phase1|phase2'); process.exit(1); }
