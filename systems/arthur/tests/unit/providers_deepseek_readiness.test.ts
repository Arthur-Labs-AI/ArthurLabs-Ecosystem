import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkDeepSeekReadiness, DEEPSEEK_VALIDATION_PROMPT } from '../../src/providers/deepseek_readiness';
import { readinessContainsSecret } from '../../src/providers/readiness';

const SECRET = 'sk-deepseek-readiness-secret';

function deepseekOk(): typeof fetch {
  const fn = (async () => {
    const body = JSON.stringify({ id: 'chatcmpl-x', object: 'chat.completion', created: 1, model: 'deepseek-chat', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return fn;
}

function deepseekStatus(status: number, message = 'err'): typeof fetch {
  const fn = (async () => new Response(JSON.stringify({ error: { message } }), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  return fn;
}

function deepseekBadBody(): typeof fetch {
  const fn = (async () => new Response('not json{{{', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  return fn;
}

test('C1: ready on minimal completion via injected fetch (no network)', async () => {
  const seen: string[] = [];
  const spy = (async (url: unknown, init: unknown) => {
    seen.push(String((init as { body?: string }).body ?? ''));
    return new Response(JSON.stringify({ id: 'chatcmpl-x', object: 'chat.completion', created: 1, model: 'deepseek-chat', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const result = await checkDeepSeekReadiness({ apiKey: SECRET, model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' }, { fetchFn: spy });
  assert.equal(result.ready, true);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.capabilities, ['completion', 'tools']);
  assert.ok(seen[0]?.includes(DEEPSEEK_VALIDATION_PROMPT), 'tiny deterministic validation prompt is sent');
  assert.ok(!seen[0]?.includes('harness.create_job'), 'never uses mutation tools for readiness');
  assert.equal(readinessContainsSecret(result, [SECRET]), false);
});

test('C2: 401 maps to auth_failed with safe diagnostics', async () => {
  const result = await checkDeepSeekReadiness({ apiKey: SECRET, model: 'deepseek-chat', baseUrl: 'https://x' }, { fetchFn: deepseekStatus(401, 'bad key') });
  assert.equal(result.status, 'auth_failed');
  assert.equal(result.ready, false);
  assert.equal(result.diagnostics[0]?.category, 'auth');
  assert.equal(readinessContainsSecret(result, [SECRET]), false);
});

test('C3: 500 maps to unavailable (no secret in diagnostics)', async () => {
  const result = await checkDeepSeekReadiness({ apiKey: SECRET, model: 'deepseek-chat', baseUrl: 'https://x' }, { fetchFn: deepseekStatus(500) });
  assert.equal(result.status, 'unavailable');
  assert.equal(readinessContainsSecret(result, [SECRET]), false);
});

test('C4: malformed body maps to failed/bad_response', async () => {
  const result = await checkDeepSeekReadiness({ apiKey: SECRET, model: 'deepseek-chat', baseUrl: 'https://x' }, { fetchFn: deepseekBadBody() });
  assert.equal(result.status, 'failed');
  assert.equal(result.diagnostics[0]?.category, 'bad_response');
});

test('C5: missing credential short-circuits to not_configured without fetch', async () => {
  let called = false;
  const spy = (async () => { called = true; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
  const result = await checkDeepSeekReadiness({ apiKey: '', model: 'deepseek-chat', baseUrl: 'https://x' }, { fetchFn: spy });
  assert.equal(result.status, 'not_configured');
  assert.equal(called, false);
});

test('C6: fetch rejection maps to unavailable/network', async () => {
  const boom = (async () => { throw new Error('socket hangup'); }) as unknown as typeof fetch;
  const result = await checkDeepSeekReadiness({ apiKey: SECRET, model: 'deepseek-chat', baseUrl: 'https://x' }, { fetchFn: boom });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.diagnostics[0]?.category, 'network');
});
/*MORE*/
