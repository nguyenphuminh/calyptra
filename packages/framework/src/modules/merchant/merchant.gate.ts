// Payment-gate math of a merchant (pure): it serves only while paid time keeps up with served time.

/** Whole seconds the merchant's balance in the latest fully signed state pays for. */
export function paidSecondsOf(balance: bigint, ratePerSecond: bigint): bigint {
  return balance / ratePerSecond;
}

/** The merchant generates output only while paidSeconds >= servedSeconds - graceSeconds. */
export function gateOpen(paidSeconds: bigint, servedSeconds: bigint, graceSeconds: number): boolean {
  return paidSeconds >= servedSeconds - BigInt(graceSeconds);
}

/**
 * Active (unpaused) time of one subscription since its first start: runs between `start` and `stop`
 * and keeps the time of earlier runs. `owner` is the session that started it, so a session that
 * ended late cannot stop a newer one.
 */
export class ServedClock {
  private servedMs = 0;
  private since: number | null = null;
  private owner: unknown = null;

  get active(): boolean {
    return this.since !== null;
  }

  start(now: number, owner: unknown): void {
    if (this.since === null) this.since = now;
    this.owner = owner;
  }

  stop(now: number, owner: unknown): void {
    if (this.since === null || this.owner !== owner) return;
    this.servedMs += Math.max(0, now - this.since);
    this.since = null;
  }

  /** Whole served seconds at `now`. */
  seconds(now: number): bigint {
    const running = this.since === null ? 0 : Math.max(0, now - this.since);
    return BigInt(Math.floor((this.servedMs + running) / 1000));
  }
}
