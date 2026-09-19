import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('IPC security contract', () => {
  it('exposes only the narrow window.sentry bridge', () => {
    const preload = readFileSync(join(root, 'src', 'preload', 'preload.ts'), 'utf8');
    expect(preload).toContain('contextBridge.exposeInMainWorld');
    expect(preload).toContain("'sentry'");
    for (const forbidden of [
      'ipcRenderer',
      'require(',
      'process.',
      'child_process',
      'BrowserWindow',
      'event.sender',
    ]) {
      const exposed = preload.split('exposeInMainWorld')[1] ?? '';
      expect(exposed).not.toContain(forbidden);
    }
  });

  it('configures sandbox + context isolation without node integration', () => {
    const main = readFileSync(join(root, 'src', 'main', 'index.ts'), 'utf8');
    expect(main).toContain('contextIsolation: true');
    expect(main).toContain('nodeIntegration: false');
    expect(main).toContain('sandbox: true');
  });

  it('delivers payloads without raw electron events', () => {
    const preload = readFileSync(join(root, 'src', 'preload', 'preload.ts'), 'utf8');
    expect(preload).toContain('callback(payload');
    expect(preload).not.toContain('callback(event,');
  });

  it('registers only known channels', () => {
    const ipc = readFileSync(join(root, 'src', 'main', 'ipc.ts'), 'utf8');
    for (const channel of [
      'projects:list',
      'runs:start-simulation',
      'runs:cancel',
      'runs:merge',
      'runs:verify',
      'runs:ingest',
      'runs:export',
      'retests:cancel',
      'doctors:environment',
    ]) {
      expect(ipc).toContain(channel);
    }
    expect(ipc).not.toContain('shell');
    expect(ipc).not.toContain('execute(');
  });

  it('exposes exactly the expected preload API keys (§175)', () => {
    const preload = readFileSync(join(root, 'src', 'preload', 'preload.ts'), 'utf8');
    for (const key of [
      'projects:',
      'runs:',
      'issues:',
      'retests:',
      'doctors:',
      'system:',
      'subscribe:',
    ]) {
      expect(preload).toContain(key);
    }
    expect(preload).not.toContain('shell');
    expect(preload).not.toContain('database');
    expect(preload).not.toContain('arbitrary');
  });

  it('never forwards secrets to the renderer', () => {
    const service = readFileSync(
      join(root, 'src', 'main', 'services', 'desktop-service.ts'),
      'utf8',
    );
    expect(service.toLowerCase()).not.toContain('api_key');
    expect(service.toLowerCase()).not.toContain('auth token');
    expect(service).toContain('simulation');
  });
});
