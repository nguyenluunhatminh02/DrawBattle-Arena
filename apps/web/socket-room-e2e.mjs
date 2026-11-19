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

function raceDrawer(sockets, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no drawer event')), timeout);
    const handlers = new Map();
    for (const s of sockets) {
      const h = d => {
        clearTimeout(t);
        for (const [sock, fn] of handlers) sock.off('turn:youAreDrawer', fn);
        resolve({ drawer: s, guessers: sockets.filter(x => x !== s), data: d });
      };
      handlers.set(s, h);
      s.on('turn:youAreDrawer', h);
    }
  });
}

async function joinOk(socket, code, extra = {}) {
  socket.emit('room:join', { roomCode: code, ...extra });
  return once(socket, 'room:snapshot');
}

async function joinErr(socket, code, extra = {}) {
  socket.emit('room:join', { roomCode: code, ...extra });
  return once(socket, 'error');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const results = {};

  const h = await createGuest('FeatHost');
  const g = await createGuest('FeatGuest');
  const room = await createRoom(h.token, { mode: 'CLASSIC', maxPlayers: 4, rounds: 1, turnDuration: 45, password: 'secret123' });

  const info = await fetch(`${API}/api/rooms/${room.roomCode}`).then(r => r.json());
  if (!info.hasPassword) throw new Error('hasPassword flag missing');
  if (info.settings.password !== undefined) throw new Error('password leaked via GET /rooms/:code');
  results.passwordNotLeaked = true;

  let hostSock = connect(h.token);
  await joinOk(hostSock, room.roomCode);

  let guestSock = connect(g.token);
  const e1 = await joinErr(guestSock, room.roomCode);
  if (e1 !== 'INVALID_PASSWORD') throw new Error(`no-password join: expected INVALID_PASSWORD, got ${e1}`);
  const e2 = await joinErr(guestSock, room.roomCode, { password: 'wrong' });
  if (e2 !== 'INVALID_PASSWORD') throw new Error(`wrong-password join: expected INVALID_PASSWORD, got ${e2}`);
  const snapG = await joinOk(guestSock, room.roomCode, { password: 'secret123' });
  results.passwordJoin = true;

  const readyP = once(hostSock, 'room:snapshot');
  guestSock.emit('room:ready', true);
  const readySnap = await readyP;
  const gp = readySnap.players.find(p => p.id === snapG.yourPlayerId);
  if (!gp?.isReady) throw new Error('ready state not broadcast');
  results.readyBroadcast = true;

  const setP = once(hostSock, 'room:snapshot');
  hostSock.emit('room:updateSettings', { rounds: 3, turnDuration: 90, enableHints: false });
  const setSnap = await setP;
  if (setSnap.settings.rounds !== 3 || setSnap.settings.turnDuration !== 90 || setSnap.settings.enableHints !== false) {
    throw new Error('settings update not reflected in snapshot');
  }
  if (setSnap.settings.password !== undefined) throw new Error('password leaked via room:snapshot');
  const info2 = await fetch(`${API}/api/rooms/${room.roomCode}`).then(r => r.json());
  if (info2.settings.rounds !== 3) throw new Error('settings not persisted to DB');
  results.hostSettings = true;

  const nhP = once(guestSock, 'error');
  guestSock.emit('room:updateSettings', { rounds: 1 });
  const nhErr = await nhP;
  if (nhErr !== 'NOT_HOST') throw new Error(`non-host settings: expected NOT_HOST, got ${nhErr}`);
  results.nonHostBlocked = true;

  hostSock.emit('room:updateSettings', { rounds: 1 });
  await once(hostSock, 'room:snapshot');

  hostSock.emit('match:start');
  const r1 = await raceDrawer([hostSock, guestSock]);
  const wp = once(r1.drawer, 'turn:yourWord');
  const pp = once(r1.guessers[0], 'match:phaseChanged');
  r1.drawer.emit('turn:chooseWord', r1.data.words[0].id);
  const { word } = await wp;
  await pp;

  const midP = once(hostSock, 'error');
  hostSock.emit('room:updateSettings', { rounds: 2 });
  const midErr = await midP;
  if (midErr !== 'SETTINGS_FAILED') throw new Error(`settings during match: expected SETTINGS_FAILED, got ${midErr}`);
  results.settingsLockedDuringMatch = true;

  const guesserIsHost = r1.guessers[0] === hostSock;
  const oldGuesserId = guesserIsHost
    ? (await Promise.resolve(null), null)
    : snapG.yourPlayerId;
  const closedSock = r1.guessers[0];
  const closedToken = guesserIsHost ? h.token : g.token;
  closedSock.close();
  await sleep(300);
  const reSock = connect(closedToken);
  const reSnap = await joinOk(reSock, room.roomCode);
  if (guesserIsHost) {
    hostSock = reSock;
  } else {
    if (reSnap.yourPlayerId !== oldGuesserId) throw new Error('rejoin created duplicate player identity');
    guestSock = reSock;
  }
  results.midMatchRejoin = true;

  const guesserNow = guesserIsHost ? hostSock : guestSock;
  const cp = once(guesserNow, 'guess:correct');
  guesserNow.emit('guess:submit', word);
  await cp;
  await once(r1.drawer, 'turn:revealed');

  const r2 = await raceDrawer([hostSock, guestSock]);
  const wp2 = once(r2.drawer, 'turn:yourWord');
  const pp2 = once(r2.guessers[0], 'match:phaseChanged');
  r2.drawer.emit('turn:chooseWord', r2.data.words[0].id);
  const { word: w2 } = await wp2;
  await pp2;
  const cp2 = once(r2.guessers[0], 'guess:correct');
  r2.guessers[0].emit('guess:submit', w2);
  await cp2;
  await once(r2.drawer, 'turn:revealed');
  await once(hostSock, 'match:finished');
  await sleep(1200);

  const late = await createGuest('LateJoiner');
  const lateSock = connect(late.token);
  const lateSnap = await joinOk(lateSock, room.roomCode, { password: 'secret123' });
  if (!lateSnap.yourPlayerId) throw new Error('join after match end failed');
  results.joinAfterMatchEnd = true;
  lateSock.close();

  const dh = await createGuest('DuelHost');
  const dg = await createGuest('DuelGuest');
  const dx = await createGuest('DuelExtra');
  const duel = await createRoom(dh.token, { mode: 'DUEL' });
  const dhs = connect(dh.token);
  await joinOk(dhs, duel.roomCode);
  const dgs = connect(dg.token);
  await joinOk(dgs, duel.roomCode);
  const dxs = connect(dx.token);
  const fullErr = await joinErr(dxs, duel.roomCode);
  if (fullErr !== 'ROOM_FULL') throw new Error(`duel third join: expected ROOM_FULL, got ${fullErr}`);
  results.duelRoomFull = true;
  dhs.close(); dgs.close(); dxs.close();

  const nf = connect(h.token);
  const nfErr = await joinErr(nf, 'ZZZZZZ');
  if (nfErr !== 'ROOM_NOT_FOUND') throw new Error(`expected ROOM_NOT_FOUND, got ${nfErr}`);
  results.notFoundCode = true;
  nf.close();

  hostSock.close();
  guestSock.close();
  console.log(JSON.stringify({ PASS: true, ...results }, null, 2));
  process.exit(0);
}

waitReady().then(main).catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
