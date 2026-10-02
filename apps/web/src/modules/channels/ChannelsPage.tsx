import { balanceOf, isAppError, sideOf, type ChannelService } from '@calyptra/framework';
import { useEffect } from 'react';
import { useApp } from '../../app/context.ts';
import { formatMoney, tokenName } from '../../shared/amounts.ts';
import { ChannelsIcon, LinkIcon, PlusIcon } from '../../shared/icons.tsx';
import { Money, Notice, Page } from '../../shared/ui.tsx';
import { subscriptionChannelIds } from '../services/index.ts';
import { Conversation } from './Conversation.tsx';
import { nicknames } from './nicknames.ts';
import { ChannelItem, InviteDialog, OpenDialog, PendingConversation } from './Panels.tsx';
import { RequestConversation } from './requests.tsx';
import { PENDING_CLASS, PENDING_TEXT, STATUS_TEXT } from './status.ts';
import { timelineOf } from './timeline.ts';

export type ChannelsView = { kind: 'none' } | { kind: 'channel'; id: string } | { kind: 'invite' } | { kind: 'open'; invite: string };

/** The newest entry of a tab's history, as one line of the list. */
function lastLine(channels: ChannelService, id: string): string {
  const record = channels.get(id);
  const token = tokenName(record.token);
  const last = timelineOf(record).at(-1);
  if (!last) return '';
  if (last.kind === 'payment') return `${last.outgoing ? 'You paid' : 'You received'} ${formatMoney(token, last.amount)}`;
  if (last.kind === 'final') return 'Final balances agreed';
  return last.text;
}

/** Tabs (channels with people), laid out like a messaging app: the list beside the selected conversation. */
export function ChannelsPage({ view }: { view: ChannelsView }) {
  const { calyptra, prompts, pendingOpens, version } = useApp();

  // An open that already became a channel: its old address leads to the channel.
  const handedOver = view.kind === 'channel' ? pendingOpens.channelFor(view.id) : null;
  useEffect(() => {
    if (handedOver) location.replace(`#/channels/${handedOver}`);
  }, [handedOver]);

  let channels: ChannelService;
  try {
    channels = calyptra.channels;
  } catch (err) {
    if (isAppError(err) && err.code === 'NO_RELAY') {
      return (
        <Page title="Tabs">
          <Notice tone="warn">Tabs need a message relay. Add one in Settings › Advanced for this network.</Notice>
        </Page>
      );
    }
    throw err;
  }

  const names = nicknames(calyptra);
  const subscriptions = subscriptionChannelIds(calyptra);
  const list = channels.list().filter((r) => !subscriptions.has(r.id)).reverse();
  const requests = prompts.requests().slice().reverse();
  const pending = pendingOpens.list(calyptra.wallet.activeAccount().id, calyptra.network().id).slice().reverse();
  const selectedId = view.kind === 'channel' ? view.id : null;
  const record = selectedId ? list.find((r) => r.id === selectedId) : undefined;
  const request = selectedId && !record ? requests.find((r) => r.prompt.request.channelId === selectedId) : undefined;
  const open = selectedId && !record && !request ? pending.find((p) => p.id === selectedId) : undefined;
  const hasFunds = [...calyptra.pool.balances().values()].some((v) => v > 0n);
  const hasOpenChannels = channels.list().some((r) => ['funding', 'live', 'closing', 'disputing'].includes(r.status));
  const empty = list.length === 0 && pending.length === 0 && requests.length === 0;

  return (
    <div className={view.kind === 'channel' ? 'channels has-detail' : 'channels'} data-version={version}>
      <section className="channel-list" aria-label="Your tabs">
        <header className="channel-list-head">
          <h1>Tabs</h1>
          <div className="page-actions">
            <a className="pill-link" href="#/channels/invite"><LinkIcon />Invite</a>
            <a className="pill-link primary" href="#/channels/new"><PlusIcon />Start a tab</a>
          </div>
        </header>
        {hasOpenChannels ? (
          <p className="notice channel-reminder" role="note">
            Open Calyptra at least every few days while you have open tabs or subscriptions. If the other side tries to settle with an
            old balance, your wallet has 7 days to answer, and it can only answer while it is open.
          </p>
        ) : null}
        {empty ? (
          <div className="empty">
            <ChannelsIcon />
            <p>No tabs yet.</p>
            <p className="muted small">
              Share your invite so someone can start a tab with you, or start one with their invite. Paying inside a tab is private
              and costs nothing per payment.
            </p>
            {!hasFunds ? <p className="muted small">To start a tab, first <a href="#/deposit">add money to your private balance</a>.</p> : null}
          </div>
        ) : (
          <ul className="channel-items">
            {requests.map((r) => {
              const req = r.prompt.request;
              return (
                <ChannelItem key={r.id} id={req.channelId} on={selectedId === req.channelId} peerId={req.peerId} names={names}
                  amount={<Money token={tokenName(req.token)} value={req.peerAmount} />}
                  line={r.joining ? 'Joining the tab…' : 'Wants to start a tab with you'} status="status-pending" statusText={r.joining ? 'Joining' : 'Request'} />
              );
            })}
            {pending.map((p) => (
              <ChannelItem key={p.id} id={p.id} on={selectedId === p.id} peerId={p.peerId} names={names}
                amount={<Money token={tokenName(p.token)} value={p.amount} />}
                line={p.state === 'declined' ? 'Declined, or no answer in time' : p.state === 'failed' ? 'Could not start the tab' : p.peerAmount > 0n ? 'Waiting for them to accept' : 'Reaching them…'}
                status={PENDING_CLASS[p.state]} statusText={PENDING_TEXT[p.state]} />
            ))}
            {list.map((r) => (
              <ChannelItem key={r.id} id={r.id} on={selectedId === r.id} peerId={r.peer.peerId} names={names}
                amount={<Money token={tokenName(r.token)} value={balanceOf(r.latest.state, sideOf(r))} />}
                line={lastLine(channels, r.id)} status={`status-${r.status}`} statusText={STATUS_TEXT[r.status]} />
            ))}
          </ul>
        )}
      </section>
      <div className="channel-detail">
        {record ? <Conversation key={record.id} record={record} channels={channels} names={names} />
          : request ? <RequestConversation key={request.id} asked={request} names={names} />
            : open ? <PendingConversation key={open.id} open={open} names={names} />
              : (
                <div className="chat-placeholder">
                  <span className="chat-placeholder-icon"><ChannelsIcon /></span>
                  {view.kind === 'channel' ? (
                    <p className="muted">
                      {prompts.hasEnded(view.id) ? 'This tab request ended: it was declined or not answered in time.' : 'This tab is not in this account on this network.'}
                    </p>
                  ) : (
                    <>
                      <h2>Your tabs</h2>
                      <p className="muted">Pick a tab to see its payments, or start one: paying inside a tab is private.</p>
                      <div className="row">
                        <a className="pill-link primary" href="#/channels/new">Start a tab</a>
                        <a className="pill-link" href="#/channels/invite">Share your invite</a>
                      </div>
                    </>
                  )}
                </div>
              )}
      </div>
      {view.kind === 'invite' ? <InviteDialog /> : null}
      {view.kind === 'open' ? <OpenDialog key={view.invite} initialInvite={view.invite} /> : null}
    </div>
  );
}
