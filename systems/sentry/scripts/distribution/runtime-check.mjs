import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parseIdentity } from './contract.mjs';

const [entry, identityFile, dataRoot] = process.argv.slice(2);
if (!entry || !identityFile || !dataRoot)
  throw new Error('Usage: runtime-check.mjs entry identityFile disposableDataRoot');
const expected = parseIdentity(JSON.parse(await readFile(identityFile, 'utf8')));
const child = spawn(
  process.execPath,
  [entry, '--stdio', '--release-validation', '--data-root', dataRoot],
  {
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);
let buffer = '',
  hello;
let failure;
const timer = setTimeout(() => {
  failure = new Error('Runtime validation timeout');
  child.kill();
}, 120000);
child.stderr.resume();
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  if (buffer.length > 1024 * 1024) {
    failure = new Error('Runtime validation output limit');
    child.kill();
    return;
  }
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    try {
      const response = JSON.parse(line);
      if (response.id === 'release-hello') {
        const value = response.result;
        const major = Number(/^v(\d+)\./.exec(value?.nodeVersion)?.[1]);
        if (
          !response.ok ||
          value?.protocolVersion !== expected.runtimeProtocol ||
          value?.runtimeVersion !== expected.version ||
          value?.sourceCommit !== expected.sourceCommit ||
          value?.platform !== 'linux' ||
          value?.isElectron !== false ||
          !Number.isInteger(major) ||
          major < 22
        )
          throw new Error('Runtime release handshake identity mismatch');
        hello = value;
        child.stdin.end(
          JSON.stringify({
            type: 'request',
            id: 'release-stop',
            method: 'runtime.shutdown',
            params: {},
          }) + '\n',
        );
      }
    } catch (error) {
      failure = error;
      child.kill();
    }
  }
});
child.stdin.write(
  JSON.stringify({ type: 'request', id: 'release-hello', method: 'runtime.hello', params: {} }) +
    '\n',
);
const code = await new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('close', resolve);
}).finally(() => clearTimeout(timer));
if (failure) throw failure;
if (code !== 0 || !hello) throw new Error('Runtime did not validate and close cleanly');
console.log(
  JSON.stringify({
    verified: true,
    runtimeVersion: hello.runtimeVersion,
    sourceCommit: hello.sourceCommit,
    protocol: hello.protocolVersion,
  }),
);
