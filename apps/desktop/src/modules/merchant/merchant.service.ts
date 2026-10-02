import { encodeInvite, encodeMerchantCard, shieldedAddressOf } from '@calyptra/framework';
import type { Calyptra, Offer } from '@calyptra/framework';

/**
 * Merchant mode of the desktop node (§11.5). The facade sells the offer on every session it starts
 * (CalyptraOptions.merchant); this service hands out the merchant card that subscribers open.
 */
export class MerchantCardService {
  private readonly calyptra: Calyptra;
  private readonly offer: Offer;

  constructor(calyptra: Calyptra, offer: Offer) {
    this.calyptra = calyptra;
    this.offer = offer;
  }

  /** The card code `{ v: 1, name, invite, offer }` of the started session. */
  async getCard(): Promise<string> {
    const p2p = this.calyptra.p2p; // NO_RELAY without a libp2p relay: subscribers could not reach the merchant
    await p2p.waitForRelay(); // the card's invite needs the relay's circuit address
    const invite = encodeInvite(p2p.invite(shieldedAddressOf(await this.calyptra.keys.poolKeys())));
    return encodeMerchantCard({ v: 1, name: this.offer.title, invite, offer: this.offer });
  }
}
