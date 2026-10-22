import {chromium} from '@playwright/test';
import{writeFileSync}from'node:fs';
const browser=await chromium.launch();const result=[];
for(const [width,height]of[[1440,700],[1440,1000],[390,667],[390,844]]){
 const page=await browser.newPage({viewport:{width,height},reducedMotion:'no-preference'});let errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://localhost:3000/suite');await page.locator('[data-ready=true]').waitFor();
 const r=await page.locator('#follow-the-idea').evaluate(e=>({top:e.getBoundingClientRect().top+scrollY,travel:e.clientHeight-innerHeight}));const samples=[];
 for(const p of [.12,.19,.215,.24,.265,.34]){await page.evaluate(y=>scrollTo({top:y,behavior:'instant'}),r.top+r.travel*p);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));samples.push(await page.locator('#follow-the-idea').evaluate((e,p)=>{const doc=e.querySelector('[data-travel-document]'),pin=e.firstElementChild;return {p,y:scrollY,static:e.dataset.static,frame:e.dataset.frame,pin:pin.getBoundingClientRect().toJSON(),document:doc.getBoundingClientRect().toJSON(),transform:getComputedStyle(doc).transform,panels:[...e.querySelectorAll('[data-suite-panel]')].map(p=>({transform:getComputedStyle(p).transform,opacity:getComputedStyle(p).opacity})),motion:matchMedia('(prefers-reduced-motion:reduce)').matches}},p));}
 await page.screenshot({path:`artifacts/phase-2b/before-${width}x${height}.png`});result.push({width,height,errors,samples});await page.close();}
writeFileSync('artifacts/phase-2b/diagnosis-before.json',JSON.stringify(result,null,2));console.log(result.map(r=>({width:r.width,height:r.height,static:r.samples[0].static,transforms:r.samples.map(s=>s.transform),errors:r.errors})));await browser.close();
