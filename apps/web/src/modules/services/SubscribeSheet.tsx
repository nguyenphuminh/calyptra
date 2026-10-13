import { offerTokenOf, quotedFee, type MerchantCard } from '@calyptra/framework';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../../app/context.ts';
import { formatDollars, formatDollarsExact, parseAmount, toDecimal } from '../../shared/amounts.ts';
import { confirmWithPasskey, isPasskeyCancelled, passkeyErrorText } from '../../shared/passkey.ts';
import { AmountField, Button, closeTo, ErrorNote, Modal, Notice, PROVING_TEXT, useAction, useLoad } from '../../shared/ui.tsx';
import { cardOf, rememberMerchant } from './merchants.ts';

/** Allowance presets of the subscribe sheet: $1, $5, $20. */
const ALLOWANCE_PRESETS = [1_000_000n, 5_000_000n, 20_000_000n];

/** A merchant's price per second, minute and hour (each card shows all three). */
export function priceText(card: MerchantCard): string {
  const rate = card.offer.ratePerSecond;
  return `${formatDollarsExact(rate)} / second · ${formatDollarsExact(rate * 60n)} / minute · ${formatDollarsExact(rate * 3600n)} / hour`;
}

/** Subscribe: choose an allowance once, confirm with the passkey, then the funding is proved and relayed. */
export function SubscribeSheet({ code }: { code: string }) {
  const { calyptra, refresh } = useApp();
  const card = cardOf(code);
  const valid = card !== null;
  useEffect(() => {
    // An opened merchant link keeps its merchant in the Services list.
    if (valid) void rememberMerchant(calyptra, code).then(refresh, () => undefined);
  }, [calyptra, code, valid, refresh]);
  if (!card) {
    return (
      <Modal title="Subscribe" onClose={closeTo('#/services')}>
        <ErrorNote error="This is not a valid Calyptra service link." />
      </Modal>
    );
  }
  return <Subscribe card={card} />;
}

function Subscribe({ card }: { card: MerchantCard }) {
  const { calyptra, refresh } = useApp();
  const network = calyptra.network();
  const token = offerTokenOf(card.offer, network);
  const presets = ALLOWANCE_PRESETS.filter((p) => p >= card.offer.minFunding);
  const [amount, setAmount] = useState(toDecimal('stablecoin', presets[1] ?? presets[0] ?? card.offer.minFunding));
  const [stage, setStage] = useState<'idle' | 'reaching' | 'proving'>('idle');
  const allowance = parseAmount('stablecoin', amount);
  const shielded = calyptra.pool.balances().get(token) ?? 0n;
  const fee = useLoad(async () => quotedFee(await calyptra.relayer().info(), token), card.invite);
  const tooSmall = allowance !== null && allowance < card.offer.minFunding;
  const short = allowance !== null && fee.data !== null && shielded < allowance + fee.data;
  const method = useLoad(() => calyptra.wallet.unlockMethod(), 'method');

  const subscribe = useAction(useCallback(async () => {
    if (allowance === null) return;
    if (method.data === 'passkey') {
      try {
        await confirmWithPasskey(); // the one confirmation of a subscription
      } catch (err) {
        if (isPasskeyCancelled(err)) return;
        throw new Error(passkeyErrorText(err), { cause: err });
      }
    }
    setStage('reaching');
    try {
      const entry = await calyptra.subscriptions.subscribe(card, allowance, calyptra.relayer(), { onAccepted: () => setStage('proving') });
      refresh();
      location.hash = `#/services/${entry.channelId}`;
    } finally {
      setStage('idle');
    }
  }, [calyptra, card, allowance, method.data, refresh]));

  const busyText = stage === 'proving' ? PROVING_TEXT : `Reaching ${card.name}…`;
  return (
    <Modal title="Subscribe" onClose={closeTo('#/services')}>
      <div className="stack">
        <div>
          <h3 className="service-name">{card.name}</h3>
          <p className="muted small">{card.offer.title}</p>
        </div>
        <p className="price">{priceText(card)}</p>
      </div>
      <span className="presets" aria-label="Allowances">
        {presets.map((p) => {
          const text = toDecimal('stablecoin', p);
          return <button key={text} type="button" className={amount === text ? 'chip on' : 'chip'} onClick={() => setAmount(text)}>{formatDollars(p)}</button>;
        })}
      </span>
      <AmountField label="Allowance" token="stablecoin" value={amount} onChange={setAmount} />
      {allowance !== null ? (
        <p className="review">{formatDollarsExact(card.offer.ratePerSecond)}/s · up to {formatDollars(allowance)} · stop anytime</p>
      ) : null}
      <Notice>
        You pay only for the seconds you use; what is left of the allowance comes back to your private balance when you end the
        subscription.{fee.data !== null ? ` Starting and ending it each cost a network fee of ${formatDollars(fee.data)}.` : ''}
      </Notice>
      {tooSmall ? <ErrorNote error={`The smallest allowance for this service is ${formatDollars(card.offer.minFunding)}.`} /> : null}
      {short && fee.data !== null ? (
        <Notice tone="warn">
          Your private balance has {formatDollars(shielded)}, less than this allowance plus the network fee of {formatDollars(fee.data)}.{' '}
          <a href="#/deposit">Add money</a> first.
        </Notice>
      ) : null}
      <ErrorNote error={fee.error ?? subscribe.error} />
      <Button className="primary wide" busy={subscribe.busy} busyText={busyText} disabled={allowance === null || tooSmall || short || fee.data === null}
        onClick={() => void subscribe.perform()}>
        Subscribe
      </Button>
    </Modal>
  );
}
