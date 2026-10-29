import {chromium} from 'playwright';import {expect} from '@playwright/test';import fs from 'node:fs/promises';
const dir='artifacts/studio-phase-5a',browser=await chromium.launch(),evidence=[];
for(const [width,height]of[[1440,1000],[390,844]]){
 const ctx=await browser.newContext({viewport:{width,height},hasTouch:width<700,isMobile:width<700,recordVideo:{dir:`${dir}/raw-video`,size:{width,height}}}),p=await ctx.newPage(),samples=[];
 const errors=[];p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')errors.push(m.text());});const started=Date.now();await p.goto('http://localhost:3004/studio/concept');await expect(p.locator('[data-desk-object=thought]')).toBeEnabled();await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(1000);
 await p.getByRole('link',{name:'Explore the Desk',exact:true}).click();await p.waitForTimeout(1100);
 for(const id of width===1440?['thought','study','observations','studio']:['thought','question','studio']){
  const button=p.locator(`[data-desk-object=${id}]`);await button.scrollIntoViewIfNeeded();if(width>=700)await button.hover();await p.waitForTimeout(350);samples.push({id,action:'select',elapsedSec:(Date.now()-started)/1000});const hit=(await button.boundingBox());if(width<700)await p.touchscreen.tap(hit.x+hit.width/2,hit.y+hit.height/2);else await p.mouse.click(hit.x+hit.width/2,hit.y+hit.height/2);
  await expect(p.locator('#infinite-desk')).toHaveAttribute('data-motion','open');await p.waitForTimeout(900);
  if(id==='thought'){
   const area=p.getByLabel('Try another wording');await area.scrollIntoViewIfNeeded();await area.fill('What if a gesture could be an invitation, rather than a command?');await p.waitForTimeout(450);await p.getByRole('button',{name:'Keep this wording on the desk'}).click();await p.waitForTimeout(650);
  }
  if(id==='study'){await p.getByRole('button',{name:'An open invitation',exact:true}).click();await p.waitForTimeout(850);}
  if(id==='observations'){await p.getByRole('button',{name:'Consent',exact:true}).click();await p.waitForTimeout(900);}
  if(id==='question'||id==='studio'){await p.locator('dialog').evaluate(e=>e.scrollTo({top:e.scrollHeight,behavior:'smooth'}));await p.waitForTimeout(1000);}
  samples.push({id,action:'return',elapsedSec:(Date.now()-started)/1000});const back=(await p.getByRole('button',{name:/Return to Desk/}).boundingBox());if(width<700)await p.touchscreen.tap(back.x+back.width/2,back.y+back.height/2);else await p.mouse.click(back.x+back.width/2,back.y+back.height/2);
  await expect(p.locator('#infinite-desk')).toHaveAttribute('data-motion','idle');await p.waitForTimeout(650);
 }
 await p.locator('#studio-downloads').scrollIntoViewIfNeeded();await p.waitForTimeout(1200);const video=p.video();await ctx.close();const filename=`${dir}/studio-${width}-exploration.webm`;await video.saveAs(filename);await video.delete();evidence.push({width,height,input:width<700?'native touch taps':'raw mouse coordinates',file:filename,errors,samples});
}
await fs.writeFile(`${dir}/recording-evidence.json`,JSON.stringify(evidence,null,2));await browser.close();
