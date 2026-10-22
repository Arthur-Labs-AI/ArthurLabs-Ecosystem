import { chromium } from '@playwright/test';
// Run with the production app on :3000 and `python -m http.server 3001` in website/.
const browser = await chromium.launch();
for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
  const page = await browser.newPage({ viewport: { width, height } });
  for (const [kind, url] of [['reference', 'http://127.0.0.1:3001/references/arthurlabs-landing-prototype.html'], ['landing', 'http://127.0.0.1:3000']]) {
    await page.goto(url);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `artifacts/${kind}-${name}.png` });
    if (kind === 'landing') {
      await page.getByRole('button', { name: 'Connected workflow chapter', exact: true }).click();
      await page.waitForTimeout(800);
      await page.screenshot({ path: `artifacts/workflow-${name}.png` });
    }
    for (const section of ['suite', 'studio', 'nexus', 'sentry', 'hardware', 'philosophy', 'footer']) {
      await page.locator(`#${section}`).evaluate(element => scrollTo({ top: element.getBoundingClientRect().top + scrollY - 80, behavior: 'instant' }));
      await page.waitForTimeout(250);
      await page.screenshot({ path: `artifacts/${kind}-${section}-${name}.png` });
    }
  }
  await page.close();
}
await browser.close();
