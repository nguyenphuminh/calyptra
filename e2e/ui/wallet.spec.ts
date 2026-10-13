// The wallet (all-ref §10.7.1: UI-W1 to UI-W8): create, import, accounts, password and lock, reset,
// export and restore, networks, the recovery-phrase banner and the theme, in the §11.6 wording.
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import {
  addMoney, card, createWallet, devNetworkInfo, expect, fundPublicly, openSettings, openTabs, openWallet, PASSWORD, phraseWords,
  popup, setPassword, test, unlock, useDevNetwork,
} from './helpers.ts';

const BUILT_IN_NETWORK = 'monad-testnet';
const PHRASE_NOTICE = 'Calyptra only ever asks for your recovery phrase when you import a wallet. Never type it anywhere else.';
const ANVIL_PHRASE = 'test test test test test test test test test test test junk';

/** Every value of the website's IndexedDB store, as one string. */
const storedText = (page: Page): Promise<string> => page.evaluate(() => new Promise<string>((resolve, reject) => {
  const open = indexedDB.open('calyptra');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const request = open.result.transaction('kv').objectStore('kv').getAll();
    request.onsuccess = () => resolve(JSON.stringify(request.result));
    request.onerror = () => reject(request.error);
  };
}));

const publicAddress = (page: Page) => page.getByTestId('public-address');
const accountSelect = (page: Page) => page.getByRole('combobox', { name: 'Account' });

/** Welcome › Use a recovery phrase instead › Import, then the secret and the password. */
async function importWallet(page: Page, secret: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Use a recovery phrase instead' }).click();
  await page.getByRole('button', { name: 'Import a recovery phrase or private key' }).click();
  await page.getByLabel('Recovery phrase or private key').fill(secret);
  await setPassword(page, 'Import wallet');
}

async function importKeyAccount(page: Page, key: string): Promise<void> {
  await openSettings(page, 'Accounts');
  await page.getByRole('button', { name: 'Import key' }).click();
  const dialog = popup(page, 'Import an account from a private key');
  await dialog.getByLabel('Private key').fill(key);
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog).toBeHidden();
}

test('UI-W1: create shows the phrase once, checks 3 words and the password, stores only encrypted data, locks', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Private dollars, paid by the second')).toBeVisible();
  await page.getByRole('button', { name: 'Use a recovery phrase instead' }).click();
  await page.getByRole('button', { name: 'Create a new wallet' }).click();
  const words = await phraseWords(page);
  expect(words).toHaveLength(12);
  const phrase = words.join(' ');
  await expect(page.getByRole('button', { name: 'I wrote it down' })).toBeDisabled();
  await page.getByLabel('I have written my recovery phrase down').check();
  await page.getByRole('button', { name: 'I wrote it down' }).click();
  await expect(page.getByRole('list', { name: 'Recovery phrase' })).toHaveCount(0);
  const labels = page.locator('.field > label');
  await expect(labels).toHaveCount(3);
  const positions = (await labels.allTextContents()).map((t) => Number(t.replace('Word #', '')));
  for (const n of positions) await page.getByLabel(`Word #${n}`, { exact: true }).fill('wrong');
  await page.getByRole('button', { name: 'Confirm words' }).click();
  await expect(page.getByRole('alert')).toHaveText('Those words do not match your phrase. Try again.');
  await expect(page.getByLabel('Wallet password', { exact: true })).toHaveCount(0);
  for (const n of positions) await page.getByLabel(`Word #${n}`, { exact: true }).fill(words[n - 1] ?? '');
  await page.getByRole('button', { name: 'Confirm words' }).click();
  await page.getByLabel('Wallet password', { exact: true }).fill('short');
  await expect(page.getByText('The password needs at least 8 characters.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create wallet' })).toBeDisabled();
  await setPassword(page, 'Create wallet');

  await openSettings(page, 'Advanced');
  await expect(page.getByRole('combobox', { name: 'Network', exact: true })).toHaveValue(BUILT_IN_NETWORK);
  await openWallet(page);
  const address = mnemonicToAccount(phrase).address;
  await expect(publicAddress(page)).toHaveAttribute('title', address);

  const stored = await storedText(page);
  expect(stored).toContain('calyptra-wallet');
  expect(stored).not.toContain(words.slice(0, 2).join(' '));
  expect(stored.toLowerCase()).not.toContain(address.slice(2).toLowerCase());

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Unlock your wallet' })).toBeVisible();
  await page.getByLabel('Wallet password', { exact: true }).fill('not the password');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('alert')).toHaveText('Wrong password');
  await unlock(page);
  await openWallet(page);
  await expect(publicAddress(page)).toHaveAttribute('title', address);
  await page.getByRole('button', { name: 'Lock' }).click();
  await expect(page.getByRole('heading', { name: 'Unlock your wallet' })).toBeVisible();
});

test('UI-W2: import a phrase, add a derived account, import a key account and switch to it', async ({ page }) => {
  await importWallet(page, ANVIL_PHRASE);
  await openWallet(page);
  await expect(publicAddress(page)).toHaveAttribute('title', mnemonicToAccount(ANVIL_PHRASE).address);
  await openSettings(page, 'Accounts');
  await page.getByRole('button', { name: 'Add account' }).click();
  const second = mnemonicToAccount(ANVIL_PHRASE, { addressIndex: 1 }).address;
  await expect(accountSelect(page)).toContainText(`Account 2 · ${second.slice(0, 6)}`);
  const key = generatePrivateKey();
  await importKeyAccount(page, key);
  const imported = privateKeyToAccount(key).address;
  await accountSelect(page).selectOption(imported);
  await openWallet(page);
  await expect(publicAddress(page)).toHaveAttribute('title', imported);
});

test('UI-W3: a wallet imported from one private key cannot derive accounts', async ({ page }) => {
  const key = generatePrivateKey();
  await importWallet(page, key);
  await openWallet(page);
  await expect(publicAddress(page)).toHaveAttribute('title', privateKeyToAccount(key).address);
  await openSettings(page);
  await expect(page.getByRole('button', { name: 'Import key' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add account' })).toHaveCount(0);
});

test('UI-W4: a forgotten password resets from the phrase only after the warning; imported keys are lost', async ({ page }) => {
  const phrase = await createWallet(page);
  await importKeyAccount(page, generatePrivateKey());
  await expect(accountSelect(page).locator('option')).toHaveCount(2);
  await page.getByRole('button', { name: 'Lock' }).click();
  await page.getByRole('button', { name: 'Forgot the password?' }).click();
  await expect(page.getByText('Imported private keys, tabs and subscriptions are lost')).toBeVisible();
  await expect(page.getByLabel('Recovery phrase', { exact: true })).toHaveCount(0);
  await page.getByLabel('I understand that imported keys, tabs and subscriptions will be lost').check();
  await page.getByLabel('Recovery phrase', { exact: true }).fill(phrase);
  await page.getByLabel('New wallet password').fill('another password');
  await page.getByRole('button', { name: 'Reset wallet' }).click();
  await expect(page.getByRole('button', { name: 'Lock' })).toBeVisible();
  await openWallet(page);
  await expect(publicAddress(page)).toHaveAttribute('title', mnemonicToAccount(phrase).address);
  await expect(accountSelect(page).locator('option')).toHaveCount(1);
});

test('UI-W5: the export file is encrypted with the password, records the time and restores in a fresh browser', async ({ page, newUser }) => {
  const phrase = await createWallet(page);
  await openSettings(page, 'Accounts');
  await page.getByRole('button', { name: 'Add account' }).click();
  await expect(accountSelect(page).locator('option')).toHaveCount(2);
  await openSettings(page, 'Backup');
  await expect(page.getByTestId('last-export')).toHaveText('Last export: never');
  const download = page.waitForEvent('download');
  await card(page, 'Export').getByRole('button', { name: 'Download export file' }).click();
  const file = await (await download).path();
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ format: 'calyptra-wallet' });
  await expect(page.getByTestId('last-export')).not.toHaveText('Last export: never');

  const fresh = await newUser('restored');
  await fresh.goto('/');
  await fresh.getByRole('button', { name: 'Use a recovery phrase instead' }).click();
  await fresh.getByRole('button', { name: 'Restore from an export file' }).click();
  await fresh.getByLabel('Export file', { exact: true }).setInputFiles(file);
  await fresh.getByLabel('Password of the export file').fill('not the password');
  await fresh.getByRole('button', { name: 'Restore' }).click();
  await expect(fresh.getByRole('alert')).toHaveText('Wrong password');
  await fresh.getByLabel('Password of the export file').fill(PASSWORD);
  await fresh.getByRole('button', { name: 'Restore' }).click();
  await expect(fresh.getByRole('button', { name: 'Lock' })).toBeVisible();
  await openWallet(fresh);
  await expect(publicAddress(fresh)).toHaveAttribute('title', mnemonicToAccount(phrase).address);
  await expect(accountSelect(fresh).locator('option')).toHaveCount(2);
});

test('UI-W6: balances per account and network, a network without Calyptra, relays kept per network', async ({ page }) => {
  const dev = devNetworkInfo();
  await createWallet(page);
  await openSettings(page, 'Advanced');
  await expect(page.getByTestId('network-logo')).toBeVisible();
  await useDevNetwork(page);
  await expect(page.getByTestId('network-logo')).toHaveCount(0);

  await fundPublicly(page, '1');
  await addMoney(page, 'native', '0.1');
  await expect(page.getByTestId('shielded-native')).toHaveText('0.1 MON');

  await openSettings(page, 'Accounts');
  await page.getByRole('button', { name: 'Add account' }).click();
  const options = accountSelect(page).locator('option');
  await expect(options).toHaveCount(2);
  const [first, second] = await options.evaluateAll((all) => all.map((o) => (o as HTMLOptionElement).value));
  await accountSelect(page).selectOption(second ?? '');
  await openWallet(page);
  await expect(publicAddress(page)).toHaveAttribute('title', second ?? '');
  await expect(page.getByTestId('shielded-stablecoin')).toHaveText('$0.00');
  await expect(page.getByTestId('shielded-native')).toHaveCount(0); // no private MON: the line is not shown
  await accountSelect(page).selectOption(first ?? '');
  await expect(page.getByTestId('shielded-native')).toHaveText('0.1 MON');

  await useDevNetwork(page, 'dev-undeployed');
  await openWallet(page);
  await expect(page.getByText('Calyptra is not available on this network yet.')).toBeVisible();
  await expect(page.getByTestId('shielded-native')).toHaveCount(0);
  await openTabs(page);
  await expect(page.getByText('Tabs need a message relay. Add one in Settings › Advanced for this network.')).toBeVisible();

  const relayer = 'https://relayer.example.com';
  const relay = dev.libp2pRelays[0] ?? '';
  await openSettings(page, 'Advanced');
  const relayers = card(page, 'Privacy relays on Second dev chain');
  const relays = card(page, 'Message relays on Second dev chain');
  await relayers.getByLabel('Add', { exact: true }).fill(relayer);
  await relayers.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(relayers).toContainText(relayer);
  await relays.getByLabel('Add', { exact: true }).fill(relay);
  await relays.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(relays).toContainText(relay);
  // Addresses the wallet cannot use are refused and never saved, so unlocking below still works.
  await relayers.getByLabel('Add', { exact: true }).fill('relayer.example.com');
  await relayers.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(relayers.getByRole('alert')).toHaveText('Enter the privacy relay’s http(s) address');
  await relays.getByLabel('Add', { exact: true }).fill('relay.example.com');
  await relays.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(relays.getByRole('alert')).toHaveText('Enter the message relay’s address, like /dns4/relay.example/tcp/443/wss/p2p/12D3…');
  await relays.getByLabel('Add', { exact: true }).fill('/nonsense/p2p/x');
  await relays.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(relays.getByRole('alert')).toHaveText('Calyptra could not start with this setting, so it was not saved.');
  await expect(relays.getByRole('list')).not.toContainText('/nonsense');

  await page.getByRole('button', { name: 'Lock' }).click();
  await unlock(page);
  await openSettings(page, 'Advanced');
  await expect(relayers).toContainText(relayer);
  await expect(relays).toContainText(relay);
  await openTabs(page);
  await expect(page.getByRole('link', { name: 'Invite', exact: true })).toBeVisible();

  await openSettings(page, 'Advanced');
  await relayers.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText(relayer)).toHaveCount(0);
  await useDevNetwork(page);
  await openWallet(page);
  await expect(page.getByTestId('shielded-native')).toHaveText('0.1 MON');
});

test('UI-W7: opens on Tabs; the recovery-phrase notice is on import forms and a closable banner', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Continue with passkey' })).toBeVisible();
  await expect(page.getByText(PHRASE_NOTICE)).toHaveCount(0);
  await page.getByRole('button', { name: 'Use a recovery phrase instead' }).click();
  await page.getByRole('button', { name: 'Import a recovery phrase or private key' }).click();
  await expect(page.getByText(PHRASE_NOTICE)).toBeVisible();
  await page.getByLabel('Recovery phrase or private key').fill(generatePrivateKey());
  await setPassword(page, 'Import wallet');

  await expect(page.getByRole('heading', { level: 1, name: 'Tabs' })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Tabs' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('link')).toHaveText(['Tabs', 'Services', 'My wallet', 'Settings']);
  await expect(page.getByRole('link', { name: /Calyptra Private dollars, paid by the second/ })).toBeVisible();

  await useDevNetwork(page);
  await openTabs(page);
  await expect(page.getByRole('link', { name: 'add money to your private balance' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your tabs' })).toBeVisible();
  await expect(page.getByRole('note')).toHaveText([PHRASE_NOTICE]);
  await openWallet(page);
  await expect(page.getByRole('note')).toHaveText([PHRASE_NOTICE]);
  await expect(page.getByText('Your Calyptra ID.')).toBeVisible();
  await expect(page.getByText('Your account address.')).toBeVisible();

  await page.getByRole('button', { name: 'Close this notice' }).click();
  await expect(page.getByRole('note')).toHaveCount(0);
  await page.reload();
  await unlock(page);
  await expect(page.getByTestId('shielded-stablecoin')).toBeVisible();
  await expect(page.getByRole('note')).toHaveCount(0);

  await page.getByRole('button', { name: 'Lock' }).click();
  await page.getByRole('button', { name: 'Forgot the password?' }).click();
  await page.getByLabel('I understand that imported keys, tabs and subscriptions will be lost').check();
  await expect(page.getByText(PHRASE_NOTICE)).toBeVisible();
});

test('UI-W8: the theme follows the device unless chosen, and the choice applies before unlock', async ({ page }) => {
  const body = page.locator('body');
  await page.emulateMedia({ colorScheme: 'dark' });
  await createWallet(page);
  await openSettings(page, 'Appearance');
  await expect(body).toHaveCSS('background-color', 'rgb(15, 15, 18)');
  await expect(page.getByLabel('Same as this device')).toBeChecked();
  await page.getByLabel('Light').check();
  await expect(body).toHaveCSS('background-color', 'rgb(244, 243, 239)');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Unlock' })).toBeVisible();
  await expect(body).toHaveCSS('background-color', 'rgb(244, 243, 239)');
  await unlock(page);
  await expect(page.getByLabel('Light')).toBeChecked();
  await page.getByLabel('Same as this device').check();
  await expect(body).toHaveCSS('background-color', 'rgb(15, 15, 18)');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(body).toHaveCSS('background-color', 'rgb(244, 243, 239)');
});
