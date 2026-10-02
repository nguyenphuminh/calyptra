// §11.10 gate for per-second subscriptions (§11.5, F17): subscribe and chat against the echo merchant the
// global setup runs (a framework node with EchoServicePort, listed in the dev network's `merchants`).
// The subscriber is a passkey wallet, so the Subscribe sheet's one passkey confirmation is covered too.
import type { Locator, Page } from '@playwright/test';
import { formatUnits } from 'viem';
import {
  addMoney, card, confirmRelayed, createPasskeyWallet, expect, fundPublicly, openTabs, openWallet, popup, test, useDevNetwork,
  virtualAuthenticator,
} from './helpers.ts';

test.use({ baseURL: 'http://localhost:5199' });

const RATE = 2_000n; // $0.002 per second (the echo merchant's offer)

/** Seconds on the session meter ("00:12 · $0.02 paid · $4.96 left"). */
async function meterSeconds(meter: Locator): Promise<number> {
  const [mm = '0', ss = '0'] = ((await meter.textContent()) ?? '').split(' · ')[0]?.split(':') ?? [];
  return Number(mm) * 60 + Number(ss);
}

/** The text of the service's newest reply. */
const lastReply = (session: Locator): Locator => session.locator('.bubble.in .chat-text').last();

async function send(session: Locator, text: string): Promise<void> {
  await session.getByRole('textbox', { name: 'Message' }).fill(text);
  await session.getByRole('button', { name: 'Send message' }).click();
}

const openServices = (page: Page) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Services' }).click();

test('subscription: subscribe once, the meter runs while chatting, pause stops the replies, resume, end settles', async ({ page }) => {
  const passkey = await virtualAuthenticator(page);
  await createPasskeyWallet(page, 'Sam');
  await useDevNetwork(page);
  await fundPublicly(page, '1', '10');
  await addMoney(page, 'stablecoin', '10');
  await expect(page.getByTestId('shielded-stablecoin')).toHaveText('$10.00');

  await openServices(page);
  const service = page.getByRole('listitem', { name: 'Echo chat' });
  await expect(service).toContainText('$0.002 / second · $0.12 / minute · $7.20 / hour');
  await service.getByRole('link', { name: 'Subscribe' }).click();
  const sheet = popup(page, 'Subscribe');
  for (const preset of ['$1.00', '$5.00', '$20.00']) await expect(sheet.getByRole('button', { name: preset })).toBeVisible();
  await expect(sheet.getByLabel('Allowance ($)')).toHaveValue('5');
  await expect(sheet).toContainText('$0.002/s · up to $5.00 · stop anytime');
  const prompts = passkey.count.asserted;
  await sheet.getByRole('button', { name: 'Subscribe', exact: true }).click();
  await expect(sheet).toBeHidden({ timeout: 120_000 });
  expect(passkey.count.asserted - prompts).toBe(1); // confirmed once with the passkey
  await expect(page).toHaveURL(/#\/services\/[0-9a-f]{32}$/);

  const session = page.getByTestId('subscription-session');
  const meter = page.getByTestId('session-meter');
  const status = session.locator('.conversation-head .pill');
  await expect(session.getByRole('button', { name: 'Start', exact: true })).toBeVisible({ timeout: 120_000 }); // live once both sides see the funding
  await expect(meter).toHaveText('00:00 · $0.00 paid · $4.99 left'); // the fee to settle is set aside from the allowance
  await expect(page.getByTestId('subscription-item')).toHaveCount(1);

  await session.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(status).toHaveText('Active');
  await expect.poll(() => meterSeconds(meter), { timeout: 30_000 }).toBeGreaterThanOrEqual(3); // the live meter moves
  await send(session, 'hello there');
  await expect(lastReply(session)).toHaveText('hello there');

  // A long reply (the echo service sends a word every 50 ms): pausing stops it, resuming finishes it.
  const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
  await send(session, long);
  await expect(lastReply(session)).toContainText('word5 ');
  await session.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(status).toHaveText('Paused');
  await expect(session.getByRole('textbox', { name: 'Message' })).toBeDisabled();
  await page.waitForTimeout(1_000); // words already on their way arrive
  const pausedReply = await lastReply(session).textContent();
  const pausedAt = await meterSeconds(meter);
  await page.waitForTimeout(3_000);
  await expect(lastReply(session)).toHaveText(pausedReply ?? '');
  expect(pausedReply).not.toBe(long);
  expect(await meterSeconds(meter)).toBe(pausedAt); // nothing paid while paused

  await session.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(status).toHaveText('Active');
  await expect(lastReply(session)).toHaveText(long, { timeout: 60_000 });

  await session.getByRole('button', { name: 'End', exact: true }).click();
  await confirmRelayed(page, 'End', '$0.01');
  await expect(status).toHaveText('Ended', { timeout: 120_000 });
  await expect(session).toContainText('This subscription has ended.');
  await page.waitForTimeout(1_500); // the meter shows the final figures
  const paid = BigInt(await meterSeconds(meter)) * RATE;
  expect(paid).toBeGreaterThan(0n);

  // $10 - $0.01 to start it - $5 allowance + what was left of it ($4.99 - paid) comes back.
  await openWallet(page);
  await expect(page.getByTestId('shielded-stablecoin')).toHaveAttribute('title', `${formatUnits(9_980_000n - paid, 6)} AUSD`, { timeout: 120_000 });
  const activity = card(page, 'Recent activity');
  await expect(activity.getByRole('listitem')).toHaveCount(1); // one row per subscription, never one per payment
  await expect(activity.getByRole('listitem')).toContainText('Echo chat');
  await openTabs(page);
  await expect(page.getByText('No tabs yet.')).toBeVisible(); // subscriptions live under Services, not Tabs
});
