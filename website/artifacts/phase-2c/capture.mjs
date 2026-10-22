import {chromium} from 'playwright';
import fs from 'node:fs/promises';
const dir='artifacts/phase-2c',base='http://localhost:3000';
const browser=await chromium.launch({headless:true});const results=[];
for(const[width,height]of[[1440,1000],[1920,1080],[768,1024],[390,844]]){
 const ctx=await browser.newContext({viewport:{width,height},deviceScaleFactor:1});const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/suite');await page.waitForSelector('[data-workflow-film][data-ready=true]');await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(250);
 await page.screenshot({path:`${dir}/suite-${width}-hero.png`});await page.screenshot({path:`${dir}/suite-${width}-full.png`,fullPage:true});
 const bounds=await page.locator('[data-workflow-film]').evaluate(e=>({top:e.getBoundingClientRect().top+scrollY,travel:e.clientHeight-innerHeight}));
 const samples=[];
 for(const[p,label]of[[.08,'capture'],[.20,'knowledge'],[.31,'plan'],[.44,'nexus'],[.54,'handoff'],[.68,'sentry'],[.79,'nexus-return'],[.87,'consolidate'],[.999,'studio-return']]){
  await page.evaluate(y=>scrollTo({top:y,behavior:'instant'}),bounds.top+bounds.travel*p);await page.waitForTimeout(100);await page.screenshot({path:`${dir}/suite-${width}-${label}.png`});
  samples.push(await page.locator('[data-workflow-film]').evaluate(e=>({p:e.dataset.progress,workspace:e.dataset.workspace,nodes:[...e.querySelectorAll('[data-wf-node]')].map(n=>n.getBoundingClientRect().toJSON())})));
 }
 await page.locator('#downloads').scrollIntoViewIfNeeded();await page.screenshot({path:`${dir}/suite-${width}-downloads.png`});results.push({width,height,errors,samples});await ctx.close();
}
// DPR2 sharpness evidence, served image dimensions are recorded separately from CSS size.
const sharp=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:2});const sp=await sharp.newPage();await sp.goto(base+'/suite');await sp.screenshot({path:`${dir}/suite-1440-dpr2.png`});await sharp.close();
for(const[width,height]of[[1440,1000],[390,844]]){
 const ctx=await browser.newContext({viewport:{width,height},recordVideo:{dir:`${dir}/raw`,size:{width,height}}});const p=await ctx.newPage();await p.goto(base+'/suite');await p.waitForSelector('[data-workflow-film][data-ready=true]');
 const b=await p.locator('[data-workflow-film]').evaluate(e=>({top:e.getBoundingClientRect().top+scrollY,travel:e.clientHeight-innerHeight}));
 await p.evaluate(y=>scrollTo({top:y,behavior:'instant'}),b.top);await p.waitForTimeout(500);
 const perf=await p.evaluate(async({top,travel})=>{const intervals=[];const duration=28000;let start,prev;await new Promise(resolve=>{function frame(t){if(!start)start=t;if(prev)intervals.push(t-prev);prev=t;const q=Math.min(1,(t-start)/duration);window.scrollTo({top:top+travel*q,behavior:'instant'});if(q<1)requestAnimationFrame(frame);else resolve();}requestAnimationFrame(frame);});return intervals;},b);
 await p.waitForTimeout(800);await p.evaluate(async({top,travel})=>{let start;await new Promise(resolve=>{function frame(t){if(!start)start=t;const q=Math.min(1,(t-start)/9000);window.scrollTo({top:top+travel*(1-q),behavior:'instant'});if(q<1)requestAnimationFrame(frame);else resolve();}requestAnimationFrame(frame);});},b);await p.waitForTimeout(400);
 const video=p.video();await p.close();await video.saveAs(`${dir}/suite-${width}-workflow.webm`);await ctx.close();perf.sort((a,b)=>a-b);results.push({recording:width,frames:perf.length,medianMs:perf[Math.floor(perf.length*.5)],p95Ms:perf[Math.floor(perf.length*.95)],maxMs:perf.at(-1)});
}
await fs.writeFile(`${dir}/browser-evidence.json`,JSON.stringify(results,null,2));await browser.close();
