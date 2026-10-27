import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLanguage, setLanguage } from '../../src/renderer/lib/app-preferences.js';

declare global {
  interface Window {
    sentry?: {
      app?: { setLanguage?: (language: string) => Promise<unknown> };
    };
  }
}

afterEach(() => {
  window.localStorage.clear();
  delete window.sentry;
  document.documentElement.lang = '';
});

describe('renderer language persistence bridge', () => {
  it('applies the selection locally without a bridge', () => {
    expect(() => setLanguage('bg')).not.toThrow();
    expect(getLanguage()).toBe('bg');
    expect(window.localStorage.getItem('sentry:language')).toBe('bg');
    expect(document.documentElement.lang).toBe('bg');
  });

  it('mirrors the selection to the main-process store when bridged', async () => {
    const setLanguageBridge = vi.fn().mockResolvedValue({ saved: true, language: 'bg' });
    window.sentry = { app: { setLanguage: setLanguageBridge } };
    setLanguage('bg');
    await Promise.resolve();
    expect(setLanguageBridge).toHaveBeenCalledWith('bg');
    expect(getLanguage()).toBe('bg');
  });

  it('never breaks language switching when the bridge rejects or throws', async () => {
    window.sentry = { app: { setLanguage: () => Promise.reject(new Error('gone')) } };
    expect(() => setLanguage('en')).not.toThrow();
    expect(getLanguage()).toBe('en');
    window.sentry = {
      app: {
        setLanguage: () => {
          throw new Error('sync gone');
        },
      },
    };
    expect(() => setLanguage('bg')).not.toThrow();
    expect(getLanguage()).toBe('bg');
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});
