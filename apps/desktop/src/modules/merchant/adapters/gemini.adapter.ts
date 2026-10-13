import { AppError, isAppError } from '@calyptra/framework';

/** Google Gemini's OpenAI-compatible chat endpoint. */
export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

export interface GeminiModel {
  model: string;
  /** Gemini 3 thinks by default and the thinking counts against max_tokens; "none" turns it off. Lite models
   *  think little and some refuse "none", so they send nothing. */
  reasoningEffort?: string;
}

/**
 * Tried in order: a model that is busy (429/5xx) or has not started its reply within the first-chunk timeout
 * is skipped for the next. Flash-Lite answered in about 1 s while 3.5 Flash was often overloaded (503).
 */
export const GEMINI_MODELS: readonly GeminiModel[] = [
  { model: 'gemini-flash-lite-latest' },
  { model: 'gemini-3.1-flash-lite', reasoningEffort: 'none' },
  { model: 'gemini-3.5-flash', reasoningEffort: 'none' },
];
/** Longest reply, in tokens. */
export const GEMINI_MAX_TOKENS = 800;
/** How long a model may take to send the first words of its reply before the next model is tried. */
export const GEMINI_FIRST_CHUNK_TIMEOUT_MS = 8_000;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GeminiOptions {
  /** GEMINI_API_KEY, on the merchant host only. */
  apiKey: string;
  endpoint?: string;
  models?: readonly GeminiModel[];
  maxTokens?: number;
  firstChunkTimeoutMs?: number;
}

/** The text of one server-sent event's `data:` payload, or null for anything that carries none. */
function deltaOf(data: string): string | null {
  try {
    const chunk = JSON.parse(data) as { choices?: { delta?: { content?: unknown } }[] };
    const content = chunk.choices?.[0]?.delta?.content;
    return typeof content === 'string' && content !== '' ? content : null;
  } catch {
    return null;
  }
}

/** The texts of a server-sent-event stream of chat-completion chunks, until `[DONE]`. */
async function* textsOf(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice('data:'.length).trim();
      if (data === '[DONE]') return;
      const text = deltaOf(data);
      if (text !== null) yield text;
    }
  }
}

/**
 * Streams chat completions from Gemini (`stream: true`, server-sent events), falling back to the next model
 * while nothing has streamed yet. Errors are wrapped into AppError and never carry the key, the prompt or
 * the reply; nothing is logged.
 */
export class GeminiAdapter {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly models: readonly GeminiModel[];
  private readonly maxTokens: number;
  private readonly firstChunkTimeoutMs: number;

  constructor(options: GeminiOptions) {
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? GEMINI_ENDPOINT;
    this.models = options.models ?? GEMINI_MODELS;
    this.maxTokens = options.maxTokens ?? GEMINI_MAX_TOKENS;
    this.firstChunkTimeoutMs = options.firstChunkTimeoutMs ?? GEMINI_FIRST_CHUNK_TIMEOUT_MS;
  }

  /** Yields the reply's text as it arrives. */
  async *stream(messages: readonly ChatMessage[], signal?: AbortSignal): AsyncGenerator<string> {
    let failure = 'The AI service did not answer';
    for (const { model, reasoningEffort } of this.models) {
      const attempt = new AbortController();
      const stop = (): void => attempt.abort();
      signal?.addEventListener('abort', stop, { once: true });
      const timer = setTimeout(stop, this.firstChunkTimeoutMs);
      let started = false;
      try {
        const response = await fetch(this.endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({
            model, messages, stream: true, max_tokens: this.maxTokens,
            ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          }),
          signal: attempt.signal,
        });
        if (!response.ok || !response.body) {
          await response.body?.cancel().catch(() => undefined);
          failure = `The AI service answered with status ${response.status}`;
          if (response.status === 429 || response.status >= 500) continue; // busy: the next model
          throw new AppError(502, 'UPSTREAM_ERROR', failure);
        }
        for await (const text of textsOf(response.body)) {
          if (!started) {
            started = true;
            clearTimeout(timer);
          }
          yield text;
        }
        return;
      } catch (err) {
        if (signal?.aborted) throw err; // stopped on purpose
        if (isAppError(err)) throw err;
        if (started) throw new AppError(502, 'UPSTREAM_ERROR', 'The AI service stopped answering');
        // No answer before its first words (network error or too slow): the next model.
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
      }
    }
    throw new AppError(502, 'UPSTREAM_ERROR', failure);
  }
}
