// Starting a tab (UI-C2, UI-C3 with its dispute start, UI-C5, UI-C7):
// approvals, declines, unanswered requests, a funding that fails, cancelling, and the balance check
// before the other side hears of anything. In the app's wording, a channel is a "tab".
import type { Page } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  confirmRelayed, createInvite, devWallet, expect, openAction, openTab, openTabs, openWallet, popup, startDialog, tabStatus, tabView, test,
} from './helpers.ts';

const ENDED = 'This tab request ended: it was declined or not answered in time.';

/** Opens the invite link and fills the Start a tab dialog (in MON); the review is left open. */
async function startTab(page: Page, link: string, terms: { nickname?: string; put: string; ask?: string }): Promise<void> {
  await page.goto(link);
  const dialog = startDialog(page);
  if (terms.nickname) await dialog.getByLabel('Nickname (optional)').fill(terms.nickname);
  await dialog.getByLabel('Currency').selectOption('native');
  await dialog.getByLabel('You put in (MON)').fill(terms.put);
  if (terms.ask) await dialog.getByLabel('Ask them to put in (MON, optional)').fill(terms.ask);
  await dialog.getByRole('button', { name: 'Start a tab', exact: true }).click();
  await expect(popup(page, 'Confirm: Start a tab')).toContainText('Network fee: 0.0001 MON');
}

async function confirmStart(page: Page): Promise<void> {
  await popup(page, 'Confirm: Start a tab').getByRole('button', { name: 'Confirm' }).click();
  // The tab starts in the background: the dialog closes at once, before the other side answers.
  await expect(startDialog(page)).toBeHidden({ timeout: 15_000 });
}

test('UI-C2: a funding that fails after acceptance is shown with its reason and can be cancelled', async ({ newUser }) => {
  const [alice, bob] = await Promise.all([devWallet(newUser, 'alice', '0.1'), devWallet(newUser, 'bob', '0.1')]);
  const link = await createInvite(bob);
  await startTab(alice, link, { nickname: 'Bob', put: '0.05', ask: '0.01' });
  await confirmStart(alice);
  const request = popup(bob, 'Tab request');
  await expect(request).toBeVisible();

  // While Bob decides, Alice spends the money she meant to put in.
  await openAction(alice, 'Cash out');
  const cashOut = popup(alice, 'Cash out');
  await cashOut.getByLabel('Currency').selectOption('native');
  await cashOut.getByLabel('Amount (MON)').fill('0.09');
  await cashOut.getByLabel('Recipient address').fill(privateKeyToAccount(generatePrivateKey()).address);
  await cashOut.getByRole('button', { name: 'Cash out', exact: true }).click();
  await confirmRelayed(alice, 'Cash out');
  await cashOut.getByRole('button', { name: 'Close' }).click();
  await expect(alice.getByTestId('shielded-native')).toHaveText('0.0099 MON');

  await request.getByRole('button', { name: 'Accept' }).click();
  await expect(request).toBeHidden();

  const aliceTab = await openTab(alice);
  await expect(aliceTab.getByRole('alert')).toContainText('Starting this tab failed: Not enough in your private balance', { timeout: 120_000 });
  await expect(tabStatus(aliceTab)).toHaveText('Starting');
  const bobTab = await openTab(bob);
  await expect(tabStatus(bobTab)).toHaveText('Starting');
  await expect(bobTab.getByRole('button', { name: 'Cancel this tab' })).toHaveCount(0); // the opener may still be funding

  await aliceTab.getByRole('button', { name: 'Cancel this tab' }).click();
  await expect(aliceTab).toContainText('Cancelled before it started');
  await expect(bobTab).toContainText('Cancelled before it started');
  await expect(tabStatus(aliceTab)).toHaveText('Cancelled');
  await expect(tabStatus(bobTab)).toHaveText('Cancelled');
  await openWallet(alice);
  await openWallet(bob);
  await expect(alice.getByTestId('shielded-native')).toHaveText('0.0099 MON');
  await expect(bob.getByTestId('shielded-native')).toHaveText('0.1 MON');
});

test('UI-C3: a request is answered from the tab list: declined, then accepted; then settled without the other side', async ({ newUser }) => {
  const [alice, bob] = await Promise.all([devWallet(newUser, 'alice', '0.1'), devWallet(newUser, 'bob', '0.1')]);
  const terms = 'They put in 0.03 MON and ask you to put in 0.02 MON';
  const pending = alice.getByTestId('pending-open');

  for (const answer of ['decline', 'accept'] as const) {
    const link = await createInvite(bob);
    await startTab(alice, link, { nickname: 'Bob', put: '0.03', ask: '0.02' });
    await confirmStart(alice);

    const request = popup(bob, 'Tab request');
    await expect(request).toContainText(terms);
    await expect(request).toContainText('Dispute window: 7 days');
    await expect(request).toContainText(/\d+ s left to answer/);
    await request.getByRole('button', { name: 'Close' }).click();
    await expect(request).toBeHidden();

    await openTabs(bob);
    await expect(bob.getByTestId('channel-item').first()).toContainText('Request');
    await bob.getByTestId('channel-item').first().click();
    const conversation = bob.getByTestId('channel-request');
    await expect(conversation).toContainText(terms);
    await expect(conversation).toContainText('Dispute window: 7 days');
    await expect(conversation).toContainText(/\d+ s left to answer/);

    await expect(pending).toContainText('Waiting for Bob to accept');
    await expect(pending.getByRole('heading', { level: 2 })).toHaveText('Bob');
    await expect(alice.getByTestId('channel-item')).toHaveCount(1);
    await expect(alice.getByTestId('channel-item')).toContainText('Pending');

    if (answer === 'decline') {
      await openAction(alice, 'Receive'); // the request goes on while Alice uses other screens
      await popup(alice, 'Receive').getByRole('button', { name: 'Close' }).click();
      await conversation.getByRole('button', { name: 'Decline' }).click();
      await expect(bob.getByText(ENDED)).toBeVisible();
      await expect(bob.getByTestId('channel-item')).toHaveCount(0);
      await expect(alice.getByTestId('shielded-native')).toHaveText('0.1 MON');
      await openTabs(alice);
      const item = alice.getByTestId('channel-item');
      await expect(item).toContainText('Declined');
      await item.click();
      await expect(pending).toContainText('Bob declined, or did not answer in time');
      await expect(pending).toContainText('Nothing left your private balance');
      await pending.getByRole('button', { name: 'Dismiss' }).click();
      await expect(alice.getByTestId('channel-item')).toHaveCount(0);
      await expect(alice).toHaveURL(/#\/channels$/);
      continue;
    }

    await conversation.getByLabel('Nickname for them (optional)').fill('Alice');
    await conversation.getByRole('button', { name: 'Accept' }).click();
    const bobTab = tabView(bob);
    await expect(bobTab.getByRole('heading', { level: 2 })).toHaveText('Alice');
    await expect(conversation).toBeHidden();
    await expect(bob.getByTestId('channel-item')).toHaveCount(1);
    await expect(alice).toHaveURL(/#\/channels\/[0-9a-f]{32}$/);
    const url = alice.url();
    await alice.goBack(); // the request's own address leads to the tab
    await expect(alice).toHaveURL(url);
    await expect(pending).toBeHidden();
    await expect(alice.getByTestId('channel-item')).toHaveCount(1);

    const aliceTab = tabView(alice);
    await expect(tabStatus(bobTab)).toHaveText('Live', { timeout: 120_000 });
    await expect(tabStatus(aliceTab)).toHaveText('Live', { timeout: 120_000 });
    await expect(bobTab.getByTestId('channel-mine')).toHaveText('0.02 MON');
    await expect(bobTab.getByRole('heading', { level: 2 })).toContainText('Alice');

    // UI-C3 (end): settling without the other side starts a dispute; the window is 7 days.
    await bobTab.getByRole('button', { name: 'Settle without the other side' }).click();
    const dispute = popup(bob, 'Settle without the other side');
    await expect(dispute).toContainText('7-day window');
    await dispute.getByRole('button', { name: 'Settle without them' }).click();
    await expect(dispute).toBeHidden({ timeout: 120_000 });
    await expect(tabStatus(bobTab)).toHaveText('Settling without them');
    await expect(tabStatus(aliceTab)).toHaveText('Settling without them', { timeout: 120_000 });
  }
});

test('UI-C5: a request nobody answers counts as declined after about a minute', async ({ newUser }) => {
  const [alice, bob] = await Promise.all([devWallet(newUser, 'alice', '0.1'), devWallet(newUser, 'bob')]);
  const link = await createInvite(bob);
  await startTab(alice, link, { put: '0.02', ask: '0.01' });
  await confirmStart(alice);
  const request = popup(bob, 'Tab request');
  await expect(request).toContainText(/\d+ s left to answer/);
  await request.getByRole('button', { name: 'Close' }).click();
  await openTabs(bob);
  await bob.getByTestId('channel-item').first().click(); // Bob only looks

  const pending = alice.getByTestId('pending-open');
  await expect(pending).toContainText('Waiting for');
  await expect(pending).toContainText('declined, or did not answer in time', { timeout: 75_000 });
  await expect(alice.getByTestId('channel-item')).toContainText('Declined');
  await expect(bob.getByText(ENDED)).toBeVisible();
  await expect(bob.getByTestId('channel-item')).toHaveCount(0);
  await expect(alice.getByTestId('channel-item')).toHaveCount(1);
  await pending.getByRole('button', { name: 'Dismiss' }).click();
  await expect(alice.getByTestId('channel-item')).toHaveCount(0);
});

test('UI-C7: putting in more than the balance allows is refused before the other side hears of it', async ({ newUser }) => {
  const [alice, bob] = await Promise.all([devWallet(newUser, 'alice', '0.1'), devWallet(newUser, 'bob')]);
  const link = await createInvite(bob);
  await startTab(alice, link, { put: '0.1' });
  const review = popup(alice, 'Confirm: Start a tab');
  await review.getByRole('button', { name: 'Confirm' }).click();
  await expect(review.getByRole('alert')).toHaveText('Your private balance has 0.1 MON. Putting in 0.1 MON also pays the network fee of 0.0001 MON.');
  await review.getByRole('button', { name: 'Cancel' }).click();
  await expect(review).toBeHidden();
  await expect(startDialog(alice)).toBeVisible(); // still open, to lower the amount
  await startDialog(alice).getByRole('button', { name: 'Close' }).click();
  await expect(alice.getByText('No tabs yet.')).toBeVisible();
  await openTabs(bob);
  await expect(bob.getByText('No tabs yet.')).toBeVisible();
});
