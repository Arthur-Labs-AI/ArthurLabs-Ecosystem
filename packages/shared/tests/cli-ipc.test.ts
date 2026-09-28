import { describe, expect, it } from 'vitest';
import {
  CLI_IPC_PROTOCOL_VERSION,
  cliPipePath,
  cliPipeScope,
  containsSecretShapedValue,
  parseClientIdentity,
  parseHelloMessage,
  parseRequestMessage,
  sanitizeBrokerField,
} from '../src/cli-ipc.js';

describe('cli ipc contract', () => {
  it('derives a stable user-scoped pipe path without embedding usernames', () => {
    const first = cliPipePath();
    const second = cliPipePath();
    expect(first).toBe(second);
    expect(cliPipeScope()).toMatch(/^[0-9a-f]{12}$/);
    const user = (process.env['USERNAME'] ?? process.env['USER'] ?? '').toLowerCase();
    if (user.length > 3) expect(first.toLowerCase()).not.toContain(user);
    if (process.platform === 'win32')
      expect(first.startsWith('\\\\.\\pipe\\sentry-cli-v1-')).toBe(true);
  });

  it('accepts the documented hello handshakes', () => {
    expect(
      parseHelloMessage({
        type: 'hello',
        protocolVersion: 1,
        client: { type: 'cli', name: 'Nexus', version: '0.1.0' },
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseHelloMessage({
        type: 'hello',
        protocolVersion: 1,
        client: { type: 'cli', name: 'Sentry CLI' },
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseHelloMessage({
        type: 'hello',
        protocolVersion: 999,
        client: { type: 'cli', name: 'Nexus' },
      }),
    ).toMatchObject({ ok: false, code: 'PROTOCOL_VERSION_MISMATCH' });
    expect(
      parseHelloMessage({ type: 'request', id: 'x', command: 'y', payload: {} }),
    ).toMatchObject({ ok: false });
  });

  it('validates requests and rejects unknown shapes', () => {
    const parsed = parseRequestMessage({
      type: 'request',
      id: 'r1',
      command: 'runs:status',
      payload: { runId: 'run_x' },
    });
    expect(parsed).toMatchObject({ ok: true });
    expect(
      parseRequestMessage({ type: 'request', id: 'r1', command: 'runs:status' }),
    ).toMatchObject({ ok: true });
    expect(
      parseRequestMessage({ type: 'request', id: '', command: 'runs:status', payload: {} }).ok,
    ).toBe(false);
    expect(parseRequestMessage({ type: 'nonsense' }).ok).toBe(false);
    expect(parseRequestMessage('text').ok).toBe(false);
  });

  it('captures only the declared client name and version', () => {
    expect(parseClientIdentity({ type: 'cli', name: 'Nexus', admin: true })).toEqual({
      name: 'Nexus',
    });
    expect(parseClientIdentity({ type: 'cli' })).toBeUndefined();
    expect(parseClientIdentity({ type: 'other', name: 'Nexus' })).toBeUndefined();
  });

  it('redacts secret-shaped broker fields', () => {
    expect(containsSecretShapedValue('DEEPSEEK_API_KEY=hunter2')).toBe(true);
    expect(sanitizeBrokerField('DEEPSEEK_API_KEY=hunter2')).toBe('[redacted]');
    expect(sanitizeBrokerField('Nexus')).toBe('Nexus');
  });

  it('pins the protocol version', () => {
    expect(CLI_IPC_PROTOCOL_VERSION).toBe(1);
  });
});
