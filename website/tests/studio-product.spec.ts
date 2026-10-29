import {test,expect} from '@playwright/test';

for(const width of [390,1440])test(`official Studio preserves all six inspections and download navigation at ${width}`,async({page})=>{
 await page.setViewportSize({width,height:width===390?844:1000});
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/studio');
 await expect(page).toHaveTitle(/Arthur Studio — A home for unfinished ideas/);
 expect(await page.locator('meta[name="robots"]').evaluateAll(elements=>elements.map(e=>e.getAttribute('content')).join(','))).not.toContain('noindex');
 await expect(page.locator('main h1')).toHaveText('A home forunfinished ideas.');
 for(const id of ['thought','study','observations','question','revisions','studio']){
  const button=page.locator(`[data-desk-object=${id}]`);
  await expect(button).toBeEnabled();await button.press('Enter');
  await expect(page.locator('#infinite-desk')).toHaveAttribute('data-motion','open');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#infinite-desk')).toHaveAttribute('data-motion','idle');
  await expect(button).toBeFocused();
 }
 await page.getByRole('link',{name:'Download Arthur Studio',exact:true}).click();
 await expect(page).toHaveURL(/\/studio#studio-downloads$/);
 await expect(page.locator('#studio-downloads')).toContainText('Download Not Yet Available');
 await expect(page.locator('#studio-downloads a[download]')).toHaveCount(0);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
 expect(errors).toEqual([]);
});

test('official Studio reduced-motion inspection and concept reference remain available',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});await page.goto('/studio');
 await expect(page.locator('[data-desk-object=question]')).toBeEnabled();
 await page.locator('[data-desk-object=question]').press('Enter');
 await expect(page.locator('#infinite-desk')).toHaveAttribute('data-motion','open');
 expect(await page.locator('[data-flight]').evaluate(e=>getComputedStyle(e).transform)).toBe('matrix(1, 0, 0, 1, 0, 0)');
 await page.keyboard.press('Escape');await expect(page.locator('#infinite-desk')).toHaveAttribute('data-motion','idle');
 await page.goto('/studio/concept');await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content',/noindex/);
 await expect(page.locator('[data-desk-object]')).toHaveCount(6);
});
