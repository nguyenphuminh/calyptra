import { decodeInvite, inviteLink, quotedFee, shieldedAddressOf, type RelayerPort } from '@calyptra/framework';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../../app/context.ts';
import { DEFAULT_TOKEN, DISPLAY_SYMBOL, formatMoney, parseAmount, tokenId, tokenName, type TokenName } from '../../shared/amounts.ts';
import { Avatar, BackIcon, SendIcon } from '../../shared/icons.tsx';
import { AmountField, Button, closeTo, Copy, ErrorNote, Field, Modal, Money, Notice, Qr, RelayedSubmit, useAction } from '../../shared/ui.tsx';
import { TokenSelect } from '../public/index.ts';
import { MAX_NICKNAME, setNickname } from './nicknames.ts';
import type { PendingOpen } from './pendingOpens.ts';
import { PENDING_CLASS, PENDING_TEXT, peerName } from './status.ts';

/** One row of the tab list: a tab, a request or an open in progress. */
export function ChannelItem({ id, on, peerId, names, amount, line, status, statusText }: {
  id: string; on: boolean; peerId: string; names: Record<string, string>; amount: ReactNode; line: string; status: string; statusText: string;
}) {
  return (
    <li>
      <a className={on ? 'channel-item on' : 'channel-item'} href={`#/channels/${id}`} data-testid="channel-item">
        <Avatar seed={peerId} />
        <span className="channel-item-main">
          <span className="channel-item-top"><strong className="truncate">{peerName(peerId, names)}</strong><span className="muted small">{amount}</span></span>
          <span className="channel-item-bottom"><span className="muted small truncate">{line}</span><span className={`pill tiny ${status}`}>{statusText}</span></span>
        </span>
      </a>
    </li>
  );
}

/** Whether the text decodes as an invite. */
const isInvite = (text: string): boolean => {
  try {
    decodeInvite(text);
    return true;
  } catch {
    return false;
  }
};

/** Create and share an invite: a link or QR code that lets one person reach this wallet through a relay. */
export function InviteDialog() {
  const { calyptra } = useApp();
  const [link, setLink] = useState<string | null>(null);
  const create = useAction(useCallback(async () => {
    const shielded = shieldedAddressOf(await calyptra.keys.poolKeys());
    await calyptra.p2p.waitForRelay();
    setLink(inviteLink(location.origin, calyptra.p2p.invite(shielded)));
  }, [calyptra]));
  const run = useRef(create.perform);
  useEffect(() => { void run.current(); }, []);
  return (
    <Modal title="Invite someone" onClose={closeTo('#/channels')}>
      <p className="muted">Share your invite privately. It lets one person start a tab with you, and it never reveals where you are.</p>
      {link ? (
        <div className="invite">
          <Qr text={link} label="Invite QR code" />
          <p className="mono break invite-link" data-testid="invite-link">{link}</p>
          <Copy text={link} label="Copy invite link" />
        </div>
      ) : create.error ? (
        <>
          <ErrorNote error={create.error} />
          <Button className="secondary wide" busy={create.busy} onClick={() => void create.perform()}>Try again</Button>
        </>
      ) : (
        <p className="waiting" aria-busy="true"><span className="spinner" aria-hidden="true" />Getting your invite ready…</p>
      )}
    </Modal>
  );
}

/** Start a tab with someone's invite (BRD 2.2.7, 2.2.14.8): checked here, then opened in the background. */
export function OpenDialog({ initialInvite }: { initialInvite: string }) {
  const { calyptra, pendingOpens } = useApp();
  const network = calyptra.network();
  const [invite, setInvite] = useState(initialInvite.trim());
  const [nickname, setName] = useState('');
  const [token, setToken] = useState<TokenName>(DEFAULT_TOKEN);
  const [amount, setAmount] = useState('');
  const [askText, setAsk] = useState('');
  const parsed = parseAmount(token, amount);
  const ask = askText.trim() === '' ? 0n : parseAmount(token, askText);
  const pendingId = useRef<string | null>(null);
  const symbol = DISPLAY_SYMBOL[token];

  const run = async (relayer: RelayerPort): Promise<void> => {
    const target = decodeInvite(invite);
    const terms = { token: tokenId(token, network), amount: parsed ?? 0n, peerAmount: ask ?? 0n };
    const fee = quotedFee(await relayer.info(), terms.token);
    await calyptra.pool.sync();
    const shielded = calyptra.pool.balances().get(terms.token) ?? 0n;
    if (shielded < terms.amount + fee) {
      // Shown inside the confirm dialog; the other side never hears of it.
      throw new Error(`Your private balance has ${formatMoney(token, shielded)}. Putting in ${formatMoney(token, terms.amount)} also pays the network fee of ${formatMoney(token, fee)}.`);
    }
    if (nickname.trim()) await setNickname(calyptra, target.peerId, nickname);
    pendingId.current = pendingOpens.start(
      { accountId: calyptra.wallet.activeAccount().id, networkId: network.id, peerId: target.peerId, ...terms },
      (onAccepted) => calyptra.channels.open(target, { ...terms, relayer, onAccepted }),
      (id, channelId) => { if (location.hash === `#/channels/${id}`) location.hash = `#/channels/${channelId}`; },
    );
  };

  return (
    <Modal title="Start a tab" onClose={closeTo('#/channels')}>
      <Field label="Invite link or code">
        <textarea rows={2} spellCheck={false} placeholder="Paste the invite you received" value={invite} onChange={(e) => setInvite(e.target.value.trim())} />
      </Field>
      <Field label="Nickname (optional)" hint="Only you see it. You can change it later.">
        <input value={nickname} placeholder="e.g. Alice" maxLength={MAX_NICKNAME} onChange={(e) => setName(e.target.value)} />
      </Field>
      <TokenSelect value={token} onChange={setToken} />
      <AmountField label="You put in" token={token} value={amount} onChange={setAmount} />
      <Field label={`Ask them to put in (${symbol}, optional)`}>
        <input inputMode="decimal" placeholder="0" value={askText} onChange={(e) => setAsk(e.target.value)} />
      </Field>
      <Notice>The fee to settle the tab later is set aside from your side when it starts.</Notice>
      <details className="notes">
        <summary>Details</summary>
        <p className="muted small">
          Dispute window: 7 days. If either of you ever has to settle without the other, the tab settles only after this waiting
          period. The fee to settle is today&apos;s network fee.
        </p>
      </details>
      <RelayedSubmit label="Start a tab" token={token} tokenId={tokenId(token, network)} relayer={() => calyptra.relayer()}
        disabled={!isInvite(invite) || parsed === null || ask === null}
        details={<>Put <strong>{amount} {symbol}</strong> into a tab{ask ? `, asking the other side for ${askText} ${symbol}` : ''}.</>}
        run={run}
        onDone={() => { if (pendingId.current) location.hash = `#/channels/${pendingId.current}`; }} />
    </Modal>
  );
}

/** An outgoing open waiting for the other side, laid out like its future tab. */
export function PendingConversation({ open, names }: { open: PendingOpen; names: Record<string, string> }) {
  const { pendingOpens } = useApp();
  const token = tokenName(open.token);
  const name = peerName(open.peerId, names);
  const asking = open.peerAmount > 0n;
  return (
    <section className="conversation" aria-label="Channel" data-testid="pending-open">
      <header className="conversation-head">
        <a className="icon-button only-narrow" href="#/channels" aria-label="Back to tabs"><BackIcon /></a>
        <Avatar seed={open.peerId} size={40} />
        <div className="conversation-title">
          <div className="conversation-name"><h2 className="peer-name truncate">{name}</h2></div>
          <span className="muted small">You are starting it</span>
        </div>
        <span className={`pill tiny ${PENDING_CLASS[open.state]}`}>{PENDING_TEXT[open.state]}</span>
      </header>
      <div className="channel-strip">
        <dl className="balance-strip">
          <div><dt>You put in</dt><dd><Money token={token} value={open.amount} /></dd></div>
          {asking ? <div><dt>You asked them for</dt><dd><Money token={token} value={open.peerAmount} /></dd></div> : null}
        </dl>
        {open.state !== 'waiting' ? (
          <div className="channel-actions">
            <Button className="secondary small" onClick={() => { pendingOpens.dismiss(open.id); location.hash = '#/channels'; }}>Dismiss</Button>
          </div>
        ) : null}
      </div>
      <ol className="timeline">
        <li className="event">{asking ? `You asked ${name} to start a tab` : `You are starting a tab with ${name}`}</li>
        {open.state === 'waiting' ? (
          <li className="event" aria-busy="true"><span className="spinner" aria-hidden="true" />{asking ? `Waiting for ${name} to accept` : `Reaching ${name}…`}</li>
        ) : (
          <>
            <li className="event">{open.state === 'declined' ? `${name} declined, or did not answer in time` : `The tab was not started: ${open.error ?? ''}`}</li>
            <li className="event">Nothing left your private balance.</li>
          </>
        )}
      </ol>
      <div className="composer">
        <div className="composer-field"><input aria-label="Pay" disabled placeholder="Payments open once the tab is live" /></div>
        <button type="button" className="primary round" aria-label="Pay" disabled><SendIcon /></button>
      </div>
    </section>
  );
}
