import fs from'node:fs/promises';import assert from'node:assert/strict';
const dir='artifacts/phase-4b1',before=JSON.parse(await fs.readFile(`${dir}/geometry-before.json`)),after=JSON.parse(await fs.readFile(`${dir}/geometry-after.json`));assert.equal(before.length,20);assert.equal(after.length,20);const results=[];
// Closed native-details content can retain nonpainted animated layout boxes in Chromium.
// Compare the actual header surface/controls; open-state checks retain the entire dropdown.
for(const sample of [...before,...after])sample.closed.elements=sample.closed.elements.filter(e=>e.y>=sample.closed.header.y&&e.y+e.height<=sample.closed.header.y+sample.closed.header.height);

for(let i=0;i<before.length;i++){const a=before[i],b=after[i];assert.equal(a.name,b.name);assert.equal(a.width,b.width);assert.deepEqual(a.closed,b.closed,`${a.name}/${a.width}: closed geometry`);assert.deepEqual(a.open,b.open,`${a.name}/${a.width}: open geometry`);assert.equal(a.scroll,b.scroll);assert.equal(b.overflow,false);assert.deepEqual(b.errors,[]);results.push({route:b.route,width:b.width,closed:'exact match',open:'exact match',scroll:b.scroll,overflow:false});}
await fs.writeFile(`${dir}/geometry-comparison.json`,JSON.stringify(results,null,2));console.log('20 route/viewport combinations, open and closed: exact geometry match');
