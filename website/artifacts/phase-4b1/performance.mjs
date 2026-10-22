import{chromium}from'playwright';import{expect}from'@playwright/test';import fs from'node:fs/promises';
const phase=process.argv[2]??'before',browser=await chromium.launch(),results=[];
for(const[width,height]of[[1440,1000],[390,844]])for(const route of ['/nexus','/sentry']){
 const p=await browser.newPage({viewport:{width,height}});await p.goto('http://localhost:3004'+route);const cdp=await p.context().newCDPSession(p);await cdp.send('Performance.enable');
 for(let repetition=0;repetition<2;repetition++){
  let delta=12;if(route==='/sentry'){
   const film=p.locator('[data-sentry-film]');await expect(film).toHaveAttribute('data-ready','true');delta=await film.evaluate(e=>{const h=parseFloat(getComputedStyle(e).getPropertyValue('--nav'))||74,travel=e.clientHeight-innerHeight+h;scrollTo({top:e.getBoundingClientRect().top+scrollY-h+travel*.2,behavior:'instant'});return travel*.55/36;});
  }else{
   const section=p.locator('#native-core');await section.scrollIntoViewIfNeeded();const replay=section.getByRole('button',{name:'Replay',exact:true});await replay.click();await section.evaluate(e=>scrollTo({top:e.getBoundingClientRect().top+scrollY-90,behavior:'instant'}));delta=8;
  }
  await p.waitForTimeout(300);await p.evaluate(()=>{window.__times=[];window.__running=true;let last;function frame(t){if(last!==undefined)window.__times.push(t-last);last=t;if(window.__running)requestAnimationFrame(frame);}requestAnimationFrame(frame);});const before=await cdp.send('Performance.getMetrics');
  for(let i=0;i<36;i++){await p.mouse.wheel(0,delta);await p.waitForTimeout(50);}
  const after=await cdp.send('Performance.getMetrics'),times=await p.evaluate(()=>{window.__running=false;return window.__times;});times.sort((a,b)=>a-b);const metrics={};for(const n of ['LayoutDuration','RecalcStyleDuration','ScriptDuration'])metrics[n]=after.metrics.find(m=>m.name===n).value-before.metrics.find(m=>m.name===n).value;results.push({phase,width,route,repetition,frames:times.length,median:times[Math.floor(times.length*.5)],p95:times[Math.floor(times.length*.95)],max:times.at(-1),metrics});console.log(results.at(-1));await fs.writeFile(`artifacts/phase-4b1/performance-${phase}.json`,JSON.stringify(results,null,2));
 }await p.close();
}await browser.close();
