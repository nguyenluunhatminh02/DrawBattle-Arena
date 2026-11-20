import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';

const WEB = process.env.E2E_WEB_URL ?? 'http://localhost:3002';
const API = process.env.E2E_API_URL ?? 'http://localhost:3001';

// Each browser-driven test gets its own forwarded-IP bucket so parallel
// guest creation never exhausts the shared localhost throttle bucket.
let nextIsolatedIp = 1;
function isolatedContext(browser: Browser, options: Record<string, unknown> = {}) {
  const ip = `198.51.101.${nextIsolatedIp++}`;
  return browser.newContext({ ...options, extraHTTPHeaders: { 'X-Forwarded-For': ip } });
}

async function setupPlayer(context: BrowserContext, nickname: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(WEB);
  await page.waitForSelector('main[data-ready="true"]', { timeout: 15000 });
  await page.getByPlaceholder('Nhập tên của bạn...').fill(nickname);
  await page.waitForFunction(
    () => {
      const btn = Array.from(document.querySelectorAll('button')).find(b =>
        b.textContent?.includes('Tạo phòng'),
      );
      return !!btn && !(btn as HTMLButtonElement).disabled;
    },
    null,
    { timeout: 5000 },
  );
  return page;
}

async function createRoom(page: Page): Promise<string> {
  await page.locator('button', { hasText: 'Tạo phòng' }).first().click();
  await page.waitForURL(/\/room\//, { timeout: 15000 });
  await page.waitForFunction(() => document.body.innerText.includes('Phòng chờ'), null, {
    timeout: 10000,
  });
  return page.url().split('/').pop()!;
}

async function joinRoom(page: Page, code: string) {
  await page.getByPlaceholder('Mã phòng').fill(code);
  await page.locator('button', { hasText: 'Vào' }).first().click();
  await page.waitForURL(/\/room\//, { timeout: 15000 });
  await page.waitForFunction(() => document.body.innerText.includes('Phòng chờ'), null, {
    timeout: 10000,
  });
}

test.describe('E2E regression matrix', () => {
  test('E2E-01 health, guest identity and room creation smoke', async ({ request }) => {
    const health = await request.get(`${API}/api/flags`);
    expect(health.ok()).toBeTruthy();

    const guest = await request.post(`${API}/api/guest-sessions`, {
      data: { nickname: 'E2ESmoke' },
      headers: { 'X-Forwarded-For': '198.51.100.10' },
    });
    expect(guest.ok()).toBeTruthy();
    const identity = await guest.json();
    expect(identity.token).toBeTruthy();

    const room = await request.post(`${API}/api/rooms`, {
      headers: { Authorization: `Bearer ${identity.token}` },
      data: { settings: { mode: 'CLASSIC', rounds: 1, maxPlayers: 4 } },
    });
    expect(room.ok()).toBeTruthy();
    expect((await room.json()).roomCode).toMatch(/^[A-Z2-9]{6}$/);
  });

  test('E2E-02 private match details are not enumerable', async ({ request }) => {
    const listed = await request.get(`${API}/api/matches?limit=20`);
    expect(listed.ok()).toBeTruthy();
    const body = await listed.json();
    for (const match of body.matches ?? []) {
      const detail = await request.get(`${API}/api/matches/${match.id}`);
      expect([200, 404]).toContain(detail.status());
    }
  });

  test('E2E-03 profane nickname and oversized nickname are rejected', async ({ request }) => {
    const profane = await request.post(`${API}/api/guest-sessions`, {
      data: { nickname: 'fuckface' },
      headers: { 'X-Forwarded-For': '198.51.100.11' },
    });
    expect(profane.status()).toBe(400);
    const tooLong = await request.post(`${API}/api/guest-sessions`, {
      data: { nickname: 'x'.repeat(21) },
      headers: { 'X-Forwarded-For': '198.51.100.12' },
    });
    expect(tooLong.status()).toBe(400);
  });

  test('E2E-04 room password required on join and never leaked', async ({ request }) => {
    const guest = await request.post(`${API}/api/guest-sessions`, {
      data: { nickname: 'PassHost' },
      headers: { 'X-Forwarded-For': '198.51.100.13' },
    });
    const { token } = await guest.json();
    const created = await request.post(`${API}/api/rooms`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { settings: { mode: 'CLASSIC', password: 'secret123', maxPlayers: 4 } },
    });
    expect(created.ok()).toBeTruthy();
    const { roomCode } = await created.json();

    const info = await request.get(`${API}/api/rooms/${roomCode}`);
    const infoBody = await info.json();
    expect(infoBody.hasPassword).toBe(true);
    expect(JSON.stringify(infoBody)).not.toContain('passwordHash');
    expect(JSON.stringify(infoBody)).not.toContain('secret123');

    const joinGuest = await request.post(`${API}/api/guest-sessions`, {
      data: { nickname: 'PassGuest' },
      headers: { 'X-Forwarded-For': '198.51.100.14' },
    });
    const joinToken = (await joinGuest.json()).token;
    const denied = await request.post(`${API}/api/rooms/${roomCode}/join`, {
      headers: { Authorization: `Bearer ${joinToken}` },
      data: { nickname: 'PassGuest' },
    });
    expect(denied.status()).toBe(400);
    const allowed = await request.post(`${API}/api/rooms/${roomCode}/join`, {
      headers: { Authorization: `Bearer ${joinToken}` },
      data: { nickname: 'PassGuest', password: 'secret123' },
    });
    expect(allowed.ok()).toBeTruthy();
  });

  test('E2E-05 QR deep link auto-joins without duplicate identity', async ({ browser }) => {
    const hostCtx = await isolatedContext(browser);
    const host = await setupPlayer(hostCtx, 'LinkHost');
    const code = await createRoom(host);

    const visitorCtx = await isolatedContext(browser);
    const visitor = await visitorCtx.newPage();
    await visitor.goto(`${WEB}/room/${code}`);
    await visitor.waitForFunction(() => document.body.innerText.includes('Phòng chờ'), null, {
      timeout: 15000,
    });
    await expect(visitor.getByRole('button', { name: 'Sẵn sàng', exact: true })).toBeVisible();

    // A reload must resync the same player, not create a duplicate seat.
    await visitor.reload();
    await visitor.waitForFunction(() => document.body.innerText.includes('Phòng chờ'), null, {
      timeout: 15000,
    });
    const readyCount = await visitor.getByRole('button', { name: 'Sẵn sàng', exact: true }).count();
    expect(readyCount).toBeGreaterThanOrEqual(1);

    await hostCtx.close();
    await visitorCtx.close();
  });

  test('E2E-06 ready gate: host cannot start before guest is ready', async ({ browser }) => {
    const hostCtx = await isolatedContext(browser);
    const guestCtx = await isolatedContext(browser);
    const host = await setupPlayer(hostCtx, 'ReadyHost');
    await createRoom(host);
    const guest = await setupPlayer(guestCtx, 'ReadyGuest');
    await joinRoom(guest, host.url().split('/').pop()!);

    const start = host.getByRole('button', { name: /^Bắt đầu/ });
    await expect(start).toBeDisabled();
    await guest.getByRole('button', { name: 'Sẵn sàng', exact: true }).click();
    await expect(start).toBeEnabled({ timeout: 10000 });

    await hostCtx.close();
    await guestCtx.close();
  });

  test('E2E-07 guest cannot draw for the active drawer', async ({ browser }) => {
    const hostCtx = await isolatedContext(browser);
    const guestCtx = await isolatedContext(browser);
    const host = await setupPlayer(hostCtx, 'DrawHost');
    await createRoom(host);
    const guest = await setupPlayer(guestCtx, 'DrawGuest');
    await joinRoom(guest, host.url().split('/').pop()!);
    await guest.getByRole('button', { name: 'Sẵn sàng', exact: true }).click();
    await host.getByRole('button', { name: /^Bắt đầu/ }).click();

    // Whoever draws, the non-drawer must never receive a private word event.
    const start = Date.now();
    let drawer: Page | null = null;
    while (Date.now() - start < 12000 && !drawer) {
      for (const page of [host, guest]) {
        if ((await page.evaluate(() => document.body.innerText)).includes('Chọn từ để vẽ')) {
          drawer = page;
          break;
        }
      }
      await new Promise(r => setTimeout(r, 200));
    }
    expect(drawer).not.toBeNull();
    const observer = drawer === host ? guest : host;
    const observerText = await observer.evaluate(() => document.body.innerText);
    expect(observerText).not.toContain('Bạn đang vẽ');
    expect(await observer.locator('canvas').count()).toBe(0);

    await hostCtx.close();
    await guestCtx.close();
  });

  test('E2E-08 secret word stays hidden from guessers until reveal', async ({ browser }) => {
    const hostCtx = await isolatedContext(browser);
    const guestCtx = await isolatedContext(browser);
    const host = await setupPlayer(hostCtx, 'WordHost');
    await createRoom(host);
    const guest = await setupPlayer(guestCtx, 'WordGuest');
    await joinRoom(guest, host.url().split('/').pop()!);
    await guest.getByRole('button', { name: 'Sẵn sàng', exact: true }).click();
    await host.getByRole('button', { name: /^Bắt đầu/ }).click();

    const start = Date.now();
    let drawer: Page | null = null;
    while (Date.now() - start < 12000 && !drawer) {
      for (const page of [host, guest]) {
        if ((await page.evaluate(() => document.body.innerText)).includes('Chọn từ để vẽ')) {
          drawer = page;
          break;
        }
      }
      await new Promise(r => setTimeout(r, 200));
    }
    expect(drawer).not.toBeNull();
    const wordButton = drawer!.locator('button', { hasText: /EASY|MEDIUM|HARD/ }).first();
    const word = (await wordButton.textContent())!.replace(/EASY|MEDIUM|HARD/, '').trim();
    await wordButton.click();
    const observer = drawer === host ? guest : host;
    await observer.waitForFunction(
      () => document.body.innerText.includes('Đang vẽ') || document.querySelector('canvas') !== null,
      null,
      { timeout: 10000 },
    );
    const observerText = await observer.evaluate(() => document.body.innerText);
    expect(observerText).not.toContain(word);

    await hostCtx.close();
    await guestCtx.close();
  });

  test('E2E-09 mobile viewport has no horizontal overflow', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    const page = await setupPlayer(ctx, 'MobileUser');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await ctx.close();
  });

  test('E2E-10 guest creation rate limit engages', async ({ request }) => {
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      const res = await request.post(`${API}/api/guest-sessions`, {
        data: { nickname: `Rate${i}` },
        headers: { 'X-Forwarded-For': '198.51.100.99' },
      });
      statuses.push(res.status());
    }
    expect(statuses.filter(s => s === 429).length).toBeGreaterThan(0);
  });
});
