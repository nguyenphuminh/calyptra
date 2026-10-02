// Paying in a tab and settling it (all-ref §10.7.4 and §10.7.5: UI-C1, UI-C4, UI-C6): confirmed and
// cancelled payments, payments both ways, nicknames, a locked receiver, a dollar tab, settling, and a
// tab carried by an export file into a fresh browser.
import type { Page } from '@playwright/test';
import {
  addMoney, card, confirmRelayed, createInvite, createWallet, devWallet, expect, fundPublicly, openSettings, openTab, openTabs, openWallet,
  PASSWORD, payInTab, startDialog, tabStatus, tabView, test, unlock, useDevNetwork,
} from './helpers.ts';

const REMINDER = 'Open Calyptra at least every few days while you have open tabs or subscriptions.';

/** Starts a MON tab from an invite link with nothing asked of the other side, and waits until it is live. */
async function startLiveTab(page: Page, link: string, put: string, nickname?: string): Promise<void> {
  await page.goto(link);
  const dialog = startDialog(page);
  await expect(dialog.getByLabel('Invite link or code')).toHaveValue(link.split('/invite/')[1] ?? '');
  await expect(dialog).toContainText('Dispute window: 7 days');
  if (nickname) await dialog.getByLabel('Nickname (optional)').fill(nickname);
  await dialog.getByLabel('Currency').selectOption('native');
  await dialog.getByLabel('You put in (MON)').fill(put);
  await dialog.getByRole('button', { name: 'Start a tab', exact: true }).click();
  await confirmRelayed(page, 'Start a tab');
  await expect(tabStatus(tabView(page))).toHaveText('Live', { timeout: 120_000 });
}

async function nameThem(tab: ReturnType<typeof tabView>, button: 'Add a nickname' | 'Rename', name: string): Promise<void> {
  await tab.getByRole('button', { name: button }).click();
  await tab.getByLabel('Nickname', { exact: true }).fill(name);
  await tab.getByRole('button', { name: 'Save' }).click();
}

test('UI-C1: confirmed and cancelled payments, payments both ways, nicknames, then settle', async ({ newUser }) => {
  const [alice, bob] = await Promise.all([devWallet(newUser, 'alice', '0.1'), devWallet(newUser, 'bob')]);
  const link = await createInvite(bob);
  await startLiveTab(alice, link, '0.05', 'Bob');
  const aliceTab = tabView(alice);
  await expect(aliceTab.getByRole('heading', { level: 2 })).toContainText('Bob');
  await expect(alice.getByTestId('channel-item')).toContainText('Bob');
  await expect(aliceTab.getByTestId('channel-mine')).toHaveText('0.0499 MON');
  await expect(alice.getByText(REMINDER)).toBeVisible();

  const bobTab = await openTab(bob);
  await expect(tabStatus(bobTab)).toHaveText('Live', { timeout: 120_000 });
  await expect(bobTab.getByRole('heading', { level: 2 })).toHaveText(/Peer [A-Za-z0-9]{6}/);

  await payInTab(alice, aliceTab, '0.01', true);
  await expect(aliceTab.getByTestId('channel-mine')).toHaveText('0.0399 MON');
  await expect(bobTab.getByTestId('channel-mine')).toHaveText('0.01 MON');
  await payInTab(alice, aliceTab, '0.005', false);
  await expect(aliceTab.getByRole('alert')).toHaveText('The payment was not confirmed');
  await expect(aliceTab.getByTestId('channel-mine')).toHaveText('0.0399 MON');
  await payInTab(bob, bobTab, '0.002', true);
  await expect(bobTab.getByTestId('channel-mine')).toHaveText('0.008 MON');
  await expect(aliceTab.getByTestId('channel-mine')).toHaveText('0.0419 MON');

  await nameThem(bobTab, 'Add a nickname', 'Alice');
  await expect(bobTab.getByRole('heading', { level: 2 })).toContainText('Alice');
  await aliceTab.getByRole('button', { name: 'Rename' }).click();
  await expect(aliceTab.getByLabel('Nickname', { exact: true })).toHaveValue('Bob');
  await aliceTab.getByLabel('Nickname', { exact: true }).fill('Bob from work');
  await aliceTab.getByRole('button', { name: 'Save' }).click();
  await expect(aliceTab.getByRole('heading', { level: 2 })).toHaveText('Bob from work');
  await expect(alice.getByTestId('channel-item')).toContainText('Bob from work');
  await expect(aliceTab.getByRole('heading', { level: 2 })).not.toContainText('Alice'); // nicknames are never sent

  await aliceTab.getByRole('button', { name: 'Settle', exact: true }).click();
  await confirmRelayed(alice, 'Settle');
  await expect(tabStatus(aliceTab)).toHaveText('Settled', { timeout: 120_000 });
  await expect(tabStatus(bobTab)).toHaveText('Settled', { timeout: 120_000 });
  await expect(alice.getByText(REMINDER)).toHaveCount(0);
  await openWallet(bob);
  await expect(bob.getByTestId('shielded-native')).toHaveText('0.008 MON');
});

test('UI-C4: a dollar tab from a pasted code; a payment to a locked wallet waits and goes first', async ({ newUser }) => {
  const alice = await newUser('alice');
  await createWallet(alice);
  await useDevNetwork(alice);
  await fundPublicly(alice, '1', '10');
  await addMoney(alice, 'stablecoin', '10');
  await expect(alice.getByTestId('shielded-stablecoin')).toHaveText('$10.00');
  const bob = await devWallet(newUser, 'bob');
  const code = (await createInvite(bob)).split('/invite/')[1] ?? '';

  await openTabs(alice);
  await alice.getByRole('link', { name: 'Start a tab' }).first().click();
  const dialog = startDialog(alice);
  await expect(dialog.getByLabel('Invite link or code')).toHaveValue('');
  await dialog.getByLabel('Invite link or code').fill(code);
  await expect(dialog.getByLabel('Currency')).toHaveValue('stablecoin');
  await dialog.getByLabel('You put in ($)').fill('5');
  await dialog.getByRole('button', { name: 'Start a tab', exact: true }).click();
  await confirmRelayed(alice, 'Start a tab', '$0.01');
  const aliceTab = tabView(alice);
  await expect(tabStatus(aliceTab)).toHaveText('Live', { timeout: 120_000 });
  let bobTab = await openTab(bob);
  await expect(tabStatus(bobTab)).toHaveText('Live', { timeout: 120_000 });
  await expect(aliceTab.getByTestId('channel-mine')).toHaveText('$4.99');

  await payInTab(alice, aliceTab, '1', true, 'stablecoin');
  await expect(aliceTab.getByTestId('channel-mine')).toHaveText('$3.99');
  await expect(bobTab.getByTestId('channel-mine')).toHaveText('$1.00');

  await bob.getByRole('button', { name: 'Lock' }).click();
  await expect(bob.getByRole('heading', { name: 'Unlock your wallet' })).toBeVisible();
  await payInTab(alice, aliceTab, '0.5', true, 'stablecoin');
  await expect(aliceTab.getByRole('alert')).toHaveText('The other party is not reachable right now');
  await expect(aliceTab.getByTestId('channel-mine')).toHaveText('$3.99');

  await unlock(bob);
  await createInvite(bob); // reachable again through the relay
  bobTab = await openTab(bob);
  await payInTab(alice, aliceTab, '0.25', true, 'stablecoin');
  await expect(aliceTab.getByTestId('channel-mine')).toHaveText('$3.24'); // the waiting 0.5 went first
  await expect(bobTab.getByTestId('channel-mine')).toHaveText('$1.75');
});

test('UI-C6: a live tab restored from an export file in a fresh browser can be paid and settled', async ({ newUser }, testInfo) => {
  const [alice, bob] = await Promise.all([devWallet(newUser, 'alice', '0.1'), devWallet(newUser, 'bob')]);
  const link = await createInvite(bob);
  await startLiveTab(alice, link, '0.03');
  const aliceTab = tabView(alice);
  const bobTab = await openTab(bob);
  await expect(tabStatus(bobTab)).toHaveText('Live', { timeout: 120_000 });
  await payInTab(alice, aliceTab, '0.01', true);
  await expect(bobTab.getByTestId('channel-mine')).toHaveText('0.01 MON');
  await nameThem(bobTab, 'Add a nickname', 'Alice');
  await expect(bobTab.getByRole('heading', { level: 2 })).toHaveText('Alice');

  await openSettings(bob, 'Backup');
  const download = bob.waitForEvent('download');
  await card(bob, 'Export').getByRole('button', { name: 'Download export file' }).click();
  const file = testInfo.outputPath('bob-export.json');
  await (await download).saveAs(file);
  await bob.context().close();

  const restored = await newUser('bob-restored');
  await restored.goto('/');
  await restored.getByRole('button', { name: 'Use a recovery phrase instead' }).click();
  await restored.getByRole('button', { name: 'Restore from an export file' }).click();
  await restored.getByLabel('Export file', { exact: true }).setInputFiles(file);
  await restored.getByLabel('Password of the export file').fill(PASSWORD);
  await restored.getByRole('button', { name: 'Restore' }).click();
  await expect(restored.getByRole('button', { name: 'Lock' })).toBeVisible();
  await createInvite(restored); // reachable through the relay again
  const restoredTab = await openTab(restored);
  await expect(tabStatus(restoredTab)).toHaveText('Live', { timeout: 120_000 });
  await expect(restoredTab.getByTestId('channel-mine')).toHaveText('0.01 MON');
  await expect(restoredTab.getByRole('heading', { level: 2 })).toHaveText('Alice');

  await payInTab(alice, aliceTab, '0.002', true);
  await expect(restoredTab.getByTestId('channel-mine')).toHaveText('0.012 MON');
  await restoredTab.getByRole('button', { name: 'Settle', exact: true }).click();
  await confirmRelayed(restored, 'Settle');
  await expect(tabStatus(restoredTab)).toHaveText('Settled', { timeout: 120_000 });
  await expect(tabStatus(aliceTab)).toHaveText('Settled', { timeout: 120_000 });
  await openWallet(restored);
  await expect(restored.getByTestId('shielded-native')).toHaveText('0.012 MON');
});
