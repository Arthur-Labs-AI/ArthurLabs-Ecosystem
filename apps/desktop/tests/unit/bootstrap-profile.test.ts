import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  profile: '/disposable/profile',
  fail: false,
  credentials: vi.fn(),
  load: vi.fn(),
  host: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  request: vi.fn(),
}));
vi.mock('node:module', async (original) => {
  const module = await original<typeof import('node:module')>();
  return {
    ...module,
    createRequire: (url: string | URL) => {
      const require = module.createRequire(url);
      return (id: string) =>
        id === 'electron'
          ? {
              app: {
                isPackaged: false,
                getPath: () => {
                  if (fixture.fail) throw new Error('private profile failure');
                  return fixture.profile;
                },
              },
            }
          : require(id);
    },
  };
});
vi.mock('../../src/main/services/provider-credentials.js', () => ({
  ProviderCredentialService: fixture.credentials,
}));
vi.mock('../../src/main/platform/create-host-platform.js', () => ({
  createHostPlatform: fixture.host,
}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.fail = false;
  fixture.profile = '/disposable/profile';
  fixture.load.mockResolvedValue(undefined);
  fixture.credentials.mockImplementation(function () {
    return {
      load: fixture.load,
      getValue: () => undefined,
      redactSecretsFromText: (text: string) => text,
    };
  });
  fixture.start.mockResolvedValue({ dataRoot: '/disposable/runtime' });
  fixture.stop.mockResolvedValue(undefined);
  fixture.request.mockResolvedValue({});
  fixture.host.mockResolvedValue({
    createRuntimeClient: async () => ({
      start: fixture.start,
      stop: fixture.stop,
      request: fixture.request,
    }),
  });
  vi.stubEnv('SENTRY_DATA_ROOT', undefined);
});
afterEach(() => vi.unstubAllEnvs());
describe('production bootstrap profile selection', () => {
  for (const kind of ['throw', 'empty'] as const)
    it('refuses ' + kind + ' profile before credentials or runtime start', async () => {
      fixture.fail = kind === 'throw';
      if (kind === 'empty') fixture.profile = '';
      const { bootstrapDesktop } = await import('../../src/main/bootstrap.js');
      await expect(bootstrapDesktop()).rejects.toMatchObject({
        code: 'CREDENTIAL_PROFILE_UNAVAILABLE',
      });
      expect(fixture.credentials).not.toHaveBeenCalled();
      expect(fixture.host).not.toHaveBeenCalled();
    });
  it('uses the same selected Electron profile for credentials and host across boots', async () => {
    const { bootstrapDesktop } = await import('../../src/main/bootstrap.js');
    for (let i = 0; i < 2; i++) {
      const boot = await bootstrapDesktop();
      await boot.close();
    }
    expect(fixture.credentials.mock.calls.map((call) => call[0].userDataDir)).toEqual([
      fixture.profile,
      fixture.profile,
    ]);
    expect(fixture.host.mock.calls.map((call) => call[0].userDataDir)).toEqual([
      fixture.profile,
      fixture.profile,
    ]);
    expect(fixture.load).toHaveBeenCalledTimes(2);
    expect(fixture.stop).toHaveBeenCalledTimes(2);
  });
});
