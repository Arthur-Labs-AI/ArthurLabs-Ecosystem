import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { appendFileSync } from 'node:fs';

/**
 * Minimal in-test OpenAI-compatible stub provider for zero-credit
 * real-binary OpenCode tests. Speaks the SSE streaming shape the
 * `@ai-sdk/openai-compatible` loader requires (`data: {...} data: [DONE]`).
 *
 * Responses are consumed in order; when the script is exhausted the last
 * entry repeats. Deterministic and local-only (127.0.0.1 ephemeral port).
 */

export type StubResponse =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'tool';
      readonly id: string;
      readonly name: string;
      readonly args: Readonly<Record<string, unknown>>;
    };

export interface StubCall {
  readonly index: number;
  readonly url: string;
  readonly body: string;
  /** role of the last conversation message + tool names it carries. */
  readonly summary: string;
}

function summarizeBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      messages?: Array<{ role?: unknown; tool_calls?: Array<{ function?: { name?: unknown } }> }>;
    };
    const messages = parsed.messages ?? [];
    const last = messages[messages.length - 1];
    if (last === undefined) return 'no-messages';
    const tools = (last.tool_calls ?? []).map((t) => String(t.function?.name ?? '?')).join(',');
    return String(last.role ?? '?') + (tools ? '[tools:' + tools + ']' : '');
  } catch {
    return 'unparseable';
  }
}

export interface StubProvider {
  readonly baseUrl: string;
  readonly calls: StubCall[];
  close(): Promise<void>;
}

function sseEnvelope(id: string, model: string, choice: unknown, usage?: unknown): string {
  const head = JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: 1,
    model,
    choices: [choice],
    ...(usage === undefined ? {} : { usage }),
  });
  return 'data: ' + head + '\n\n';
}

export async function startStubProvider(script: readonly StubResponse[]): Promise<StubProvider> {
  const calls: StubCall[] = [];
  let n = 0;
  const trafficLog = process.env['STUB_TRAFFIC_LOG'];
  const traffic = (line: string): void => {
    if (trafficLog === undefined) return;
    appendFileSync(trafficLog, line + '\n');
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      if (req.url === '/v1/models' || req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-model', object: 'model' }] }));
        return;
      }
      n += 1;
      calls.push({ index: n, url: req.url ?? '', body, summary: summarizeBody(body) });
      traffic('### call=' + n + ' len=' + body.length);
      traffic(body.slice(-3000));
      const step = script[Math.min(n - 1, script.length - 1)] ?? {
        kind: 'text',
        text: 'stub done',
      };
      const usage = { prompt_tokens: 11, completion_tokens: 6, total_tokens: 17 };
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
      if (step.kind === 'text') {
        res.end(
          sseEnvelope('stub-' + n, 'stub-model', {
            index: 0,
            delta: { content: step.text },
            finish_reason: null,
          }) +
            sseEnvelope(
              'stub-' + n,
              'stub-model',
              { index: 0, delta: {}, finish_reason: 'stop' },
              usage,
            ) +
            'data: [DONE]\n\n',
        );
        return;
      }
      res.end(
        sseEnvelope('stub-' + n, 'stub-model', {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: step.id,
                type: 'function',
                function: { name: step.name, arguments: JSON.stringify(step.args) },
              },
            ],
          },
          finish_reason: null,
        }) +
          sseEnvelope(
            'stub-' + n,
            'stub-model',
            { index: 0, delta: {}, finish_reason: 'tool_calls' },
            usage,
          ) +
          'data: [DONE]\n\n',
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    baseUrl: 'http://127.0.0.1:' + String(port) + '/v1',
    calls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((cause) => (cause ? reject(cause) : resolve()));
      }),
  };
}
