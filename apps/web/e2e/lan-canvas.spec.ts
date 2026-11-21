import { test, expect, BrowserContext, Page } from '@playwright/test';

const WEB = process.env.E2E_WEB_URL ?? 'http://localhost:3002';

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

test.describe('HTTP LAN canvas and touch-target regressions', () => {
  test('drawing works when crypto.randomUUID is unavailable', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await setupPlayer(ctx, 'LanDrawer');
    await page.addInitScript(() => {
      Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true });
    });
    await page.route('**/api/challenges', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ challengeId: 'lan-test', word: 'con meo', timeLimit: 15 }),
    }));
    // Use the real home-page action so the guest token is persisted before
    // the create page's hydration guard decides whether to redirect home.
    await page.getByRole('button', { name: 'Thách bạn bè' }).click();
    await page.waitForURL(/\/challenge\/create/, { timeout: 15000 });
    await page.waitForFunction(() => document.body.innerText.includes('Bắt đầu vẽ'), null, { timeout: 15000 });
    await page.getByRole('button', { name: 'Bắt đầu vẽ' }).click();
    const canvas = page.getByLabel('Khu vực vẽ thách thức');
    await expect(canvas).toBeVisible();
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + 80, { steps: 4 });
    await page.mouse.up();
    await expect(page.getByRole('button', { name: 'Hoàn tác' })).toBeEnabled();
    await ctx.close();
  });

  test('landing settings toggles have 44px touch targets', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    const page = await setupPlayer(ctx, 'TouchTargetUser');
    const settingsToggle = page.getByRole('button', { name: /cài đặt phòng/i });
    const settingsBox = (await settingsToggle.boundingBox())!;
    expect(settingsBox.height).toBeGreaterThanOrEqual(44);
    await settingsToggle.click();
    const hintsToggle = page.getByRole('button', { name: 'Bật tắt gợi ý' });
    const hintsBox = (await hintsToggle.boundingBox())!;
    expect(hintsBox.width).toBeGreaterThanOrEqual(44);
    expect(hintsBox.height).toBeGreaterThanOrEqual(44);
    await ctx.close();
  });
});
