import {chromium,expect} from '@playwright/test';
import fs from 'node:fs/promises';
const browser=await chromium.launch(),evidence=[];
for(const [width,height] of [[390,844],[1440,1000]]){
 const page=await browser.newPage({viewport:{width,height},reducedMotion:'reduce'}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const layouts=[];
 for(const route of ['/studio','/studio/concept']){
  await page.goto('http://127.0.0.1:3004'+route);
  await expect(page.locator('[data-desk-object=thought]')).toBeEnabled();
  await page.evaluate(()=>document.fonts.ready);
  layouts.push(await page.locator('main h1, #infinite-desk, [data-desk-object], #studio-downloads').evaluateAll(elements=>elements.map(e=>({id:e.id||e.getAttribute('data-desk-object'),rect:e.getBoundingClientRect().toJSON()}))));
  const prefix=`artifacts/studio-integration/${route.endsWith('concept')?'concept':'studio'}-${width}`;
  await page.screenshot({path:prefix+'-hero.png'});
  await page.screenshot({path:prefix+'-full.png',fullPage:true});
  await page.locator('#infinite-desk').screenshot({path:prefix+'-desk.png'});
  if(route==='/studio'){
   await page.locator('[data-desk-object=thought]').press('Enter');
   await expect(page.locator('#infinite-desk')).toHaveAttribute('data-motion','open');
   await page.screenshot({path:prefix+'-inspection.png'});
   await page.keyboard.press('Escape');await expect(page.locator('#infinite-desk')).toHaveAttribute('data-motion','idle');
  }
 }
 expect(layouts[0]).toEqual(layouts[1]);
 evidence.push({width,height,identicalSectionAndObjectGeometry:true,pageErrors:errors});
 await page.close();
}
await fs.writeFile('artifacts/studio-integration/visual-evidence.json',JSON.stringify(evidence,null,2));
await browser.close();
