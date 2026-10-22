import { expect, test } from '@playwright/test';

for (const width of [320, 390, 600]) {
  test(`workflow captions, focused windows and controls stay separated at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    for (let scene = 1; scene <= 4; scene++) {
      await page.locator('.scene-btn').nth(scene).click();
      await expect(page.locator('.hero-sticky')).toHaveAttribute('data-scene', String(scene));
      await page.locator('.hero-sticky').evaluate(async hero => {
        await Promise.allSettled(hero.getAnimations({ subtree: true })
          .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
          .map(animation => animation.finished));
      });
      await expect.poll(async () => {
        return page.locator('.visual-stage').evaluate(stage => {
          const caption = stage.querySelector('.scene-description')!.getBoundingClientRect();
          const controls = stage.querySelector('.stage-bottom')!.getBoundingClientRect();
          const selected = stage.querySelector('.window[aria-pressed=true]');
          const preview = selected?.getBoundingClientRect();
          return { captionClear: caption.bottom <= controls.top - 12, contained: !preview || (preview.left >= 8 && preview.right <= innerWidth - 8), previewClear: !preview || preview.bottom <= caption.top - 12, captionGap: controls.top - caption.bottom, previewBottom: preview?.bottom, captionTop: caption.top, previewLeft: preview?.left, previewRight: preview?.right };
        });
      }).toMatchObject({ captionClear: true, contained: true, previewClear: true });
      expect(await page.locator('.scene-description').evaluate(e => e.scrollHeight <= e.clientHeight && e.scrollWidth <= e.clientWidth)).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });
}

test('chapter navigation seeks the story and subsequent scrolling stays synchronized', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const hero = page.locator('.hero-sticky');
  await page.getByRole('button', { name: 'Connected workflow chapter', exact: true }).click();
  await expect(hero).toHaveAttribute('data-scene', '4');
  const travel = await page.locator('.hero-story').evaluate(e => e.clientHeight - innerHeight);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(travel * .8);
  await expect.poll(() => page.locator('.story-progress > span').evaluate(e => new DOMMatrixReadOnly(getComputedStyle(e).transform).m22)).toBeGreaterThan(.8);
  await page.mouse.wheel(0, 60);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(travel * .9);
  await expect(hero).toHaveAttribute('data-scene', '4');
  for (const [fraction, scene] of [[.67, '3'], [.45, '2'], [.2, '1'], [0, '0']]) {
    await page.evaluate(y => scrollTo({ top: y, behavior: 'instant' }), travel * Number(fraction));
    await expect(hero).toHaveAttribute('data-scene', String(scene));
  }
  await page.getByRole('button', { name: 'Overview chapter' }).focus();
  await page.keyboard.press('End');
  await expect(hero).toHaveAttribute('data-scene', '4');
  await page.keyboard.press('ArrowLeft');
  await expect(hero).toHaveAttribute('data-scene', '3');
});

test('mobile menu closes on destination, Escape and outside pointer, with predictable focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const toggle = page.getByLabel('Open navigation');
  const menu = page.locator('.mobile-menu');
  await toggle.click();
  await menu.getByRole('link', { name: 'Our approach' }).click();
  await expect(menu).not.toHaveAttribute('open', '');
  await expect(page.locator('#philosophy h2')).toBeFocused();
  await expect.poll(async () => (await page.locator('#philosophy h2').boundingBox())!.y).toBeGreaterThan(66);
  await toggle.click();
  await menu.getByRole('link', { name: 'Nexus', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(menu).not.toHaveAttribute('open', '');
  await expect(toggle).toBeFocused();
  await toggle.click();
  await page.locator('#philosophy .lede').click();
  await expect(menu).not.toHaveAttribute('open', '');
  await toggle.click();
  await menu.getByRole('link', { name: 'Nexus', exact: true }).click();
  await expect(page).toHaveURL(/\/nexus$/);
  await expect(page.locator('main h1')).toBeFocused();
  await expect(menu).not.toHaveAttribute('open', '');
});

test('portrait tablet uses a balanced single-column product layout', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto('/');
  const heading = await page.locator('#sentry h2').boundingBox();
  const image = await page.locator('#sentry .visual').boundingBox();
  expect(image!.width).toBeGreaterThan(600);
  expect(image!.y + image!.height).toBeLessThan(heading!.y);
  expect(heading!.height).toBeLessThan(140);
  expect(await page.locator('.suite-grid').evaluate(e => getComputedStyle(e).gridTemplateColumns.split(' ').length)).toBe(1);
});

test('reduced motion selects chapters without seeking and keeps mobile captions clear', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  for (let scene = 1; scene <= 4; scene++) {
    await page.locator('.scene-btn').nth(scene).click();
    await expect(page.locator('.hero-sticky')).toHaveAttribute('data-scene', String(scene));
    expect(await page.evaluate(() => scrollY)).toBe(0);
    const caption = await page.locator('.scene-description').boundingBox();
    const controls = await page.locator('.stage-bottom').boundingBox();
    expect(controls!.y - (caption!.y + caption!.height)).toBeGreaterThanOrEqual(12);
    expect(controls!.y + controls!.height).toBeLessThan(800);
  }
});

test('hardware annotation has mobile insets and clears the illustration', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const annotation = await page.locator('.hardware-visual .fine').boundingBox();
  const band = await page.locator('.hardware-band').boundingBox();
  expect(annotation!.x).toBeGreaterThanOrEqual(20);
  expect(annotation!.x + annotation!.width).toBeLessThanOrEqual(370);
  expect(annotation!.y).toBeGreaterThan(band!.y + band!.height + 12);
});
