const fs=require('fs'),path=require('path'),crypto=require('crypto');
const root=process.cwd(),before=require('./before.json');
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const changed=Object.keys(before).filter(f=>!fs.existsSync(f)||hash(f)!==before[f]);
const newFiles=fs.readdirSync('src/components/nexus-concept/features').map(f=>'src/components/nexus-concept/features/'+f);
const manifest=Object.fromEntries([...newFiles,'src/app/nexus/concept/page.tsx','tests/nexus-concept.spec.ts'].map(f=>[f,hash(f)]));
const result={protectedBaselineFiles:Object.keys(before).length,changedExistingFiles:changed,allowedChange:'src/app/nexus/concept/page.tsx',preservationPassed:changed.length===1&&changed[0]==='src/app/nexus/concept/page.tsx',checkedAt:new Date().toISOString(),checkedSource:manifest};
fs.writeFileSync('artifacts/phase-3a1/preservation.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));if(!result.preservationPassed)process.exitCode=1;
