import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GEMINI_ENDPOINT, GEMINI_FIRST_CHUNK_TIMEOUT_MS, GEMINI_MAX_TOKENS, GEMINI_MODELS, GeminiAdapter } from './adapters/gemini.adapter.ts';
import { SYSTEM_PROMPT, GeminiChatService } from './gemini-chat.service.ts';

/** A stand-in for Gemini's OpenAI-compatible endpoint: records requests, streams a scripted reply. */
interface Seen {
  headers: IncomingHttpHeaders;
  body: { model: string; stream: boolean; max_tokens: number; reasoning_effort?: string; messages: { role: string; content: string }[] };
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
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta/openai/chat/completions`;
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

describe('GeminiAdapter', () => {
  it('targets the OpenAI-compatible Gemini endpoint with Flash-Lite first, then fallbacks with thinking off', () => {
    expect(GEMINI_ENDPOINT).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(GEMINI_MODELS).toEqual([
      { model: 'gemini-flash-lite-latest' },
      { model: 'gemini-3.1-flash-lite', reasoningEffort: 'none' },
      { model: 'gemini-3.5-flash', reasoningEffort: 'none' },
    ]);
    expect(GEMINI_MAX_TOKENS).toBe(800);
    expect(GEMINI_FIRST_CHUNK_TIMEOUT_MS).toBe(8_000);
  });

  it('streams the reply with the key, the first model, stream: true and max_tokens 800', async () => {
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
    const gemini = new GeminiAdapter({ apiKey: 'test-key', endpoint });
    const messages = [{ role: 'user' as const, content: 'hi' }];
    expect(await collect(gemini.stream(messages))).toEqual(['Hello', ' there']);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.authorization).toBe('Bearer test-key');
    expect(seen[0]?.body).toEqual({ model: 'gemini-flash-lite-latest', messages, stream: true, max_tokens: 800 });
  });

  it('moves to the next model when one is busy or overloaded, then gives up with the last status', async () => {
    const statuses = [503, 429];
    reply = (res) => {
      const status = statuses.shift();
      if (status === undefined) return sse(res, ['Back']);
      res.writeHead(status, { 'content-type': 'application/json' }).end('{"error":{"message":"busy"}}');
    };
    const gemini = new GeminiAdapter({ apiKey: 'k', endpoint });
    expect(await collect(gemini.stream([{ role: 'user', content: 'hi' }]))).toEqual(['Back']);
    expect(seen.map((s) => [s.body.model, s.body.reasoning_effort])).toEqual([
      ['gemini-flash-lite-latest', undefined], ['gemini-3.1-flash-lite', 'none'], ['gemini-3.5-flash', 'none'],
    ]);
    seen.length = 0;
    reply = (res) => res.writeHead(503).end('busy');
    await expect(collect(gemini.stream([{ role: 'user', content: 'hi' }]))).rejects.toMatchObject({ message: 'The AI service answered with status 503' });
    expect(seen).toHaveLength(3);
  });

  it('moves to the next model when one has not started its reply in time, but not once words have streamed', async () => {
    let calls = 0;
    reply = (res) => {
      calls += 1;
      if (calls === 1) return void setTimeout(() => sse(res, ['Late']), 400); // too slow: skipped
      sse(res, ['Quick']);
    };
    const gemini = new GeminiAdapter({ apiKey: 'k', endpoint, firstChunkTimeoutMs: 150 });
    expect(await collect(gemini.stream([{ role: 'user', content: 'hi' }]))).toEqual(['Quick']);
    expect(seen.map((s) => s.body.model)).toEqual(['gemini-flash-lite-latest', 'gemini-3.1-flash-lite']);
  });

  it('wraps upstream failures without revealing the key', async () => {
    reply = (res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"Incorrect API key provided"}}');
    };
    const gemini = new GeminiAdapter({ apiKey: 'secret-key', endpoint });
    const failure = collect(gemini.stream([{ role: 'user', content: 'hi' }]));
    await expect(failure).rejects.toMatchObject({ code: 'UPSTREAM_ERROR', statusCode: 502 });
    await expect(failure).rejects.not.toThrow(/secret-key/);
    const down = new GeminiAdapter({ apiKey: 'secret-key', endpoint: 'http://127.0.0.1:9/v1/chat/completions' });
    await expect(collect(down.stream([{ role: 'user', content: 'hi' }]))).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });
});

describe('GeminiChatService', () => {
  it('keeps each conversation in memory until its session ends', async () => {
    let answer = ['Paris', '.'];
    reply = (res) => sse(res, answer);
    const chat = new GeminiChatService(new GeminiAdapter({ apiKey: 'k', endpoint }));
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
    const chat = new GeminiChatService(new GeminiAdapter({ apiKey: 'k', endpoint }));
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
    await collect(new GeminiChatService(new GeminiAdapter({ apiKey: 'k', endpoint })).reply('chan-4', 'private question', new AbortController().signal));
    for (const spy of [...spies, writes]) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
