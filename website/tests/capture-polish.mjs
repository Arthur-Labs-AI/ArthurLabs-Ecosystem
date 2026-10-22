import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
const browser = await chromium.launch();
const observations = [];
for (const [width, height] of [[1440, 1000], [1920, 1080], [768, 1024], [390, 844], [600, 844]]) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://localhost:3000');
  await page.locator('footer').scrollIntoViewIfNeeded();
  await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForTimeout(850); // Capture settled visual interpolation, not a test assertion.
  await page.screenshot({ path: `artifacts/phase-1.1/landing-${width}-full.png`, fullPage: true });
  await page.screenshot({ path: `artifacts/phase-1.1/landing-${width}-overview.png` });
  for (let scene = 1; scene <= 4; scene++) {
    await page.locator('.scene-btn').nth(scene).click();
    await page.waitForTimeout(850);
    await page.screenshot({ path: `artifacts/phase-1.1/landing-${width}-chapter-${scene}.png` });
    observations.push(await page.evaluate(({ width, scene }) => {
      const rect = selector => {
        const r = document.querySelector(selector).getBoundingClientRect();
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      };
      return { width, scene, scrollY, actualScene: document.querySelector('.hero-sticky').dataset.scene,
        caption: rect('.scene-description'), controls: rect('.stage-bottom'),
        selected: document.querySelector('.window[aria-pressed=true]') ? rect('.window[aria-pressed=true]') : null,
        overflow: document.documentElement.scrollWidth - innerWidth };
    }, { width, scene }));
  }
  for (const section of ['suite', 'sentry', 'hardware']) {
    await page.locator(`#${section}`).evaluate(element => scrollTo({ top: element.getBoundingClientRect().top + scrollY - 90, behavior: 'instant' }));
    await page.screenshot({ path: `artifacts/phase-1.1/landing-${width}-${section}.png` });
  }
  observations.push({ width, errors });
  await page.close();
}
for (const width of [1440, 390]) {
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 }, deviceScaleFactor: 2 });
  await page.goto('http://localhost:3000');
  await page.locator('.window img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  await page.screenshot({ path: `artifacts/phase-1.1/landing-${width}-dpr2.png` });
  await page.close();
}
writeFileSync('artifacts/phase-1.1/measurements.json', JSON.stringify(observations, null, 2));
await browser.close();
