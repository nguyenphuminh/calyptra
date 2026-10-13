// Consumer UX and PWA: main screens use no crypto jargon, and the app is installable
// from localhost (a manifest and an active service worker that serves the app shell).
import type { Page } from '@playwright/test';
import {
  addMoney, confirmRelayed, createInvite, createWallet, devWallet, expect, fundPublicly, openAction, openSettings,
  openTabs, openWallet, popup, startDialog, tabStatus, tabView, test, unlock, useDevNetwork, type SettingsCategory,
} from './helpers.ts';

/**
 * Words main screens never show. Left out on purpose, because the product's wording keeps them: recovery phrase, private key (import forms), network fee,
 * account address, MON (fees), MetaMask, Settled, message relay (the notice that points to Advanced),
 * and the round-amount "trace" hint. One error state is scanned too (an over-balance Send).
 */
const BANNED: RegExp[] = [
  // never shown
  /\bshield(ed|ing)?\b/i, /\bnullifiers?\b/i, /\bcommitments?\b/i, /\bproofs?\b/i, /\bnotes?\b/i, /\bunspent\b/i,
  // only in Advanced
  /\brelayers?\b/i, /\blibp2p\b/i, /\brpc\b/i, /\bendpoints?\b/i,
  // protocol terms the app renames
  /\bchannels?\b/i, /\bdeposit(s|ed|ing)?\b/i, /\bwithdraw(s|n|al|als|ing)?\b/i, /\bsend privately\b/i, /\bpublic balance\b/i,
  /\bcooperative(ly)?\b/i, /\bdisputes?\b/i,
  // "never mentions a blockchain" and other jargon
  /\bblockchain\b/i, /\bon-?chain\b/i, /\boff-?chain\b/i, /\bchain\b/i, /\bmonad\b/i, /\bzk\b/i, /\bzero[- ]knowledge\b/i, /\bgas\b/i,
  /\btransactions?\b/i, /\bsmart contracts?\b/i, /\bpool\b/i, /\bsync(ing|ed)?\b/i, /\bdeployed\b/i, /\bfund(ed|ing)?\b/i,
  /\bcontributions?\b/i, /\bfinaliz(e|es|ed|ing)\b/i, /\bnonce\b/i, /\btokens?\b/i,
];

/**
 * Banned words in what the page shows now (innerText leaves out closed "Details" disclosures and hidden
 * elements); `where` narrows the scan, e.g. to a settings page without the menu entry of Advanced.
 */
async function jargon(page: Page, screen: string, where = 'body'): Promise<string[]> {
  const text = await page.locator(where).innerText();
  return BANNED.flatMap((word) => {
    const match = word.exec(text);
    if (!match) return [];
    const around = text.slice(Math.max(0, match.index - 40), match.index + 40).replace(/\s+/g, ' ');
    return [`${screen}: "${match[0]}" in "…${around}…"`];
  });
}

test('no crypto jargon on the main screens', async ({ newUser }) => {
  const found: string[] = [];
  const scan = async (page: Page, screen: string, where?: string) => { found.push(...(await jargon(page, screen, where))); };

  const alice = await newUser('alice');
  await alice.goto('/');
  await expect(alice.getByRole('button', { name: 'Continue with passkey' })).toBeVisible();
  await scan(alice, 'Welcome');
  await alice.getByRole('button', { name: 'Continue with passkey' }).click();
  await expect(alice.getByRole('button', { name: 'Create passkey' })).toBeVisible();
  await scan(alice, 'Create your passkey');
  await alice.getByRole('button', { name: '← Back' }).click();
  await alice.getByRole('button', { name: 'Use a recovery phrase instead' }).click();
  await expect(alice.getByRole('button', { name: 'Create a new wallet' })).toBeVisible();
  await scan(alice, 'Use a recovery phrase');
  await createWallet(alice);
  await useDevNetwork(alice);
  await fundPublicly(alice, '1', '10');
  await addMoney(alice, 'stablecoin', '10');
  await expect(alice.getByTestId('shielded-stablecoin')).toHaveText('$10.00');

  // A tab with Bob, and a request from Alice that Bob looks at.
  const bob = await devWallet(newUser, 'bob');
  await openWallet(bob);
  const bobId = (await bob.getByTestId('shielded-address').getAttribute('title')) ?? '';
  await alice.goto(await createInvite(bob));
  await scan(alice, 'Start a tab');
  const start = startDialog(alice);
  await start.getByLabel('Nickname (optional)').fill('Bob');
  await start.getByLabel('You put in ($)').fill('2');
  await start.getByRole('button', { name: 'Start a tab', exact: true }).click();
  await scan(alice, 'Confirm: Start a tab');
  await confirmRelayed(alice, 'Start a tab', '$0.01');
  const tab = tabView(alice);
  await expect(tabStatus(tab)).toHaveText('Live', { timeout: 120_000 });
  await scan(alice, 'Tab (live)');
  await tab.getByRole('button', { name: 'Settle without the other side' }).click();
  await scan(alice, 'Settle without the other side');
  await popup(alice, 'Settle without the other side').getByRole('button', { name: 'Cancel' }).click();
  await openTabs(alice);
  await scan(alice, 'Tabs');
  await alice.getByRole('link', { name: 'Invite', exact: true }).click();
  await expect(popup(alice, 'Invite someone').getByRole('img', { name: 'Invite QR code' })).toBeVisible();
  await scan(alice, 'Invite someone');
  await popup(alice, 'Invite someone').getByRole('button', { name: 'Close' }).click();

  await alice.goto(await createInvite(bob));
  await start.getByLabel('You put in ($)').fill('1');
  await start.getByLabel('Ask them to put in ($, optional)').fill('1');
  await start.getByRole('button', { name: 'Start a tab', exact: true }).click();
  await popup(alice, 'Confirm: Start a tab').getByRole('button', { name: 'Confirm' }).click();
  await expect(popup(bob, 'Tab request')).toBeVisible();
  await scan(bob, 'Tab request');
  await expect(alice.getByTestId('pending-open')).toBeVisible();
  await scan(alice, 'Tab (waiting for them)');
  await popup(bob, 'Tab request').getByRole('button', { name: 'Decline' }).click();
  await expect(alice.getByTestId('pending-open')).toContainText('declined');
  await scan(alice, 'Tab (declined)');

  // A subscription.
  await alice.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Services' }).click();
  await expect(alice.getByRole('listitem', { name: 'Echo chat' })).toBeVisible();
  await scan(alice, 'Services');
  await alice.getByRole('listitem', { name: 'Echo chat' }).getByRole('link', { name: 'Subscribe' }).click();
  const sheet = popup(alice, 'Subscribe');
  await sheet.getByRole('button', { name: '$1.00' }).click();
  await expect(sheet).toContainText('Starting and ending it each cost a network fee');
  await scan(alice, 'Subscribe');
  await sheet.getByRole('button', { name: 'Subscribe', exact: true }).click();
  const session = alice.getByTestId('subscription-session');
  await expect(session.getByRole('button', { name: 'Start', exact: true })).toBeVisible({ timeout: 120_000 });
  await session.getByRole('button', { name: 'Start', exact: true }).click();
  await session.getByRole('textbox', { name: 'Message' }).fill('hello');
  await session.getByRole('button', { name: 'Send message' }).click();
  await expect(session.locator('.bubble.in')).toContainText('hello');
  await scan(alice, 'Subscription');
  await session.getByRole('button', { name: 'Pause', exact: true }).click();
  await session.getByText('Details').click();
  await session.getByRole('button', { name: 'Settle without the other side' }).click();
  await scan(alice, 'Subscription: settle without the other side');
  await popup(alice, 'Settle without the other side').getByRole('button', { name: 'Cancel' }).click();

  // Home and its dialogs.
  await openWallet(alice);
  await expect(alice.getByRole('region', { name: 'Recent activity' }).getByRole('listitem')).toHaveCount(2);
  await scan(alice, 'My wallet');
  for (const action of ['Add money', 'Send', 'Receive', 'Cash out'] as const) {
    await openAction(alice, action);
    await expect(popup(alice, action)).toBeVisible();
    await scan(alice, action);
    await popup(alice, action).getByRole('button', { name: 'Close' }).click();
  }
  await openAction(alice, 'Send');
  const send = popup(alice, 'Send');
  await send.getByLabel('To Calyptra ID').fill(bobId);
  await send.getByLabel('Amount ($)').fill('1');
  await send.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(popup(alice, 'Confirm: Send')).toContainText('Network fee: $0.01');
  await scan(alice, 'Confirm: Send');
  await popup(alice, 'Confirm: Send').getByRole('button', { name: 'Cancel' }).click();
  // An error state: more than the private balance holds. The framework's message is shown in the website's words.
  await send.getByLabel('Amount ($)').fill('1000');
  await send.getByRole('button', { name: 'Send', exact: true }).click();
  const review = popup(alice, 'Confirm: Send');
  await review.getByRole('button', { name: 'Confirm' }).click();
  await expect(review.getByRole('alert')).toHaveText('Not enough in your private balance for this amount plus the network fee', { timeout: 120_000 });
  await scan(alice, 'Send (error: more than the private balance)');
  await review.getByRole('button', { name: 'Cancel' }).click();
  await send.getByRole('button', { name: 'Close' }).click();

  // Settings pages other than Advanced; the menu's entry for Advanced describes Advanced, so it is left out.
  for (const category of ['Accounts', 'Backup', 'Appearance'] satisfies SettingsCategory[]) {
    await openSettings(alice, category);
    await scan(alice, `Settings › ${category}`, '.settings-detail');
  }
  await alice.getByRole('button', { name: 'Lock' }).click();
  await expect(alice.getByRole('heading', { name: 'Unlock your wallet' })).toBeVisible();
  await scan(alice, 'Unlock');
  await unlock(alice);

  expect(found).toEqual([]);
});

test.describe('installable app (PWA)', () => {
  test.use({ baseURL: 'http://localhost:5199' });

  /** Width and height of a PNG, from its IHDR chunk. */
  const pngSize = (bytes: Buffer): string => `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;

  test('installable from localhost: a valid manifest and an active service worker that serves the app offline', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Continue with passkey' })).toBeVisible();
    const href = (await page.locator('link[rel="manifest"]').getAttribute('href')) ?? '';
    const manifestUrl = new URL(href, page.url()).toString();
    const manifest = (await (await page.request.get(manifestUrl)).json()) as {
      name: string; start_url: string; display: string; theme_color: string; icons: { src: string; sizes: string; type: string }[];
    };
    expect(manifest).toMatchObject({ name: 'Calyptra', start_url: '/', display: 'standalone', theme_color: expect.stringMatching(/^#[0-9a-f]{6}$/i) });
    for (const size of ['192x192', '512x512']) {
      const icon = manifest.icons.find((i) => i.sizes === size);
      expect(icon?.type).toBe('image/png');
      const response = await page.request.get(new URL(icon?.src ?? '', manifestUrl).toString());
      expect(response.ok()).toBe(true);
      expect(pngSize(await response.body())).toBe(size);
    }

    expect(await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state)).toBe('activated');
    await page.reload();
    expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toMatch(/\/sw\.js$/);
    const cdp = await page.context().newCDPSession(page);
    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
    expect(installabilityErrors).toEqual([]); // Chromium's own install criteria

    await page.context().setOffline(true); // the cached app shell still opens
    await page.reload();
    await expect(page.getByRole('button', { name: 'Continue with passkey' })).toBeVisible();
    await page.context().setOffline(false);
  });
});
