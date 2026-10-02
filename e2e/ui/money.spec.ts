// Add money, Send, Cash out (all-ref §10.7.2: UI-P1, UI-P2), in the consumer wording of §11.6.
import { parseEther, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { devPublicClient } from '../../scripts/lib/devnode.ts';
import {
  card, confirmRelayed, createWallet, devNetworkInfo, expect, fundPublicly, openAction, openWallet, popup, test, useDevNetwork,
} from './helpers.ts';

const freshAddress = (): Address => privateKeyToAccount(generatePrivateKey()).address;

const BALANCE_OF_ABI = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }] as const;

test('UI-P1: add MON (presets, round-amount hint), send it privately, cash out to a fresh address', async ({ newUser }) => {
  const alice = await newUser('alice');
  const bob = await newUser('bob');
  await Promise.all([createWallet(alice), createWallet(bob)]);
  await Promise.all([useDevNetwork(alice), useDevNetwork(bob)]);

  await fundPublicly(alice, '1');
  await expect(alice.getByTestId('public-native')).toHaveText('1 MON');
  await expect(card(alice, 'Account balance')).toContainText('Everyone can see this address and its balance.');
  await expect(alice.getByText('Send publicly')).toHaveCount(0);

  await openAction(alice, 'Receive');
  const receive = popup(alice, 'Receive');
  await expect(receive.getByRole('region', { name: 'Account address' }).getByRole('img', { name: 'Address QR code' })).toBeVisible();
  const privatePart = receive.getByRole('region', { name: 'Private payments' });
  await expect(privatePart.getByRole('img', { name: 'Calyptra ID QR code' })).toBeVisible();
  await expect(privatePart).toContainText('nobody else can see payments to it');
  await receive.getByRole('button', { name: 'Close' }).click();
  await expect(receive).toBeHidden();

  await openAction(alice, 'Add money');
  const add = popup(alice, 'Add money');
  await add.getByLabel('Currency').selectOption('native');
  await add.getByLabel('Amount (MON)').fill('0.15');
  await expect(add).toContainText('Round amounts (1, 10, 100…) are harder to trace');
  await expect(add.getByRole('button', { name: 'Add money', exact: true })).toBeEnabled();
  await add.getByRole('button', { name: '0.1', exact: true }).click();
  await expect(add).not.toContainText('Round amounts');
  await add.getByRole('button', { name: 'Add money', exact: true }).click();
  await expect(add).toBeHidden({ timeout: 120_000 });
  await expect(alice.getByTestId('shielded-native')).toHaveText('0.1 MON');
  await expect.poll(async () => parseEther(((await alice.getByTestId('public-native').getAttribute('title')) ?? '').split(' ')[0] ?? '1'))
    .toBeLessThan(parseEther('0.9'));

  await openWallet(bob);
  const bobId = bob.getByTestId('shielded-address');
  await expect(bobId).toHaveText(/^cal[0-9a-f]{8}…[0-9a-f]{8}$/);
  await expect(bobId).toHaveAttribute('title', /^cal[0-9a-f]{136}$/);
  const calyptraId = (await bobId.getAttribute('title')) ?? '';

  await openAction(alice, 'Send');
  const send = popup(alice, 'Send');
  await send.getByLabel('To Calyptra ID').fill(calyptraId);
  await send.getByLabel('Currency').selectOption('native');
  await send.getByLabel('Amount (MON)').fill('0.03');
  await send.getByRole('button', { name: 'Send', exact: true }).click();
  await confirmRelayed(alice, 'Send');
  await expect(send).toBeHidden();
  await expect(alice.getByTestId('shielded-native')).toHaveText('0.0699 MON');
  await expect(bob.getByTestId('shielded-native')).toHaveText('0.03 MON');

  const exit = freshAddress();
  await openAction(bob, 'Cash out');
  const cashOut = popup(bob, 'Cash out');
  await expect(cashOut).toContainText('Tip: waiting longer between adding money and cashing out');
  await cashOut.getByLabel('Currency').selectOption('native');
  await cashOut.getByRole('button', { name: '0.01', exact: true }).click();
  await expect(cashOut.getByRole('button', { name: 'Cash out', exact: true })).toBeDisabled();
  await expect(cashOut).toContainText('for example a new account in MetaMask');
  await cashOut.getByLabel('Recipient address').fill(exit);
  await cashOut.getByRole('button', { name: 'Cash out', exact: true }).click();
  await confirmRelayed(bob, 'Cash out');
  await expect(cashOut).toContainText(`Cashed out to ${exit}.`);
  expect(await devPublicClient().getBalance({ address: exit })).toBe(parseEther('0.01'));
  await cashOut.getByRole('button', { name: 'Close' }).click();
  await expect(bob.getByTestId('shielded-native')).toHaveText('0.0199 MON');
  await expect(bob.getByRole('combobox', { name: 'Account' }).locator('option')).toHaveCount(1);
});

test('UI-P2: dollars: add with approval, send, refuse more than the balance, cash out', async ({ newUser }) => {
  const alice = await newUser('alice');
  const bob = await newUser('bob');
  await Promise.all([createWallet(alice), createWallet(bob)]);
  await Promise.all([useDevNetwork(alice), useDevNetwork(bob)]);

  await fundPublicly(alice, '1', '100');
  await expect(alice.getByTestId('public-stablecoin')).toHaveText('$100.00');

  await openAction(alice, 'Add money');
  const add = popup(alice, 'Add money');
  await expect(add.getByLabel('Currency')).toHaveValue('stablecoin'); // dollars first (§11.6)
  await expect(add.getByRole('button', { name: '1000', exact: true })).toBeVisible();
  await add.getByRole('button', { name: '10', exact: true }).click();
  await add.getByRole('button', { name: 'Add money', exact: true }).click();
  await expect(add).toBeHidden({ timeout: 120_000 });
  await expect(alice.getByTestId('shielded-stablecoin')).toHaveText('$10.00');
  await expect(alice.getByTestId('shielded-stablecoin')).toHaveAttribute('title', '10 AUSD');

  await openWallet(bob);
  const calyptraId = (await bob.getByTestId('shielded-address').getAttribute('title')) ?? '';
  expect(calyptraId).toMatch(/^cal[0-9a-f]{136}$/);

  await openAction(alice, 'Send');
  let send = popup(alice, 'Send');
  await send.getByLabel('To Calyptra ID').fill(calyptraId);
  await send.getByLabel('Amount ($)').fill('2.5');
  await send.getByRole('button', { name: 'Send', exact: true }).click();
  await confirmRelayed(alice, 'Send', '$0.01');
  await expect(alice.getByTestId('shielded-stablecoin')).toHaveText('$7.49');
  await expect(bob.getByTestId('shielded-stablecoin')).toHaveText('$2.50');

  await openAction(alice, 'Send');
  send = popup(alice, 'Send');
  await send.getByLabel('To Calyptra ID').fill(calyptraId);
  await send.getByLabel('Amount ($)').fill('50');
  await send.getByRole('button', { name: 'Send', exact: true }).click();
  const review = popup(alice, 'Confirm: Send');
  await review.getByRole('button', { name: 'Confirm' }).click();
  await expect(review.getByRole('alert')).toHaveText('Not enough shielded funds in this token (including the relayer fee)');
  await review.getByRole('button', { name: 'Cancel' }).click();
  await expect(review).toBeHidden();
  await send.getByRole('button', { name: 'Close' }).click();
  await expect(send).toBeHidden();
  await expect(alice.getByTestId('shielded-stablecoin')).toHaveText('$7.49');

  const to = freshAddress();
  await openAction(bob, 'Cash out');
  const cashOut = popup(bob, 'Cash out');
  await cashOut.getByRole('button', { name: '1', exact: true }).click();
  await cashOut.getByLabel('Recipient address').fill(to);
  await cashOut.getByRole('button', { name: 'Cash out', exact: true }).click();
  await confirmRelayed(bob, 'Cash out', '$0.01');
  await expect(cashOut).toContainText(`Cashed out to ${to}.`);
  const { stablecoin } = devNetworkInfo();
  expect(await devPublicClient().readContract({ address: stablecoin, abi: BALANCE_OF_ABI, functionName: 'balanceOf', args: [to] })).toBe(1_000_000n);
  await cashOut.getByRole('button', { name: 'Close' }).click();
  await expect(bob.getByTestId('shielded-stablecoin')).toHaveText('$1.49');
});
