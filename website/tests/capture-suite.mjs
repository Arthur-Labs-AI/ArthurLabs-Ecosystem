import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
const base = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';
const directory = 'artifacts/phase-2a';
const browser = await chromium.launch();
const observations = [];
for (const [width, height] of [[390,844],[768,1024],[1440,1000],[1920,1080]]) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/suite`);
  await page.locator('footer').scrollIntoViewIfNeeded();
  await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode().catch(() => {}))));
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: `${directory}/suite-${width}-full.png`, fullPage: true });
  await page.screenshot({ path: `${directory}/suite-${width}-hero.png` });
  const story = page.locator('#follow-the-idea');
  const bounds = await story.evaluate(element => ({ top: element.getBoundingClientRect().top + scrollY, travel: element.clientHeight - innerHeight }));
  for (const [name, progress] of [['capture',.12],['handoff-studio-nexus',.24],['orchestrate',.34],['handoff-nexus-sentry',.46],['verify',.58],['handoff-sentry-nexus',.70],['consolidate',.77],['handoff-nexus-studio',.84],['return',.93]]) {
    await page.evaluate(top => scrollTo({ top, behavior: 'instant' }), bounds.top + bounds.travel * progress);
    await page.waitForFunction(() => !document.querySelector('#follow-the-idea').hasAttribute('hidden'));
    await page.waitForTimeout(100); // Capture a settled scrub position; assertions live in suite.spec.ts.
    await page.screenshot({ path: `${directory}/suite-${width}-${name}.png` });
    observations.push(await story.evaluate((element, input) => {
      const rect = e => { const r = e.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right }; };
      return { ...input, chapter: element.dataset.chapter, frame: element.dataset.frame, workspace: element.dataset.workspace,
        overflow: document.documentElement.scrollWidth - innerWidth,
        controls: rect(element.querySelector('[aria-label="Suite workflow chapters"]')),
        document: rect(element.querySelector('[data-travel-document]')),
        panels: [...element.querySelectorAll('[data-suite-panel]')].map(e => Number(getComputedStyle(e).opacity)) };
    }, { width, name, progress }));
  }
  for (const [id,name] of [['architecture-title','architecture'],['independent-title','products'],['suite-hardware-title','hardware'],['availability-title','availability']]) {
    await page.locator(`#${id}`).evaluate(element => scrollTo({ top: element.getBoundingClientRect().top + scrollY - 110, behavior: 'instant' }));
    await page.screenshot({ path: `${directory}/suite-${width}-${name}.png` });
  }
  observations.push({ width, errors });
  await page.close();
}
for (const width of [390,1440]) {
  const height = width === 390 ? 844 : 1000;
  const page = await browser.newPage({ viewport:{width,height} });
  await page.goto(base);
  await page.locator('[data-workflow-ready=true]').waitFor();
  await page.locator('.window img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  await page.screenshot({ path:`${directory}/landing-${width}-regression.png` });
  await page.close();
}
const reduced = await browser.newPage({ viewport:{width:390,height:844}, reducedMotion:'reduce' });
await reduced.goto(`${base}/suite`);
await reduced.getByRole('button',{name:'Return chapter',exact:true}).click();
await reduced.getByRole('button',{name:'Show Nexus consolidation'}).click();
await reduced.screenshot({path:`${directory}/suite-390-reduced-motion.png`});
await reduced.close();
writeFileSync(`${directory}/capture-observations.json`,JSON.stringify(observations,null,2));
await browser.close();
