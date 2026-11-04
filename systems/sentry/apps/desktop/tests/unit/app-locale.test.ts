import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_LOCALE_FILENAME,
  isAppLanguage,
  mainCopyKeys,
  readAppLanguage,
  resolveAppLocalePath,
  translateMainCopy,
  writeAppLanguage,
} from '../../src/main/app-locale.js';

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sentry-applocale-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('main-process app locale store', () => {
  it('defaults to English when nothing is stored', () => {
    expect(readAppLanguage(freshDir())).toBe('en');
    expect(readAppLanguage(undefined)).toBe('en');
    expect(readAppLanguage('')).toBe('en');
  });

  it('round-trips the renderer selection through the file', () => {
    const dir = freshDir();
    expect(writeAppLanguage(dir, 'bg')).toBe(true);
    expect(readAppLanguage(dir)).toBe('bg');
    expect(writeAppLanguage(dir, 'en')).toBe(true);
    expect(readAppLanguage(dir)).toBe('en');
  });

  it('stores a single small JSON document under the product file name', () => {
    const dir = freshDir();
    writeAppLanguage(dir, 'bg');
    expect(resolveAppLocalePath(dir)).toBe(join(dir, APP_LOCALE_FILENAME));
    const raw = JSON.parse(readFileSync(resolveAppLocalePath(dir), 'utf8'));
    expect(raw).toEqual({ language: 'bg' });
  });

  it('falls back to English on corrupt or unexpected content', () => {
    const dir = freshDir();
    writeFileSync(resolveAppLocalePath(dir), 'not-json{{{', 'utf8');
    expect(readAppLanguage(dir)).toBe('en');
    writeFileSync(resolveAppLocalePath(dir), JSON.stringify({ language: 'fr' }), 'utf8');
    expect(readAppLanguage(dir)).toBe('en');
    writeFileSync(resolveAppLocalePath(dir), JSON.stringify(['bg']), 'utf8');
    expect(readAppLanguage(dir)).toBe('en');
  });

  it('never throws and reports failure for unusable locations', () => {
    expect(writeAppLanguage(undefined, 'bg')).toBe(false);
    expect(writeAppLanguage('', 'bg')).toBe(false);
    // @ts-expect-error invalid on purpose: validation rejects non-enum values
    expect(writeAppLanguage(freshDir(), 'fr')).toBe(false);
    expect(isAppLanguage('bg')).toBe(true);
    expect(isAppLanguage('en')).toBe(true);
    expect(isAppLanguage('fr')).toBe(false);
    expect(isAppLanguage(undefined)).toBe(false);
  });

  it('translates known main-process copy and passes everything else through', () => {
    expect(translateMainCopy('Sentry is still running', 'en')).toBe('Sentry is still running');
    expect(translateMainCopy('Sentry is still running', 'bg')).toBe('Sentry все още работи');
    expect(translateMainCopy('unmapped dynamic detail 42', 'bg')).toBe(
      'unmapped dynamic detail 42',
    );
  });

  it('keeps every main-process string translated in both languages', () => {
    for (const key of mainCopyKeys()) {
      expect(translateMainCopy(key, 'en')).toBe(key);
      const bg = translateMainCopy(key, 'bg');
      expect(bg.length).toBeGreaterThan(0);
      expect(bg).not.toBe(key);
    }
  });
});
