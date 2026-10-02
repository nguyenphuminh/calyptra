// Live tests on Monad testnet (all-ref §10.5, §10.7 LIVE rows, §11.10 Stage 2): the deployed website with
// the live relayer and libp2p relay. Stage 2 only: run after the deployment, with CALYPTRA_LIVE_URL and the
// funder key in ~/.calyptra-secrets/funder.key. It never starts a dispute (the live window is 3-7 days).
// Money moves in dollars (AUSD, the main currency, §11.2/§11.6); MON only pays the accounts' network fees
// and the reserve. Every expected amount is computed from the relayer's live quote.
import { statSync } from 'node:fs';
import type { Browser, Page } from '@playwright/test';
import { formatEther, parseUnits, type Address } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { APPROVE_GAS_LIMIT, DEPOSIT_GAS_LIMIT, MONAD_RESERVE_BALANCE, chainIdAt, defaultRpcUrls } from '../../packages/framework/src/index.ts';
import { REPO } from '../../scripts/lib/devnode.ts';
import {
  addMoney, card, confirmRelayed, createInvite, createWallet, expect, openAction, openSettings, openTab, openTabs, openWallet, PASSWORD,
  payInTab, phraseWords, popup, recordConsole, setPassword, startDialog, tabStatus, tabView, test, unlock,
} from '../ui/helpers.ts';
import { client, faucetStablecoin, fund, funder, network, rememberWallet, stablecoin, stablecoinBalance, stablecoinDecimals, sweepPublic } from './funding.ts';

const RELAYER = network.relayers[0] ?? '';
const RELAY = network.libp2pRelays[0] ?? '';

let decimals = 6;
/** AUSD base units as the website shows them: dollars cut to cents. */
function usd(units: bigint): string {
  const cents = units / 10n ** BigInt(decimals - 2);
  return `$${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}
const units = (dollars: string): bigint => parseUnits(dollars, decimals);

/** The relayer's AUSD fee, from its live quote. */
async function stableFee(): Promise<bigint> {
  const info = (await (await fetch(`${RELAYER}/relayer/info`)).json()) as { fees: Record<string, string> };
  const fee = info.fees[stablecoin.toLowerCase()];
  if (fee === undefined) throw new Error('the live relayer quotes no AUSD fee');
  return BigInt(fee);
}

/** A new wallet in its own browser context, on the built-in network; its phrase is kept for recovery. */
async function newUser(browser: Browser, name: string): Promise<{ page: Page; phrase: string }> {
  const page = await (await browser.newContext()).newPage();
  await recordConsole(page, name);
  const phrase = await createWallet(page);
  rememberWallet(name, phrase);
  await openSettings(page, 'Advanced');
  await expect(page.getByRole('combobox', { name: 'Network', exact: true })).toHaveValue(network.id);
  return { page, phrase };
}

async function restoreInto(browser: Browser, file: string, name: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await recordConsole(page, name);
  await page.goto('/');
  await page.getByRole('button', { name: 'Use a recovery phrase instead' }).click();
  await page.getByRole('button', { name: 'Restore from an export file' }).click();
  await page.getByLabel('Export file', { exact: true }).setInputFiles(file);
  await page.getByLabel('Password of the export file').fill(PASSWORD);
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByRole('button', { name: 'Lock' })).toBeVisible();
  return page;
}

test('LIVE-1: the site, its proving files, the relayer, the relay and the RPC endpoints', async ({ request }) => {
  const home = await request.get('/');
  expect(home.ok()).toBe(true);
  const html = await home.text();
  expect(html).toContain('<div id="root">');
  expect(html).toContain('<title>Calyptra</title>');
  const favicon = await request.get('/favicon.svg');
  expect(favicon.ok()).toBe(true);
  expect(await favicon.text()).toContain('<svg');
  // GET, because the CDN gives no length for HEAD: the proving file is the one this build was made with.
  const zkey = await request.get('/artifacts/transfer.zkey');
  expect(zkey.ok()).toBe(true);
  expect((await zkey.body()).length).toBe(statSync(`${REPO}/packages/framework/artifacts/transfer.zkey`).size);
  expect((await request.get('/manifest.webmanifest')).ok()).toBe(true);
  expect((await request.get('/sw.js')).ok()).toBe(true);

  const info = await request.get(`${RELAYER}/relayer/info`);
  expect(info.ok()).toBe(true);
  expect(await info.json()).toMatchObject({ chainId: network.chainId, shieldedAddress: expect.stringMatching(/^cal/) });
  expect(RELAY).toMatch(/^\/dns4\/[^/]+\/tcp\/443\/wss\/p2p\/12D3/);
  for (const url of defaultRpcUrls(network)) expect(await chainIdAt(url)).toBe(network.chainId);
});

test('LIVE-2: a new wallet knows the network’s relays and endpoints; its phrase imports elsewhere', async ({ browser }) => {
  const { page, phrase } = await newUser(browser, 'live-2');
  await openTabs(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Tabs' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Invite', exact: true })).toBeVisible(); // a relay is known
  await openSettings(page, 'Advanced');
  await expect(page.getByTestId('network-logo')).toBeVisible();
  const rpc = card(page, `RPC endpoints on ${network.name}`);
  for (const url of defaultRpcUrls(network)) await expect(rpc.getByRole('listitem').filter({ hasText: url })).toContainText('Network default');
  await expect(card(page, `Privacy relays on ${network.name}`).getByRole('listitem').filter({ hasText: RELAYER })).toContainText('Network default');
  await expect(card(page, `Message relays on ${network.name}`).getByRole('listitem').filter({ hasText: RELAY })).toContainText('Network default');
  await page.getByRole('button', { name: 'Lock' }).click();
  await unlock(page);

  const other = await (await browser.newContext()).newPage();
  await other.goto('/');
  await other.getByRole('button', { name: 'Use a recovery phrase instead' }).click();
  await other.getByRole('button', { name: 'Import a recovery phrase or private key' }).click();
  await other.getByLabel('Recovery phrase or private key').fill(phrase);
  await setPassword(other, 'Import wallet');
  await openWallet(other);
  await expect(other.getByTestId('public-address')).toHaveAttribute('title', mnemonicToAccount(phrase).address);
  await other.context().close();
  await page.context().close();
});

test('LIVE-3: the phone layout', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'Use a recovery phrase instead' }).click();
  await page.getByRole('button', { name: 'Create a new wallet' }).click();
  expect(await phraseWords(page)).toHaveLength(12);
  await page.getByRole('button', { name: '← Back' }).click();
  await createWallet(page);
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link')).toHaveText(['Tabs', 'Services', 'My wallet', 'Settings']);
  await openWallet(page);
  await expect(page.getByTestId('shielded-stablecoin')).toHaveText('$0.00');
  await context.close();
});

test.describe.serial('money on testnet', () => {
  let alice: Page;
  let bob: Page;
  let alicePhrase = '';
  let bobPhrase = '';
  let fee = 0n;
  let bobPrivate = 0n;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(20 * 60_000);
    [{ page: alice, phrase: alicePhrase }, { page: bob, phrase: bobPhrase }] = await Promise.all([newUser(browser, 'alice'), newUser(browser, 'bob')]);
    decimals = await stablecoinDecimals();
    fee = await stableFee();
    if ((await stablecoinBalance(funder())) < units('2')) await faucetStablecoin();
    // Adding money is an approve and a deposit from Alice's account, billed on their gas limits; the account keeps its reserve.
    const { maxFeePerGas } = await client.estimateFeesPerGas();
    const gas = (APPROVE_GAS_LIMIT + DEPOSIT_GAS_LIMIT) * maxFeePerGas * 2n;
    await fund(mnemonicToAccount(alicePhrase).address, formatEther(MONAD_RESERVE_BALANCE + gas), '2');
  });

  test.afterAll(async () => {
    test.setTimeout(20 * 60_000);
    const note = (type: string, description: string) => test.info().annotations.push({ type, description });
    for (const page of [alice, bob]) {
      if (!page || page.isClosed()) continue;
      await popup(page, 'Tab request').getByRole('button', { name: 'Decline' }).click({ timeout: 2_000 }).catch(() => undefined);
      try {
        await page.goto('/#/wallet');
        const shown = parseUnits(((await page.getByTestId('shielded-stablecoin').getAttribute('title')) ?? '0').split(' ')[0] ?? '0', decimals);
        if (shown <= fee) continue;
        const cents = (shown - fee) / 10n ** BigInt(decimals - 2);
        await page.goto('/#/withdraw');
        const dialog = popup(page, 'Cash out');
        await dialog.getByLabel('Currency').selectOption('stablecoin');
        await dialog.getByLabel('Amount ($)').fill(`${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`);
        await dialog.getByLabel('Recipient address').fill(funder());
        await dialog.getByRole('button', { name: 'Cash out', exact: true }).click();
        await confirmRelayed(page, 'Cash out', usd(fee));
        await dialog.getByRole('button', { name: 'Close' }).click();
      } catch (err) {
        note('leftover', `AUSD not cashed out: ${String(err).split('\n')[0]}`);
      }
    }
    for (const phrase of [alicePhrase, bobPhrase]) {
      if (!phrase) continue;
      await sweepPublic(phrase).then((done) => note('returned', done), (err: unknown) => note('sweep failed', String(err).split('\n')[0] ?? ''));
    }
  });

  test('LIVE-4a: add dollars, send them privately, cash out to the funder', async () => {
    await openWallet(alice);
    await expect(alice.getByTestId('public-stablecoin')).toHaveText('$2.00');
    await addMoney(alice, 'stablecoin', '1');
    await expect(alice.getByTestId('shielded-stablecoin')).toHaveText('$1.00');
    await openWallet(bob);
    const bobId = (await bob.getByTestId('shielded-address').getAttribute('title')) ?? '';

    await openAction(alice, 'Send');
    const send = popup(alice, 'Send');
    await send.getByLabel('To Calyptra ID').fill(bobId);
    await send.getByLabel('Amount ($)').fill('0.5');
    await send.getByRole('button', { name: 'Send', exact: true }).click();
    await confirmRelayed(alice, 'Send', usd(fee));
    await expect(alice.getByTestId('shielded-stablecoin')).toHaveText(usd(units('0.5') - fee));
    await expect(bob.getByTestId('shielded-stablecoin')).toHaveText('$0.50');

    const to: Address = funder();
    const before = await stablecoinBalance(to);
    await openAction(bob, 'Cash out');
    const cashOut = popup(bob, 'Cash out');
    await cashOut.getByLabel('Amount ($)').fill('0.1');
    await cashOut.getByLabel('Recipient address').fill(to);
    await cashOut.getByRole('button', { name: 'Cash out', exact: true }).click();
    await confirmRelayed(bob, 'Cash out', usd(fee));
    await expect(cashOut).toContainText(`Cashed out to ${to}.`);
    expect((await stablecoinBalance(to)) - before).toBe(units('0.1'));
    await cashOut.getByRole('button', { name: 'Close' }).click();
    bobPrivate = units('0.4') - fee;
    await expect(bob.getByTestId('shielded-stablecoin')).toHaveText(usd(bobPrivate));
  });

  test('LIVE-4b: a dollar tab: payments both ways, a locked receiver, export and restore, settle', async ({ browser }, testInfo) => {
    await alice.goto(await createInvite(bob));
    const dialog = startDialog(alice);
    await dialog.getByLabel('Nickname (optional)').fill('Bob');
    await dialog.getByLabel('You put in ($)').fill('0.2');
    await dialog.getByRole('button', { name: 'Start a tab', exact: true }).click();
    await confirmRelayed(alice, 'Start a tab', usd(fee));
    const aliceTab = tabView(alice);
    await expect(tabStatus(aliceTab)).toHaveText('Live', { timeout: 300_000 });
    let bobTab = await openTab(bob);
    await expect(tabStatus(bobTab)).toHaveText('Live', { timeout: 300_000 });
    await expect(aliceTab.getByTestId('channel-mine')).toHaveText(usd(units('0.2') - fee));

    await payInTab(alice, aliceTab, '0.05', true, 'stablecoin');
    await expect(bobTab.getByTestId('channel-mine')).toHaveText('$0.05');
    await payInTab(bob, bobTab, '0.02', true, 'stablecoin');
    await expect(bobTab.getByTestId('channel-mine')).toHaveText('$0.03');
    await bob.getByRole('button', { name: 'Lock' }).click();
    await payInTab(alice, aliceTab, '0.01', true, 'stablecoin');
    await expect(aliceTab.getByRole('alert')).toHaveText('The other side is not reachable right now');
    await unlock(bob);
    await createInvite(bob);
    bobTab = await openTab(bob);
    await payInTab(alice, aliceTab, '0.01', true, 'stablecoin');
    await expect(bobTab.getByTestId('channel-mine')).toHaveText('$0.05'); // the waiting payment went first

    await openSettings(bob, 'Backup');
    const download = bob.waitForEvent('download');
    await card(bob, 'Export').getByRole('button', { name: 'Download export file' }).click();
    const file = testInfo.outputPath('bob-export.json');
    await (await download).saveAs(file);
    await bob.context().close();
    bob = await restoreInto(browser, file, 'bob-restored');
    await createInvite(bob);
    bobTab = await openTab(bob);
    await expect(tabStatus(bobTab)).toHaveText('Live', { timeout: 300_000 });
    await expect(bobTab.getByTestId('channel-mine')).toHaveText('$0.05');
    await payInTab(alice, aliceTab, '0.01', true, 'stablecoin');
    await expect(bobTab.getByTestId('channel-mine')).toHaveText('$0.06');

    await aliceTab.getByRole('button', { name: 'Settle', exact: true }).click();
    await confirmRelayed(alice, 'Settle', usd(fee));
    await expect(tabStatus(aliceTab)).toHaveText('Settled', { timeout: 300_000 });
    await expect(tabStatus(bobTab)).toHaveText('Settled', { timeout: 300_000 });
    bobPrivate += units('0.06');
    await openWallet(bob);
    await expect(bob.getByTestId('shielded-stablecoin')).toHaveText(usd(bobPrivate));
  });

  test('LIVE-4c: a request declined, one ignored, one accepted from the list; settling without the other side is only offered', async () => {
    for (const round of ['decline', 'ignore', 'accept'] as const) {
      await alice.goto('/#/channels');
      await alice.goto(await createInvite(bob));
      const dialog = startDialog(alice);
      await dialog.getByLabel('You put in ($)').fill('0.1');
      await dialog.getByLabel('Ask them to put in ($, optional)').fill('0.05');
      await dialog.getByRole('button', { name: 'Start a tab', exact: true }).click();
      await popup(alice, 'Confirm: Start a tab').getByRole('button', { name: 'Confirm' }).click();
      const pending = alice.getByTestId('pending-open');
      await expect(pending).toContainText('Waiting for');
      const request = popup(bob, 'Tab request');
      await expect(request).toContainText('They put in $0.10 and ask you to put in $0.05');

      if (round !== 'accept') {
        if (round === 'decline') {
          await openAction(alice, 'Receive');
          await popup(alice, 'Receive').getByRole('button', { name: 'Close' }).click();
          await request.getByRole('button', { name: 'Decline' }).click();
          await openTabs(alice);
          await alice.getByTestId('channel-item').first().click();
        } else {
          await request.getByRole('button', { name: 'Close' }).click();
        }
        await expect(pending).toContainText('declined, or did not answer in time', { timeout: 120_000 });
        await expect(request).toBeHidden();
        await pending.getByRole('button', { name: 'Dismiss' }).click();
        await expect(pending).toBeHidden();
        continue;
      }

      await request.getByRole('button', { name: 'Close' }).click();
      await openTabs(bob);
      await bob.getByTestId('channel-item').first().click();
      const conversation = bob.getByTestId('channel-request');
      await conversation.getByLabel('Nickname for them (optional)').fill('Alice');
      await conversation.getByRole('button', { name: 'Accept' }).click();
      await expect(alice).toHaveURL(/#\/channels\/[0-9a-f]{32}$/, { timeout: 300_000 });
      const bobTab = await openTab(bob);
      await expect(tabStatus(bobTab)).not.toHaveText('Settled');
      await expect(tabStatus(bobTab)).toHaveText('Live', { timeout: 300_000 });
      await expect(bobTab.getByRole('heading', { level: 2 })).toHaveText('Alice');
      await expect(bobTab.getByTestId('channel-mine')).toHaveText('$0.05');

      // Offered, never started live: the window is days long.
      await bobTab.getByRole('button', { name: 'Settle without the other side' }).click();
      const dispute = popup(bob, 'Settle without the other side');
      await expect(dispute).toContainText('7-day window');
      await dispute.getByRole('button', { name: 'Cancel' }).click();
      await expect(dispute).toBeHidden();

      await bobTab.getByRole('button', { name: 'Settle', exact: true }).click();
      await confirmRelayed(bob, 'Settle', usd(fee));
      await expect(tabStatus(bobTab)).toHaveText('Settled', { timeout: 300_000 });
      await expect(tabStatus(tabView(alice))).toHaveText('Settled', { timeout: 300_000 });
    }
  });
});
