import { AppError } from '@calyptra/framework';

/** Google Gemini's OpenAI-compatible chat endpoint and the model id (§11.5). */
export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
/** 3.5 Flash streams its reply in about 1-3 s; 3.8 Flash held the whole reply back for 7-20 s and was often overloaded. */
export const GEMINI_MODEL = 'gemini-3.5-flash';
/** Longest reply, in tokens. */
export const GEMINI_MAX_TOKENS = 800;
/** Gemini 3 thinks by default and the thinking counts against max_tokens; "none" turns it off so replies stream fast and whole. */
export const GEMINI_REASONING_EFFORT = 'none';
/** Busy (429) and overloaded (503) answers are retried after these pauses, before anything has streamed. */
export const GEMINI_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GeminiOptions {
  /** GEMINI_API_KEY, on the merchant host only. */
  apiKey: string;
  endpoint?: string;
  model?: string;
  maxTokens?: number;
  retryDelaysMs?: readonly number[];
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

/**
 * Streams chat completions from Gemini (`stream: true`, server-sent events). Errors are wrapped into
 * AppError and never carry the key, the prompt or the reply; nothing is logged.
 */
export class GeminiAdapter {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly retryDelaysMs: readonly number[];

  constructor(options: GeminiOptions) {
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? GEMINI_ENDPOINT;
    this.model = options.model ?? GEMINI_MODEL;
    this.maxTokens = options.maxTokens ?? GEMINI_MAX_TOKENS;
    this.retryDelaysMs = options.retryDelaysMs ?? GEMINI_RETRY_DELAYS_MS;
  }

  /** Yields the reply's text as it arrives. */
  async *stream(messages: readonly ChatMessage[], signal?: AbortSignal): AsyncGenerator<string> {
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await fetch(this.endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({ model: this.model, messages, stream: true, max_tokens: this.maxTokens, reasoning_effort: GEMINI_REASONING_EFFORT }),
          signal,
        });
      } catch (err) {
        if (signal?.aborted) throw err; // stopped on purpose
        throw new AppError(502, 'UPSTREAM_ERROR', 'The AI service did not answer');
      }
      const delay = this.retryDelaysMs[attempt];
      if ((response.status !== 429 && response.status !== 503) || delay === undefined) break;
      await response.body?.cancel().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (signal?.aborted) throw signal.reason;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new AppError(502, 'UPSTREAM_ERROR', `The AI service answered with status ${response.status}`);
    }
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const bytes of response.body) {
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
    } catch (err) {
      if (signal?.aborted) throw err; // stopped on purpose
      throw new AppError(502, 'UPSTREAM_ERROR', 'The AI service stopped answering');
    }
  }
}
