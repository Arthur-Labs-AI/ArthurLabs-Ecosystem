import sharp from 'sharp';
const dir='artifacts/phase-3a2';
const features=[['native','native-core'],['nova','nexus-nova'],['context','context-compaction'],['registry','model-registry']];
const tiles=[];
for(let i=0;i<features.length;i++){const [name,id]=features[i];const sources=[`artifacts/phase-3a1/nexus-1440-explored-${id}.png`,`${dir}/motion-1440-${name}-middle.png`];const labels=[`BEFORE / PHASE 3A.1 / ${name.toUpperCase()}`,`AFTER / ACTUAL PLAYBACK FRAME / ${name.toUpperCase()}`];
 const pair=[];for(let j=0;j<2;j++){const picture=await sharp(sources[j]).resize({width:680,height:920,fit:'inside'}).png().toBuffer();const label=Buffer.from(`<svg width="680" height="50"><rect width="680" height="50" fill="#17101e"/><text x="18" y="30" font-family="monospace" font-size="12" fill="#c4a7de">${labels[j]}</text></svg>`);pair.push({input:label,left:j*700,top:0},{input:picture,left:j*700,top:60});}
 await sharp({create:{width:1380,height:1000,channels:3,background:'#0d0d12'}}).composite(pair).toFile(`${dir}/before-after-${name}.png`);
 const summary=await sharp(`${dir}/before-after-${name}.png`).resize({width:960}).png().toBuffer();tiles.push({input:summary,left:0,top:i*710});
}
await sharp({create:{width:960,height:2840,channels:3,background:'#0d0d12'}}).composite(tiles).toFile(`${dir}/before-after-overview.png`);
