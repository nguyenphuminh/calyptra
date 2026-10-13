import { AppError, decodeInvite, MAX_PROMPT_LENGTH, type MerchantMessage, type StopReason, type Subscription } from '@calyptra/framework';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../app/context.ts';
import { formatDollars, tokenName } from '../../shared/amounts.ts';
import { friendlyError } from '../../shared/errors.ts';
import { BackIcon, PauseIcon, PlayIcon, SendIcon } from '../../shared/icons.tsx';
import { Button, ErrorNote, Modal, Notice, RelayedSubmit, useAction } from '../../shared/ui.tsx';
import { clockText, merchantsOf, paidSeconds } from './merchants.ts';

interface Line { id: string; from: 'you' | 'service'; text: string; done: boolean }

/** Why the service stopped, as the session's banner says it. */
function stopBanner(reason: StopReason): string | null {
  if (reason === 'timeout' || reason === 'disconnected') return 'Service unreachable';
  if (reason === 'error') return "Payment didn't go through, the service paused";
  if (reason === 'cap') return 'Your allowance is used up';
  return null;
}

/** One subscription in use: the chat, a live meter, Pause / Resume / End. */
export function Session({ subscription }: { subscription: Subscription }) {
  const { calyptra, refresh } = useApp();
  const subscriptions = calyptra.subscriptions;
  const { channelId } = subscription;
  const record = calyptra.channels.get(channelId);
  const token = tokenName(record.token);
  const [entry, setEntry] = useState(subscription);
  const [active, setActive] = useState(() => subscriptions.isActive(channelId));
  const [banner, setBanner] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [text, setText] = useState('');
  const [disputing, setDisputing] = useState(false);

  // The meter follows the allowance registry, which the ticker updates after every payment.
  useEffect(() => {
    const timer = setInterval(() => {
      setEntry(subscriptions.get(channelId) ?? subscription);
      setActive(subscriptions.isActive(channelId));
    }, 1000);
    return () => clearInterval(timer);
  }, [subscriptions, channelId, subscription]);

  // Leaving the session pauses it: the app pays only while the service is in use.
  useEffect(() => () => { void subscriptions.pause(channelId); }, [subscriptions, channelId]);

  const onMessage = useCallback((message: MerchantMessage) => {
    if (message.type === 'chunk') {
      setLines((all) => (all.some((l) => l.id === message.id && l.from === 'service')
        ? all.map((l) => (l.id === message.id && l.from === 'service' ? { ...l, text: l.text + message.text } : l))
        : [...all, { id: message.id, from: 'service', text: message.text, done: false }]));
    } else if (message.type === 'done') {
      setLines((all) => all.map((l) => (l.id === message.id && l.from === 'service' ? { ...l, done: true } : l)));
    } else if (message.type === 'insufficient') {
      setBanner("Payment didn't go through, the service paused");
    } else {
      setBanner(friendlyError(new AppError(409, message.code, message.message)));
    }
  }, []);
  const onStop = useCallback((reason: StopReason) => {
    setActive(false);
    setBanner(stopBanner(reason));
  }, []);

  const start = useAction(useCallback(async () => {
    setBanner(null);
    await subscriptions.start(channelId, { onMessage, onStop });
    setActive(true);
  }, [subscriptions, channelId, onMessage, onStop]));
  const pause = useAction(useCallback(async () => {
    await subscriptions.pause(channelId);
    setActive(false);
  }, [subscriptions, channelId]));
  const send = useAction(useCallback(async (prompt: string) => {
    const id = await subscriptions.prompt(channelId, prompt);
    setLines((all) => [...all, { id, from: 'you', text: prompt, done: true }]);
    setText('');
  }, [subscriptions, channelId]));
  const dispute = useAction(useCallback(async () => {
    await calyptra.disputes.start(channelId, calyptra.relayer());
    setDisputing(false);
    refresh();
  }, [calyptra, channelId, refresh]));

  const chat = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const list = chat.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [lines]);

  // The same merchant, to subscribe again ("Add more"): the listed merchant whose invite reaches this peer.
  const merchantCode = merchantsOf(calyptra).find((m) => {
    try {
      return decodeInvite(m.card.invite).peerId === record.peer.peerId;
    } catch {
      return false;
    }
  })?.code ?? null;
  const live = record.status === 'live';
  const ended = record.status === 'closed' || record.status === 'settled' || record.status === 'cancelled';
  const left = entry.cap > entry.paid ? entry.cap - entry.paid : 0n;
  const statusText = ended ? 'Ended' : !live ? 'Setting up' : active ? 'Active' : 'Paused';

  return (
    <section className="conversation session" aria-label="Subscription" data-testid="subscription-session">
      <header className="conversation-head">
        <a className="icon-button only-narrow" href="#/services" aria-label="Back to services"><BackIcon /></a>
        <div className="conversation-title">
          <h2 className="truncate">{entry.merchant}</h2>
          <span className="meter" data-testid="session-meter">
            {clockText(paidSeconds(entry))} · {formatDollars(entry.paid)} paid · {formatDollars(left)} left
          </span>
        </div>
        <span className={`pill tiny ${active ? 'status-live' : 'status-pending'}`}>{statusText}</span>
      </header>
      <div className="channel-strip">
        <div className="channel-actions">
          {live && !active ? (
            <Button className="primary small" busy={start.busy} onClick={() => void start.perform()}><PlayIcon />{entry.paid > 0n ? 'Resume' : 'Start'}</Button>
          ) : null}
          {live && active ? <Button className="secondary small" busy={pause.busy} onClick={() => void pause.perform()}><PauseIcon />Pause</Button> : null}
          {live || record.status === 'closing' ? (
            <RelayedSubmit label="End" token={token} tokenId={record.token} relayer={() => calyptra.relayer()} className="ghost small"
              details={<>End the subscription. What is left of the allowance, <strong>{formatDollars(left)}</strong>, goes back to your private balance.</>}
              run={(relayer) => subscriptions.end(channelId, relayer)} onDone={() => { setActive(false); refresh(); }} />
          ) : null}
        </div>
      </div>
      {banner ? <Notice tone="warn">{banner}</Notice> : null}
      {!live && !ended ? <Notice>Setting up your subscription… It starts once your payment is confirmed.</Notice> : null}
      {ended ? <Notice tone="ok">This subscription has ended. What was left of the allowance is back in your private balance.</Notice> : null}
      {left === 0n && live ? (
        <div className="stack session-more">
          <Notice>Your allowance is used up. Add more: this subscription ends, then you start a new one.</Notice>
          <RelayedSubmit label="Add more" token={token} tokenId={record.token} relayer={() => calyptra.relayer()} className="primary small"
            details="End this subscription, then choose a new allowance for the same service."
            run={(relayer) => subscriptions.end(channelId, relayer)}
            onDone={() => { refresh(); location.hash = merchantCode ? `#/merchant/${merchantCode}` : '#/services'; }} />
        </div>
      ) : null}
      <ol className="timeline chat" ref={chat}>
        {lines.length === 0 ? <li className="event">{active ? 'Ask anything. You pay only while the session runs.' : 'Start the session to chat. You pay by the second while it runs.'}</li> : null}
        {lines.map((line) => (
          <li key={`${line.from}-${line.id}`} className={line.from === 'you' ? 'bubble out' : 'bubble in'}>
            <span className="chat-text">{line.text}</span>
            {line.from === 'service' && !line.done ? <span className="bubble-note">…</span> : null}
          </li>
        ))}
      </ol>
      <ErrorNote error={start.error ?? pause.error ?? send.error ?? dispute.error} />
      <form className="composer" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void send.perform(text.trim()); }}>
        <div className="composer-field">
          {/* The service refuses longer prompts, and its refusal stops the session. */}
          <input aria-label="Message" placeholder={active ? 'Message' : 'Start the session to chat'} disabled={!active} maxLength={MAX_PROMPT_LENGTH} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <Button type="submit" className="primary round" aria-label="Send message" busy={send.busy} disabled={!active || text.trim() === ''}><SendIcon /></Button>
      </form>
      {['funding', 'live', 'closing'].includes(record.status) ? (
        <details className="notes session-details">
          <summary>Details</summary>
          <p className="muted small">If the service stops answering, you can settle without it: your share comes back after a 7-day waiting period.</p>
          <Button className="danger small" onClick={() => setDisputing(true)}>Settle without the other side</Button>
        </details>
      ) : null}
      {disputing ? (
        <Modal title="Settle without the other side">
          <p>This settles the subscription with your latest balances, without the service. Use it only if it stopped answering.</p>
          <details className="notes">
            <summary>Details</summary>
            <p className="muted small">It starts a public dispute and settles only after the 7-day window. Your wallet must be opened during that time.</p>
          </details>
          <ErrorNote error={dispute.error} />
          <div className="stack">
            <Button className="danger wide" busy={dispute.busy} onClick={() => void dispute.perform()}>Settle without them</Button>
            <Button className="ghost wide" disabled={dispute.busy} onClick={() => setDisputing(false)}>Cancel</Button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
