import { test, expect } from '@playwright/test';

const API = process.env.E2E_API_URL ?? 'http://localhost:3001';

test('API health check + scoring endpoints exist', async ({ request }) => {
  // API reachable
  const flags = await request.get(`${API}/api/flags`);
  expect(flags.ok()).toBeTruthy();

  // Guest session creation works
  const guest = await request.post(`${API}/api/guest-sessions`, {
    data: { nickname: 'SmokeTest' },
  });
  expect(guest.ok()).toBeTruthy();
  const guestData = await guest.json();
  expect(guestData.token).toBeTruthy();
  expect(guestData.playerId).toBeTruthy();

  // Room creation
  const room = await request.post(`${API}/api/rooms`, {
    headers: { Authorization: `Bearer ${guestData.token}` },
    data: { settings: { mode: 'CLASSIC', rounds: 1, turnDuration: 60, maxPlayers: 8 } },
  });
  expect(room.ok()).toBeTruthy();
  const roomData = await room.json();
  expect(roomData.roomCode).toBeTruthy();

  // Room info
  const roomInfo = await request.get(`${API}/api/rooms/${roomData.roomCode}`);
  expect(roomInfo.ok()).toBeTruthy();

  console.log('✅ API smoke test passed');
  console.log('  Room code:', roomData.roomCode);
  console.log('  Player ID:', guestData.playerId);
});
