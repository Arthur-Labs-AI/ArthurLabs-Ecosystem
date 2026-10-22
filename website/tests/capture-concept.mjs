import{chromium}from'@playwright/test';import{writeFileSync}from'node:fs';
const out='artifacts/suite-concept';const browser=await chromium.launch();const measurements=[];
for(const[width,height]of[[390,844],[768,1024],[1440,900],[1920,1080]]){
 const page=await browser.newPage({viewport:{width,height},reducedMotion:'no-preference'});const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});await page.goto('http://localhost:3000/suite/concept');await page.locator('[data-ready=true]').waitFor();await page.locator('img').evaluateAll(ims=>Promise.all(ims.map(i=>i.decode())));
 const film=page.locator('[data-concept-film]');const bounds=await film.evaluate(e=>({top:e.getBoundingClientRect().top+scrollY,travel:e.clientHeight-innerHeight}));
 for(const[name,p]of[['begin',.12],['unfold-1',.20],['unfold-2',.27],['knowledge',.44],['align-1',.47],['plan',.675],['transform-1',.73],['transform-2',.82],['end',.97],['reverse-middle',.44]]){
 await page.evaluate(y=>scrollTo({top:y,behavior:'instant'}),bounds.top+bounds.travel*p);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await page.screenshot({path:`${out}/concept-${width}-${name}.png`});
 measurements.push(await film.evaluate((e,input)=>({...input,scrollY,progress:e.dataset.progress,timeline:e.dataset.timeline,camera:getComputedStyle(e.querySelector('[data-camera]')).transform,nodes:[...e.querySelectorAll('[data-information]')].map(n=>({id:n.dataset.information,rect:n.getBoundingClientRect().toJSON(),transform:getComputedStyle(n).transform,opacity:getComputedStyle(n).opacity})),paths:[...e.querySelectorAll('[data-link]')].map(p=>p.getAttribute('d')),overflow:document.documentElement.scrollWidth-innerWidth}),{width,height,name,p}));}
 measurements.push({width,errors});await page.close();
}
writeFileSync(`${out}/measurements.json`,JSON.stringify(measurements,null,2));
// Actual rAF-paced native scrolling, rather than widely spaced chapter jumps.
for(const[width,height]of[[1440,900],[390,844]]){
 const context=await browser.newContext({viewport:{width,height},reducedMotion:'no-preference',recordVideo:{dir:out,size:{width,height}}});const page=await context.newPage();await page.goto('http://localhost:3000/suite/concept');await page.locator('[data-ready=true]').waitFor();await page.locator('img').evaluateAll(ims=>Promise.all(ims.map(i=>i.decode())));
 await page.evaluate(async()=>{const root=document.querySelector('[data-concept-film]'),top=root.getBoundingClientRect().top+scrollY,travel=root.clientHeight-innerHeight;await new Promise(done=>{let start;function frame(time){start??=time;const t=(time-start)/1000;const p=t<18?-.03+t/18*1.06:1.03-(t-18)/6*1.06;scrollTo({top:top+travel*p,behavior:'instant'});if(t<24)requestAnimationFrame(frame);else done();}requestAnimationFrame(frame);});});
 const video=page.video();await context.close();await video.saveAs(`${out}/concept-${width}-scroll.webm`);await video.delete();
}
// Frame callback timing with warm assets and without video encoding.
const performance=[];
for(const[width,height]of[[1440,900],[390,844]]){
 const page=await browser.newPage({viewport:{width,height},reducedMotion:'no-preference'});await page.goto('http://localhost:3000/suite/concept');await page.locator('[data-ready=true]').waitFor();await page.locator('img').evaluateAll(ims=>Promise.all(ims.map(i=>i.decode())));
 const result=await page.evaluate(async()=>{const root=document.querySelector('[data-concept-film]'),top=root.getBoundingClientRect().top+scrollY,travel=root.clientHeight-innerHeight;let last;const deltas=[];await new Promise(done=>{let count=0;function tick(time){if(last)deltas.push(time-last);last=time;scrollTo({top:top+travel*(count/240),behavior:'instant'});if(count++<240)requestAnimationFrame(tick);else done();}requestAnimationFrame(tick);});const sorted=[...deltas].sort((a,b)=>a-b);return{samples:deltas.length,medianMs:sorted[Math.floor(sorted.length*.5)],p95Ms:sorted[Math.floor(sorted.length*.95)],maxMs:Math.max(...deltas),over50ms:deltas.filter(d=>d>50).length,dpr:devicePixelRatio};});performance.push({width,height,...result});await page.close();
}
writeFileSync(`${out}/performance.json`,JSON.stringify(performance,null,2));
const reduced=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});await reduced.goto('http://localhost:3000/suite/concept');await reduced.screenshot({path:`${out}/concept-390-reduced.png`,fullPage:true});await reduced.close();await browser.close();
