import { io } from 'socket.io-client';

const API = 'http://127.0.0.1:3001';
const NS = `${API}/game`;

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${API}/api/flags`);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('API not ready after 30s');
}

async function createGuest(nickname) {
  const r = await fetch(`${API}/api/guest-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname }),
  });
  if (!r.ok) throw new Error(`guest ${nickname}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function createRoom(token, settings) {
  const r = await fetch(`${API}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ settings }),
  });
  if (!r.ok) throw new Error(`room: ${r.status} ${await r.text()}`);
  return r.json();
}

function connect(token) {
  return io(NS, { auth: { token }, transports: ['websocket'] });
}

function once(socket, event, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting ${event}`)), timeout);
    socket.once(event, data => { clearTimeout(t); resolve(data); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const results = {};

  const h = await createGuest('LeaveHost');
  const g = await createGuest('LeaveGuest');
  const room = await createRoom(h.token, { mode: 'CLASSIC', maxPlayers: 2, rounds: 1, turnDuration: 45 });

  const host = connect(h.token);
  const guest = connect(g.token);
  host.emit('room:join', { roomCode: room.roomCode });
  await once(host, 'room:snapshot');
  guest.emit('room:join', { roomCode: room.roomCode });
  await Promise.all([once(guest, 'room:snapshot'), once(host, 'room:playerJoined')]);

  const notReadyP = once(host, 'error');
  host.emit('match:start');
  const nr = await notReadyP;
  if (nr !== 'PLAYERS_NOT_READY') throw new Error(`expected PLAYERS_NOT_READY, got ${nr}`);
  results.readyGating = true;

  const rp = once(host, 'room:snapshot');
  guest.emit('room:ready', true);
  await rp;

  const drawerP = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no drawer')), 20000);
    const hh = d => { clearTimeout(t); guest.off('turn:youAreDrawer', gh); resolve(d); };
    const gh = d => { clearTimeout(t); host.off('turn:youAreDrawer', hh); resolve(d); };
    host.on('turn:youAreDrawer', hh);
    guest.on('turn:youAreDrawer', gh);
  });
  host.emit('match:start');
  await drawerP;
  results.startAfterReady = true;

  const leftP = once(host, 'room:playerLeft');
  const finP = once(host, 'match:finished', 20000);
  const ownLeftP = once(guest, 'room:left');
  guest.emit('room:leave');
  await ownLeftP;
  await leftP;
  const fin = await finP;
  if (!Array.isArray(fin.rankings)) throw new Error('match:finished missing rankings');
  results.leaveEndsMatch = true;

  await sleep(600);
  const info = await fetch(`${API}/api/rooms/${room.roomCode}`).then(r => r.json());
  if (info.playerCount !== 1) throw new Error(`expected 1 active player after leave, got ${info.playerCount}`);

  const g2 = await createGuest('LeaveGuest2');
  const guest2 = connect(g2.token);
  guest2.emit('room:join', { roomCode: room.roomCode });
  const snap2 = await once(guest2, 'room:snapshot');
  if (!snap2.yourPlayerId) throw new Error('join after leave failed');
  results.slotFreed = true;

  const hostChangedP = once(guest2, 'room:hostChanged');
  const hostLeftP = once(guest2, 'room:playerLeft');
  const ownHostLeftP = once(host, 'room:left');
  host.emit('room:leave');
  await ownHostLeftP;
  const newHostId = await hostChangedP;
  await hostLeftP;
  if (newHostId !== snap2.yourPlayerId) throw new Error('host not transferred to remaining player');
  results.hostTransferOnLeave = true;

  const lastLeftP = once(guest2, 'room:left');
  guest2.emit('room:leave');
  await lastLeftP;
  await sleep(400);
  const info2 = await fetch(`${API}/api/rooms/${room.roomCode}`).then(r => r.json());
  if (info2.playerCount !== 0) throw new Error(`expected 0 players, got ${info2.playerCount}`);
  results.emptyRoomReset = true;

  host.close(); guest.close(); guest2.close();
  console.log(JSON.stringify({ PASS: true, ...results }, null, 2));
  process.exit(0);
}

waitReady().then(main).catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
