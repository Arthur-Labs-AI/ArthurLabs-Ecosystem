/**
 * Native Save As orchestration for run exports (Electron main process).
 *
 * Safety contract: the renderer controls runId + format ONLY. The
 * destination always originates from the native Save As dialog (via the
 * injected requestSavePath hook) and is never accepted from the renderer.
 * Export bytes always come from the canonical RunExporter artifact for
 * this run + format — no arbitrary filesystem reads exist on this path.
 */
import { open, rename, rm } from 'node:fs/promises';

export interface SaveDialogOptions {
  readonly suggestedFilename: string;
  readonly filters: ReadonlyArray<{ readonly name: string; readonly extensions: string[] }>;
}

export type ExportSaveResult =
  { readonly status: 'saved'; readonly path: string } | { readonly status: 'cancelled' };

export interface ExportSaveDeps {
  readonly requestSavePath: (options: SaveDialogOptions) => Promise<string | null>;
  readonly fetchContent: (
    runId: string,
    format: 'log' | 'json',
  ) => Promise<{ readonly contentBase64: string }>;
  readonly writeDestination?: (destination: string, bytes: Buffer) => Promise<void>;
}

export function saveOptionsForFormat(runId: string, format: 'log' | 'json'): SaveDialogOptions {
  if (format === 'json') {
    return {
      suggestedFilename: 'sentry-' + runId + '.json',
      filters: [
        { name: 'JSON files', extensions: ['json'] },
        { name: 'All files', extensions: ['*'] },
      ],
    };
  }
  return {
    suggestedFilename: 'sentry-' + runId + '.log',
    filters: [
      { name: 'Log files', extensions: ['log'] },
      { name: 'Text files', extensions: ['txt'] },
      { name: 'All files', extensions: ['*'] },
    ],
  };
}

/** Atomic host write: temp sibling, fsync, close, then rename over the
 *  dialog-confirmed destination. A failed write never leaves a partial
 *  export at the selected path (the temp sibling is removed instead). */
export async function writeAtomically(destination: string, bytes: Buffer): Promise<void> {
  const temporary = destination + '.sentry-part';
  try {
    const handle = await open(temporary, 'w');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Windows rename cannot overwrite: the dialog already confirmed, so
    // remove-then-rename is the honest overwrite path. The export is
    // regenerable from the run, so crash residue here is recoverable.
    await rm(destination, { force: true });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function saveExportRun(
  runId: string,
  format: 'log' | 'json',
  deps: ExportSaveDeps,
): Promise<ExportSaveResult> {
  const destination = await deps.requestSavePath(saveOptionsForFormat(runId, format));
  // Dialog cancellation is a normal outcome: no error, no file written.
  if (destination === null || destination.length === 0) return { status: 'cancelled' };
  const content = await deps.fetchContent(runId, format);
  const bytes = Buffer.from(content.contentBase64, 'base64');
  await (deps.writeDestination ?? writeAtomically)(destination, bytes);
  return { status: 'saved', path: destination };
}
