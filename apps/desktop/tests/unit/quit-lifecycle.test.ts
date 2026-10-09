import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (event: { preventDefault(): void }) => void>(),
  windowHandlers: new Map<string, (event: { preventDefault(): void }) => void>(),
  showError: vi.fn(),
  quit: vi.fn(),
  close: vi.fn<() => Promise<void>>(),
  stopBroker: vi.fn<() => Promise<void>>(),
  boot: vi.fn(),
}));
vi.mock('electron', () => ({
  app: {
    on: (name: string, handler: (event: { preventDefault(): void }) => void) =>
      fixture.handlers.set(name, handler),
    quit: fixture.quit,
    whenReady: async () => undefined,
    requestSingleInstanceLock: () => true,
  },
  BrowserWindow: class {
    loadFile = async () => undefined;
    on = (name: string, handler: (event: { preventDefault(): void }) => void) =>
      fixture.windowHandlers.set(name, handler);
  },
  dialog: { showErrorBox: fixture.showError },
  ipcMain: { handle: vi.fn() },
}));
vi.mock('../../src/main/bootstrap.js', () => ({ bootstrapDesktop: fixture.boot }));
vi.mock('../../src/main/ipc.js', () => ({ registerDesktopIpc: vi.fn() }));
vi.mock('../../src/main/live-updates.js', () => ({
  DesktopLiveUpdates: class {
    start = vi.fn();
    stop = vi.fn();
  },
}));
vi.mock('../../src/main/cli-server.js', () => ({
  SentryCliServer: class {
    start = async () => ({ started: true });
    stop = fixture.stopBroker;
  },
}));

function desktop() {
  return {
    recoveryWarnings: [],
    service: {},
    runtime: { onNotification: vi.fn(), onExit: vi.fn() },
    close: fixture.close,
  };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.handlers.clear();
  fixture.windowHandlers.clear();
  fixture.boot.mockResolvedValue(desktop());
  fixture.close.mockResolvedValue(undefined);
  fixture.stopBroker.mockResolvedValue(undefined);
});

describe('Electron quit lifecycle', () => {
  it('waits for pending runtime cleanup and handles repeated quit', async () => {
    let finish!: () => void;
    fixture.close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await import('../../src/main/index.js');
    await flush();
    const event = { preventDefault: vi.fn() };
    fixture.handlers.get('before-quit')?.(event);
    fixture.handlers.get('before-quit')?.(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    await flush();
    expect(fixture.close).toHaveBeenCalledTimes(1);
    expect(fixture.quit).not.toHaveBeenCalled();
    finish();
    await flush();
    expect(fixture.quit).toHaveBeenCalledTimes(1);
    const finalEvent = { preventDefault: vi.fn() };
    fixture.handlers.get('before-quit')?.(finalEvent);
    expect(finalEvent.preventDefault).not.toHaveBeenCalled();
  });

  it('waits for in-progress bootstrap before closing its runtime', async () => {
    let finishBoot!: (value: ReturnType<typeof desktop>) => void;
    fixture.boot.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishBoot = resolve;
        }),
    );
    await import('../../src/main/index.js');
    const event = { preventDefault: vi.fn() };
    fixture.handlers.get('before-quit')?.(event);
    await flush();
    expect(fixture.quit).not.toHaveBeenCalled();
    finishBoot(desktop());
    await flush();
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.quit).toHaveBeenCalledOnce();
  });

  it('keeps quit blocked if cleanup rejects and permits retry', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fixture.close.mockRejectedValueOnce(new Error('cleanup failed'));
    try {
      await import('../../src/main/index.js');
      await flush();
      fixture.handlers.get('before-quit')?.({ preventDefault: vi.fn() });
      await flush();
      expect(fixture.quit).not.toHaveBeenCalled();
      expect(fixture.stopBroker).not.toHaveBeenCalled();
      expect(fixture.showError).toHaveBeenCalledWith(
        'Sentry is still running',
        expect.stringContaining('Cancel active QA work'),
      );
      expect(log).toHaveBeenCalled();
      fixture.handlers.get('before-quit')?.({ preventDefault: vi.fn() });
      await flush();
      expect(fixture.close).toHaveBeenCalledTimes(2);
      expect(fixture.quit).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });

  it('holds window close until runtime cleanup completes', async () => {
    await import('../../src/main/index.js');
    await flush();
    const event = { preventDefault: vi.fn() };
    fixture.windowHandlers.get('close')?.(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(fixture.quit).toHaveBeenCalledOnce();
  });
});
