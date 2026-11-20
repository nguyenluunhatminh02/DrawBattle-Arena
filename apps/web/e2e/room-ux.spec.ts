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
  await page.locator('button', { hasText: 'Vào' }).click();
  await page.waitForURL(/\/room\//, { timeout: 15000 });
  await page.waitForFunction(
    () => document.body.innerText.includes('Phòng chờ'),
    null,
    { timeout: 10000 },
  );
}

test.describe('QR Direct Join', () => {
  test('fresh visitor opens room link, enters nickname, joins lobby', async ({ browser }) => {
    test.setTimeout(90000);
    const hostCtx = await browser.newContext();
    const host = await setupPlayer(hostCtx, 'QrHost');
    const code = await createRoom(host);
    await host.waitForFunction(
      () => document.body.innerText.includes('Phòng chờ'),
      null,
      { timeout: 10000 },
    );

    const visitorCtx = await browser.newContext();
    const visitor = await visitorCtx.newPage();
    await visitor.goto(`${WEB}/room/${code}`);
    await visitor.getByPlaceholder('Nhập tên của bạn...').fill('QrVisitor');
    await visitor.locator('button', { hasText: 'Vào phòng' }).click();
    await visitor.waitForFunction(
      () => document.body.innerText.includes('Phòng chờ'),
      null,
      { timeout: 15000 },
    );
    const text = await visitor.evaluate(() => document.body.innerText);
    expect(text).toContain('QrHost');
    expect(text).toContain('Sẵn sàng');

    await hostCtx.close();
    await visitorCtx.close();
  });
});

test.describe('Mobile UI', () => {
  test('390x844: no horizontal overflow, start gated by ready, leave button visible', async ({ browser }) => {
    test.setTimeout(90000);
    const hostCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const guestCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const host = await setupPlayer(hostCtx, 'MHost');
    const code = await createRoom(host);
    const guest = await setupPlayer(guestCtx, 'MGuest');
    await joinRoom(guest, code);

    const overflow = await host.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    const startBtn = host.locator('button', { hasText: 'Bắt đầu' });
    await expect(startBtn).toBeDisabled();
    await guest.locator('button', { hasText: 'Sẵn sàng' }).click();
    await expect(startBtn).toBeEnabled({ timeout: 10000 });

    await expect(host.locator('button', { hasText: 'Thoát' })).toBeVisible();

    const guestOverflow = await guest.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(guestOverflow).toBeLessThanOrEqual(1);

    await hostCtx.close();
    await guestCtx.close();
  });
});
