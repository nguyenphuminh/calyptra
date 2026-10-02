import type { OpenRequest } from '@calyptra/framework';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prompts, type Prompt } from './prompts.ts';

const request = (channelId = 'c1'): OpenRequest => ({ channelId, peerId: 'peer', token: 0n, amount: 3n, peerAmount: 2n, window: 604_800n, closingFee: 1n });
const payment: Prompt = { kind: 'confirm-payment', channelId: 'c', token: 0n, amount: 1n };

describe('Prompts', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows the oldest question first, and each answer goes to its own question', async () => {
    const prompts = new Prompts();
    const paid = prompts.ask(payment);
    const approved = prompts.ask({ kind: 'approve-open', request: request() }, 50_000);
    const first = prompts.current();
    expect(first?.prompt.kind).toBe('confirm-payment');
    const listed = prompts.requests()[0];
    if (!listed || !first) throw new Error('missing prompt');
    prompts.answer(listed.id, false);
    expect(await approved).toBe(false);
    expect(prompts.current()?.id).toBe(first.id);
    prompts.answer(first.id, true);
    expect(await paid).toBe(true);
    expect(prompts.current()).toBeNull();
  });

  it('keeps a request whose dialog was closed in the list', async () => {
    const prompts = new Prompts();
    const answer = prompts.ask({ kind: 'approve-open', request: request() }, 50_000);
    const asked = prompts.current();
    if (!asked) throw new Error('missing prompt');
    expect(asked.deadline).toBe(Date.now() + 50_000);
    prompts.hide(asked.id);
    expect(prompts.current()).toBeNull();
    expect(prompts.requests()).toMatchObject([{ hidden: true, joining: false }]);
    vi.advanceTimersByTime(30_000);
    prompts.answer(asked.id, true);
    expect(await answer).toBe(true);
  });

  it('holds an accepted request until its channel is saved', () => {
    const prompts = new Prompts();
    void prompts.ask({ kind: 'approve-open', request: request() }, 50_000);
    const asked = prompts.current();
    if (!asked) throw new Error('missing prompt');
    prompts.answer(asked.id, true);
    expect(prompts.requests()).toMatchObject([{ joining: true }]);
    expect(prompts.current()).toBeNull();
    prompts.answer(asked.id, false);
    expect(prompts.requests()).toHaveLength(1);
    prompts.joined('c1');
    expect(prompts.requests()).toHaveLength(0);
    expect(prompts.hasEnded('c1')).toBe(false);
  });

  it('declines a request nobody answers at its deadline', async () => {
    const prompts = new Prompts();
    const listener = vi.fn();
    prompts.subscribe(listener);
    const answer = prompts.ask({ kind: 'approve-open', request: request() }, 50_000);
    const asked = prompts.current();
    if (!asked) throw new Error('missing prompt');
    prompts.hide(asked.id);
    vi.advanceTimersByTime(50_000);
    expect(await answer).toBe(false);
    expect(prompts.requests()).toHaveLength(0);
    expect(prompts.hasEnded('c1')).toBe(true);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('remembers a declined request as ended, and drops an accepted one that never joined', () => {
    const prompts = new Prompts();
    void prompts.ask({ kind: 'approve-open', request: request('c1') }, 50_000);
    void prompts.ask({ kind: 'approve-open', request: request('c2') }, 50_000);
    const [first, second] = prompts.requests();
    if (!first || !second) throw new Error('missing prompts');
    prompts.answer(first.id, false);
    expect(prompts.hasEnded('c1')).toBe(true);
    prompts.answer(second.id, true);
    vi.advanceTimersByTime(50_000);
    expect(prompts.requests()).toHaveLength(0);
    expect(prompts.hasEnded('c2')).toBe(false);
  });

  it('never puts a payment confirmation aside', () => {
    const prompts = new Prompts();
    void prompts.ask(payment);
    const asked = prompts.current();
    if (!asked) throw new Error('missing prompt');
    prompts.hide(asked.id);
    expect(prompts.current()?.id).toBe(asked.id);
    expect(prompts.requests()).toHaveLength(0);
  });
});
