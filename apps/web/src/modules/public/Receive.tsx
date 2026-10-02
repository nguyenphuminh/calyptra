import { shieldedAddressOf } from '@calyptra/framework';
import { useApp } from '../../app/context.ts';
import { PUBLIC_ADDRESS_TEXT, SHIELDED_ADDRESS_TEXT } from '../../shared/addresses.ts';
import { closeTo, Copy, Modal, Notice, Qr, useLoad } from '../../shared/ui.tsx';

/** A link that opens Calyptra's Send dialog with this Calyptra ID filled in (§11.7: an ID shared as a link or QR code). */
export const paymentLink = (calyptraId: string): string => `${location.origin}/#/send/${calyptraId}`;

/** Receive: the Calyptra ID for private payments, and the account address for adding money. */
export function Receive() {
  const { calyptra } = useApp();
  const account = calyptra.wallet.activeAccount();
  const { data: calyptraId } = useLoad(async () => shieldedAddressOf(await calyptra.keys.poolKeys()), account.id);
  return (
    <Modal title="Receive" wide onClose={closeTo('#/wallet')}>
      <div className="receive">
        <section className="receive-part" aria-label="Private payments">
          <h3>Private payments</h3>
          <Notice>{SHIELDED_ADDRESS_TEXT}</Notice>
          {calyptraId ? (
            <>
              <Qr text={paymentLink(calyptraId)} label="Calyptra ID QR code" />
              <p className="mono break">{calyptraId}</p>
              <div className="row">
                <Copy text={calyptraId} label="Copy Calyptra ID" />
                <Copy text={paymentLink(calyptraId)} label="Copy payment link" />
              </div>
            </>
          ) : <p className="muted">…</p>}
        </section>
        <section className="receive-part public" aria-label="Account address">
          <h3>Account address</h3>
          <Notice>{PUBLIC_ADDRESS_TEXT}</Notice>
          <Qr text={account.address} label="Address QR code" />
          <p className="mono break">{account.address}</p>
          <Copy text={account.address} label="Copy address" />
        </section>
      </div>
    </Modal>
  );
}
