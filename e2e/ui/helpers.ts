// Helpers of the UI tier (all-ref §10.4.2), in the website's consumer wording (§11.6): tabs, private
// balance, Add money / Send / Cash out, Settings › Advanced.
import './port.ts';
import { appendFileSync, writeFileSync } from 'node:fs';
import { test as base, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { parseEther, parseUnits, type Address } from 'viem';
import { devPublicClient, devWalletClient } from '../../scripts/lib/devnode.ts';

/** The wallet password of every UI user. */
export const PASSWORD = 'correct horse battery';

export interface DevNetworkInfo { id: string; name: string; chainId: number; rpcUrl: string; stablecoin: Address; relayers: string[]; libp2pRelays: string[]; merchants: string[] }

/** The dev network the website was built with (set by the global setup). */
export function devNetworkInfo(): DevNetworkInfo {
  const raw = process.env.CALYPTRA_UI_NETWORK;
  if (!raw) throw new Error('CALYPTRA_UI_NETWORK is not set: run the UI tests through e2e/playwright.config.ts');
  return JSON.parse(raw) as DevNetworkInfo;
}

/** The tests' `test`, with `newUser(name)`: a page in a browser context of its own (its own IndexedDB), closed after the test. */
export const test = base.extend<{ newUser: (name: string) => Promise<Page> }>({
  newUser: async ({ browser }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (name) => {
      const context = await browser.newContext();
      contexts.push(context);
      const page = await context.newPage();
      await recordConsole(page, name);
      return page;
    });
    await Promise.all(contexts.map((c) => c.close()));
  },
});
export { expect };

/** Cards are labelled regions. */
export const card = (page: Page, title: string): Locator => page.getByRole('region', { name: title, exact: true });

/** A dialog by its exact title (so "Cash out" is not its review "Confirm: Cash out"). */
export const popup = (page: Page, title: string): Locator => page.getByRole('dialog', { name: title, exact: true });

/** Creates a wallet with a new recovery phrase (the phrase path; passkeys have their own spec) and returns the phrase. */
export async function createWallet(page: Page): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Use a recovery phrase instead' }).click();
  await page.getByRole('button', { name: 'Create a new wallet' }).click();
  const words = await phraseWords(page);
  expect(words).toHaveLength(12);
  await page.getByLabel('I have written my recovery phrase down').check();
  await page.getByRole('button', { name: 'I wrote it down' }).click();
  for (const label of await page.locator('.field > label').all()) {
    const n = Number((await label.textContent())?.replace('Word #', ''));
    await page.getByLabel(`Word #${n}`, { exact: true }).fill(words[n - 1] ?? '');
  }
  await page.getByRole('button', { name: 'Confirm words' }).click();
  await setPassword(page, 'Create wallet');
  return words.join(' ');
}

export const phraseWords = (page: Page): Promise<string[]> =>
  page.getByRole('list', { name: 'Recovery phrase' }).locator('.phrase-word').allTextContents();

export async function setPassword(page: Page, submit: string): Promise<void> {
  await page.getByLabel('Wallet password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Repeat the password').fill(PASSWORD);
  await page.getByRole('button', { name: submit }).click();
  await expect(page.getByRole('button', { name: 'Lock' })).toBeVisible();
}

export async function unlock(page: Page, password = PASSWORD): Promise<void> {
  await page.getByLabel('Wallet password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('button', { name: 'Lock' })).toBeVisible();
}

const mainNav = (page: Page): Locator => page.getByRole('navigation', { name: 'Main' });

export async function openWallet(page: Page): Promise<void> {
  await mainNav(page).getByRole('link', { name: 'My wallet' }).click();
}

export type WalletAction = 'Add money' | 'Send' | 'Receive' | 'Cash out';

/** My wallet, then the action: Add money and Send are in the hero's actions, Receive and Cash out are links under it. */
export async function openAction(page: Page, action: WalletAction): Promise<void> {
  await openWallet(page);
  const where = action === 'Add money' || action === 'Send'
    ? page.getByRole('navigation', { name: 'Private balance actions' })
    : card(page, 'Private balance');
  await where.getByRole('link', { name: action, exact: true }).click();
}

export type SettingsCategory = 'Accounts' | 'Backup' | 'Advanced' | 'Appearance';

export async function openSettings(page: Page, category?: SettingsCategory): Promise<void> {
  await mainNav(page).getByRole('link', { name: 'Settings' }).click();
  if (category) await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('link', { name: new RegExp(`^${category}`) }).click();
}

export async function openTabs(page: Page): Promise<void> {
  await mainNav(page).getByRole('link', { name: 'Tabs' }).click();
}

/** Tabs, then the first tab of the list; returns the open conversation. */
export async function openTab(page: Page): Promise<Locator> {
  await openTabs(page);
  await page.getByTestId('channel-item').first().click();
  return tabView(page);
}

/** The open conversation (a tab, a request or an outgoing request). */
export const tabView = (page: Page): Locator => page.getByRole('region', { name: 'Channel', exact: true });
export const startDialog = (page: Page): Locator => popup(page, 'Start a tab');

/** Switches the wallet to the dev network in Settings › Advanced. */
export async function useDevNetwork(page: Page, id = devNetworkInfo().id): Promise<void> {
  await openSettings(page, 'Advanced');
  const select = page.getByRole('combobox', { name: 'Network', exact: true });
  await select.selectOption(id);
  await expect(select).toHaveValue(id);
  await expect(select).toBeEnabled();
}

let devQueue: Promise<unknown> = Promise.resolve();
/** The dev account sends one transaction at a time, so concurrent funding never reuses a nonce. */
export function devSend<T>(fn: () => Promise<T>): Promise<T> {
  const run = devQueue.then(fn);
  devQueue = run.catch(() => undefined);
  return run;
}

const STABLECOIN_ABI = [{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [] }] as const;

/** Sends dev-chain money to an address: `native` MON, and `stable` AUSD minted by the test stablecoin. */
export async function fundAddress(to: Address, native: string, stable?: string): Promise<void> {
  const client = devPublicClient();
  const dev = devWalletClient();
  await devSend(async () => client.waitForTransactionReceipt({ hash: await dev.sendTransaction({ to, value: parseEther(native) }) }));
  if (stable) {
    const { stablecoin } = devNetworkInfo();
    await devSend(async () => client.waitForTransactionReceipt({
      hash: await dev.writeContract({ address: stablecoin, abi: STABLECOIN_ABI, functionName: 'mint', args: [to, parseUnits(stable, 6)] }),
    }));
  }
}

/** Funds the open wallet's account publicly (My wallet's account address) and returns that address. */
export async function fundPublicly(page: Page, native: string, stable?: string): Promise<Address> {
  await openWallet(page);
  const address = (await page.getByTestId('public-address').getAttribute('title')) as Address;
  await fundAddress(address, native, stable);
  return address;
}

/** Mines an empty transaction, which brings the dev chain's clock up to wall-clock time. */
export async function mineBlock(): Promise<void> {
  const client = devPublicClient();
  const dev = devWalletClient();
  await devSend(async () => client.waitForTransactionReceipt({ hash: await dev.sendTransaction({ to: dev.account.address, value: 0n }) }));
}

/** The review dialog of a relayed action shows its network fee; confirming it closes it once the transaction went through. */
export async function confirmRelayed(page: Page, label: string, fee = '0.0001 MON'): Promise<void> {
  const review = popup(page, `Confirm: ${label}`);
  await expect(review).toContainText(`Network fee: ${fee}`);
  await review.getByRole('button', { name: 'Confirm' }).click();
  await expect(review).toBeHidden({ timeout: 120_000 });
}

/** Opens Add money, picks the currency and amount (a preset when one matches), and adds it. */
export async function addMoney(page: Page, currency: 'native' | 'stablecoin', amount: string, preset = true): Promise<void> {
  await openAction(page, 'Add money');
  const dialog = popup(page, 'Add money');
  await dialog.getByLabel('Currency').selectOption(currency);
  if (preset) await dialog.getByRole('button', { name: amount, exact: true }).click();
  else await dialog.getByLabel(currency === 'native' ? 'Amount (MON)' : 'Amount ($)').fill(amount);
  await dialog.getByRole('button', { name: 'Add money', exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 120_000 });
}

/** Creates an invite in Tabs › Invite and returns its link. */
export async function createInvite(page: Page): Promise<string> {
  await openTabs(page);
  await page.getByRole('link', { name: 'Invite', exact: true }).click();
  const dialog = popup(page, 'Invite someone');
  // The invite is made at once; its QR code also waits until the wallet is reachable through the relay.
  await expect(dialog.getByRole('img', { name: 'Invite QR code' })).toBeVisible();
  const link = (await dialog.getByTestId('invite-link').textContent()) ?? '';
  expect(link).toMatch(/\/#\/invite\/[A-Za-z0-9_-]+$/);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  return link;
}

/** Pays in the open tab: the composer, then the wallet's confirmation, answered with `confirm`. */
export async function payInTab(page: Page, tab: Locator, amount: string, confirm: boolean, token: 'native' | 'stablecoin' = 'native'): Promise<void> {
  await tab.getByLabel(token === 'native' ? 'Pay (MON)' : 'Pay ($)').fill(amount);
  await tab.getByRole('button', { name: 'Pay', exact: true }).click();
  const dialog = popup(page, 'Confirm payment');
  await expect(dialog).toContainText(`Pay ${token === 'native' ? `${amount} MON` : dollars(amount)}`);
  await dialog.getByRole('button', { name: confirm ? 'Confirm payment' : 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** A decimal dollar amount as the website shows it: `$X.XX`, cut to cents. */
export function dollars(amount: string): string {
  const [whole = '0', fraction = ''] = amount.split('.');
  return `$${Number(whole).toLocaleString('en-US')}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

/** Writes the page's console and page errors to CALYPTRA_UI_CONSOLE (when set), with CALYPTRA_UI_DEBUG as `localStorage.debug`. */
export async function recordConsole(page: Page, name: string): Promise<void> {
  const file = process.env.CALYPTRA_UI_CONSOLE;
  if (!file) return;
  page.on('console', (m) => appendFileSync(file, `${new Date().toISOString()} [${name}] ${m.type()} ${m.text()}\n`));
  page.on('pageerror', (e) => appendFileSync(file, `${new Date().toISOString()} [${name}] pageerror ${e.message}\n`));
  const debug = process.env.CALYPTRA_UI_DEBUG;
  if (debug) await page.addInitScript((value) => localStorage.setItem('debug', value), debug);
}

/** Runs `run` under the DevTools CPU profiler when CALYPTRA_UI_PROFILE names an output file. */
export async function profiled<T>(page: Page, run: () => Promise<T>): Promise<T> {
  const file = process.env.CALYPTRA_UI_PROFILE;
  if (!file) return run();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.start');
  try {
    return await run();
  } finally {
    const { profile } = await cdp.send('Profiler.stop');
    writeFileSync(file, JSON.stringify(profile));
  }
}

/** A new user with a wallet on the dev network; with `add`, its account is funded and that much MON is added to its private balance. */
export async function devWallet(newUser: (name: string) => Promise<Page>, name: string, add?: string): Promise<Page> {
  const page = await newUser(name);
  await createWallet(page);
  await useDevNetwork(page);
  if (add) {
    await fundPublicly(page, '1');
    await addMoney(page, 'native', add);
    await expect(page.getByTestId('shielded-native')).toHaveText(`${add} MON`);
  }
  return page;
}

/** The status pill of the open conversation. */
export const tabStatus = (tab: Locator): Locator => tab.locator('.conversation-head .pill');

/**
 * A DevTools (CDP) virtual authenticator on this page (§11.10: passkey gates), a platform passkey with
 * user verification, resident keys and the PRF extension unless `prf` is false. It counts the
 * ceremonies: passkeys created and assertions made (each one is a passkey prompt for a real user).
 */
export async function virtualAuthenticator(page: Page, { prf = true, verified = true } = {}) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
      isUserVerified: verified, automaticPresenceSimulation: true, hasPrf: prf,
    },
  });
  const count = { created: 0, asserted: 0 };
  cdp.on('WebAuthn.credentialAdded', () => { count.created++; });
  cdp.on('WebAuthn.credentialAsserted', () => { count.asserted++; });
  return {
    count,
    credentials: async () => (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials,
    /** Deletes everything the site stored in this browser (a new device), keeping the passkey. */
    clearSiteData: async (origin: string) => { await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' }); },
  };
}

/** Welcome › Continue with passkey › Create passkey: a passkey wallet (no password, no phrase to write down). */
export async function createPasskeyWallet(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue with passkey' }).click();
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Create passkey' }).click();
  await expect(page.getByRole('button', { name: 'Lock' })).toBeVisible();
}
