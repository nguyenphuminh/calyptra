import { balanceOf, sideOf, type ChannelRecord, type ChannelService } from '@calyptra/framework';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../app/context.ts';
import { DISPLAY_SYMBOL, formatMoney, parseAmount, tokenName } from '../../shared/amounts.ts';
import { Avatar, BackIcon, EditIcon, SendIcon } from '../../shared/icons.tsx';
import { Button, ErrorNote, Modal, Money, Notice, RelayedSubmit, useAction } from '../../shared/ui.tsx';
import { MAX_NICKNAME, setNickname } from './nicknames.ts';
import { peerName, STATUS_TEXT } from './status.ts';
import { timelineOf } from './timeline.ts';

/** One tab (a channel with a person) shown as a chat: balances, payments both ways, and its actions. */
export function Conversation({ record, channels, names }: { record: ChannelRecord; channels: ChannelService; names: Record<string, string> }) {
  const { calyptra, pendingOpens, refresh } = useApp();
  const { id, status, peer } = record;
  const token = tokenName(record.token);
  const me = sideOf(record);
  const latest = record.latest.state;
  const name = peerName(peer.peerId, names);
  const entries = timelineOf(record);

  const [renaming, setRenaming] = useState(false);
  const [nickname, setNicknameText] = useState('');
  const [amount, setAmount] = useState('');
  const [disputing, setDisputing] = useState(false);

  const pay = useAction(useCallback(async (value: bigint) => {
    await channels.pay(id, value);
    setAmount('');
    refresh();
  }, [channels, id, refresh]));
  const rename = useAction(useCallback(async () => {
    await setNickname(calyptra, peer.peerId, nickname);
    setRenaming(false);
    refresh();
  }, [calyptra, peer.peerId, nickname, refresh]));
  const cancel = useAction(useCallback(async () => {
    await channels.cancel(id);
    refresh();
  }, [channels, id, refresh]));
  const dispute = useAction(useCallback(async () => {
    await calyptra.disputes.start(id, calyptra.relayer());
    setDisputing(false);
    refresh();
  }, [calyptra, id, refresh]));
  const check = useAction(useCallback(async () => {
    await calyptra.tick();
    refresh();
  }, [calyptra, refresh]));

  // The timeline scrolls to the bottom whenever the number of entries changes.
  const timeline = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const list = timeline.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [entries.length]);

  const live = status === 'live';
  const parsed = parseAmount(token, amount);
  const cancellable = status === 'opening' && !pendingOpens.isFunding(id) && channels.canCancel(id);
  const disputable = ['funding', 'live', 'closing'].includes(status) || (status === 'opening' && record.role === 'A' && channels.openerFunded(id));
  const fundingError = status === 'opening' ? pendingOpens.fundingError(id) : null;
  const payLabel = `Pay (${DISPLAY_SYMBOL[token]})`;

  return (
    <section className="conversation" aria-label="Tab" data-testid={`channel-${id}`}>
      <header className="conversation-head">
        <a className="icon-button only-narrow" href="#/channels" aria-label="Back to tabs"><BackIcon /></a>
        <Avatar seed={peer.peerId} size={40} />
        {renaming ? (
          <form className="rename" onSubmit={(e) => { e.preventDefault(); void rename.perform(); }}>
            <input aria-label="Nickname" placeholder="Nickname" maxLength={MAX_NICKNAME} autoFocus value={nickname} onChange={(e) => setNicknameText(e.target.value)} />
            <Button type="submit" className="primary small" busy={rename.busy}>Save</Button>
            <Button className="ghost small" onClick={() => setRenaming(false)}>Cancel</Button>
          </form>
        ) : (
          <div className="conversation-title">
            <div className="conversation-name">
              <h2 className="peer-name truncate">{name}</h2>
              <button type="button" className="icon-button tiny" aria-label={names[peer.peerId] ? 'Rename' : 'Add a nickname'}
                onClick={() => { setNicknameText(names[peer.peerId] ?? ''); setRenaming(true); }}><EditIcon /></button>
            </div>
            <span className="muted small">{record.role === 'A' ? 'You started it' : 'You were invited'}</span>
          </div>
        )}
        <span className={`pill tiny status-${status}`}>{STATUS_TEXT[status]}</span>
      </header>

      <div className="channel-strip">
        <dl className="balance-strip">
          <div><dt>Your balance</dt><dd><Money token={token} value={balanceOf(latest, me)} testId="channel-mine" /></dd></div>
          <div><dt>Their balance</dt><dd><Money token={token} value={balanceOf(latest, me === 0 ? 1 : 0)} testId="channel-theirs" /></dd></div>
          <div><dt>Fee to settle</dt><dd><Money token={token} value={latest.closingFee} /></dd></div>
        </dl>
        <div className="channel-actions">
          {status === 'live' || status === 'closing' ? (
            <RelayedSubmit label="Settle" token={token} tokenId={record.token} relayer={() => calyptra.relayer()} className="secondary small"
              details="Settle the tab with the current balances: each side's share goes to its private balance. The fee to settle becomes today's network fee; any difference comes from your side."
              run={(relayer) => channels.close(id, relayer)} onDone={refresh} />
          ) : null}
          {cancellable ? <Button className="secondary small" busy={cancel.busy} onClick={() => void cancel.perform()}>Cancel this tab</Button> : null}
          {disputable ? <Button className="danger small" onClick={() => { dispute.setError(null); setDisputing(true); }}>Settle without the other side</Button> : null}
          {status === 'disputing' ? <Button className="secondary small" busy={check.busy} onClick={() => void check.perform()}>Check now</Button> : null}
        </div>
      </div>

      <ol className="timeline" ref={timeline}>
        {entries.map((entry, i) => {
          if (entry.kind === 'payment') {
            return (
              <li key={i} className={entry.outgoing ? 'bubble out' : 'bubble in'}>
                <span className="bubble-label">{entry.outgoing ? 'You paid' : 'You received'}</span>
                <strong><Money token={token} value={entry.amount} /></strong>
                {entry.pending ? <span className="bubble-note">Waiting for the other side</span> : null}
              </li>
            );
          }
          if (entry.kind === 'final') {
            return <li key={i} className="event">Final balances agreed · you {formatMoney(token, entry.mine)}, them {formatMoney(token, entry.theirs)}</li>;
          }
          return <li key={i} className="event">{entry.text}</li>;
        })}
      </ol>

      {status === 'disputing' ? (
        <Notice>While your wallet is unlocked, it answers an old balance with your latest one, settles when the waiting period ends and takes back what is yours.</Notice>
      ) : null}
      <ErrorNote error={pay.error ?? dispute.error ?? check.error ?? rename.error ?? cancel.error} />
      {fundingError ? <ErrorNote error={`Starting this tab failed: ${fundingError}`} /> : null}

      <form className="composer" onSubmit={(e) => { e.preventDefault(); if (parsed !== null) void pay.perform(parsed); }}>
        <div className="composer-field">
          <label className="sr-only" htmlFor={`pay-${id}`}>{payLabel}</label>
          <input id={`pay-${id}`} aria-label={payLabel} inputMode="decimal" disabled={!live} value={amount}
            placeholder={live ? `Amount in ${DISPLAY_SYMBOL[token]}` : 'Payments open once the tab is live'} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <Button type="submit" className="primary round" aria-label="Pay" busy={pay.busy} disabled={!live || parsed === null}><SendIcon /></Button>
      </form>

      {disputing ? (
        <Modal title="Settle without the other side">
          <p>This settles the tab with your latest balances, without the other side. Use it only if they stopped answering.</p>
          <details className="notes">
            <summary>Details</summary>
            <p className="muted small">
              It starts a public dispute with your latest state, and it settles only after the 7-day window, so the other side
              has time to answer with a newer balance. Your wallet must be opened during that time.
            </p>
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
