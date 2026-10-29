import {chromium} from 'playwright';import {expect} from '@playwright/test';import fs from 'node:fs/promises';
const browser=await chromium.launch(),samples=[];
// Independent native captures avoid screenshot readback delaying a later capture in the same transition.
for(const [label,desiredPhase,delay]of[['lift','lifting',35],['expansion','opening',300],['return','closing',250]]){
 const p=await browser.newPage({viewport:{width:1440,height:1000}}),cdp=await p.context().newCDPSession(p);let captured;
 await p.exposeBinding('captureStudioFrame',(_,sample)=>{captured=(async()=>{const image=await cdp.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});await fs.writeFile(`artifacts/studio-phase-5a/motion-${sample.label}.png`,Buffer.from(image.data,'base64'));samples.push(sample);})();return captured;});
 await p.goto('http://localhost:3004/studio/concept');await expect(p.locator('[data-desk-object=thought]')).toBeEnabled();await p.evaluate(()=>document.fonts.ready);await p.locator('[data-desk-object=thought]').scrollIntoViewIfNeeded();
 await p.evaluate(({label,desiredPhase,delay})=>{let started=0,last='';function watch(t){const phase=document.querySelector('#infinite-desk').dataset.motion;if(phase!==last){last=phase;started=t;}if(phase===desiredPhase&&t-started>=delay){const e=document.querySelector('[data-flight]');void window.captureStudioFrame({label,phase,phaseElapsedMs:t-started,matrix:getComputedStyle(e).transform,rect:e.getBoundingClientRect().toJSON()});}else requestAnimationFrame(watch);}requestAnimationFrame(watch);},{label,desiredPhase,delay});
 await p.locator('[data-desk-object=thought]').press('Enter');await expect(p.locator('#infinite-desk')).toHaveAttribute('data-motion','open');
 if(label==='return'){await p.screenshot({path:'artifacts/studio-phase-5a/motion-fully-open.png'});await p.keyboard.press('Escape');await expect(p.locator('#infinite-desk')).toHaveAttribute('data-motion','idle');}
 await expect.poll(()=>!!captured).toBe(true);await captured;if(label!=='return'){await p.keyboard.press('Escape');await expect(p.locator('#infinite-desk')).toHaveAttribute('data-motion','idle');}await p.close();
}await browser.close();await fs.writeFile('artifacts/studio-phase-5a/motion-evidence.json',JSON.stringify(samples,null,2));
