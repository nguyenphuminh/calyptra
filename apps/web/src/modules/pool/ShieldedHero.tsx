import { shieldedAddressOf } from '@calyptra/framework';
import { useCallback } from 'react';
import { useApp } from '../../app/context.ts';
import { SHIELDED_ADDRESS_TEXT, shortAddress } from '../../shared/addresses.ts';
import { formatAmount, formatDollars, tokenId } from '../../shared/amounts.ts';
import { DepositIcon, SendIcon, ServicesIcon, ShieldIcon } from '../../shared/icons.tsx';
import { ActionLink, Button, Copy, ErrorNote, Notice, useAction, useLoad } from '../../shared/ui.tsx';

/**
 * The private balance (the shielded pool balance) as the hero of My wallet: dollars first, three
 * actions (Add money, Send, Services), the Calyptra ID to get paid, and the less common Receive and Cash out.
 */
export function ShieldedHero() {
  const { calyptra, refresh } = useApp();
  const account = calyptra.wallet.activeAccount();
  const network = calyptra.network();
  const balances = calyptra.pool.balances();
  const native = balances.get(0n) ?? 0n;
  const stablecoin = balances.get(tokenId('stablecoin', network)) ?? 0n;
  const { data: calyptraId } = useLoad(async () => shieldedAddressOf(await calyptra.keys.poolKeys()), account.id);
  const sync = useAction(useCallback(async () => {
    await calyptra.pool.sync();
    refresh();
  }, [calyptra, refresh]));
  return (
    <section className="hero-card" aria-label="Private balance">
      <div className="hero-card-top">
        <span className="eyebrow"><ShieldIcon />Private balance</span>
        <Button className="ghost small on-dark" busy={sync.busy} onClick={() => void sync.perform()}>Refresh</Button>
      </div>
      <div className="big-amounts">
        <span className="big" data-testid="shielded-stablecoin" title={formatAmount('stablecoin', stablecoin)}>{formatDollars(stablecoin)}</span>
        {/* Dollars are the hero; MON shows only when the user holds some privately (product-owner decision). */}
        {native > 0n ? (
          <span className="medium"><span data-testid="shielded-native" title={formatAmount('native', native)}>{formatAmount('native', native)}</span></span>
        ) : null}
      </div>
      {network.contracts ? null : <Notice tone="warn">Calyptra is not available on this network yet.</Notice>}
      <ErrorNote error={sync.error} />
      <nav className="actions three" aria-label="Private balance actions">
        <ActionLink href="#/deposit" icon={<DepositIcon />} label="Add money" />
        <ActionLink href="#/send" icon={<SendIcon />} label="Send" />
        <ActionLink href="#/services" icon={<ServicesIcon />} label="Services" />
      </nav>
      <div className="hero-details">
        <div className="detail-row">
          <div className="row-main">
            <span className="detail-label">Calyptra ID</span>
            <span className="address mono" title={calyptraId ?? undefined} data-testid="shielded-address">{calyptraId ? shortAddress(calyptraId) : '…'}</span>
          </div>
          {calyptraId ? <Copy text={calyptraId} label="Copy Calyptra ID" className="ghost small on-dark" /> : null}
        </div>
        <p className="hero-note">{SHIELDED_ADDRESS_TEXT}</p>
        <div className="row hero-links">
          <a className="pill-link on-dark" href="#/receive">Receive</a>
          <a className="pill-link on-dark" href="#/withdraw">Cash out</a>
        </div>
      </div>
    </section>
  );
}
