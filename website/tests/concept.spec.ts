import{test,expect}from'@playwright/test';
for(const[width,height]of[[390,844],[768,1024],[1440,900],[1920,1080]]){
 test(`concept film is continuous and reversible at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height});await page.emulateMedia({reducedMotion:'no-preference'});
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/suite/concept');
  const film=page.locator('[data-concept-film]');await expect(film).toHaveAttribute('data-ready','true',{timeout:15000});
  const b=await film.evaluate(e=>({top:e.getBoundingClientRect().top+scrollY,travel:e.clientHeight-innerHeight}));
  const nodes=page.locator('[data-information]');const first=await nodes.first().elementHandle();
  const sample=async(p:number)=>{await page.evaluate(y=>scrollTo({top:y,behavior:'instant'}),b.top+b.travel*p);await expect.poll(async()=>Math.abs(Number(await film.getAttribute('data-timeline'))-p)).toBeLessThan(.002);return film.evaluate(e=>({camera:getComputedStyle(e.querySelector('[data-camera]')!).transform,path:e.querySelector('[data-link]')!.getAttribute('d'),node:e.querySelector('[data-information="storage"]')!.getBoundingClientRect().toJSON(),pin:e.firstElementChild!.getBoundingClientRect().toJSON()}));};
  const a=await sample(.23),m=await sample(.38),p=await sample(.61),z=await sample(.96);
  expect(a.camera).not.toBe(m.camera);expect(m.path).not.toBe(p.path);expect(p.path).not.toBe(z.path);expect(Math.hypot(z.node.x-m.node.x,z.node.y-m.node.y)).toBeGreaterThan(20);
  const reverse=await sample(.38);expect(reverse.node.x).toBeCloseTo(m.node.x,0);expect(reverse.node.y).toBeCloseTo(m.node.y,0);expect(await first!.evaluate(e=>e.isConnected)).toBe(true);
  for(const s of[m,p,z]){expect(s.node.x).toBeGreaterThanOrEqual(0);expect(s.node.right).toBeLessThanOrEqual(width);expect(s.pin.y).toBeCloseTo(0,0);}
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);expect(errors).toEqual([]);
 });
}
test('reduced motion exposes a usable storyboard and preserves both existing routes',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});await page.goto('/suite/concept');
 await expect(page.getByRole('heading',{name:'The idea is the thread.'})).toBeVisible();
 await expect(page.locator('[data-canvas]')).not.toBeVisible();
 await expect(page.getByText('This experiment stops at Nexus.',{exact:false})).toBeVisible();
 await page.getByRole('link',{name:'Return to the current Suite page',exact:false}).click();await expect(page).toHaveURL(/\/suite$/);await expect(page.getByRole('heading',{level:1})).toContainText('Three applications.');
 await page.goto('/');await expect(page.getByRole('heading',{level:1})).toBeVisible();
});

for (const height of [667,844]) test(`mobile held compositions remain readable at 390x${height}`,async({page})=>{
 await page.setViewportSize({width:390,height});await page.emulateMedia({reducedMotion:'no-preference'});await page.goto('/suite/concept');const film=page.locator('[data-concept-film]');await expect(film).toHaveAttribute('data-ready','true');const b=await film.evaluate(e=>({top:e.getBoundingClientRect().top+scrollY,travel:e.clientHeight-innerHeight}));
 for(const p of [.44,.675,.97]){
  await page.evaluate(y=>scrollTo({top:y,behavior:'instant'}),b.top+b.travel*p);await expect.poll(async()=>Math.abs(Number(await film.getAttribute('data-timeline'))-p)).toBeLessThan(.002);
  const rects=await page.locator('[data-information]').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().toJSON()));
  for(const r of rects){expect(r.x).toBeGreaterThanOrEqual(0);expect(r.right).toBeLessThanOrEqual(390);}
  for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++){const a=rects[i],b=rects[j];expect(Math.max(0,Math.min(a.right,b.right)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y))).toBeLessThan(1);}
 }
});

test('concept uses crisp scene geometry without raster application backgrounds',async({page})=>{
 const rasterRequests:string[]=[];page.on('request',r=>{if(/(?:studio|nexus)\.(?:webp|png|avif)/.test(decodeURIComponent(r.url())))rasterRequests.push(r.url());});
 await page.goto('/suite/concept');await expect(page.locator('[data-concept-film]')).toHaveAttribute('data-ready','true');
 await expect(page.locator('[data-concept-film] img')).toHaveCount(0);
 await expect(page.locator('[data-capture-surface]')).toHaveCount(1);
 await expect(page.locator('[data-orchestration-space] svg')).toHaveCount(1);
 expect(rasterRequests).toEqual([]);
});
