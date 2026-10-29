import {chromium} from 'playwright';import {expect} from '@playwright/test';import fs from 'node:fs/promises';
const dir='artifacts/studio-phase-5a',browser=await chromium.launch(),results=[];
const ids=['thought','study','observations','question','revisions','studio'];
for(const [width,height] of [[320,844],[390,844],[768,1024],[1440,1000],[1920,1080]]){
 const p=await browser.newPage({viewport:{width,height}}),errors=[];p.on('pageerror',e=>errors.push(e.message));await p.goto('http://localhost:3004/studio/concept');await expect(p.locator('[data-desk-object=thought]')).toBeEnabled();await p.evaluate(()=>document.fonts.ready);
 await p.screenshot({path:`${dir}/studio-${width}-full.png`,fullPage:true});await p.screenshot({path:`${dir}/studio-${width}-hero.png`});
 await p.locator('#infinite-desk').screenshot({path:`${dir}/studio-${width}-desk.png`});
 const facts={width,height,overflow:await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),errors,objects:[]};
 for(const id of width===1440?ids:['thought','studio']){
  const button=p.locator(`[data-desk-object=${id}]`);await button.scrollIntoViewIfNeeded();await p.mouse.move(1,1);await button.focus();await button.press('Enter');await expect(p.locator('#infinite-desk')).toHaveAttribute('data-motion','open');
  await p.screenshot({path:`${dir}/studio-${width}-focus-${id}.png`});
  facts.objects.push({id,dialogOverflow:await p.locator('dialog').evaluate(e=>e.scrollWidth>e.clientWidth),capture:await p.locator('[data-flight] img').count()?await p.locator('[data-flight] img').evaluate(e=>({width:e.clientWidth,height:e.clientHeight,nativeWidth:e.naturalWidth,nativeHeight:e.naturalHeight})):null});
  if(width===390&&id==='thought'){await p.locator('dialog').evaluate(e=>e.scrollTo({top:e.scrollHeight,behavior:'instant'}));await p.screenshot({path:`${dir}/studio-390-focus-content.png`});}
  await p.keyboard.press('Escape');await expect(p.locator('#infinite-desk')).toHaveAttribute('data-motion','idle');
 }
 if(width===1440){for(const [name,id]of[['editorial','space-title'],['downloads','studio-downloads']]){await p.locator('#'+id).scrollIntoViewIfNeeded();await p.screenshot({path:`${dir}/studio-1440-${name}.png`});}}
 results.push(facts);await p.close();
}await fs.writeFile(`${dir}/visual-evidence.json`,JSON.stringify(results,null,2));await browser.close();
