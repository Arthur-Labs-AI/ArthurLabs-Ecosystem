import{test,expect}from '@playwright/test';
import nextConfig from '../next.config';
import {products} from '../src/lib/products';
for(const[width,height]of[[390,667],[390,844],[768,1024],[1440,900],[1920,1080]]){
 test(`full workflow motion, bounds and reverse at ${width}x${height}`,async({page})=>{
 await page.setViewportSize({width,height});await page.goto('/suite');const film=page.locator('[data-workflow-film]');await expect(film).toHaveAttribute('data-ready','true');
 const b=await film.evaluate(e=>({top:e.getBoundingClientRect().top+scrollY,travel:e.clientHeight-innerHeight}));
 const node=await page.locator('[data-wf-node="1"]').elementHandle();
 const sample=async(p:number)=>{await page.evaluate(y=>scrollTo({top:y,behavior:'instant'}),b.top+b.travel*p);await expect.poll(async()=>Math.abs(Number(await film.getAttribute('data-progress'))-p)).toBeLessThan(.002);return film.evaluate(e=>({camera:getComputedStyle(e.querySelector('[data-wf-camera]')!).transform,path:e.querySelector('[data-wf-link]')!.getAttribute('d'),nodes:Array.from(e.querySelectorAll('[data-wf-node]')).map(n=>n.getBoundingClientRect().toJSON()),title:e.querySelector('h3')!.getBoundingClientRect().toJSON(),footer:e.querySelector('[role=group]')!.getBoundingClientRect().toJSON()}));};
 const opening=await sample(.03),knowledge=await sample(.20),coordination=await sample(.44),review=await sample(.68),consolidated=await sample(.86),returned=await sample(.999);
 expect(opening.camera).not.toBe(knowledge.camera);expect(knowledge.path).not.toBe(coordination.path);expect(review.path).not.toBe(consolidated.path);expect(returned.path).not.toBe(consolidated.path);
 for(const state of[knowledge,coordination,review,consolidated,returned])for(const r of state.nodes){expect(r.x).toBeGreaterThanOrEqual(-1);expect(r.right).toBeLessThanOrEqual(width+1);expect(r.top).toBeGreaterThan(74);expect(r.bottom).toBeLessThan(state.footer.y);}
 const reverse=await sample(.44);expect(reverse.nodes[1].x).toBeCloseTo(coordination.nodes[1].x,0);expect(reverse.nodes[1].y).toBeCloseTo(coordination.nodes[1].y,0);expect(await node!.evaluate(e=>e.isConnected)).toBe(true);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);await expect(film.locator('img')).toHaveCount(0);
 });
}
test('hero retains authentic ratios at DPR2',async({browser})=>{
 const ctx=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:2});const page=await ctx.newPage();await page.goto('/suite');
 const images=page.locator('figure button img');await expect(images).toHaveCount(3);
 for(const [i,img] of (await images.all()).entries()){
  await expect.poll(()=>img.evaluate((e:HTMLImageElement)=>e.complete&&e.naturalWidth>0)).toBe(true);
  const s=await img.evaluate((e:HTMLImageElement)=>({ratio:e.clientWidth/e.clientHeight,native:Number(e.getAttribute('width'))/Number(e.getAttribute('height')),url:e.currentSrc,width:e.naturalWidth,height:e.naturalHeight,displayWidth:e.clientWidth}));
  expect(s.ratio).toBeCloseTo(s.native,2);const source=new URL(s.url),product=products[i];
  if(nextConfig.images?.unoptimized){
   expect(source.pathname).toBe(`/images/${product.id}.webp`);expect(s.width).toBe(product.width);expect(s.height).toBe(product.height);expect(s.displayWidth).toBeLessThanOrEqual(s.width);
  }else{expect(source.searchParams.get('url')).toBe(`/images/${product.id}.webp`);expect(source.searchParams.get('q')).toBe('90');}
 }
 await ctx.close();
});

test('opening thought keeps its measure until the typographic handoff',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.goto('/suite');const film=page.locator('[data-workflow-film]');await expect(film).toHaveAttribute('data-ready','true');
 const y=await film.evaluate(e=>e.getBoundingClientRect().top+scrollY+(e.clientHeight-innerHeight)*.10);await page.evaluate(top=>scrollTo({top,behavior:'instant'}),y);
 await expect.poll(()=>page.locator('[data-wf-node="0"]').evaluate(e=>e.getBoundingClientRect().width)).toBeGreaterThan(295);
 const gap=await page.locator('[data-wf-node="0"]').evaluate(e=>{const index=e.firstElementChild!.getBoundingClientRect();const text=e.querySelector('[data-wf-title]')!.getBoundingClientRect();return text.top-index.bottom;});expect(gap).toBeGreaterThan(5);
});
