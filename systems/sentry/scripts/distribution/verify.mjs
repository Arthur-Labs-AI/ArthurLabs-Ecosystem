import { resolve } from 'node:path';
import { validate } from './contract.mjs';
const manifest = await validate(resolve(process.argv[2] ?? '.'));
console.log(
  JSON.stringify({
    product: manifest.product,
    version: manifest.version,
    sourceCommit: manifest.sourceCommit,
    targetPlatform: manifest.targetPlatform,
    verifiedFiles: Object.keys(manifest.files).length,
  }),
);
