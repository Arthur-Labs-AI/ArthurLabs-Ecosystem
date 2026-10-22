import sharp from 'sharp';
const dir='artifacts/phase-3a1';
const ids=['native-core','nexus-nova','context-compaction','model-registry'];
const tiles=[];
for(let i=0;i<ids.length;i++){const desktop=await sharp(`${dir}/nexus-1440-explored-${ids[i]}.png`).resize({width:640}).png().toBuffer();const m=await sharp(desktop).metadata();tiles.push({input:desktop,left:(i%2)*660,top:Math.floor(i/2)*1120});}
await sharp({create:{width:1300,height:2240,channels:3,background:'#0c0b12'}}).composite(tiles).png().toFile(`${dir}/desktop-review-board.png`);
