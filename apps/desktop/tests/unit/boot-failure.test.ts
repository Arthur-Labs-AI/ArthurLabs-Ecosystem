import { describe, expect, it } from 'vitest';
import { classifyBootFailure, fatalScreenCopy } from '../../src/main/boot-failure.js';

function offlineError(hostPlatform: string, executionMode: string): Error {
  return Object.assign(new Error('boom [host=linux/native-linux]'), {
    code: 'RUNTIME_OFFLINE',
    hostPlatform,
    executionMode,
  });
}

describe('boot failure classification', () => {
  it('routes structured native failures to the native copy', () => {
    const classified = classifyBootFailure(offlineError('linux', 'native-linux'));
    expect(classified.kind).toBe('native-runtime-offline');
    const copy = fatalScreenCopy(classified.kind);
    expect(copy.intro).toContain('native Linux');
    expect(copy.help).toContain('CachyOS');
    expect(copy.help).not.toContain('wsl');
    expect(copy.help).not.toContain('WSL');
    expect(copy.help).not.toContain('Ubuntu');
    expect(copy.help).not.toContain('wsl --install');
  });

  it('routes structured windows failures to the WSL copy', () => {
    const classified = classifyBootFailure(offlineError('windows', 'wsl2'));
    expect(classified.kind).toBe('wsl-runtime-offline');
    const copy = fatalScreenCopy(classified.kind);
    expect(copy.intro).toContain('WSL2');
    expect(copy.help).toContain('wsl-runtime.md');
  });

  it('routes distro rejection to the native host failure', () => {
    const failure = Object.assign(
      new Error('Native Linux support currently targets CachyOS only. Detected: Ubuntu.'),
      { code: 'LINUX_DISTRO_UNSUPPORTED' },
    );
    expect(classifyBootFailure(failure).kind).toBe('native-runtime-offline');
  });

  it('routes missing WSL to the WSL failure', () => {
    const failure = Object.assign(new Error('wsl.exe is unavailable.'), {
      code: 'WSL_UNAVAILABLE',
    });
    expect(classifyBootFailure(failure).kind).toBe('wsl-runtime-offline');
  });

  it('keeps legacy unstructured WSL errors on the WSL copy', () => {
    const failure = Object.assign(new Error('wsl.exe spawn failed: boom'), {
      code: 'RUNTIME_OFFLINE',
    });
    expect(classifyBootFailure(failure).kind).toBe('wsl-runtime-offline');
  });

  it('routes unknown failures to the data-store copy', () => {
    const classified = classifyBootFailure(new Error('disk is full'));
    expect(classified.kind).toBe('data-store');
    expect(fatalScreenCopy(classified.kind).help).toContain('SENTRY_DATA_ROOT');
  });
});
