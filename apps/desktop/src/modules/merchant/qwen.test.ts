import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { QWEN_ENDPOINT, QWEN_MAX_TOKENS, QWEN_MODEL, QwenAdapter } from './adapters/qwen.adapter.ts';
import { SYSTEM_PROMPT, QwenChatService } from './qwen-chat.service.ts';

/** A stand-in for DashScope's OpenAI-compatible endpoint: records requests, streams a scripted reply. */
interface Seen {
  headers: IncomingHttpHeaders;
  body: { model: string; stream: boolean; max_tokens: number; messages: { role: string; content: string }[] };
}
const seen: Seen[] = [];
let reply: (res: ServerResponse) => void;
let server: Server;
let endpoint: string;

const sse = (res: ServerResponse, pieces: string[]): void => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const piece of pieces) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
  res.end('data: [DONE]\n\n');
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let text = '';
    req.on('data', (chunk: Buffer) => (text += chunk.toString()));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(text) as Seen['body'] });
      reply(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/compatible-mode/v1/chat/completions`;
});
afterEach(() => {
  seen.length = 0;
});
afterAll(() => {
  server.close();
});

const collect = async (pieces: AsyncIterable<string>): Promise<string[]> => {
  const out: string[] = [];
  for await (const piece of pieces) out.push(piece);
  return out;
};

describe('QwenAdapter', () => {
  it('targets the OpenAI-compatible DashScope endpoint with the Qwen model', () => {
    expect(QWEN_ENDPOINT).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions');
    expect(QWEN_MODEL).toBe('qwen3.8-max');
    expect(QWEN_MAX_TOKENS).toBe(800);
  });

  it('streams the reply with the key, the model, stream: true and max_tokens 800', async () => {
    reply = (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // A role-only first event, a keep-alive comment and an event split across writes.
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n: keep-alive\n\n`);
      const event = `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] })}\n\n`;
      res.write(event.slice(0, 20));
      res.write(event.slice(20));
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ' there' } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    };
    const qwen = new QwenAdapter({ apiKey: 'test-key', endpoint });
    const messages = [{ role: 'user' as const, content: 'hi' }];
    expect(await collect(qwen.stream(messages))).toEqual(['Hello', ' there']);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.authorization).toBe('Bearer test-key');
    expect(seen[0]?.body).toEqual({ model: 'qwen3.8-max', messages, stream: true, max_tokens: 800 });
  });

  it('wraps upstream failures without revealing the key', async () => {
    reply = (res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"Incorrect API key provided"}}');
    };
    const qwen = new QwenAdapter({ apiKey: 'secret-key', endpoint });
    const failure = collect(qwen.stream([{ role: 'user', content: 'hi' }]));
    await expect(failure).rejects.toMatchObject({ code: 'UPSTREAM_ERROR', statusCode: 502 });
    await expect(failure).rejects.not.toThrow(/secret-key/);
    const down = new QwenAdapter({ apiKey: 'secret-key', endpoint: 'http://127.0.0.1:9/v1/chat/completions' });
    await expect(collect(down.stream([{ role: 'user', content: 'hi' }]))).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });
});

describe('QwenChatService', () => {
  it('keeps each conversation in memory until its session ends', async () => {
    let answer = ['Paris', '.'];
    reply = (res) => sse(res, answer);
    const chat = new QwenChatService(new QwenAdapter({ apiKey: 'k', endpoint }));
    const signal = new AbortController().signal;
    expect(await collect(chat.reply('chan-1', 'Capital of France?', signal))).toEqual(['Paris', '.']);
    answer = ['About 2 million.'];
    await collect(chat.reply('chan-1', 'Its population?', signal));
    expect(seen[1]?.body.messages).toEqual([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'Capital of France?' },
      { role: 'assistant', content: 'Paris.' },
      { role: 'user', content: 'Its population?' },
    ]);
    await collect(chat.reply('chan-2', 'Hello', signal)); // another subscription starts fresh
    expect(seen[2]?.body.messages).toEqual([{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: 'Hello' }]);
    chat.end('chan-1');
    await collect(chat.reply('chan-1', 'Again', signal));
    expect(seen[3]?.body.messages).toHaveLength(2);
  });

  it('stops when the merchant aborts the reply', async () => {
    reply = (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'first' } }] })}\n\n`);
      // never ends on its own
    };
    const chat = new QwenChatService(new QwenAdapter({ apiKey: 'k', endpoint }));
    const abort = new AbortController();
    const pieces: string[] = [];
    const run = (async () => {
      for await (const piece of chat.reply('chan-3', 'Tell me a long story', abort.signal)) {
        pieces.push(piece);
        abort.abort();
      }
    })();
    await expect(run).rejects.toThrow();
    expect(pieces).toEqual(['first']);
  });

  it('logs nothing', async () => {
    reply = (res) => sse(res, ['ok']);
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
    const writes = vi.spyOn(process.stderr, 'write');
    await collect(new QwenChatService(new QwenAdapter({ apiKey: 'k', endpoint })).reply('chan-4', 'private question', new AbortController().signal));
    for (const spy of [...spies, writes]) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
