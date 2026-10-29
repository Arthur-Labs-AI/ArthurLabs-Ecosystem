import {test,expect} from '@playwright/test';
import {objects} from '../src/components/studio-concept/content';
const route='/studio/concept';
const desk=(page:import('@playwright/test').Page)=>page.locator('#infinite-desk');
const object=(page:import('@playwright/test').Page,id:string)=>page.locator(`[data-desk-object=${id}]`);
async function settle(page:import('@playwright/test').Page,phase:string){await expect(desk(page)).toHaveAttribute('data-motion',phase);}
async function prepare(page:import('@playwright/test').Page){await page.goto(route);await expect(object(page,'thought')).toBeEnabled();await page.evaluate(()=>document.fonts.ready);}
for(const [width,height]of [[320,844],[390,844],[768,1024],[1440,1000],[1920,1080]])test(`desk objects remain independently inspectable and return exactly at ${width}`,async({page})=>{
 await page.setViewportSize({width,height});await prepare(page);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
 for(const entry of objects){
  const button=object(page,entry.id);await button.scrollIntoViewIfNeeded();await page.mouse.move(1,1);await page.locator('[aria-label="Reset desk perspective"]').evaluate((e:HTMLButtonElement)=>e.click());
  // Keyboard activation avoids pointer-dependent parallax while measuring exact geometry.
  await button.focus();const before=await button.boundingBox();await button.press('Enter');await settle(page,'open');
  await expect(page.getByRole('dialog')).toBeVisible();await expect(page.locator('#desk-inspector-title')).toHaveText(entry.title);
  expect(await page.locator('dialog').evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);
  await page.keyboard.press('Escape');await settle(page,'idle');await expect(button).toBeFocused();
  const after=await button.boundingBox();expect(after).toEqual(before);
 }
});

test('mouse selection performs lift, expansion, recession and continuous reverse',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});await prepare(page);const button=object(page,'thought');await button.click();
 await expect(page.getByRole('dialog')).toBeVisible();await settle(page,'opening');
 const first=await page.locator('[data-flight]').evaluate(e=>({rect:e.getBoundingClientRect().toJSON(),transform:getComputedStyle(e).transform}));
 await page.waitForFunction(()=>{const e=document.querySelector('[data-flight]')!;return e.getBoundingClientRect().width>420;});
 const second=await page.locator('[data-flight]').evaluate(e=>({rect:e.getBoundingClientRect().toJSON(),transform:getComputedStyle(e).transform}));expect(second.transform).not.toBe(first.transform);
 await settle(page,'open');expect(await object(page,'observations').evaluate(e=>Number(getComputedStyle(e).opacity))).toBeLessThan(.4);
 await page.getByRole('button',{name:/Return to Desk/}).click();await settle(page,'closing');await expect(page.locator('[data-flight]')).toBeVisible();await settle(page,'idle');await expect(button).toBeFocused();
});

test('rapid close during expansion, keyboard Space and viewport change recover cleanly',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});await prepare(page);
 for(let i=0;i<3;i++){await object(page,'study').focus();await object(page,'study').press('Space');await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');await settle(page,'idle');}
 await object(page,'revisions').press('Enter');await settle(page,'open');await page.setViewportSize({width:768,height:1024});await settle(page,'idle');expect(await page.evaluate(()=>document.body.style.overflow)).not.toBe('hidden');
 await object(page,'observations').press('Enter');await settle(page,'open');await page.keyboard.press('Escape');await settle(page,'idle');
});

test('local sample interactions, focus containment and honest downloads',async({page})=>{
 await prepare(page);await object(page,'thought').press('Enter');await settle(page,'open');await page.getByLabel('Try another wording').fill('A gesture can be an invitation.');await page.getByRole('button',{name:'Keep this wording on the desk'}).click();await expect(page.getByRole('status')).toContainText('Your sample wording');
 await page.keyboard.press('Escape');await settle(page,'idle');await expect(object(page,'thought')).toContainText('A gesture can be an invitation.');
 await object(page,'observations').press('Enter');await settle(page,'open');await page.getByRole('button',{name:'Consent',exact:true}).click();await expect(page.locator('[aria-live=polite]')).toContainText('Consent is a design material.');
 for(let i=0;i<8;i++)await page.keyboard.press('Tab');expect(await page.evaluate(()=>document.querySelector('dialog')!.contains(document.activeElement))).toBe(true);
 await page.keyboard.press('Escape');await settle(page,'idle');await page.getByRole('link',{name:'Download Arthur Studio',exact:true}).click();await expect(page).toHaveURL(/#studio-downloads$/);await expect(page.locator('#studio-downloads')).toContainText('Download Not Yet Available');await expect(page.locator('#studio-downloads a[download]')).toHaveCount(0);await expect.poll(()=>page.locator('#studio-download-title').evaluate(e=>e.getBoundingClientRect().top)).toBeGreaterThan(66);
});

test('reduced motion has equivalent inspections without flight or parallax and native page scrolling returns',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});await prepare(page);await object(page,'question').press('Enter');await settle(page,'open');
 expect(await page.locator('[data-flight]').evaluate(e=>getComputedStyle(e).transform)).toBe('matrix(1, 0, 0, 1, 0, 0)');
 await page.keyboard.press('Escape');await settle(page,'idle');const y=await page.evaluate(()=>scrollY);await page.mouse.wheel(0,400);await expect.poll(()=>page.evaluate(()=>scrollY)).toBeGreaterThan(y);
 await page.locator('summary').filter({hasText:'Prefer to read?'}).click();await expect(page.getByRole('heading',{name:'Follow the question.',exact:true})).toBeVisible();
});

test('pointer inspection preserves the page scroll position through open and return',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});await prepare(page);await page.getByRole('link',{name:'Explore the Desk',exact:true}).click();await page.waitForFunction(()=>{const e=document.querySelector('#infinite-desk')!;const offset=parseFloat(getComputedStyle(e).scrollMarginTop)+parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop);return Math.abs(e.getBoundingClientRect().top-offset)<1;});
 const button=object(page,'thought');await button.scrollIntoViewIfNeeded();await button.hover();
 const y=await page.evaluate(()=>scrollY);const box=(await button.boundingBox())!;await page.mouse.click(box.x+box.width/2,box.y+box.height/2);await settle(page,'open');expect(await page.evaluate(()=>scrollY)).toBe(y);
 await page.getByRole('button',{name:/Return to Desk/}).click();await settle(page,'idle');expect(await page.evaluate(()=>scrollY)).toBe(y);await expect(button).toBeFocused();
});

test('touch inspection preserves the mobile desk position and restores its source',async({browser})=>{
 const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});const page=await context.newPage();await prepare(page);const button=object(page,'question');await button.scrollIntoViewIfNeeded();const y=await page.evaluate(()=>scrollY);await button.tap();await settle(page,'open');expect(await page.evaluate(()=>scrollY)).toBe(y);await page.getByRole('button',{name:/Return to Desk/}).tap();await settle(page,'idle');expect(await page.evaluate(()=>scrollY)).toBe(y);await expect(button).toBeFocused();await context.close();
});
