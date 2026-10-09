import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ArthurError } from '../../src/core/errors/errors';
import {
  MachineConfigCredentialStore,
  isCredentialName,
  resolveCredentialState,
} from '../../src/providers/credentials';
import type { MachineConfigUpdate } from '../../src/config/machine_config';

const SECRET_A = 'sk-deepseek-test-credential-a';
const SECRET_B = 'sk-openai-test-credential-b';

function fakeBackend(seed: Record<string, string> = {}): { store: MachineConfigCredentialStore; writes: MachineConfigUpdate[]; entries: Record<string, string> } {
  const entries: Record<string, string> = { ...seed };
  const writes: MachineConfigUpdate[] = [];
  const store = new MachineConfigCredentialStore({
    readEntries: () => ({ ...entries }),
    writeUpdate: (update) => {
      writes.push(update);
      for (const [k, v] of Object.entries(update.set ?? {})) entries[k] = v;
      for (const k of update.remove ?? []) delete entries[k];
      return { ...entries };
    },
  });
  return { store, writes, entries };
}

test('A1: MachineConfigCredentialStore set/get/has/remove round-trips through the injected writer', () => {
  const { store, writes } = fakeBackend();
  assert.equal(store.has('DEEPSEEK_API_KEY'), false);
  assert.equal(store.get('DEEPSEEK_API_KEY'), undefined);
  store.set('DEEPSEEK_API_KEY', SECRET_A);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]?.set, { DEEPSEEK_API_KEY: SECRET_A });
  assert.equal(store.has('DEEPSEEK_API_KEY'), true);
  assert.equal(store.get('DEEPSEEK_API_KEY'), SECRET_A);
  store.remove('DEEPSEEK_API_KEY');
  assert.deepEqual(writes[1]?.remove, ['DEEPSEEK_API_KEY']);
  assert.equal(store.has('DEEPSEEK_API_KEY'), false);
});

test('A2: credential store delegates to the FRS-01 writer shape (set/remove patch)', () => {
  const { store, writes } = fakeBackend({ OPENAI_API_KEY: SECRET_B });
  assert.equal(store.get('OPENAI_API_KEY'), SECRET_B);
  store.set('OPENAI_API_KEY', SECRET_A);
  assert.ok((writes[0]?.set ?? {})['OPENAI_API_KEY'] === SECRET_A);
});

test('A3: unknown credential names fail typed and never touch storage', () => {
  const { store, writes } = fakeBackend();
  assert.equal(isCredentialName('DEEPSEEK_API_KEY'), true);
  assert.equal(isCredentialName('SOME_OTHER_KEY'), false);
  assert.throws(() => store.get('NOPE' as never), (e: unknown) => e instanceof ArthurError);
  assert.throws(() => store.set('NOPE' as never, 'x'), (e: unknown) => e instanceof ArthurError);
  assert.equal(writes.length, 0);
});

test('A4: empty secret set fails typed (no silent empty credential)', () => {
  const { store, writes } = fakeBackend();
  assert.throws(() => store.set('DEEPSEEK_API_KEY', ''), (e: unknown) => e instanceof ArthurError);
  assert.equal(writes.length, 0);
});

test('G1: ambient env outranks repo .env outranks machine config (no silent copy)', () => {
  const layers = { ambient: { OPENAI_API_KEY: 'env-key' }, repo: { OPENAI_API_KEY: 'repo-key' }, machine: { OPENAI_API_KEY: 'machine-key' } };
  const state = resolveCredentialState('OPENAI_API_KEY', layers);
  assert.equal(state.configured, true);
  assert.equal(state.source, 'process_env');
  assert.equal(state.machinePersisted, true);
  const repoWins = resolveCredentialState('OPENAI_API_KEY', { ambient: {}, repo: { OPENAI_API_KEY: 'repo-key' }, machine: { OPENAI_API_KEY: 'machine-key' } });
  assert.equal(repoWins.source, 'repo_env');
  assert.equal(repoWins.machinePersisted, true);
  const machineOnly = resolveCredentialState('OPENAI_API_KEY', { ambient: {}, repo: {}, machine: { OPENAI_API_KEY: 'machine-key' } });
  assert.equal(machineOnly.source, 'machine_config');
  const absent = resolveCredentialState('OPENAI_API_KEY', { ambient: {}, repo: {}, machine: {} });
  assert.equal(absent.configured, false);
  assert.equal(absent.source, 'absent');
});

test('G2: external credential is effective but not machine-persisted (must ask before saving)', () => {
  const state = resolveCredentialState('DEEPSEEK_API_KEY', { ambient: { DEEPSEEK_API_KEY: 'external' }, repo: {}, machine: {} });
  assert.equal(state.configured, true);
  assert.equal(state.source, 'process_env');
  assert.equal(state.machinePersisted, false);
});
/*MORE*/
