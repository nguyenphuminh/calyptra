import type { ServicePort } from '@calyptra/framework';
import type { ChatMessage, QwenAdapter } from './adapters/qwen.adapter.ts';

/** A short system prompt for the demo merchant's chat. */
export const SYSTEM_PROMPT =
  'You are Calyptra AI, a helpful assistant powered by Qwen. The user pays for this chat by the second, so answer clearly and concisely.';
/** Earlier messages sent along with a prompt (the newest ones), so long sessions stay within the model's context. */
export const MAX_HISTORY = 20;

/**
 * The merchant's service: an AI chat on Qwen. Each subscription (conversation id = channel id) has
 * its conversation in memory for as long as its session lasts; nothing is written or logged.
 */
export class QwenChatService implements ServicePort {
  private readonly qwen: QwenAdapter;
  private readonly conversations = new Map<string, ChatMessage[]>();

  constructor(qwen: QwenAdapter) {
    this.qwen = qwen;
  }

  async *reply(conversationId: string, text: string, signal: AbortSignal): AsyncIterable<string> {
    const history = this.conversations.get(conversationId) ?? [];
    const prompt: ChatMessage = { role: 'user', content: text };
    let answer = '';
    try {
      for await (const piece of this.qwen.stream([{ role: 'system', content: SYSTEM_PROMPT }, ...history, prompt], signal)) {
        answer += piece;
        yield piece;
      }
    } finally {
      // Whatever part of the reply was produced is part of the conversation from now on.
      if (answer !== '') {
        const turn: ChatMessage[] = [prompt, { role: 'assistant', content: answer }];
        this.conversations.set(conversationId, [...history, ...turn].slice(-MAX_HISTORY));
      }
    }
  }

  end(conversationId: string): void {
    this.conversations.delete(conversationId);
  }
}
