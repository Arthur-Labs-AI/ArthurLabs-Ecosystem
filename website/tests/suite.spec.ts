import {test,expect} from '@playwright/test';
import {eligibleArtifacts,type Artifact} from '../src/components/suite-launch/releases';
test('release evidence gates distribution and never invents artifacts',()=>{
 expect(eligibleArtifacts('suite')).toEqual([]);
 const item:Artifact={package:'suite',version:'fixture',system:'fixture',architecture:'fixture',url:'https://example.invalid/fixture',filename:'fixture',format:'fixture',evidence:'test fixture only',verifiedAt:'2026-10-21',state:'verified'};
 expect(eligibleArtifacts('suite',[item])).toHaveLength(1);
 for(const invalid of [{...item,state:'withdrawn' as const},{...item,evidence:''},{...item,url:'javascript:alert(1)'},{...item,verifiedAt:''},{...item,version:''}])expect(eligibleArtifacts('suite',[invalid])).toEqual([]);
});
test('honest availability, independent applications, real local navigation',async({page})=>{
 await page.goto('/suite');await expect(page.getByRole('heading',{level:1})).toContainText('Three applications.');
 await expect(page.locator('a[download]')).toHaveCount(0);await expect(page.getByText('Download unavailable',{exact:false})).toHaveCount(4);
 await expect(page.locator('select')).toHaveCount(0);
 for(const [id,name] of [['studio','Arthur Studio'],['nexus','Nexus'],['sentry','Sentry']])await expect(page.getByRole('link',{name:`Explore ${name}`,exact:false})).toHaveAttribute('href',`/${id}`);
 await page.getByRole('link',{name:'Explore download options'}).click();await expect(page).toHaveURL(/#downloads$/);
 await expect.poll(()=>page.locator('#downloads-title').evaluate(e=>e.getBoundingClientRect().top)).toBeGreaterThan(74);
});
test('native chapter seeking stays synchronized through Sentry and both return workspaces',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/suite');const film=page.locator('[data-workflow-film]');await expect(film).toHaveAttribute('data-ready','true');
 await page.getByRole('button',{name:/04.*Evolve/}).click();await expect(film).toHaveAttribute('data-workspace','nexus');
 expect(Number(await film.getAttribute('data-progress'))).toBeCloseTo(.8,2);
 await page.mouse.wheel(0,80);await expect.poll(async()=>Number(await film.getAttribute('data-progress'))).toBeGreaterThan(.8);
 const b=await film.evaluate(e=>({top:e.getBoundingClientRect().top+scrollY,travel:e.clientHeight-innerHeight}));
 for(const[p,workspace]of[[.99,'studio'],[.82,'nexus'],[.67,'sentry'],[.43,'nexus'],[.17,'studio']] as const){await page.evaluate(y=>scrollTo({top:y,behavior:'instant'}),b.top+b.travel*p);await expect(film).toHaveAttribute('data-workspace',workspace);expect(Number(await film.getAttribute('data-progress'))).toBeCloseTo(p,2);}
 await page.getByRole('button',{name:/03.*Question/}).focus();await page.keyboard.press('Enter');await expect(film).toHaveAttribute('data-workspace','sentry');await expect(page.getByRole('button',{name:/03.*Question/})).toHaveAttribute('aria-current','step');
 expect(errors).toEqual([]);
});
test('reduced motion provides the complete readable four-act architecture',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});await page.goto('/suite');await expect(page.locator('[data-workflow-film]')).toBeHidden();
 await expect(page.locator('#workflow-story article')).toHaveCount(4);await expect(page.locator('#workflow-story')).toContainText('Nexus → Arthur Studio');
 await page.getByRole('link',{name:'Read the four acts'}).click();await expect(page).toHaveURL(/#workflow-story$/);
});

test('authentic interface inspection supports keyboard Escape and restores focus',async({page})=>{
 await page.goto('/suite');const open=page.getByRole('button',{name:'Inspect Nexus interface'});await open.focus();await page.keyboard.press('Enter');
 await expect(page.getByRole('dialog',{name:'Nexus interface preview'})).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);await expect(open).toBeFocused();
});
