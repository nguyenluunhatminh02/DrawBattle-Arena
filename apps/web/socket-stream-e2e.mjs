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

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const a = await createGuest('StreamHost');
  const b = await createGuest('StreamGuest');
  const room = await createRoom(a.token, { mode: 'CLASSIC', maxPlayers: 4, rounds: 1, turnDuration: 45 });
  const host = connect(a.token);
  const guest = connect(b.token);

  host.emit('room:join', { roomCode: room.roomCode });
  await once(host, 'room:snapshot');
  guest.emit('room:join', { roomCode: room.roomCode });
  await Promise.all([once(guest, 'room:snapshot'), once(host, 'room:playerJoined')]);

  const readyP = once(host, 'room:snapshot');
  guest.emit('room:ready', true);
  await readyP;

  const received = [];
  guest.on('draw:chunk', c => received.push(c));

  host.emit('match:start');
  const r1 = await raceDrawer([host, guest]);
  const turnId = r1.data.turnId;
  const wordP = once(r1.drawer, 'turn:yourWord');
  const phaseP = once(r1.guessers[0], 'match:phaseChanged');
  r1.drawer.emit('turn:chooseWord', r1.data.words[0].id);
  const { word } = await wordP;
  await phaseP;

  const chunks = [
    { seq: 0, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] },
    { seq: 1, points: [{ x: 0.3, y: 0.3 }, { x: 0.4, y: 0.4 }] },
    { seq: 2, points: [{ x: 0.5, y: 0.5 }] },
  ];
  r1.drawer.emit('draw:strokeStart', { turnId, strokeId: 's1' });
  for (const c of chunks) {
    r1.drawer.emit('draw:strokeChunk', { turnId, strokeId: 's1', seq: c.seq, points: c.points, color: '#1F2937', width: 4 });
    await sleep(80);
  }
  const midCount = received.filter(c => c.strokeId === 's1').length;
  r1.drawer.emit('draw:strokeEnd', { turnId, strokeId: 's1' });

  r1.drawer.emit('draw:strokeStart', { turnId, strokeId: 's2' });
  r1.drawer.emit('draw:strokeChunk', { turnId, strokeId: 's2', seq: 0, points: [{ x: 0.8, y: 0.8 }], color: '#EF4444', width: 6 });
  r1.drawer.emit('draw:strokeEnd', { turnId, strokeId: 's2' });
  await sleep(400);

  if (midCount < 3) throw new Error(`streaming broken: guesser saw ${midCount}/3 chunks before strokeEnd`);
  const s1Points = received.filter(c => c.strokeId === 's1').reduce((n, c) => n + c.points.length, 0);
  if (s1Points !== 5) throw new Error(`expected 5 streamed points for s1, got ${s1Points}`);

  const resyncP = once(r1.guessers[0], 'turn:restore');
  r1.guessers[0].emit('state:resync');
  const restore = await resyncP;
  const m1 = restore.strokes.find(s => s.strokeId === 's1');
  const m2 = restore.strokes.find(s => s.strokeId === 's2');
  if (!m1 || m1.points.length !== 5) throw new Error(`server merge broken: s1 has ${m1?.points.length} points, expected 5`);
  if (!m2 || m2.points.length !== 1) throw new Error('single-point dot stroke lost');

  const errP = once(r1.guessers[0], 'error');
  r1.guessers[0].emit('draw:strokeStart', { turnId, strokeId: 'hack' });
  const errCode = await errP;
  if (errCode !== 'NOT_DRAWER') throw new Error(`expected NOT_DRAWER, got ${errCode}`);
  r1.guessers[0].emit('draw:strokeChunk', { turnId, strokeId: 'hack', seq: 0, points: [{ x: 0.9, y: 0.9 }], color: '#000000', width: 4 });
  await sleep(200);
  const resync2P = once(r1.guessers[0], 'turn:restore');
  r1.guessers[0].emit('state:resync');
  const restore2 = await resync2P;
  if (restore2.strokes.length !== 2) throw new Error('non-drawer stroke was accepted');

  const undoP = once(r1.guessers[0], 'draw:undo');
  r1.drawer.emit('draw:undo');
  const undoneId = await undoP;
  if (undoneId !== 's2') throw new Error(`undo removed ${undoneId}, expected s2`);

  const correctP = once(r1.guessers[0], 'guess:correct');
  r1.guessers[0].emit('guess:submit', word);
  await correctP;
  await once(r1.drawer, 'turn:revealed');

  const r2 = await raceDrawer([host, guest]);
  const wp2 = once(r2.drawer, 'turn:yourWord');
  const pp2 = once(r2.guessers[0], 'match:phaseChanged');
  r2.drawer.emit('turn:chooseWord', r2.data.words[0].id);
  const { word: w2 } = await wp2;
  await pp2;
  const cp2 = once(r2.guessers[0], 'guess:correct');
  r2.guessers[0].emit('guess:submit', w2);
  await cp2;
  await once(r2.drawer, 'turn:revealed');
  const finished = await once(host, 'match:finished');
  if (finished.rankings.length !== 2) throw new Error('rankings mismatch');

  await sleep(500);
  const replayRes = await fetch(`${API}/api/replays/turn/${turnId}`);
  if (!replayRes.ok) throw new Error(`replay fetch: ${replayRes.status}`);
  const replay = await replayRes.json();
  const rs1 = replay.strokes.find(s => s.strokeId === 's1');
  if (!rs1 || rs1.points.length !== 5) throw new Error(`persisted replay not merged: ${rs1?.points.length} points`);
  if (replay.strokes.find(s => s.strokeId === 's2')) throw new Error('undone stroke persisted in replay');

  host.close();
  guest.close();
  console.log(JSON.stringify({
    PASS: true,
    streamedChunksBeforeEnd: midCount,
    mergedPoints: m1.points.length,
    dotStroke: true,
    nonDrawerBlocked: errCode,
    undoBroadcast: undoneId,
    replayMerged: rs1.points.length,
  }, null, 2));
  process.exit(0);
}

waitReady().then(main).catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
