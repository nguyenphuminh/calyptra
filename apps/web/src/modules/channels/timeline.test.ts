import { describe, expect, it } from 'vitest';
import { entriesFrom, type TimelineInput } from './timeline.ts';

type State = TimelineInput['latest'];
let nonce = 0n;
const state = (balA: bigint, balB: bigint, contribB = 50n, final = false): State => ({
  contribs: [5n, contribB], balA, balB, payoutA: 1n, payoutB: 2n, closingFee: 1n, nonce: (nonce += 7n), final,
});

// 99/0 -> 99/50 (state 1 adds the second contribution) -> 89/60 -> 92/57
const history = (): State[] => [state(99n, 0n, 0n), state(99n, 50n), state(89n, 60n), state(92n, 57n)];
const input = (over: Partial<TimelineInput>): TimelineInput => {
  const states = over.states ?? history();
  const latest = states[states.length - 1];
  if (!latest) throw new Error('no states');
  return { me: 0, opener: 'me', myContribution: 99n, theirContribution: 50n, states, pending: null, latest, status: 'live', ...over };
};

describe('timeline', () => {
  it('shows payments from both sides and skips the state that only adds the second contribution', () => {
    expect(entriesFrom(input({}))).toEqual([
      { kind: 'event', text: 'You started this tab' },
      { kind: 'payment', outgoing: true, amount: 10n },
      { kind: 'payment', outgoing: false, amount: 3n },
    ]);
  });

  it('shows the same history from the other side', () => {
    expect(entriesFrom(input({ me: 1, opener: 'them' }))).toEqual([
      { kind: 'event', text: 'They started this tab' },
      { kind: 'payment', outgoing: false, amount: 10n },
      { kind: 'payment', outgoing: true, amount: 3n },
    ]);
  });

  it('marks the final state, a pending payment and a dispute', () => {
    const closed = [state(99n, 0n, 0n), state(99n, 50n), state(89n, 60n, 50n, true)];
    const entries = entriesFrom(input({ states: closed, status: 'closed' }));
    expect(entries).toContainEqual({ kind: 'final', mine: 89n, theirs: 60n });
    expect(entries.at(-1)).toEqual({ kind: 'event', text: 'Settled · your share is in your private balance' });

    const states = [state(99n, 0n, 0n)];
    const latest = states[0];
    if (!latest) throw new Error('no state');
    expect(entriesFrom(input({ states, latest, pending: state(94n, 0n, 0n) }))).toContainEqual({ kind: 'payment', outgoing: true, amount: 5n, pending: true });

    expect(entriesFrom(input({ status: 'disputing' })).at(-1)).toEqual({ kind: 'event', text: 'Settling without the other side' });
  });
});
