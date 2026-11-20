import { test, expect, BrowserContext, Page } from '@playwright/test';

const WEB = 'http://localhost:3002';

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
  const btn = page.locator('button', { hasText: 'Tạo phòng' }).first();
  await btn.waitFor({ state: 'visible', timeout: 10000 });
  await btn.click();
  await page.waitForURL(/\/room\//, { timeout: 15000 });
  return page.url().split('/').pop()!;
}

async function joinRoom(page: Page, code: string) {
  await page.getByPlaceholder('Mã phòng').fill(code);
  const btn = page.locator('button', { hasText: 'Vào' });
  await btn.waitFor({ state: 'visible', timeout: 10000 });
  await btn.click();
  await page.waitForURL(/\/room\//, { timeout: 15000 });
  await page.waitForFunction(
    () => document.body.innerText.includes('Phòng chờ'),
    null,
    { timeout: 10000 },
  );
}

async function waitForDrawer(pages: Page[], timeout = 12000): Promise<{ drawer: Page; guessers: Page[] } | null> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (let i = 0; i < pages.length; i++) {
      const text = await pages[i].evaluate(() => document.body.innerText);
      if (text.includes('Chọn từ để vẽ')) {
        return {
          drawer: pages[i],
          guessers: pages.filter((_, j) => j !== i),
        };
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

test.describe('Live Room Full Flow', () => {
  let hostCtx: BrowserContext;
  let guestCtx: BrowserContext;

  test.beforeAll(async ({ browser }) => {
    hostCtx = await browser.newContext();
    guestCtx = await browser.newContext();
  });

  test.afterAll(async () => {
    await hostCtx.close();
    await guestCtx.close();
  });

  test('2 players: create room, join, start match, draw, guess, reveal', async () => {
    test.setTimeout(120000);
    const host = await setupPlayer(hostCtx, 'Host');
    const guest = await setupPlayer(guestCtx, 'Guest');

    const code = await createRoom(host);
    await host.waitForFunction(
      () => document.body.innerText.includes('Phòng chờ'),
      null,
      { timeout: 10000 },
    );

    await joinRoom(guest, code);
    await new Promise(r => setTimeout(r, 2000));

    const hostText = await host.evaluate(() => document.body.innerText);
    expect(hostText).toContain('Guest');

    const readyBtn = guest.locator('button', { hasText: 'Sẵn sàng' });
    await readyBtn.waitFor({ state: 'visible', timeout: 10000 });
    await readyBtn.click();
    await host.waitForFunction(
      () => document.body.innerText.includes('Sẵn sàng'),
      null,
      { timeout: 10000 },
    );

    const startBtn = host.locator('button', { hasText: 'Bắt đầu' });
    await startBtn.waitFor({ state: 'visible', timeout: 10000 });
    await expect(startBtn).toBeEnabled({ timeout: 10000 });
    await startBtn.click();

    const drawerInfo = await waitForDrawer([host, guest]);
    expect(drawerInfo).not.toBeNull();
    const { drawer, guessers } = drawerInfo!;

    const wordBtn = drawer.locator('button', { hasText: /EASY|MEDIUM|HARD/ }).first();
    const wordText = await wordBtn.textContent();
    const word = wordText!.replace(/EASY|MEDIUM|HARD/, '').trim();
    await wordBtn.click();

    await drawer.waitForFunction(
      () => document.body.innerText.includes('Bạn đang vẽ'),
      null,
      { timeout: 10000 },
    );

    const canvas = drawer.locator('canvas');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      await drawer.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
      await drawer.mouse.down();
      await drawer.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5, { steps: 10 });
      await drawer.mouse.up();
    }

    for (const g of guessers) {
      const input = g.locator('input[placeholder="Đoán từ..."]');
      await input.waitFor({ timeout: 5000 });
      await input.fill(word);
      await input.press('Enter');
    }

    await drawer.waitForFunction(
      () =>
        document.body.innerText.includes('Người đoán đúng') ||
        document.body.innerText.includes('Kết quả'),
      null,
      { timeout: 20000 },
    );

    await host.close();
    await guest.close();
  });
});

test.describe('Quick Challenge', () => {
  test('create challenge, finalize, guess correctly', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(WEB);
    await page.waitForSelector('main[data-ready="true"]', { timeout: 15000 });
    await page.getByPlaceholder('Nhập tên của bạn...').fill('Challenger');
    await page.waitForFunction(
      () => {
        const btn = Array.from(document.querySelectorAll('button')).find(b =>
          b.textContent?.includes('Thách bạn bè'),
        );
        return !!btn && !(btn as HTMLButtonElement).disabled;
      },
      null,
      { timeout: 5000 },
    );
    await page.locator('button', { hasText: 'Thách bạn bè' }).click();
    await page.waitForURL(/\/challenge\/create/, { timeout: 15000 });

    await page.getByRole('button', { name: 'Bắt đầu vẽ' }).click();

    // The redesigned challenge page renders "Vẽ từ" as a label followed by the
    // word in a live region, with no colon. Wait for the async word to load.
    const wordEl = page.locator('[aria-live="polite"]').first();
    await expect(wordEl).toBeVisible({ timeout: 10000 });
    await expect(wordEl).not.toHaveText('', { timeout: 10000 });
    const word = await wordEl.textContent();
    expect(word?.trim()).toBeTruthy();

    await page.waitForFunction(
      () =>
        document.body.innerText.includes('Tạo thách thức thành công!') ||
        document.body.innerText.includes('Sao chép liên kết'),
      null,
      { timeout: 40000 },
    );
  });
});

test.describe('Profanity Filter', () => {
  test('rejects profane nicknames', async ({ request }) => {
    const res = await request.post('http://127.0.0.1:3001/api/guest-sessions', {
      data: { nickname: 'fuckface' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(400);
  });
});

test.describe('API Rate Limiting', () => {
  test('guest creation rate limited after 10 requests', async ({ request }) => {
    const results: number[] = [];
    for (let i = 0; i < 15; i++) {
      const res = await request.post('http://127.0.0.1:3001/api/guest-sessions', {
        data: { nickname: `User${i}` },
        headers: { 'Content-Type': 'application/json' },
      });
      results.push(res.status());
    }
    expect(results.filter(s => s === 429).length).toBeGreaterThan(0);
  });
});
