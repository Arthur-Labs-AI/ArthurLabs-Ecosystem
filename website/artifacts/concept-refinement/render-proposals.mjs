import{chromium}from'@playwright/test';import{readFileSync}from'node:fs';
const browser=await chromium.launch();
for(const[name,width]of[['full-workflow-storyboard',1440],['download-layout-desktop',1440],['download-layout-mobile',390]]){
 const page=await browser.newPage({viewport:{width,height:1000}});await page.setContent('<style>html,body{margin:0;background:#0d1012}svg{display:block}</style>'+readFileSync(`artifacts/concept-refinement/${name}.svg`,'utf8')); await page.screenshot({path:`artifacts/concept-refinement/${name}.png`,fullPage:true});await page.close();
}await browser.close();
