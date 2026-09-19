import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapDesktop, type BootstrappedDesktop } from './bootstrap.js';
import { registerDesktopIpc } from './ipc.js';
import { DesktopLiveUpdates } from './live-updates.js';

const currentDir = dirname(fileURLToPath(import.meta.url));

let bootstrapped: BootstrappedDesktop | undefined;
let mainWindow: BrowserWindow | undefined;
let liveUpdates: DesktopLiveUpdates | undefined;

function resolveAsset(...segments: string[]): string {
  return join(currentDir, ...segments);
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    title: 'Sentry',
    backgroundColor: '#0b0e14',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: resolveAsset('../preload/preload.js'),
    },
  });

  const devUrl = process.env['SENTRY_DESKTOP_URL'];
  if (devUrl !== undefined && devUrl.length > 0) {
    await mainWindow.loadURL(devUrl);
  } else {
    await mainWindow.loadFile(resolveAsset('../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
}

function registerDialogIpc(): void {
  ipcMain.handle('sentry:dialog:open-directory', async () => {
    const win = mainWindow;
    if (win === undefined)
      return { ok: false as const, error: { code: 'NO_WINDOW', message: 'No window' } };
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0)
      return { ok: true as const, result: null };
    return { ok: true as const, result: result.filePaths[0] };
  });
}

async function boot(): Promise<void> {
  const dataRoot = process.env['SENTRY_DATA_ROOT'];
  try {
    bootstrapped = await bootstrapDesktop(dataRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
    await app.whenReady();
    const runtimeOffline =
      code === 'WSL_UNAVAILABLE' ||
      code === 'WSL_NO_DISTRO' ||
      code === 'RUNTIME_OFFLINE' ||
      code === 'RUNTIME_TIMEOUT' ||
      /runtime|wsl|handshake/i.test(message);
    const fatal = new BrowserWindow({
      width: 640,
      height: runtimeOffline ? 420 : 320,
      title: runtimeOffline ? 'Sentry — runtime offline' : 'Sentry — data store unavailable',
      backgroundColor: '#0b0e14',
    });
    await fatal.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          "<body style='background:#0b0e14;color:#e6e9f0;font-family:sans-serif;padding:32px'>" +
            (runtimeOffline
              ? '<h1>Sentry Runtime Offline</h1><p>Sentry Desktop is running, but the WSL2 execution runtime could not start.</p><p>' +
                message.replace(/</g, '&lt;') +
                '</p><p>QA execution is disabled. See docs/setup/wsl-runtime.md for setup instructions.</p>'
              : '<h1>Sentry could not open its data store.</h1><p>' +
                message.replace(/</g, '&lt;') +
                '</p><p>Fix the data root (SENTRY_DATA_ROOT) and retry.</p>') +
            '</body>',
        ),
    );
    return;
  }
  for (const warning of bootstrapped.recoveryWarnings) {
    // Bounded non-fatal boot warnings; Environment diagnostics surface them.
    console.warn('[sentry] boot warning: ' + warning);
  }
  liveUpdates = new DesktopLiveUpdates(() => mainWindow, bootstrapped.service);
  const updates: DesktopLiveUpdates = liveUpdates;
  bootstrapped.runtime.onNotification((event, payload) => {
    const typed = payload as { runId?: string; retestRunId?: string } | undefined;
    if (event === 'run.created' && typeof typed?.runId === 'string') {
      updates.notifyRunCreated(typed.runId);
    } else if (event === 'run.snapshot' && typeof typed?.runId === 'string') {
      updates.watchRun(typed.runId);
    } else if (event === 'retest.created' && typeof typed?.retestRunId === 'string') {
      updates.notifyRetestCreated(typed.retestRunId);
    } else if (event === 'retest.snapshot' && typeof typed?.retestRunId === 'string') {
      updates.watchRetest(typed.retestRunId);
    } else if (event === 'activeRuns.updated') {
      updates.refreshActiveRuns();
    }
  });
  bootstrapped.runtime.onExit(() => {
    liveUpdates?.stop();
  });
  registerDesktopIpc(bootstrapped.service, {
    onRunCreated: (runId, operationId) => updates.notifyRunCreated(runId, operationId),
    onRetestCreated: (retestRunId, operationId) =>
      updates.notifyRetestCreated(retestRunId, operationId),
  });
  registerDialogIpc();
  liveUpdates.start();

  ipcMain.handle('sentry:watch-run', (_event, payload: unknown) => {
    const runId = (payload as { runId?: unknown }).runId;
    if (typeof runId === 'string') liveUpdates?.watchRun(runId);
    return { ok: true as const, result: null };
  });
  ipcMain.handle('sentry:unwatch-run', (_event, payload: unknown) => {
    const runId = (payload as { runId?: unknown }).runId;
    if (typeof runId === 'string') liveUpdates?.unwatchRun(runId);
    return { ok: true as const, result: null };
  });
  ipcMain.handle('sentry:watch-retest', (_event, payload: unknown) => {
    const retestRunId = (payload as { retestRunId?: unknown }).retestRunId;
    if (typeof retestRunId === 'string') liveUpdates?.watchRetest(retestRunId);
    return { ok: true as const, result: null };
  });

  await app.whenReady();
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  liveUpdates?.stop();
  void bootstrapped?.close();
});

void boot();
