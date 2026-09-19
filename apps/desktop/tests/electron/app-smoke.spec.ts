import { expect, test } from '@playwright/test';
import { electronLaunch } from './helpers.js';

/**
 * True Electron smoke: main → preload → renderer.
 * Launches the packaged/dev Electron app headlessly (xvfb on Linux CI),
 * asserts window title, renderer load, Dashboard, window.sentry bridge,
 * no Node integration, and navigation. No provider calls.
 */
test('electron launches Sentry with secure renderer bridge', async () => {
  const { app, window } = await electronLaunch();
  try {
    await expect(window).toHaveTitle(/Sentry/);
    await expect(window.getByText('Dashboard', { exact: false }).first()).toBeVisible({
      timeout: 30000,
    });
    const bridge = await window.evaluate(() => ({
      hasSentry: typeof (window as unknown as { sentry?: unknown }).sentry !== 'undefined',
      hasRequire: typeof (window as unknown as { require?: unknown }).require !== 'undefined',
      hasProcess: typeof (window as unknown as { process?: unknown }).process !== 'undefined',
    }));
    expect(bridge.hasSentry).toBe(true);
    expect(bridge.hasRequire).toBe(false);
    expect(bridge.hasProcess).toBe(false);
    await window.getByRole('link', { name: 'Projects' }).first().click();
    await expect(window).toHaveURL(/#\/projects/);
  } finally {
    await app.close();
  }
});
