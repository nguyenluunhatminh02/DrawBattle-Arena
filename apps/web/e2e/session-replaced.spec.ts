import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';

const WEB = process.env.E2E_WEB_URL ?? 'http://localhost:3002';

let nextIsolatedIp = 1;
function isolatedContext(browser: Browser) {
  return browser.newContext({
    extraHTTPHeaders: { 'X-Forwarded-For': `198.51.102.${nextIsolatedIp++}` },
  });
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

// A focused unit test would require a React DOM/Jest setup that this repo
// does not have. This Playwright spec drives the real room page against the
// real gateway and uses the page's opt-in `?socketProbe=1` observation hook to
// inspect the shared socket singleton.
test.describe('session:replaced scoped cleanup', () => {
  test('keeps other listeners, suppresses stale emits, preserves identity and normal join', async ({ browser }) => {
    test.setTimeout(120000);
    const ctx = await isolatedContext(browser);
    const host = await setupPlayer(ctx, 'ReplaceHost');
    const code = await createRoom(host);
    const roomUrl = host.url();

    await host.goto(`${roomUrl}?socketProbe=1`);
    await host.waitForFunction(() => document.body.innerText.includes('Phòng chờ'), null, {
      timeout: 15000,
    });
    await host.waitForFunction(() => !!(window as any).__drawbattleSocketProbe?.getSocket?.()?.connected, null, {
      timeout: 15000,
    });

    const before = await host.evaluate(() => {
      const probe = (window as any).__drawbattleSocketProbe;
      const socket = probe.getSocket();
      // A separate consumer of the shared socket registers its own listener.
      (window as any).__observerCalls = 0;
      (window as any).__observer = () => { (window as any).__observerCalls += 1; };
      probe.registerObserver('room:hostChanged', (window as any).__observer);
      return {
        socketId: socket.id,
        observerCount: probe.listenerCount('room:hostChanged'),
        connected: socket.connected,
      };
    });
    expect(before.socketId).toBeTruthy();
    expect(before.connected).toBe(true);
    expect(before.observerCount).toBeGreaterThanOrEqual(2);

    // A second tab with the same guest identity triggers session:replaced on
    // the first tab without unmounting it.
    const replacement = await ctx.newPage();
    await replacement.goto(`${roomUrl}?socketProbe=1`);
    await replacement.waitForFunction(() => document.body.innerText.includes('Phòng chờ'), null, {
      timeout: 15000,
    });
    await host.waitForFunction(() => !(window as any).__drawbattleSocketProbe.isActive(), null, {
      timeout: 15000,
    });

    const after = await host.evaluate(() => {
      const probe = (window as any).__drawbattleSocketProbe;
      const socket = probe.getSocket();
      // Invoke listeners directly: the independent consumer's callback must
      // still be registered after the room effect removed only its own.
      for (const listener of socket.listeners('room:hostChanged')) listener('new-host');
      return {
        active: probe.isActive(),
        connected: socket.connected,
        observerCalls: (window as any).__observerCalls,
        observerCount: probe.listenerCount('room:hostChanged'),
      };
    });
    expect(after.active).toBe(false);
    expect(after.connected).toBe(true); // live replacement socket not disconnected
    expect(after.observerCalls).toBeGreaterThan(0);
    expect(after.observerCount).toBe(1); // only this effect's listener was removed

    // Record every outgoing packet, then exercise real UI actions on the
    // replaced page. The active-socket guard must suppress all of them.
    await host.evaluate(() => {
      const socket = (window as any).__drawbattleSocketProbe.getSocket();
      (window as any).__emitted = [];
      const original = socket.emit.bind(socket);
      socket.emit = (event: string, ...args: any[]) => {
        (window as any).__emitted.push(event);
        return original(event, ...args);
      };
      window.confirm = () => true;
    });
    await host.getByRole('button', { name: /Rời phòng|Thoát/ }).first().click({ force: true });
    await host.evaluate(() => (window as any).__drawbattleSocketProbe.emit('match:start'));
    const emitted = await host.evaluate(() => (window as any).__emitted);
    expect(emitted).toEqual([]);

    // The replacement still has an active socket and keeps the same identity.
    expect(await replacement.evaluate(() => (window as any).__drawbattleSocketProbe.isActive())).toBe(true);
    const playerId = await replacement.evaluate(() =>
      JSON.parse(localStorage.getItem('drawbattle-store') || '{}')?.state?.player?.playerId,
    );
    expect(playerId).toBeTruthy();

    // A reload keeps the same player id and joins normally again.
    await replacement.reload();
    await replacement.waitForFunction(() => document.body.innerText.includes('Phòng chờ'), null, {
      timeout: 15000,
    });
    const reloadedId = await replacement.evaluate(() =>
      JSON.parse(localStorage.getItem('drawbattle-store') || '{}')?.state?.player?.playerId,
    );
    expect(reloadedId).toBe(playerId);
    expect(code).toMatch(/^[A-Z2-9]{6}$/);

    await ctx.close();
  });
});
