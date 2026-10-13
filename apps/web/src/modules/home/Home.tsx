import { balanceOf, sideOf, type Calyptra, type ChannelRecord } from '@calyptra/framework';
import { useApp } from '../../app/context.ts';
import { formatDollars, formatMoney, tokenName } from '../../shared/amounts.ts';
import { ActivityIcon } from '../../shared/icons.tsx';
import { Card } from '../../shared/ui.tsx';
import { nicknames, peerName, STATUS_TEXT } from '../channels/index.ts';
import { Deposit, SendPrivately, ShieldedHero, Withdraw } from '../pool/index.ts';
import { PublicCard, Receive } from '../public/index.ts';
import { durationText, paidSeconds, subscriptionsOf } from '../services/index.ts';

export type WalletDialog = 'deposit' | 'withdraw' | 'receive' | 'send';

const RECENT = 8;

interface ActivityRow { key: string; href: string; title: string; detail: string; at: number }

/**
 * Recent activity: one row per subscription ("Calyptra AI · 5 min 12 s · $0.62", never one row
 * per payment) and one per tab, newest first.
 */
function activityOf(calyptra: Calyptra): ActivityRow[] {
  let records: ChannelRecord[];
  try {
    records = calyptra.channels.list();
  } catch {
    return []; // no message relay: no tabs or subscriptions on this network
  }
  const subscriptions = new Map(subscriptionsOf(calyptra).map((s) => [s.channelId, s]));
  const names = nicknames(calyptra);
  return records.map((r): ActivityRow => {
    const sub = subscriptions.get(r.id);
    const at = r.createdAt ?? 0;
    if (sub) {
      return { key: r.id, href: `#/services/${r.id}`, title: sub.merchant, detail: `${durationText(paidSeconds(sub))} · ${formatDollars(sub.paid)}`, at };
    }
    const token = tokenName(r.token);
    return {
      key: r.id, href: `#/channels/${r.id}`, title: `Tab with ${peerName(r.peer.peerId, names)}`,
      detail: `${STATUS_TEXT[r.status]} · your balance ${formatMoney(token, balanceOf(r.latest.state, sideOf(r)))}`, at,
    };
  }).sort((a, b) => b.at - a.at).slice(0, RECENT);
}

function Activity() {
  const { calyptra } = useApp();
  const rows = activityOf(calyptra);
  return (
    <Card title="Recent activity">
      {rows.length === 0 ? (
        <div className="empty small-empty">
          <ActivityIcon />
          <p className="muted small">Nothing yet. Add money, then send it, start a tab or subscribe to a service.</p>
        </div>
      ) : (
        <ul className="rows">
          {rows.map((row) => (
            <li key={row.key} className="row-item">
              <a className="activity-link" href={row.href}>
                <span className="row-main"><strong className="truncate">{row.title}</strong><span className="muted small truncate">{row.detail}</span></span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** My wallet, laid out as the consumer home: the private balance first, recent activity, then the account balance. */
export function MyWallet({ dialog, sendTo }: { dialog: WalletDialog | null; sendTo?: string }) {
  const { calyptra, version } = useApp();
  const account = calyptra.wallet.activeAccount();
  return (
    <div className="page" data-version={version}>
      <header className="page-head">
        <div>
          <p className="muted small">{account.label}</p>
          <h1>My wallet</h1>
        </div>
      </header>
      <ShieldedHero />
      <Activity />
      <PublicCard />
      {dialog === 'deposit' ? <Deposit /> : null}
      {dialog === 'withdraw' ? <Withdraw /> : null}
      {dialog === 'receive' ? <Receive /> : null}
      {dialog === 'send' ? <SendPrivately key={sendTo ?? ''} initialTo={sendTo ?? ''} /> : null}
    </div>
  );
}
