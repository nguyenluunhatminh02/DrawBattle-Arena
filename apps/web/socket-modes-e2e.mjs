import { io } from 'socket.io-client';

const API = 'http://127.0.0.1:3001';
const NS = `${API}/game`;
const run = process.argv[2] || 'speed';

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

async function setFlag(name, enabled, variant) {
  const r = await fetch(`${API}/api/flags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, enabled, variant }),
  });
  if (!r.ok) throw new Error(`flag ${name}: ${r.status}`);
}

async function deleteFlag(name) {
  await fetch(`${API}/api/flags/${name}`, { method: 'DELETE' }).catch(() => {});
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

function never(socket, event, ms) {
  return new Promise(resolve => {
    const handler = () => resolve(false);
    socket.once(event, handler);
    setTimeout(() => { socket.off(event, handler); resolve(true); }, ms);
  });
}

function raceDrawer(sockets, timeout = 45000) {
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

async function joinTwo(host, guest, code) {
  host.emit('room:join', { roomCode: code });
  const snapH = await once(host, 'room:snapshot');
  guest.emit('room:join', { roomCode: code });
  const [snapG] = await Promise.all([
    once(guest, 'room:snapshot'),
    once(host, 'room:playerJoined'),
  ]);
  return { snapH, snapG };
}

async function playTurn(sockets, raced) {
  const { drawer, guessers, data } = raced ?? (await raceDrawer(sockets));
  const wordP = once(drawer, 'turn:yourWord', 10000);
  const phaseP = once(guessers[0], 'match:phaseChanged', 10000);
  drawer.emit('turn:chooseWord', data.words[0].id);
  const { word } = await wordP;
  const phase = await phaseP;
  const correctP = once(guessers[0], 'guess:correct', 10000);
  guessers[0].emit('guess:submit', word);
  await correctP;
  const revealed = await once(drawer, 'turn:revealed', 30000);
  return { word, phase, revealed };
}

async function speedTest() {
  const a = await createGuest('SpeedHost');
  const b = await createGuest('SpeedGuest');
  const room = await createRoom(a.token, { mode: 'SPEED', maxPlayers: 8, rounds: 1, turnDuration: 90 });
  const host = connect(a.token);
  const guest = connect(b.token);
  await joinTwo(host, guest, room.roomCode);

  const info = await fetch(`${API}/api/rooms/${room.roomCode}`).then(r => r.json());
  if (info.settings.mode !== 'SPEED') throw new Error(`mode not persisted: ${info.settings.mode}`);
  if (info.settings.turnDuration !== 30) throw new Error(`speed duration should normalize to 30, got ${info.settings.turnDuration}`);

  host.emit('match:start');
  const raced = await raceDrawer([host, guest]);
  if (raced.data.timeLimit !== 5) throw new Error(`speed word pick should be 5s, got ${raced.data.timeLimit}`);

  const t1 = await playTurn([host, guest], raced);
  const remaining = (t1.phase.endsAt - Date.now()) / 1000;
  if (!(remaining > 22 && remaining <= 30)) throw new Error(`speed turn ~30s expected, got ${remaining}s`);

  await playTurn([host, guest]);
  const finished = await once(host, 'match:finished', 20000);
  if (finished.rankings.length !== 2) throw new Error('rankings mismatch');
  if (finished.teams) throw new Error('speed must not have teams');
  host.close(); guest.close();
  return { roomCode: room.roomCode, word: t1.word, normalizedDuration: info.settings.turnDuration, turnSeconds: Math.round(remaining) };
}

async function duelTest() {
  const a = await createGuest('DuelHost');
  const b = await createGuest('DuelGuest');
  const c = await createGuest('DuelIntruder');
  const room = await createRoom(a.token, { mode: 'DUEL', maxPlayers: 8, rounds: 1, turnDuration: 90 });
  const host = connect(a.token);
  const guest = connect(b.token);
  await joinTwo(host, guest, room.roomCode);

  const info = await fetch(`${API}/api/rooms/${room.roomCode}`).then(r => r.json());
  if (info.settings.maxPlayers !== 2) throw new Error(`duel maxPlayers should be 2, got ${info.settings.maxPlayers}`);
  if (info.settings.turnDuration !== 45) throw new Error(`duel duration should be 45, got ${info.settings.turnDuration}`);

  const intruder = connect(c.token);
  intruder.emit('room:join', { roomCode: room.roomCode });
  const errCode = await once(intruder, 'error', 8000);
  intruder.close();

  host.emit('match:start');
  const turns = [];
  const drawers = new Set();
  for (let i = 0; i < 3; i++) {
    const raced = await raceDrawer([host, guest]);
    drawers.add(raced.drawer === host ? 'host' : 'guest');
    const res = await playTurn([host, guest], raced);
    turns.push(res.word);
  }
  if (drawers.size !== 2) throw new Error('duel should alternate drawers');

  const finished = await once(host, 'match:finished', 20000);
  if (finished.rankings.length !== 2) throw new Error('duel rankings mismatch');
  host.close(); guest.close();
  return { roomCode: room.roomCode, turns, thirdPlayerBlocked: errCode, drawers: [...drawers] };
}

async function teamTest() {
  const players = [];
  for (const n of ['TeamOne', 'TeamTwo', 'TeamThree', 'TeamFour']) {
    players.push(await createGuest(n));
  }
  const room = await createRoom(players[0].token, { mode: 'TEAM', maxPlayers: 8, rounds: 1, turnDuration: 20 });
  const sockets = players.map(p => connect(p.token));
  const playerIds = [];

  sockets[0].emit('room:join', { roomCode: room.roomCode });
  const snap0 = await once(sockets[0], 'room:snapshot');
  playerIds[0] = snap0.yourPlayerId;
  for (let i = 1; i < sockets.length; i++) {
    sockets[i].emit('room:join', { roomCode: room.roomCode });
    const [snap] = await Promise.all([
      once(sockets[i], 'room:snapshot'),
      once(sockets[0], 'room:playerJoined'),
    ]);
    playerIds[i] = snap.yourPlayerId;
  }

  let teamsPayload = null;
  for (const s of sockets) {
    s.on('match:teams', d => { if (!teamsPayload) teamsPayload = d; });
  }

  sockets[0].emit('match:start');
  const raced1 = await raceDrawer(sockets);
  if (!teamsPayload || teamsPayload.teamA.length + teamsPayload.teamB.length !== 4) {
    throw new Error('match:teams payload invalid');
  }

  function rolesFor(raced) {
    const drawerIdx = sockets.indexOf(raced.drawer);
    const drawerId = playerIds[drawerIdx];
    const teamKey = teamsPayload.teamA.some(m => m.id === drawerId) ? 'teamA' : 'teamB';
    const memberIdxs = teamsPayload[teamKey].map(m => playerIds.indexOf(m.id));
    const teammateIdx = memberIdxs.find(i => i !== drawerIdx);
    const opponents = [0, 1, 2, 3].filter(i => i !== drawerIdx && i !== teammateIdx);
    return { drawerIdx, teammateIdx, opponents };
  }

  const r1 = rolesFor(raced1);
  const wordP = once(raced1.drawer, 'turn:yourWord', 10000);
  const phaseP = once(sockets[r1.opponents[0]], 'match:phaseChanged', 10000);
  raced1.drawer.emit('turn:chooseWord', raced1.data.words[0].id);
  const { word } = await wordP;
  await phaseP;

  const rejected = never(sockets[r1.teammateIdx], 'guess:correct', 3000);
  sockets[r1.teammateIdx].emit('guess:submit', word);
  if (!(await rejected)) throw new Error('teammate guess should not be accepted');

  const correctP = once(sockets[r1.opponents[0]], 'guess:correct', 10000);
  sockets[r1.opponents[0]].emit('guess:submit', word);
  await correctP;
  const revealed1 = await once(raced1.drawer, 'turn:revealed', 30000);
  if (revealed1.drawerScore !== 20) throw new Error(`drawer should score 20 (1 opponent), got ${revealed1.drawerScore}`);

  for (let turn = 0; turn < 3; turn++) {
    const raced = await raceDrawer(sockets);
    const roles = rolesFor(raced);
    const wp = once(raced.drawer, 'turn:yourWord', 10000);
    const pp = once(sockets[roles.opponents[0]], 'match:phaseChanged', 10000);
    raced.drawer.emit('turn:chooseWord', raced.data.words[0].id);
    const { word: w } = await wp;
    await pp;
    const ps = roles.opponents.map(i => once(sockets[i], 'guess:correct', 10000));
    for (const i of roles.opponents) sockets[i].emit('guess:submit', w);
    await Promise.all(ps);
    await once(raced.drawer, 'turn:revealed', 15000);
  }

  const finished = await once(sockets[0], 'match:finished', 20000);
  if (!finished.teams) throw new Error('match:finished should include teams result');
  if (!['A', 'B', 'DRAW'].includes(finished.teams.winner)) throw new Error('invalid winner');
  const teamSum = finished.teams.teamA.points + finished.teams.teamB.points;
  const individualSum = finished.rankings.reduce((s, r) => s + r.points, 0);
  if (teamSum !== individualSum) throw new Error('team totals must equal individual totals');

  for (const s of sockets) s.close();
  return {
    roomCode: room.roomCode,
    teams: { A: teamsPayload.teamA.map(m => m.nickname), B: teamsPayload.teamB.map(m => m.nickname) },
    winner: finished.teams.winner,
    teamSum,
  };
}

async function abTest() {
  await setFlag('classic_turn_duration', true, '25');
  await setFlag('classic_hints', false);
  try {
    const a = await createGuest('ABHost');
    const b = await createGuest('ABGuest');
    const room = await createRoom(a.token, { mode: 'CLASSIC', maxPlayers: 8, rounds: 1, turnDuration: 60, enableHints: true });
    const host = connect(a.token);
    const guest = connect(b.token);
    await joinTwo(host, guest, room.roomCode);

    let hintSeen = false;
    host.on('turn:hint', () => { hintSeen = true; });
    guest.on('turn:hint', () => { hintSeen = true; });

    host.emit('match:start');
    const raced = await raceDrawer([host, guest]);
    const t1 = await playTurn([host, guest], raced);
    const remaining = (t1.phase.endsAt - Date.now()) / 1000;
    if (!(remaining > 18 && remaining <= 25)) throw new Error(`AB duration should be ~25s, got ${remaining}`);
    if (t1.phase.hint !== undefined) throw new Error('AB should suppress initial hint');

    await playTurn([host, guest]);
    const finished = await once(host, 'match:finished', 20000);
    if (hintSeen) throw new Error('AB should suppress hint events');
    if (finished.teams) throw new Error('classic match must not have teams');
    host.close(); guest.close();
    return { roomCode: room.roomCode, abTurnSeconds: Math.round(remaining), hintsSuppressed: true };
  } finally {
    await deleteFlag('classic_turn_duration');
    await deleteFlag('classic_hints');
  }
}

const tests = { speed: speedTest, duel: duelTest, team: teamTest, ab: abTest };
if (!tests[run]) {
  console.error(`unknown run '${run}' (speed|duel|team|ab)`);
  process.exit(1);
}

waitReady()
  .then(() => tests[run]())
  .then(res => {
    console.log(JSON.stringify({ PASS: true, mode: run, ...res }, null, 2));
    process.exit(0);
  })
  .catch(err => {
    console.error('FAIL:', err.message);
    process.exit(1);
  });
