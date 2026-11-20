import { test, expect } from '@playwright/test';

test('API health check + scoring endpoints exist', async ({ request }) => {
  // API reachable
  const flags = await request.get('http://localhost:3001/api/flags');
  expect(flags.ok()).toBeTruthy();

  // Guest session creation works
  const guest = await request.post('http://localhost:3001/api/guest-sessions', {
    data: { nickname: 'SmokeTest' },
  });
  expect(guest.ok()).toBeTruthy();
  const guestData = await guest.json();
  expect(guestData.token).toBeTruthy();
  expect(guestData.playerId).toBeTruthy();

  // Room creation
  const room = await request.post('http://localhost:3001/api/rooms', {
    headers: { Authorization: `Bearer ${guestData.token}` },
    data: { settings: { mode: 'CLASSIC', rounds: 1, turnDuration: 60, maxPlayers: 8 } },
  });
  expect(room.ok()).toBeTruthy();
  const roomData = await room.json();
  expect(roomData.roomCode).toBeTruthy();

  // Room info
  const roomInfo = await request.get(`http://localhost:3001/api/rooms/${roomData.roomCode}`);
  expect(roomInfo.ok()).toBeTruthy();

  console.log('✅ API smoke test passed');
  console.log('  Room code:', roomData.roomCode);
  console.log('  Player ID:', guestData.playerId);
});
