import { balanceOf, sideOf, signedStates, type ChannelRecord, type ChannelStatus } from '@calyptra/framework';

type State = ReturnType<typeof signedStates>[number]; // {contribs:[c0,c1], balA, balB, payoutA, payoutB, closingFee, nonce, final}
type Side = 0 | 1;

export type TimelineEntry =
  | { kind: 'event'; text: string }
  | { kind: 'payment'; outgoing: boolean; amount: bigint; pending?: boolean }
  | { kind: 'final'; mine: bigint; theirs: bigint };

export interface TimelineInput {
  me: Side;
  opener: 'me' | 'them';
  myContribution: bigint;
  theirContribution: bigint; // computed but not used by entriesFrom
  states: readonly State[]; // every state signed by both sides, oldest first
  pending: State | null; // this side's proposal still waiting for the other side's signature
  latest: State;
  status: ChannelStatus;
}

/** The history of a tab as payments in both directions, derived from consecutive signed states. */
export function entriesFrom(t: TimelineInput): TimelineEntry[] {
  const out: TimelineEntry[] = [{ kind: 'event', text: t.opener === 'me' ? 'You started this tab' : 'They started this tab' }];
  for (let i = 1; i < t.states.length; i++) {
    const prev = t.states[i - 1];
    const cur = t.states[i];
    if (!prev || !cur) continue;
    // State 1 only adds the second contribution; it moves nothing between the two sides.
    if (prev.contribs[1] === 0n && cur.contribs[1] !== 0n) continue;
    if (cur.final) {
      out.push({ kind: 'final', mine: balanceOf(cur, t.me), theirs: balanceOf(cur, t.me === 0 ? 1 : 0) });
      continue;
    }
    const delta = balanceOf(cur, t.me) - balanceOf(prev, t.me);
    if (delta > 0n) out.push({ kind: 'payment', outgoing: false, amount: delta });
    else if (delta < 0n) out.push({ kind: 'payment', outgoing: true, amount: -delta });
  }
  if (t.pending && !t.pending.final) {
    const delta = balanceOf(t.latest, t.me) - balanceOf(t.pending, t.me);
    if (delta > 0n) out.push({ kind: 'payment', outgoing: true, amount: delta, pending: true });
  }
  if (t.status === 'opening' || t.status === 'funding') out.push({ kind: 'event', text: 'Setting up the tab' });
  if (t.status === 'disputing') out.push({ kind: 'event', text: 'Settling without the other side' });
  if (t.status === 'closed') out.push({ kind: 'event', text: 'Settled · your share is in your private balance' });
  if (t.status === 'settled') out.push({ kind: 'event', text: 'Settled without the other side · your share is in your private balance' });
  if (t.status === 'cancelled') out.push({ kind: 'event', text: 'Cancelled before it started · nothing left your private balance' });
  return out;
}

export function timelineOf(r: ChannelRecord): TimelineEntry[] {
  const me = sideOf(r);
  const a = r.contribA.amount;
  const b = r.contribB?.amount ?? 0n;
  return entriesFrom({
    me, opener: r.role === 'A' ? 'me' : 'them',
    myContribution: me === 0 ? a : b, theirContribution: me === 0 ? b : a,
    states: signedStates(r), pending: r.pending?.state ?? null, latest: r.latest.state, status: r.status,
  });
}
