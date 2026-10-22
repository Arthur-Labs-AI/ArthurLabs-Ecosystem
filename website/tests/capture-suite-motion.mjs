import {chromium} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
const base=process.env.PLAYWRIGHT_BASE_URL??'http://localhost:3000';
const output='artifacts/phase-2b';mkdirSync(output,{recursive:true});
const browser=await chromium.launch();const records=[];
for(const [width,height]of[[390,844],[768,1024],[1440,1000],[1920,1080]]){
 const page=await browser.newPage({viewport:{width,height},reducedMotion:'no-preference'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${base}/suite`);await page.locator('[data-entrance=complete]').waitFor();
 await page.locator('footer').scrollIntoViewIfNeeded();await page.locator('img').evaluateAll(ims=>Promise.all(ims.map(im=>im.decode().catch(()=>{}))));
 await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));await page.screenshot({path:`${output}/suite-${width}-hero.png`});
 const story=page.locator('#follow-the-idea');await page.locator('[data-ready=true]').waitFor();
 const bounds=await story.evaluate(e=>({top:e.getBoundingClientRect().top+scrollY,travel:e.clientHeight-innerHeight}));
 const sample=async(p,name)=>{
  await page.evaluate(y=>scrollTo({top:y,behavior:'instant'}),bounds.top+bounds.travel*p);
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const value=await story.evaluate((e,input)=>{
   const rect=node=>node.getBoundingClientRect().toJSON();const style=node=>({transform:getComputedStyle(node).transform,opacity:getComputedStyle(node).opacity,visibility:getComputedStyle(node).visibility});
   return{...input,y:scrollY,viewport:[innerWidth,innerHeight],static:e.dataset.static,frame:e.dataset.frame,chapter:e.dataset.chapter,timeline:e.dataset.timelineProgress,trigger:e.dataset.scrollProgress,document:{rect:rect(e.querySelector('[data-travel-document]')),...style(e.querySelector('[data-travel-document]'))},pin:rect(e.firstElementChild),panels:[...e.querySelectorAll('[data-suite-panel]')].map(style),overflow:document.documentElement.scrollWidth-innerWidth};
  },{width,p,name});records.push(value);
  await page.screenshot({path:`${output}/suite-${width}-${name}.png`});
 };
 for(const [name,p]of[['entry',-.12],['emerge-1',.035],['emerge-2',.075],['capture',.12],['studio-nexus-1',.185],['studio-nexus-2',.215],['studio-nexus-mid',.24],['studio-nexus-3',.265],['orchestrate',.34],['nexus-sentry-1',.425],['nexus-sentry-2',.455],['nexus-sentry-mid',.48],['nexus-sentry-3',.505],['verify',.58],['sentry-nexus-1',.665],['sentry-nexus-2',.695],['sentry-nexus-mid',.72],['sentry-nexus-3',.745],['consolidate',.795],['nexus-studio-1',.805],['nexus-studio-2',.835],['nexus-studio-mid',.86],['nexus-studio-3',.885],['return',.96],['exit',1.13]]) await sample(p,name);
 for(const p of [.86,.72,.48,.24])await sample(p,`reverse-${p}`);
 for(const [id,name]of[['architecture-title','architecture'],['independent-title','products'],['suite-hardware-title','hardware'],['availability-title','availability']]){
  await page.locator(`#${id}`).evaluate(e=>scrollTo({top:e.getBoundingClientRect().top+scrollY-110,behavior:'instant'}));
  await page.locator('[data-suite-entry]').evaluateAll(nodes=>Promise.all(nodes.flatMap(n=>n.getAnimations()).map(a=>a.finished.catch(()=>{}))));
  // GSAP entry tweens use its own clock; settle the framing for still captures.
  await page.waitForTimeout(800);await page.screenshot({path:`${output}/suite-${width}-${name}.png`});
 }
 await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));await page.screenshot({path:`${output}/suite-${width}-full.png`,fullPage:true});records.push({width,errors});await page.close();
}
writeFileSync(`${output}/motion-measurements.json`,JSON.stringify(records,null,2));
// A slow, ordered scroll film is evidence of continuity, not a frame-rate benchmark.
for(const [width,height]of[[1440,900],[390,844]]){
 const context=await browser.newContext({viewport:{width,height},reducedMotion:'no-preference',recordVideo:{dir:output,size:{width,height}}});
 const page=await context.newPage();await page.goto(`${base}/suite`);await page.locator('[data-entrance=complete]').waitFor();
 const bounds=await page.locator('#follow-the-idea').evaluate(e=>({top:e.getBoundingClientRect().top+scrollY,travel:e.clientHeight-innerHeight}));
 for(let i=-10;i<=110;i++){await page.evaluate(y=>scrollTo({top:y,behavior:'instant'}),bounds.top+bounds.travel*i/100);await page.waitForTimeout(100);}
 for(let i=100;i>=0;i-=2){await page.evaluate(y=>scrollTo({top:y,behavior:'instant'}),bounds.top+bounds.travel*i/100);await page.waitForTimeout(70);}
 const video=page.video();await context.close();await video.saveAs(`${output}/suite-${width}-scroll.webm`);await video.delete();
}
for(const [width,height]of [[1440,700],[390,667]]){
 const page=await browser.newPage({viewport:{width,height},reducedMotion:'no-preference'});await page.goto(`${base}/suite`);await page.locator('[data-ready=true]').waitFor();await page.getByRole('button',{name:'Orchestrate chapter',exact:true}).click();await page.screenshot({path:`${output}/after-${width}x${height}.png`});await page.close();
}
const reduced=await browser.newPage({viewport:{width:390,height:667},reducedMotion:'reduce'});await reduced.goto(`${base}/suite`);await reduced.getByRole('button',{name:'Return chapter',exact:true}).click();await reduced.screenshot({path:`${output}/suite-390-reduced.png`});await reduced.close();
for(const width of[390,1440]){const page=await browser.newPage({viewport:{width,height:width===390?844:1000}});await page.goto(base);await page.locator('[data-workflow-ready=true]').waitFor();await page.locator('.window img').evaluateAll(ims=>Promise.all(ims.map(i=>i.decode())));await page.screenshot({path:`${output}/landing-${width}-regression.png`});await page.close();}
writeFileSync(`${output}/motion-measurements.json`,JSON.stringify(records,null,2));await browser.close();
