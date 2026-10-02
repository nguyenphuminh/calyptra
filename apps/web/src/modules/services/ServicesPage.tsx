import { isAppError, type SubscriptionService } from '@calyptra/framework';
import { useState } from 'react';
import { useApp } from '../../app/context.ts';
import { formatDollars } from '../../shared/amounts.ts';
import { Avatar, ServicesIcon } from '../../shared/icons.tsx';
import { Field, Notice, Page } from '../../shared/ui.tsx';
import { durationText, merchantsOf, paidSeconds } from './merchants.ts';
import { Session } from './Session.tsx';
import { priceText, SubscribeSheet } from './SubscribeSheet.tsx';

export type ServicesView = { kind: 'none' } | { kind: 'session'; id: string } | { kind: 'subscribe'; code: string };

const SUBSCRIPTION_STATUS: Record<string, string> = {
  opening: 'Setting up', funding: 'Setting up', live: 'Active', closing: 'Ending', closed: 'Ended',
  disputing: 'Settling without them', settled: 'Ended', cancelled: 'Cancelled',
};

/** Services paid by the second (§11.5): the merchants to subscribe to, the user's subscriptions, and a session. */
export function ServicesPage({ view }: { view: ServicesView }) {
  const { calyptra, version } = useApp();
  const [link, setLink] = useState('');

  let subscriptions: SubscriptionService;
  try {
    subscriptions = calyptra.subscriptions;
  } catch (err) {
    if (isAppError(err) && err.code === 'NO_RELAY') {
      return (
        <Page title="Services">
          <Notice tone="warn">Services need a message relay. Add one in Settings › Advanced for this network.</Notice>
        </Page>
      );
    }
    throw err;
  }

  const mine = subscriptions.list().slice().reverse();
  const merchants = merchantsOf(calyptra);
  const selected = view.kind === 'session' ? mine.find((s) => s.channelId === view.id) : undefined;
  const statusOf = (channelId: string): string => {
    try {
      return calyptra.channels.get(channelId).status;
    } catch {
      return 'opening';
    }
  };

  return (
    <div className={view.kind === 'session' ? 'channels has-detail' : 'channels'} data-version={version}>
      <section className="channel-list" aria-label="Services">
        <header className="channel-list-head"><h1>Services</h1></header>
        <div className="services-scroll">
          {mine.length > 0 ? (
            <>
              <h2 className="list-title">Your subscriptions</h2>
              <ul className="channel-items">
                {mine.map((s) => {
                  const status = statusOf(s.channelId);
                  return (
                    <li key={s.channelId}>
                      <a className={selected?.channelId === s.channelId ? 'channel-item on' : 'channel-item'} href={`#/services/${s.channelId}`} data-testid="subscription-item">
                        <Avatar seed={s.merchant} />
                        <span className="channel-item-main">
                          <span className="channel-item-top"><strong className="truncate">{s.merchant}</strong><span className="muted small">{formatDollars(s.paid)}</span></span>
                          <span className="channel-item-bottom">
                            <span className="muted small truncate">{durationText(paidSeconds(s))} used</span>
                            <span className={`pill tiny status-${status === 'live' ? 'live' : 'pending'}`}>{SUBSCRIPTION_STATUS[status] ?? status}</span>
                          </span>
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
          <h2 className="list-title">Pay by the second</h2>
          {merchants.length === 0 ? (
            <div className="empty">
              <ServicesIcon />
              <p>No services here yet.</p>
              <p className="muted small">Open a service&apos;s link to subscribe to it.</p>
            </div>
          ) : (
            <ul className="service-cards">
              {merchants.map((m) => (
                <li key={m.code} className="service-card" aria-label={m.card.name}>
                  <div className="row-main">
                    <strong>{m.card.name}</strong>
                    <span className="muted small">{m.card.offer.title}</span>
                  </div>
                  <p className="price small">{priceText(m.card)}</p>
                  <a className="pill-link primary" href={`#/merchant/${m.code}`}>Subscribe</a>
                </li>
              ))}
            </ul>
          )}
          <form className="inline-form service-link" onSubmit={(e) => { e.preventDefault(); const code = link.trim().split('/merchant/').pop(); if (code) location.hash = `#/merchant/${code}`; }}>
            <Field label="Have a service link?">
              <input placeholder="Paste the link" spellCheck={false} value={link} onChange={(e) => setLink(e.target.value)} />
            </Field>
            <button type="submit" className="secondary" disabled={link.trim() === ''}>Open</button>
          </form>
        </div>
      </section>
      <div className="channel-detail">
        {selected ? <Session key={selected.channelId} subscription={selected} /> : (
          <div className="chat-placeholder">
            <span className="chat-placeholder-icon"><ServicesIcon /></span>
            {view.kind === 'session' ? <p className="muted">This subscription is not in this account on this network.</p> : (
              <>
                <h2>Pay by the second</h2>
                <p className="muted">Subscribe once with an allowance, then pay only for the seconds you use. Nobody else can tell who pays whom, or how much.</p>
              </>
            )}
          </div>
        )}
      </div>
      {view.kind === 'subscribe' ? <SubscribeSheet key={view.code} code={view.code} /> : null}
    </div>
  );
}
