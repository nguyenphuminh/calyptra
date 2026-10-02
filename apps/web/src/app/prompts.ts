import type { OpenRequest } from '@calyptra/framework';

/**
 * Questions the framework asks the user while it works: confirming an outgoing channel payment
 * (BRD 2.2.8) and approving a channel that asks for the user's money (BRD 2.2.7, 2.2.14.9). The dialog
 * shows one at a time; a channel request can also be answered from the channel list.
 */
export type Prompt =
  | { kind: 'approve-open'; request: OpenRequest }
  | { kind: 'confirm-payment'; channelId: string; token: bigint; amount: bigint };

export interface Asked<P extends Prompt = Prompt> {
  id: string; // 'prompt-0', 'prompt-1', ... per Prompts instance
  prompt: P;
  deadline: number | null; // epoch ms when an unanswered question counts as "no"; null = no limit
  hidden: boolean; // the user closed its dialog to answer later from the channel list (requests only)
  joining: boolean; // an accepted channel request, until its channel is saved
}
type Pending = Asked & { resolve: (answer: boolean) => void };

type Request = Asked<{ kind: 'approve-open'; request: OpenRequest }>;
const isRequest = <T extends Asked>(a: T): a is T & Request => a.prompt.kind === 'approve-open';

export class Prompts {
  private queue: Pending[] = [];
  private readonly ended = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private next = 0;

  /** Asks the user; the promise resolves with the answer (false when the deadline passes unanswered). */
  ask(prompt: Prompt, timeoutMs?: number): Promise<boolean> {
    return new Promise((resolve) => {
      const id = `prompt-${this.next++}`;
      this.queue = [...this.queue, { id, prompt, deadline: timeoutMs ? Date.now() + timeoutMs : null, hidden: false, joining: false, resolve }];
      this.emit();
      if (timeoutMs) setTimeout(() => this.expire(id), timeoutMs);
    });
  }

  /** The question the dialog shows: the oldest one neither put aside nor joining. */
  current(): Asked | null {
    return this.queue.find((p) => !p.hidden && !p.joining) ?? null;
  }

  /** Every channel request (waiting, put aside or joining), for the channel list. */
  requests(): Request[] {
    return this.queue.filter(isRequest);
  }

  /** Whether that channel's request ended without a channel (declined or not answered in time). */
  hasEnded(channelId: string): boolean {
    return this.ended.has(channelId);
  }

  answer(id: string, answer: boolean): void {
    const pending = this.queue.find((p) => p.id === id);
    if (!pending || pending.joining) return;
    pending.resolve(answer);
    if (answer && pending.prompt.kind === 'approve-open') {
      this.queue = this.queue.map((p) => (p.id === id ? { ...p, joining: true } : p));
    } else {
      this.remove(pending, answer);
    }
    this.emit();
  }

  /** Closes a channel request's dialog; the request stays answerable from the channel list. */
  hide(id: string): void {
    this.queue = this.queue.map((p) => (p.id === id && p.prompt.kind === 'approve-open' ? { ...p, hidden: true } : p));
    this.emit();
  }

  /** The channel of an accepted request was saved: it takes the request's place. */
  joined(channelId: string): void {
    this.queue = this.queue.filter((p) => !(p.prompt.kind === 'approve-open' && p.prompt.request.channelId === channelId));
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private expire(id: string): void {
    const pending = this.queue.find((p) => p.id === id);
    if (!pending) return;
    if (!pending.joining) pending.resolve(false);
    this.queue = this.queue.filter((p) => p.id !== id);
    // An accepted request that never joined is dropped without being marked ended.
    if (!pending.joining && pending.prompt.kind === 'approve-open') this.ended.add(pending.prompt.request.channelId);
    this.emit();
  }

  private remove(pending: Pending, accepted: boolean): void {
    this.queue = this.queue.filter((p) => p.id !== pending.id);
    if (!accepted && pending.prompt.kind === 'approve-open') this.ended.add(pending.prompt.request.channelId);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
