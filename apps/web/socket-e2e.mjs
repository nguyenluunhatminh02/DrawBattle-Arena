import { io } from 'socket.io-client';

const API = 'http://127.0.0.1:3001';
const NS = `${API}/game`;

async function createGuest(nickname) {
  const r = await fetch(`${API}/api/guest-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname }),
  });
  if (!r.ok) throw new Error(`guest ${nickname}: ${r.status}`);
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

function once(socket, event, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting ${event}`)), timeout);
    socket.once(event, data => { clearTimeout(t); resolve(data); });
  });
}

function raceDrawer(host, guest) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no drawer within 12s')), 12000);
    const h = d => { clearTimeout(t); host.off('turn:youAreDrawer', g); resolve({ drawer: host, guesser: guest, data: d }); };
    const g = d => { clearTimeout(t); guest.off('turn:youAreDrawer', h); resolve({ drawer: guest, guesser: host, data: d }); };
    host.on('turn:youAreDrawer', h);
    guest.on('turn:youAreDrawer', g);
  });
}

async function playTurn(host, guest) {
  const { drawer, guesser, data } = await raceDrawer(host, guest);
  drawer.off('turn:youAreDrawer');
  guesser.off('turn:youAreDrawer');
  const wordId = data.words[0].id;
  drawer.emit('turn:chooseWord', wordId);
  const wordP = once(drawer, 'turn:yourWord', 10000);
  await once(guesser, 'match:phaseChanged', 10000);
  const { word } = await wordP;
  const correctP = once(guesser, 'guess:correct', 10000);
  guesser.emit('guess:submit', word);
  await correctP;
  await once(drawer, 'turn:revealed', 10000);
  return word;
}

async function main() {
  const a = await createGuest('E2EHost');
  const b = await createGuest('E2EGuest');
  const room = await createRoom(a.token, { turnDuration: 20, rounds: 1, maxPlayers: 4 });
  const host = connect(a.token);
  const guest = connect(b.token);

  host.emit('room:join', { roomCode: room.roomCode });
  const snapH = await once(host, 'room:snapshot');
  guest.emit('room:join', { roomCode: room.roomCode });
  const [snapG, guestJoinedOnHost] = await Promise.all([
    once(guest, 'room:snapshot'),
    once(host, 'room:playerJoined'),
  ]);

  const hostSees = snapH.players.length + 1; // host snapshot + guest join event
  const guestSees = snapG.players.length;
  if (hostSees !== 2 || guestSees !== 2) {
    throw new Error(`lobby sync broken: host sees ${hostSees}, guest sees ${guestSees}`);
  }
  if (snapG.yourPlayerId === snapH.yourPlayerId) throw new Error('duplicate player id');

  host.emit('match:start');
  const w1 = await playTurn(host, guest);
  const w2 = await playTurn(host, guest);
  const finished = await once(host, 'match:finished', 20000);

  const total = finished.rankings.reduce((s, r) => s + r.points, 0);
  if (total <= 0) throw new Error('no scores awarded');

  console.log(JSON.stringify({
    PASS: true,
    roomCode: room.roomCode,
    lobbySync: { hostSees, guestSees },
    words: [w1, w2],
    rankings: finished.rankings.map(r => ({ n: r.nickname, p: r.points, rank: r.rank })),
  }, null, 2));

  host.close();
  guest.close();
  process.exit(0);
}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});