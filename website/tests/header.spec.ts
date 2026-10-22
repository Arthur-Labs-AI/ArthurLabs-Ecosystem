import {expect,test} from '@playwright/test';

test('desktop product disclosure exposes the three official routes and restores focus',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});await page.goto('/');
 const trigger=page.getByRole('button',{name:'Products',exact:true});
 await expect(trigger).toBeEnabled();await trigger.focus();await page.keyboard.press('Enter');
 const panel=page.locator('#product-navigation');await expect(panel).toBeVisible();
 for(const [name,href] of [['Nexus','/nexus'],['Sentry','/sentry'],['Arthur Studio','/studio']])await expect(panel.getByRole('link',{name:new RegExp(name)})).toHaveAttribute('href',href);
 await page.keyboard.press('ArrowDown');await expect(panel.getByRole('link').first()).toBeFocused();
 await page.keyboard.press('End');await expect(panel.getByRole('link').last()).toBeFocused();
 await page.keyboard.press('Escape');await expect(trigger).toBeFocused();await expect(trigger).toHaveAttribute('aria-expanded','false');
 await trigger.press('Space');await expect(panel).toBeVisible();await page.mouse.click(20,110);await expect(panel).toBeHidden();
});

for(const width of [320,390,768,1440,1920])test(`global navigation fits and reaches every official product at ${width}`,async({page})=>{
 await page.setViewportSize({width,height:844});await page.goto('/');
 if(width<900)await page.getByLabel('Open navigation').click();else await page.getByRole('button',{name:'Products',exact:true}).click();
 const panel=page.locator(width<900?'#mobile-navigation':'#product-navigation');
 for(const name of ['Nexus','Sentry','Arthur Studio'])await expect(panel.getByRole('link',{name:new RegExp(name)})).toBeInViewport();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
 const box=await panel.boundingBox();expect(box!.x).toBeGreaterThanOrEqual(8);expect(box!.x+box!.width).toBeLessThanOrEqual(width-8);
 await panel.getByRole('link',{name:/Arthur Studio/}).click();await expect(page).toHaveURL(/\/studio$/);await expect(page.locator('main h1')).toBeFocused();
});

test('product destinations, active state and home brand survive client navigation',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});await page.goto('/suite');
 for(const [name,path] of [['Nexus','nexus'],['Sentry','sentry'],['Arthur Studio','studio']]){
 await page.getByRole('button',{name:'Products',exact:true}).click();await page.locator('#product-navigation').getByRole('link',{name:new RegExp(name)}).click();await expect(page).toHaveURL(new RegExp('/'+path+'$'));
 await page.getByRole('button',{name:'Products',exact:true}).click();await expect(page.locator(`#product-navigation a[href="/${path}"]`)).toHaveAttribute('aria-current','page');await page.keyboard.press('Escape');
 }
 await page.locator('header').getByRole('link',{name:'ArthurLabs home',exact:true}).click();await expect(page).toHaveURL(/\/$/);
});

test('touch navigation closes after a product and after the home brand',async({browser})=>{
 const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});const page=await context.newPage();await page.goto((process.env.PLAYWRIGHT_BASE_URL??'http://127.0.0.1:3000')+'/');await page.getByLabel('Open navigation').tap();await page.locator('#mobile-navigation').getByRole('link',{name:'Sentry',exact:true}).tap();await expect(page).toHaveURL(/\/sentry$/);await expect(page.locator('.mobile-menu')).not.toHaveAttribute('open','');await page.getByLabel('Open navigation').tap();await page.locator('header').getByRole('link',{name:'ArthurLabs home'}).tap();await expect(page).toHaveURL(/\/$/);await expect(page.locator('.mobile-menu')).not.toHaveAttribute('open','');await context.close();
});
for(const[path,hash]of[['/nexus','nexus-downloads'],['/sentry','sentry-downloads'],['/suite','downloads']])test(`contextual header downloads reach a visible heading on ${path}`,async({page})=>{
 await page.setViewportSize({width:1440,height:1000});await page.goto(path);await page.locator('header').getByRole('link',{name:/Downloads/}).click();await expect(page).toHaveURL(new RegExp('#'+hash+'$'));const heading=page.locator('#'+hash+' h2');await expect(heading).toBeInViewport();await expect.poll(async()=>(await heading.boundingBox())!.y).toBeGreaterThan(66);await expect(heading).toBeFocused();
});

test('Products waits for hydration and preserves its first keyboard activation',async({page})=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});await page.route('**/_next/static/chunks/*.js',async route=>{await gate;await route.continue();});
 try{await page.goto('/',{waitUntil:'domcontentloaded'});const trigger=page.getByRole('button',{name:'Products',exact:true});await expect(trigger).toBeDisabled();release();await expect(trigger).toBeEnabled();await expect(trigger).toBeEnabled();await trigger.focus();await page.keyboard.press('Enter');await expect(page.locator('#product-navigation')).toBeVisible();}finally{release();}
});
