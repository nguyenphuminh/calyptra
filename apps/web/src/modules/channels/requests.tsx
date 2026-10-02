import { quotedFee, type OpenRequest } from '@calyptra/framework';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../../app/context.ts';
import type { Asked } from '../../app/prompts.ts';
import { formatMoney, tokenName } from '../../shared/amounts.ts';
import { Avatar, BackIcon } from '../../shared/icons.tsx';
import { Button, ErrorNote, Field, Money, Notice, useAction, useLoad } from '../../shared/ui.tsx';
import { MAX_NICKNAME, setNickname } from './nicknames.ts';
import { peerName } from './status.ts';

/** A channel request waiting for the user's answer (BRD 2.2.7, 2.2.14.9). */
export type ChannelRequest = Asked<{ kind: 'approve-open'; request: OpenRequest }>;

/** What each side puts into the requested tab. */
export function requestTerms(request: OpenRequest): string {
  const token = tokenName(request.token);
  return `They put in ${formatMoney(token, request.amount)} and ask you to put in ${formatMoney(token, request.peerAmount)}`;
}

/** The dispute window in whole days, as the details of a request explain it. */
export const windowDays = (request: OpenRequest): number => Number(request.window) / 86_400;

/** Seconds left before a deadline, re-rendered every second; null without a deadline. */
export function useSecondsLeft(deadline: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  return deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** Details of a request that most users never need: the waiting period of settling without the other side. */
export function RequestDetails({ request }: { request: OpenRequest }) {
  return (
    <details className="notes">
      <summary>Details</summary>
      <p className="muted small">
        Dispute window: {windowDays(request)} days. If either of you ever has to settle without the other, the tab settles only
        after this waiting period, so the other side has time to answer.
      </p>
    </details>
  );
}

/** Accept (with an optional nickname for the peer) or decline a request; used by the dialog and the conversation. */
export function RequestAnswer({ asked }: { asked: ChannelRequest }) {
  const { calyptra, prompts } = useApp();
  const { request } = asked.prompt;
  const token = tokenName(request.token);
  const [nickname, setName] = useState('');
  const shielded = calyptra.pool.balances().get(request.token) ?? 0n;
  // Funding is a relayed transfer of its own, so the relayer fee comes on top of what they ask for.
  const fee = useLoad(async () => quotedFee(await calyptra.relayer().info(), request.token), request.channelId);
  const short = fee.data !== null && shielded < request.peerAmount + fee.data;
  const accept = useAction(useCallback(async () => {
    if (nickname.trim()) await setNickname(calyptra, request.peerId, nickname);
    prompts.answer(asked.id, true);
  }, [calyptra, prompts, asked.id, request.peerId, nickname]));
  return (
    <div className="stack">
      <Field label="Nickname for them (optional)" hint="Only you see it. You can change it later.">
        <input value={nickname} placeholder="e.g. Bob" maxLength={MAX_NICKNAME} onChange={(e) => setName(e.target.value)} />
      </Field>
      {short && fee.data !== null ? (
        <Notice tone="warn">
          Your private balance has {formatMoney(token, shielded)}, less than the {formatMoney(token, request.peerAmount)} they ask you to put in plus
          the network fee of {formatMoney(token, fee.data)}.
        </Notice>
      ) : null}
      <ErrorNote error={fee.error ?? accept.error} />
      <Button className="primary wide" busy={accept.busy} disabled={short || fee.data === null} onClick={() => void accept.perform()}>Accept</Button>
      <Button className="ghost wide" onClick={() => prompts.answer(asked.id, false)}>Decline</Button>
    </div>
  );
}

/** The same request as a conversation, for answering after its dialog was closed. */
export function RequestConversation({ asked, names }: { asked: ChannelRequest; names: Record<string, string> }) {
  const { request } = asked.prompt;
  const token = tokenName(request.token);
  const name = peerName(request.peerId, names);
  const secondsLeft = useSecondsLeft(asked.deadline);
  return (
    <section className="conversation" aria-label="Channel" data-testid="channel-request">
      <header className="conversation-head">
        <a className="icon-button only-narrow" href="#/channels" aria-label="Back to tabs"><BackIcon /></a>
        <Avatar seed={request.peerId} size={40} />
        <div className="conversation-title">
          <div className="conversation-name"><h2 className="peer-name truncate">{name}</h2></div>
          <span className="muted small">Wants to start a tab with you</span>
        </div>
        <span className="pill tiny status-pending">{asked.joining ? 'Joining' : 'Request'}</span>
      </header>
      <div className="channel-strip">
        <dl className="balance-strip">
          <div><dt>They put in</dt><dd><Money token={token} value={request.amount} /></dd></div>
          <div><dt>They ask you for</dt><dd><Money token={token} value={request.peerAmount} /></dd></div>
          <div><dt>Fee to settle</dt><dd><Money token={token} value={request.closingFee} />, paid by them</dd></div>
        </dl>
      </div>
      <ol className="timeline">
        <li className="event">{requestTerms(request)}</li>
        {asked.joining
          ? <li className="event" aria-busy="true"><span className="spinner" aria-hidden="true" />Joining the tab…</li>
          : <li className="event">{secondsLeft} s left to answer</li>}
      </ol>
      {asked.joining ? null : (
        <div className="request-answer">
          <RequestDetails request={request} />
          <RequestAnswer asked={asked} />
        </div>
      )}
    </section>
  );
}
