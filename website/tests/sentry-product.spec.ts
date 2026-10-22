import{test,expect,type Page}from'@playwright/test';
import{eligibleArtifacts,releaseCatalog}from'../src/components/suite-launch/releases';
import{verifiedNexusReleases}from'../src/components/nexus-download/releases';
import{verifiedSentryReleases}from'../src/components/sentry-concept/releases';
async function seek(page:Page,p:number){const film=page.locator('[data-sentry-film]');await expect(film).toHaveAttribute('data-ready','true');await film.evaluate((e,p)=>{const h=parseFloat(getComputedStyle(e).getPropertyValue('--nav'))||74,top=e.getBoundingClientRect().top+scrollY-h;scrollTo({top:top+(e.clientHeight-innerHeight+h)*p,behavior:'instant'});},p);await expect.poll(async()=>Number(await film.getAttribute('data-progress'))).toBeCloseTo(p,2);}
test('one shared catalog preserves Sentry integrity and Nexus fail-closed eligibility',()=>{
 expect(eligibleArtifacts('sentry')).toEqual(verifiedSentryReleases());expect(eligibleArtifacts('sentry')).toHaveLength(1);expect(verifiedNexusReleases()).toEqual([]);expect(eligibleArtifacts('suite')).toEqual([]);
 const artifact=releaseCatalog.find(a=>a.package==='sentry')!;
 for(const patch of [{state:'withdrawn'},{sha256:''},{checksumUrl:''},{sourceCommit:''},{installation:''},{url:'http://example.invalid/archive'},{bytes:0}])expect(eligibleArtifacts('sentry',[{...artifact,...patch} as never])).toEqual([]);
});
for(const[width,height]of[[390,844],[768,1024],[1440,1000],[1920,1080]])test(`official Sentry retains reversible approved geometry and header clearance at ${width}`,async({page})=>{
 await page.setViewportSize({width,height});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/sentry');await expect(page.locator('h1')).toContainText('Generation isn’t');await expect(page.locator('h1')).not.toContainText('concept');
 await seek(page,.245);const film=page.locator('[data-sentry-film]'),path=await film.locator('[data-branch=opencode]').getAttribute('d'),camera=await film.locator('[data-chamber-camera]').getAttribute('transform');
 const box=await film.locator(':scope > div').boundingBox(),header=await page.locator('body > header').boundingBox();expect(box!.y).toBeGreaterThanOrEqual(header!.y+header!.height);
 await seek(page,.43);expect(await film.locator('[data-branch=opencode]').getAttribute('d')).not.toBe(path);await seek(page,.245);expect(await film.locator('[data-branch=opencode]').getAttribute('d')).toBe(path);expect(await film.locator('[data-chamber-camera]').getAttribute('transform')).toBe(camera);
 await seek(page,.94);await expect(film.locator('[data-parent-outcome]')).toHaveText('PARTIAL');await film.getByRole('button',{name:/Replay/}).click();await expect.poll(async()=>Number(await film.getAttribute('data-progress'))).toBeLessThan(.01);
 const order=await page.locator('#sentry-harnesses,#sentry-scope,#sentry-evidence,#sentry-projects,#sentry-interfaces,#sentry-nexus,#sentry-downloads,#sentry-resources').evaluateAll(es=>es.map(e=>e.id));expect(order).toEqual(['sentry-harnesses','sentry-scope','sentry-evidence','sentry-projects','sentry-interfaces','sentry-nexus','sentry-downloads','sentry-resources']);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);expect(errors).toEqual([]);
});
test('official CTA, shared Suite artifact and documentation keep accurate release facts',async({page})=>{
 await page.goto('/sentry');await page.locator('main').getByRole('link',{name:'Download Sentry',exact:true}).click();await expect(page).toHaveURL(/#sentry-downloads$/);const section=page.locator('#sentry-downloads');await expect(section).toContainText('Windows 11 + WSL2');await expect(section).toContainText('unsigned archive');const url=await section.getByRole('link',{name:'Download Sentry 1.0.2 ↓',exact:true}).getAttribute('href');
 await page.goto('/suite');await expect(page.locator('#downloads a[download]')).toHaveCount(1);await expect(page.locator('#downloads a[download]')).toHaveAttribute('href',url!);await expect(page.locator('#downloads')).toContainText('Download unavailable');await expect(page.locator('#downloads')).toContainText('SHA256');
});
test('official reduced motion retains manual film, full explanations and downloads',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});await page.setViewportSize({width:390,height:844});await page.goto('/sentry');const film=page.locator('[data-sentry-film]');await expect(film).toHaveAttribute('data-motion','reduced');await expect(page.locator('#sentry-story details[open]')).toHaveCount(9);await page.getByLabel('Verification chapter',{exact:true}).selectOption('7');await expect(film.locator('[data-parent-outcome]')).toHaveText('PARTIAL');await expect(page.locator('#sentry-downloads a[href*=".zip"]')).toHaveCount(2);
});
for(const[path,film]of[['/','.hero-sticky'],['/suite','[data-workflow-film]'],['/nexus','#native-core'],['/sentry','[data-sentry-film]']])test(`global glass and dropdown stay above cinematic layers on ${path}`,async({page})=>{
 await page.setViewportSize({width:1440,height:1000});await page.goto(path);const scene=page.locator(film);await scene.scrollIntoViewIfNeeded();const trigger=page.getByRole('button',{name:'Products',exact:true});await trigger.click();const link=page.locator('#product-navigation').getByRole('link',{name:/Sentry/});await expect(link).toBeInViewport();expect(await link.evaluate(e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})).toBe(true);await page.keyboard.press('Escape');await expect(trigger).toBeFocused();
});
