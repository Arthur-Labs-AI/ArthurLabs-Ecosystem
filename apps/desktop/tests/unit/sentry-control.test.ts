import { describe, expect, it } from 'vitest';
import { parseSentryControlArgs } from '../../src/main/sentry-control.js';

describe('parseSentryControlArgs', () => {
  it('detects open while closed (no control args)', () => {
    expect(parseSentryControlArgs(['electron', '.'])).toEqual({
      mode: undefined,
      setupDistro: undefined,
    });
    expect(parseSentryControlArgs(['electron', '.', '--sentry-app']).mode).toBeUndefined();
  });

  it('detects stop in = and space forms', () => {
    expect(parseSentryControlArgs(['electron', '.', '--sentry-control=stop']).mode).toBe('stop');
    expect(parseSentryControlArgs(['electron', '.', '--sentry-control', 'stop']).mode).toBe('stop');
  });

  it('does not mistake other flags for stop', () => {
    expect(
      parseSentryControlArgs(['electron', '.', '--sentry-control=status']).mode,
    ).toBeUndefined();
    expect(parseSentryControlArgs(['electron', '.', '--sentry-app']).setupDistro).toBeUndefined();
  });

  it('parses setup-distro in = and space forms', () => {
    expect(
      parseSentryControlArgs(['electron', '.', '--sentry-setup-distro=Ubuntu']).setupDistro,
    ).toBe('Ubuntu');
    expect(
      parseSentryControlArgs(['electron', '.', '--sentry-setup-distro', 'Ubuntu-24.04'])
        .setupDistro,
    ).toBe('Ubuntu-24.04');
  });

  it('ignores a setup-distro flag with no value', () => {
    expect(
      parseSentryControlArgs(['electron', '.', '--sentry-setup-distro']).setupDistro,
    ).toBeUndefined();
  });

  it('stop while not running must not carry a window request', () => {
    // The control instance quits before boot(); the parser only signals intent.
    const parsed = parseSentryControlArgs(['electron', '.', '--sentry-control=stop']);
    expect(parsed.mode).toBe('stop');
    expect(parsed.setupDistro).toBeUndefined();
  });
});
