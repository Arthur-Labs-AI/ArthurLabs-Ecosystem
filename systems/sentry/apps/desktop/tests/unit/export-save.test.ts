import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isSavedExport,
  revealSavedExport,
  saveExportRun,
  saveOptionsForFormat,
  writeAtomically,
} from '../../src/main/services/export-save.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const RUN_ID = 'run_01K7777777777777777777A8W1';
const CANONICAL_JSON = JSON.stringify({ schemaVersion: 1, qaRun: { id: RUN_ID } });

function deps(
  overrides: {
    dialogResult?: string | null;
    seenPaths?: string[];
    content?: string;
  } = {},
) {
  const seenPaths = overrides.seenPaths ?? [];
  return {
    seenPaths,
    requestSavePath: async (options: { suggestedFilename: string }): Promise<string | null> => {
      seenPaths.push(options.suggestedFilename);
      return overrides.dialogResult === undefined
        ? join('C:', 'chosen', 'file')
        : overrides.dialogResult;
    },
    fetchContent: async () => ({
      contentBase64: Buffer.from(overrides.content ?? CANONICAL_JSON, 'utf8').toString('base64'),
    }),
  };
}

describe('native Save As export', () => {
  it('offers JSON defaults + JSON filters for JSON exports', () => {
    const options = saveOptionsForFormat(RUN_ID, 'json');
    expect(options.suggestedFilename).toBe('sentry-' + RUN_ID + '.json');
    expect(options.filters[0]).toMatchObject({ name: 'JSON files', extensions: ['json'] });
  });

  it('offers .log defaults + log filters for log exports', () => {
    const options = saveOptionsForFormat(RUN_ID, 'log');
    expect(options.suggestedFilename).toBe('sentry-' + RUN_ID + '.log');
    expect(options.filters.map((filter) => filter.name)).toEqual([
      'Log files',
      'Text files',
      'All files',
    ]);
  });

  it('cancellation writes nothing and fetches nothing', async () => {
    const written: string[] = [];
    let fetched = 0;
    const result = await saveExportRun(RUN_ID, 'json', {
      requestSavePath: async () => null,
      fetchContent: async () => {
        fetched += 1;
        return { contentBase64: '' };
      },
      writeDestination: async (destination) => {
        written.push(destination);
      },
    });
    expect(result).toEqual({ status: 'cancelled' });
    expect(fetched).toBe(0);
    expect(written).toHaveLength(0);
  });

  it('saves the exact canonical bytes to the dialog-chosen destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-save-'));
    roots.push(root);
    const destination = join(root, 'sentry-run.json');
    const result = await saveExportRun(RUN_ID, 'json', {
      ...deps({ dialogResult: destination }),
      writeDestination: writeAtomically,
    });
    expect(result).toEqual({ status: 'saved', path: destination });
    await expect(readFile(destination, 'utf8')).resolves.toBe(CANONICAL_JSON);
    // Atomic write leaves no temp sibling behind.
    await expect(stat(destination + '.sentry-part')).rejects.toThrow();
  });

  it('ignores renderer-supplied destinations: only the dialog path is used', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-save-'));
    roots.push(root);
    const destination = join(root, 'dialog-choice.log');
    const written: string[] = [];
    const result = await saveExportRun(RUN_ID, 'log', {
      // A renderer-controlled `destination` key has no channel: even when
      // present it must never reach the filesystem.
      ...deps({ dialogResult: destination }),
      destination: join(root, 'evil.log'),
      writeDestination: async (chosen) => {
        written.push(chosen);
      },
    } as never);
    expect(result).toEqual({ status: 'saved', path: destination });
    expect(written).toEqual([destination]);
  });

  it('registers the saved destination for Show in folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-save-'));
    roots.push(root);
    const destination = join(root, 'sentry-run.json');
    expect(isSavedExport(destination)).toBe(false);
    const shown: string[] = [];
    const result = await saveExportRun(RUN_ID, 'json', {
      ...deps({ dialogResult: destination }),
      writeDestination: writeAtomically,
    });
    expect(result).toEqual({ status: 'saved', path: destination });
    expect(isSavedExport(destination)).toBe(true);
    await expect(
      revealSavedExport(destination, {
        showInFolder: (path) => {
          shown.push(path);
        },
      }),
    ).resolves.toEqual({ status: 'shown' });
    expect(shown).toEqual([destination]);
  });

  it('rejects Show in folder for paths this session never saved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-save-'));
    roots.push(root);
    await expect(
      revealSavedExport(join(root, 'evil.log'), {
        showInFolder: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'REVEAL_NOT_PERMITTED' });
    await expect(
      revealSavedExport('C:\\Windows\\System32\\drivers\\etc\\hosts', {
        showInFolder: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'REVEAL_NOT_PERMITTED' });
  });

  it('failed writes leave no partial file at the destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-save-'));
    roots.push(root);
    const destination = join(root, 'no-such-dir', 'export.json');
    await expect(writeAtomically(destination, Buffer.from('{}'))).rejects.toThrow();
    await expect(stat(destination)).rejects.toThrow();
  });
});
