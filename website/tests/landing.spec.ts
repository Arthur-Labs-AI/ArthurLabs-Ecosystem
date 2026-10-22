import { expect, test } from '@playwright/test';

test('production page hydrates, serves screenshots, and all navigation resolves', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('From idea to impact.');
  await page.locator('footer').scrollIntoViewIfNeeded();
  await expect.poll(() => page.locator('img').evaluateAll(images => images.every(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0))).toBe(true);
  const links = await page.locator('a').evaluateAll(anchors => anchors.map(anchor => anchor.getAttribute('href')!).filter(Boolean));
  for (const href of new Set(links)) {
    const [path, hash] = href.split('#');
    const response = await request.get(path || '/');
    expect(response.status(), href).toBe(200);
    if (hash && (!path || path === '/')) expect(await page.locator(`[id="${hash}"]`).count(), href).toBe(1);
  }
  expect(errors).toEqual([]);
});

test('workflow chapters follow scrolling forward and backward; windows and keyboard select', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const hero = page.locator('.hero-sticky');
  await page.getByRole('button', { name: 'Focus Arthur Studio preview' }).click();
  await expect(hero).toHaveAttribute('data-scene', '1');
  await page.getByRole('button', { name: 'Sentry chapter', exact: true }).click();
  await expect(hero).toHaveAttribute('data-scene', '3');
  await page.keyboard.press('ArrowLeft');
  await expect(hero).toHaveAttribute('data-scene', '2');
  const travel = await page.locator('.hero-story').evaluate(element => element.clientHeight - innerHeight);
  for (const [progress, scene] of [[.2, 1], [.45, 2], [.67, 3], [.9, 4], [.45, 2], [0, 0]]) {
    await page.evaluate(y => window.scrollTo({ top: y, behavior: 'instant' }), travel * progress);
    await expect(hero).toHaveAttribute('data-scene', String(scene));
  }
});

for (const width of [320, 390, 768, 1440, 2560]) {
  test(`responsive layout at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 760 ? 844 : 1000 });
    await page.goto('/');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const title = await page.locator('h1').boundingBox();
    expect(title!.x).toBeGreaterThanOrEqual(0);
    expect(title!.x + title!.width).toBeLessThanOrEqual(width);
    await expect(page.getByRole('button', { name: 'Nexus chapter', exact: true })).toBeInViewport();
    if (width < 760) {
      await page.getByLabel('Open navigation').click();
      await page.locator('.mobile-menu').getByRole('link', { name: 'Sentry', exact: true }).click();
      await expect(page).toHaveURL(/\/sentry$/);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sentry');
    }
  });
}

test('reduced motion keeps an accessible selectable hero without a scroll trap', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  expect(await page.locator('.hero-story').evaluate(element => element.clientHeight)).toBeLessThanOrEqual(850);
  await page.getByRole('button', { name: 'Sentry chapter', exact: true }).click();
  await expect(page.locator('.hero-sticky')).toHaveAttribute('data-scene', '3');
  await expect(page.locator('.scene-description')).toContainText('Check the outcome.');
  await page.getByRole('button', { name: 'Overview chapter' }).focus();
  await page.keyboard.press('End');
  await expect(page.locator('.hero-sticky')).toHaveAttribute('data-scene', '4');
});

test('route foundations and unknown route', async ({ page }) => {
  for (const [path, heading] of [['/suite', 'Three applications.One greater possibility.'], ['/studio', 'Arthur Studio'], ['/nexus', 'One task.The right intelligence.'], ['/sentry', 'Sentry'], ['/hardware', 'Beyond the screen.']]) {
    const response = await page.goto(path);
    expect(response!.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
  }
  expect((await page.goto('/unknown'))!.status()).toBe(404);
});

test('short phone screens keep the headline, previews, and controls separated', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  expect(await page.locator('.hero-sticky').evaluate(element => getComputedStyle(element).position)).toBe('relative');
  const actions = await page.locator('.ctas').boundingBox();
  const preview = await page.locator('.window.nexus').boundingBox();
  expect(preview!.y).toBeGreaterThan(actions!.y + actions!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
});

test('all authentic product windows can be brought forward with the keyboard', async ({ page }) => {
  await page.goto('/');
  for (const [name, scene] of [['Arthur Studio', '1'], ['Nexus', '2'], ['Sentry', '3']]) {
    const button = page.getByRole('button', { name: `Focus ${name} preview`, exact: true });
    await expect(button).toBeEnabled();
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.hero-sticky')).toHaveAttribute('data-scene', scene);
  }
});
