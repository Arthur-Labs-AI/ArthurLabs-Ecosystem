import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const electronRequire = createRequire(require.resolve('electron/package.json'));
const extractorPath = electronRequire.resolve('extract-zip');

// Large enough to exercise multiple fd-slicer reads even when compressed.
const payload = Buffer.alloc(256 * 1024);
let seed = 1;
for (let i = 0; i < payload.length; i++) {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  payload[i] = seed & 0xff;
}

function zipFixture(compressed: boolean) {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of [
    ['libvulkan.so.1', payload],
    ['electron', Buffer.from('second entry')],
  ] as const) {
    const filename = Buffer.from(name);
    const body = compressed ? deflateRawSync(data) : data;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(compressed ? 8 : 0, 8);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    locals.push(header, filename, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    header.copy(entry, 6, 4, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, filename);
    offset += header.length + filename.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(2, 8);
  end.writeUInt16LE(2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

it.each([false, true])('completes Electron ZIP extraction (deflated=%s)', (compressed) => {
  const root = mkdtempSync(join(tmpdir(), 'sentry-electron-extract-'));
  try {
    const zipPath = join(root, 'electron.zip');
    const distPath = join(root, 'dist');
    writeFileSync(zipPath, zipFixture(compressed));
    // Match install.js's CommonJS promise chain: an unsettled extraction can
    // exit 0 without calling either handler. Exit status alone is insufficient.
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `require(process.argv[1])(process.argv[2], { dir: process.argv[3] })
          .then(() => console.log('EXTRACTION_COMPLETE'))
          .catch(error => { console.error(error); process.exitCode = 1; });`,
        extractorPath,
        zipPath,
        distPath,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('EXTRACTION_COMPLETE');
    expect(readFileSync(join(distPath, 'libvulkan.so.1'))).toEqual(payload);
    expect(readFileSync(join(distPath, 'electron'), 'utf8')).toBe('second entry');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
