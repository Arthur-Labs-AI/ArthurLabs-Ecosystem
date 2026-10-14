import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapDesktop, type BootstrappedDesktop } from './bootstrap.js';
import { classifyBootFailure, fatalScreenCopy } from './boot-failure.js';
import { parseSentryControlArgs } from './sentry-control.js';
import { dispatchDesktopCommand } from './desktop-command-router.js';
import { ProviderCredentialService } from './services/provider-credentials.js';
import { SentryCliServer } from './cli-server.js';
import { registerDesktopIpc } from './ipc.js';
import { DesktopLiveUpdates } from './live-updates.js';
import { readReleaseIdentity, sourceUserDataPath } from './distribution.js';
import { mkdirSync } from 'node:fs';
import { WslMaintenance } from './wsl-maintenance.js';
import { WslSpaceReclaimer } from './platform/windows/wsl-space-reclaimer.js';

// Keep source-beta credential/prefs and single-instance scope when the
// packaged product is named Sentry. Do this before bootstrap/lock acquisition.
if (app.isPackaged) {
  const directory = sourceUserDataPath(
    app.getPath('appData'),
    app.commandLine.getSwitchValue('user-data-dir'),
  );
  mkdirSync(directory, { recursive: true });
  app.setPath('userData', directory);
  const identity = readReleaseIdentity(app.getAppPath());
  if (process.argv.includes('--sentry-version')) {
    console.log(JSON.stringify(identity));
    app.exit(0);
  }
}

const currentDir = dirname(fileURLToPath(import.meta.url));

let bootstrapped: BootstrappedDesktop | undefined;
let mainWindow: BrowserWindow | undefined;
let liveUpdates: DesktopLiveUpdates | undefined;
let cliServer: SentryCliServer | undefined;
let bootPromise: Promise<void> | undefined;
let quitting = false;
let cleanupComplete = false;
let maintenance: WslMaintenance | undefined;

function resolveAsset(...segments: string[]): string {
  return join(currentDir, ...segments);
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 680,
    title: 'Sentry',
    icon: resolveAsset('../../assets/sentry-icon.png'),
    backgroundColor: '#0d100d',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: resolveAsset('../preload/preload.js'),
    },
  });
  mainWindow.on('close', (event) => {
    if (!cleanupComplete) {
      event.preventDefault();
      app.quit();
    }
  });

  const devUrl = process.env['SENTRY_DESKTOP_URL'];
  if (!app.isPackaged && devUrl !== undefined && devUrl.length > 0) {
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
    // safeStorage cannot decrypt persisted credentials before Electron is ready.
    await app.whenReady();
    bootstrapped = await bootstrapDesktop(dataRoot);
  } catch (error) {
    // Bootstrap hydrates stored credentials into the main-process environment.
    // Its service may not exist after failure: scrub known environment values
    // without reading, changing, or migrating any credential store here.
    const credentials = new ProviderCredentialService({});
    const classified = classifyBootFailure(error, {
      redactSecrets: (text) => credentials.redactSecretsFromText(text),
    });
    const message = classified.message;
    await app.whenReady();
    const copy = fatalScreenCopy(classified.kind);
    const nativeHostFailure = classified.kind === 'native-runtime-offline';
    const runtimeOffline = classified.kind !== 'data-store';
    const fatal = new BrowserWindow({
      width: 640,
      height: runtimeOffline ? 420 : 320,
      title: copy.title,
      icon: resolveAsset('../../assets/sentry-icon.png'),
      backgroundColor: '#0d100d',
    });
    await fatal.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          "<body style='background:#0d100d;color:#eef1eb;font-family:sans-serif;padding:32px'>" +
            (nativeHostFailure
              ? '<h1>' +
                copy.heading +
                '</h1><p>' +
                copy.intro +
                '</p><p>' +
                message.replace(/</g, '&lt;') +
                '</p><p>' +
                copy.help +
                '</p>'
              : runtimeOffline
                ? '<h1>' +
                  copy.heading +
                  '</h1><p>' +
                  copy.intro +
                  '</p><p>' +
                  message.replace(/</g, '&lt;') +
                  '</p><p>' +
                  copy.help +
                  '</p>'
                : '<h1>' +
                  copy.heading +
                  '</h1><p>' +
                  message.replace(/</g, '&lt;') +
                  '</p><p>' +
                  copy.help +
                  '</p>') +
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
  const desktopService = bootstrapped.service;
  const desktop = bootstrapped;
  const reclaimer = new WslSpaceReclaimer(join(app.getPath('userData'), 'maintenance'));
  maintenance = new WslMaintenance({
    runtime: desktop.runtime,
    hostKind: desktop.host.hostKind,
    async distro() {
      const info = await desktop.host.runtimeEnvironmentInfo();
      if (info.distro === undefined) throw new Error('No WSL distribution is connected.');
      return info.distro;
    },
    inspect: (distro) => reclaimer.inspect(distro),
    reclaim: (distro) => reclaimer.reclaim(distro),
    reconnect: () => desktop.reconnect(),
    pause: () => updates.stop(),
    resume: () => updates.start(),
  });
  // No catch here by design: a throwing scrubber must propagate into the
  // shared fail-closed mapping (fixed safe message), never keep raw text.
  const redactErrorText = (text: string): string => desktopService.redactSecretsFromText(text);
  cliServer = new SentryCliServer({
    redactErrorText,
    dispatch: (command, payload) =>
      dispatchDesktopCommand(
        desktopService,
        command,
        payload,
        {
          maintenanceActive: () => maintenance?.active ?? false,
          onRunCreated: (runId, operationId) => updates.notifyRunCreated(runId, operationId),
          onRetestCreated: (retestRunId, operationId) =>
            updates.notifyRetestCreated(retestRunId, operationId),
          // Self-status: external clients may inspect broker liveness and
          // (non-secret) client names; the payload carries no credentials.
          cliStatus: () => cliServer?.status ?? { started: false },
        },
        { external: true },
      ),
    onStatusChange: () => {
      if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sentry:cli-status', cliServer?.status);
      }
    },
  });
  const broker = cliServer;
  registerDesktopIpc(bootstrapped.service, {
    maintenanceActive: () => maintenance?.active ?? false,
    reclaimSpace: () => {
      if (quitting || maintenance === undefined) throw new Error('Sentry is shutting down.');
      return maintenance.reclaimSpace();
    },
    redactErrorText,
    onRunCreated: (runId, operationId) => updates.notifyRunCreated(runId, operationId),
    onRetestCreated: (retestRunId, operationId) =>
      updates.notifyRetestCreated(retestRunId, operationId),
    cliStatus: () => broker.status,
    requestSavePath: async ({ suggestedFilename, filters }) => {
      const win = mainWindow;
      if (win === undefined) return null;
      const result = await dialog.showSaveDialog(win, {
        defaultPath: suggestedFilename,
        filters: filters.map((filter) => ({
          name: filter.name,
          extensions: [...filter.extensions],
        })),
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
      if (result.canceled) return null;
      return result.filePath ?? null;
    },
  });
  registerDialogIpc();
  liveUpdates.start();
  const cliStatus = await cliServer.start();
  if (!cliStatus.started) {
    console.warn('[sentry] CLI broker unavailable: ' + (cliStatus.error ?? 'unknown'));
  }

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

app.on('before-quit', (event) => {
  if (cleanupComplete) return;
  // Electron does not await async event handlers. Hold the first quit until
  // bootstrap and runtime shutdown finish; repeated requests share cleanup.
  event.preventDefault();
  if (maintenance?.active) {
    dialog.showErrorBox(
      'Disk reclamation is running',
      'Wait for Windows disk reclamation and runtime reconnection to finish before closing Sentry.',
    );
    return;
  }
  if (quitting) return;
  quitting = true;
  void (async () => {
    try {
      await bootPromise;
      // Refusal must leave the window and broker usable for cancellation.
      await bootstrapped?.close();
      liveUpdates?.stop();
      await cliServer?.stop();
      cleanupComplete = true;
      app.quit();
    } catch {
      quitting = false;
      console.error('[sentry] Shutdown cleanup failed; cancel active work and retry sentry stop.');
      dialog.showErrorBox(
        'Sentry is still running',
        'Shutdown could not complete. Cancel active QA work, wait for it to finish, then retry sentry stop.',
      );
    }
  })();
});

// Single instance: a second launch focuses the running window instead of
// starting a second runtime (dual leases corrupt run ownership and
// produce phantom timeouts across both instances).
const sentryControl = parseSentryControlArgs(process.argv);
if (sentryControl.mode === 'stop') {
  // Graceful stop (`sentry stop`): never kill processes, never boot the UI.
  if (!app.requestSingleInstanceLock()) {
    // A Sentry instance is running; it receives this argv via
    // 'second-instance' and quits through the normal before-quit path
    // (DesktopLiveUpdates.stop() -> runtime.close() -> runtime.shutdown).
    app.quit();
  } else {
    // No instance holds the lock: report cleanly without launching Desktop.
    void app.whenReady().then(() => {
      console.log('Sentry is not currently running.');
      app.quit();
    });
  }
} else if (sentryControl.setupDistro !== undefined) {
  // Distro preference sync (`sentry setup`): Windows-only. Persist through
  // the existing WslRuntimeManager so the JSON format stays authoritative,
  // then quit.
  if (process.platform !== 'win32') {
    void app.whenReady().then(() => {
      console.error('Distro preference sync applies to Windows (WSL) only.');
      app.exit(1);
    });
  } else {
    const distroToSave = sentryControl.setupDistro;
    if (!app.requestSingleInstanceLock()) {
      app.quit();
    } else {
      void app.whenReady().then(() => {
        import('./services/wsl-runtime-client.js')
          .then(async ({ WslRuntimeManager }) => {
            const manager = new WslRuntimeManager({ userDataDir: app.getPath('userData') });
            await manager.savePreferredDistro(distroToSave);
            console.log('Saved WSL distro preference: ' + distroToSave);
            app.quit();
          })
          .catch((error: unknown) => {
            console.error('Failed to save distro preference: ' + String(error));
            app.exit(1);
          });
      });
    }
  }
} else if (sentryControl.providerBinary !== undefined) {
  // Provider binary override (`sentry setup`): persist a NON-SECRET
  // executable path through the existing plain-prefs mechanism, then quit.
  // Secret keys are rejected by the parser allowlist; values are Linux
  // paths, never credentials.
  const binaryToSave = sentryControl.providerBinary;
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    void app.whenReady().then(() => {
      import('./services/provider-credentials.js')
        .then(async ({ ProviderCredentialService }) => {
          const credentials = new ProviderCredentialService({
            userDataDir: app.getPath('userData'),
          });
          await credentials.load();
          await credentials.saveKey(binaryToSave.key, binaryToSave.value);
          console.log('Saved provider binary override: ' + binaryToSave.key);
          app.quit();
        })
        .catch((error: unknown) => {
          console.error('Failed to save provider binary: ' + String(error));
          app.exit(1);
        });
    });
  }
} else if (sentryControl.credentialStatus) {
  // Presence-only credential diagnostic (`sentry doctor`): prints booleans
  // only — never values, blobs, prefixes, or paths.
  if (!app.requestSingleInstanceLock()) {
    console.error(
      'Credential status unavailable while Sentry is running. Check Settings -> Providers / Environment in the running application.',
    );
    app.exit(1);
  } else {
    void app.whenReady().then(() => {
      import('./services/provider-credentials.js')
        .then(async ({ ProviderCredentialService }) => {
          const credentials = new ProviderCredentialService({
            userDataDir: app.getPath('userData'),
            safeStorage: {
              isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
              encryptString: (value: string) => safeStorage.encryptString(value),
              decryptString: (buffer: Buffer) => safeStorage.decryptString(buffer),
            },
          });
          await credentials.load({ strict: true });
          const isSet = (name: string): boolean => (credentials.getValue(name) ?? '').length > 0;
          const report = {
            opencode: isSet('OPENROUTER_API_KEY') || isSet('OPENCODE_API_KEY'),
            deepseek: isSet('DEEPSEEK_API_KEY'),
            glm: isSet('ANTHROPIC_AUTH_TOKEN'),
          };
          console.log('SENTRY_CREDENTIAL_STATUS=' + JSON.stringify(report));
          app.quit();
        })
        .catch(() => {
          console.error(
            'Credential status unavailable. Check OS secure storage and Settings -> Providers / Environment. Keep the existing credential store; do not delete it to repair diagnostics.',
          );
          app.exit(1);
        });
    });
  }
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const command = parseSentryControlArgs(argv);
    if (command.mode === 'stop') {
      app.quit();
      return;
    }
    // The standalone diagnostic reports unavailable while this profile is
    // owned. Its lock probe must not steal focus from the running Desktop.
    if (command.credentialStatus) return;
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  bootPromise = boot();
}
