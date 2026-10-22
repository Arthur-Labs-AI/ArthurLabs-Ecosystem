import{chromium}from'playwright';import{expect}from'@playwright/test';import fs from'node:fs/promises';
const phase=process.argv[2]??'before',dir='artifacts/phase-4b1',browser=await chromium.launch(),results=[];
const routes=[['landing','/'],['suite','/suite'],['nexus','/nexus'],['sentry','/sentry'],['studio','/studio']];
for(const[width,height]of[[390,844],[768,1024],[1440,1000],[1920,1080]])for(const[name,route]of routes){
 const p=await browser.newPage({viewport:{width,height}}),errors=[];p.on('pageerror',e=>errors.push(e.message));await p.goto('http://localhost:3004'+route);await expect(p.locator('body > header')).toHaveAttribute('data-ready','true');
 await p.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
 async function geometry(){return p.locator('body > header').evaluate(e=>{const sample=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return{x:r.x,y:r.y,width:r.width,height:r.height,radius:s.borderRadius,font:s.font,fontSize:s.fontSize,padding:s.padding,gap:s.gap,position:s.position};};return{header:sample(e),elements:[...e.querySelectorAll('nav,.brand,.brand svg,button,summary,a,details')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height;}).map(e=>({tag:e.tagName,label:e.getAttribute('aria-label')??e.textContent.trim(),href:e.getAttribute('href'),...sample(e)}))};});}
 const closed=await geometry();await p.screenshot({animations:'disabled',path:`${dir}/${name}-${width}-closed-${phase}.png`});
 if(width<900)await p.getByLabel('Open navigation').click();else await p.getByRole('button',{name:'Products',exact:true}).click();
 await p.locator('body > header').evaluate(async e=>{await Promise.allSettled(e.getAnimations({subtree:true}).map(a=>a.finished));});
 const open=await geometry();await p.screenshot({animations:'disabled',path:`${dir}/${name}-${width}-open-${phase}.png`});results.push({name,route,width,height,scroll:await p.evaluate(()=>scrollY),closed,open,overflow:await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),errors});await p.close();await fs.writeFile(`${dir}/geometry-${phase}.json`,JSON.stringify(results,null,2));
}await browser.close();
