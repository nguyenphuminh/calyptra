// §11.10 gates for Mera passkey accounts (§11.4) on localhost: create, unlock and restore with a DevTools
// virtual authenticator with PRF, and the recovery phrase's export and import round trip. A passkey's
// relying party is the site's hostname, and an IP address cannot be one, so these tests use localhost.
import type { Page } from '@playwright/test';
import { mnemonicToAccount } from 'viem/accounts';
import {
  card, createPasskeyWallet, expect, openSettings, openWallet, phraseWords, setPassword, test, virtualAuthenticator,
} from './helpers.ts';

const ORIGIN = 'http://localhost:5199';
test.use({ baseURL: ORIGIN });

const publicAddress = (page: Page) => page.getByTestId('public-address');

/** Settings › Backup › Show recovery phrase: the passkey wallet's 24 words. */
async function showPhrase(page: Page): Promise<string[]> {
  await openSettings(page, 'Backup');
  const phrase = card(page, 'Recovery phrase');
  await phrase.getByRole('button', { name: 'Show recovery phrase' }).click();
  await expect(phrase).toContainText('Anyone with these words controls your money.');
  return phraseWords(page);
}

test('passkey: create, unlock and restore on a new device, one prompt per key namespace', async ({ page }) => {
  const passkey = await virtualAuthenticator(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue with passkey' }).click();
  await expect(page.getByRole('button', { name: 'Create passkey' })).toBeDisabled(); // a name first
  await page.getByLabel('Your name').fill('Alice');
  await page.getByRole('button', { name: 'Create passkey' }).click();
  await expect(page.getByRole('button', { name: 'Lock' })).toBeVisible();
  // One passkey; its PRF is evaluated once for the phrase (at creation) and once for the vault key.
  expect(passkey.count).toEqual({ created: 1, asserted: 1 });
  const [credential] = await passkey.credentials();
  expect(credential?.rpId).toBe('localhost');
  const saved = await page.evaluate(() => localStorage.getItem('calyptra.credential'));
  expect(JSON.parse(saved ?? '{}')).toEqual({ credentialId: expect.any(String), transports: expect.any(Array) }); // metadata only
  await openWallet(page);
  const address = (await publicAddress(page).getAttribute('title')) ?? '';
  expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Unlock your wallet' })).toBeVisible();
  await expect(page.getByLabel('Wallet password', { exact: true })).toHaveCount(0); // no password to type
  await page.getByRole('button', { name: 'Unlock with passkey' }).click();
  await expect(page.getByRole('button', { name: 'Lock' })).toBeVisible();
  expect(passkey.count.asserted).toBe(2); // unlocking is one prompt
  await expect(publicAddress(page)).toHaveAttribute('title', address);

  // A new device: nothing of the site is stored, but the passkey is there (the authenticator keeps it).
  await page.goto('about:blank');
  await passkey.clearSiteData(ORIGIN);
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue with passkey' }).click();
  await page.getByRole('button', { name: 'I already have a passkey' }).click();
  await expect(page.getByRole('button', { name: 'Lock' })).toBeVisible();
  expect(passkey.count).toEqual({ created: 1, asserted: 4 }); // restoring is two prompts: phrase and vault
  await openWallet(page);
  await expect(publicAddress(page)).toHaveAttribute('title', address);
});

test('recovery phrase: shown with the passkey, imported elsewhere it gives the same account; the export file needs its own password', async ({ page, newUser }, testInfo) => {
  const passkey = await virtualAuthenticator(page);
  await createPasskeyWallet(page, 'Alice');
  await openWallet(page);
  const address = (await publicAddress(page).getAttribute('title')) ?? '';
  const before = passkey.count.asserted;
  const words = await showPhrase(page);
  expect(passkey.count.asserted - before).toBe(1); // showing the phrase asks for the passkey again
  expect(words).toHaveLength(24);
  expect(mnemonicToAccount(words.join(' ')).address).toBe(address); // the standard path: same account in any wallet

  // Import: the phrase in another browser, through the recovery-phrase way in.
  const other = await newUser('imported');
  await other.goto('/');
  await other.getByRole('button', { name: 'Use a recovery phrase instead' }).click();
  await other.getByRole('button', { name: 'Import a recovery phrase or private key' }).click();
  await other.getByLabel('Recovery phrase or private key').fill(words.join(' '));
  await setPassword(other, 'Import wallet');
  await openWallet(other);
  await expect(publicAddress(other)).toHaveAttribute('title', address);

  // Export: a passkey wallet has no password, so its export file gets one of its own.
  await openSettings(page, 'Backup');
  const exportCard = card(page, 'Export');
  await exportCard.getByLabel('Export password', { exact: true }).fill('export password 1');
  await exportCard.getByLabel('Repeat the export password').fill('export password 1');
  const download = page.waitForEvent('download');
  await exportCard.getByRole('button', { name: 'Download export file' }).click();
  const file = testInfo.outputPath('passkey-export.json');
  await (await download).saveAs(file);
  const restored = await newUser('restored');
  await restored.goto('/');
  await restored.getByRole('button', { name: 'Use a recovery phrase instead' }).click();
  await restored.getByRole('button', { name: 'Restore from an export file' }).click();
  await restored.getByLabel('Export file', { exact: true }).setInputFiles(file);
  await restored.getByLabel('Password of the export file').fill('export password 1');
  await restored.getByRole('button', { name: 'Restore' }).click();
  await expect(restored.getByRole('button', { name: 'Lock' })).toBeVisible();
  await openWallet(restored);
  await expect(publicAddress(restored)).toHaveAttribute('title', address);
});

test('passkey errors: a passkey without PRF is explained; a cancelled prompt returns to the first screen silently', async ({ page, newUser }) => {
  await virtualAuthenticator(page, { prf: false });
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue with passkey' }).click();
  await page.getByLabel('Your name').fill('Alice');
  await page.getByRole('button', { name: 'Create passkey' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    "This passkey can't unlock Calyptra on this browser. Save it to iCloud Keychain, Google Password Manager or 1Password, or continue with a recovery phrase.",
  );

  const cancelling = await newUser('cancelling');
  await virtualAuthenticator(cancelling, { verified: false }); // the user does not confirm: the browser reports NotAllowedError
  await cancelling.goto('/');
  await cancelling.getByRole('button', { name: 'Continue with passkey' }).click();
  await cancelling.getByLabel('Your name').fill('Bob');
  await cancelling.getByRole('button', { name: 'Create passkey' }).click();
  await expect(cancelling.getByRole('button', { name: 'Continue with passkey' })).toBeVisible();
  await expect(cancelling.getByRole('alert')).toHaveCount(0);
});
