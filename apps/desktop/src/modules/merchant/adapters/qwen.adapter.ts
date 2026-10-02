import { AppError } from '@calyptra/framework';

/** Alibaba Cloud Model Studio's OpenAI-compatible chat endpoint and the model id (§11.5; to verify, §13.1 V2). */
export const QWEN_ENDPOINT = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';
export const QWEN_MODEL = 'qwen3.8-max';
/** Longest reply, in tokens. */
export const QWEN_MAX_TOKENS = 800;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface QwenOptions {
  /** DASHSCOPE_API_KEY, on the merchant host only. */
  apiKey: string;
  endpoint?: string;
  model?: string;
  maxTokens?: number;
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
 * Streams chat completions from Qwen (`stream: true`, server-sent events). Errors are wrapped into
 * AppError and never carry the key, the prompt or the reply; nothing is logged.
 */
export class QwenAdapter {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(options: QwenOptions) {
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? QWEN_ENDPOINT;
    this.model = options.model ?? QWEN_MODEL;
    this.maxTokens = options.maxTokens ?? QWEN_MAX_TOKENS;
  }

  /** Yields the reply's text as it arrives. */
  async *stream(messages: readonly ChatMessage[], signal?: AbortSignal): AsyncGenerator<string> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ model: this.model, messages, stream: true, max_tokens: this.maxTokens }),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err; // stopped on purpose
      throw new AppError(502, 'UPSTREAM_ERROR', 'The AI service did not answer');
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
