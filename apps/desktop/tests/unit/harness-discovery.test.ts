import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverDeepSeekBinary } from '../../src/main/services/harness-discovery.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe('harness binary discovery', () => {
  it('finds the npm-global dsh entry without relying on PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-detect-'));
    roots.push(root);
    const bin = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    await mkdir(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true });
    await writeFile(bin, 'probe');
    const saved = {
      APPDATA: process.env['APPDATA'],
      HOME: process.env['HOME'],
      USERPROFILE: process.env['USERPROFILE'],
      PATH: process.env['PATH'],
      PREFIX: process.env['npm_config_prefix'],
    };
    process.env['APPDATA'] = root;
    process.env['HOME'] = root;
    process.env['USERPROFILE'] = root;
    process.env['PATH'] = root;
    process.env['npm_config_prefix'] = root;
    try {
      await expect(discoverDeepSeekBinary()).resolves.toBe(bin);
    } finally {
      if (saved.APPDATA === undefined) delete process.env['APPDATA'];
      else process.env['APPDATA'] = saved.APPDATA;
      if (saved.HOME === undefined) delete process.env['HOME'];
      else process.env['HOME'] = saved.HOME;
      if (saved.USERPROFILE === undefined) delete process.env['USERPROFILE'];
      else process.env['USERPROFILE'] = saved.USERPROFILE;
      if (saved.PATH === undefined) delete process.env['PATH'];
      else process.env['PATH'] = saved.PATH;
      if (saved.PREFIX === undefined) delete process.env['npm_config_prefix'];
      else process.env['npm_config_prefix'] = saved.PREFIX;
    }
  });

  it('returns undefined when nothing is installed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-detect-empty-'));
    roots.push(root);
    const previousPath = process.env['PATH'];
    const previousAppData = process.env['APPDATA'];
    const previousHome = process.env['HOME'];
    const previousProfile = process.env['USERPROFILE'];
    const previousPrefix = process.env['npm_config_prefix'];
    process.env['PATH'] = root;
    process.env['APPDATA'] = root;
    process.env['HOME'] = root;
    process.env['USERPROFILE'] = root;
    delete process.env['npm_config_prefix'];
    try {
      await expect(discoverDeepSeekBinary()).resolves.toBeUndefined();
    } finally {
      if (previousPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = previousPath;
      if (previousAppData === undefined) delete process.env['APPDATA'];
      else process.env['APPDATA'] = previousAppData;
      if (previousHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = previousHome;
      if (previousProfile === undefined) delete process.env['USERPROFILE'];
      else process.env['USERPROFILE'] = previousProfile;
      if (previousPrefix !== undefined) process.env['npm_config_prefix'] = previousPrefix;
    }
  });
});
