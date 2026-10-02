/**
 * The service a merchant sells by the second (e.g. an AI chat). A streaming LLM fits directly: a reply
 * is an async iterable of text chunks, which the merchant forwards only while the subscriber pays.
 */
export interface ServicePort {
  /**
   * Streams the reply to one prompt. `conversationId` identifies the subscription (its channel id), so
   * the service can keep the conversation in memory; `signal` aborts when the subscriber goes away.
   */
  reply(conversationId: string, text: string, signal: AbortSignal): AsyncIterable<string>;
  /** The subscriber's session ended: forget the conversation. */
  end(conversationId: string): void;
}

/** A fake service that echoes each prompt back word by word (tests and demos without an LLM). */
export class EchoServicePort implements ServicePort {
  private readonly delayMs: number;

  constructor(options: { delayMs?: number } = {}) {
    this.delayMs = options.delayMs ?? 0;
  }

  async *reply(_conversationId: string, text: string, signal: AbortSignal): AsyncIterable<string> {
    for (const piece of text.split(/(?<=\s)/)) {
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      if (signal.aborted) return;
      yield piece;
    }
  }

  end(_conversationId: string): void {
    // nothing is kept
  }
}
