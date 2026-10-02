import { useApp } from '../../app/context.ts';
import { PUBLIC_ADDRESS_TEXT, shortAddress } from '../../shared/addresses.ts';
import { formatAmount, formatBalance, formatDollars, tokenId } from '../../shared/amounts.ts';
import { EyeIcon } from '../../shared/icons.tsx';
import { Copy, ErrorNote, useLoad } from '../../shared/ui.tsx';

/**
 * The account balance (the account's public funds, BRD 2.2.14.4), laid out like the private balance but
 * quieter. Dollars first; the MON shown here pays the network fees of adding money (§11.6).
 */
export function PublicCard() {
  const { calyptra, version } = useApp();
  const account = calyptra.wallet.activeAccount();
  const network = calyptra.network();
  const { data, error } = useLoad(async () => ({
    native: await calyptra.chain.publicBalance(account.address, 0n),
    stablecoin: await calyptra.chain.publicBalance(account.address, tokenId('stablecoin', network)),
  }), `${version}/${account.id}/${network.id}`);
  return (
    <section className="hero-card public" aria-label="Account balance">
      <div className="hero-card-top">
        <span className="eyebrow"><EyeIcon />Account balance · visible to everyone</span>
      </div>
      <div className="big-amounts">
        <span className="big" data-testid="public-stablecoin" title={data ? formatAmount('stablecoin', data.stablecoin) : undefined}>
          {data ? formatDollars(data.stablecoin) : '…'}
        </span>
        <span className="medium">
          <span data-testid="public-native" title={data ? formatAmount('native', data.native) : undefined}>{data ? formatBalance('native', data.native) : '…'}</span>
          <span className="money-note"> for network fees</span>
        </span>
      </div>
      <ErrorNote error={error} />
      <div className="hero-details">
        <div className="detail-row">
          <div className="row-main">
            <span className="detail-label">Account address</span>
            <span className="address mono" title={account.address} data-testid="public-address">{shortAddress(account.address)}</span>
          </div>
          <Copy text={account.address} label="Copy address" className="ghost small" />
        </div>
        <p className="hero-note">{PUBLIC_ADDRESS_TEXT}</p>
      </div>
    </section>
  );
}
