// Settling without the other side (UI-D1, UI-D2, UI-D3). The website always opens tabs
// with the 7-day window, so the counterparty is a framework node in the test process that opens with a
// 20-second window (the test contracts accept 10 s and up); the web wallet is the invitee.
import { setTimeout as sleep } from 'node:timers/promises';
import type { Page } from '@playwright/test';
import { parseEther } from 'viem';
import { NetworkConfigSchema, decodeInvite, type Calyptra } from '../../packages/framework/src/index.ts';
import { channelNullifierOf } from '../../packages/framework/src/shared/protocol/index.ts';
import {
  card, createInvite, devNetworkInfo, devWallet, expect, fundAddress, mineBlock, openSettings, openTab, openWallet, PASSWORD, popup,
  tabStatus, test,
} from './helpers.ts';
import { startPeer } from './peer.ts';

const WINDOW = 20n;

/** Framework Alice: 0.1 MON in her private balance; her relayer and relay are the desktop client's. */
async function frameworkAlice(): Promise<Calyptra> {
  const alice = await startPeer(NetworkConfigSchema.parse(devNetworkInfo()), { disputeWindow: WINDOW });
  await fundAddress(alice.wallet.activeAccount().address, '1');
  await alice.pool.deposit(0n, parseEther('0.1'));
  await alice.pool.sync();
  return alice;
}

const shielded = (alice: Calyptra): bigint => alice.pool.balances().get(0n) ?? 0n;

/** Ticks Alice until her record of the tab reaches `status`; every tick must report no problem. */
async function tickUntil(alice: Calyptra, id: string, status: string): Promise<void> {
  await expect.poll(async () => {
    expect(await alice.tick()).toEqual([]);
    return alice.channels.get(id).status;
  }, { timeout: 120_000, intervals: [1_000] }).toBe(status);
}

/** The nonce of the state pending in the contract's dispute of this tab. */
const disputedNonce = async (alice: Calyptra, id: string): Promise<bigint> =>
  (await alice.chain.disputeOf(channelNullifierOf(alice.channels.get(id).params.channelSecret))).nonce;

/** Waits out the dispute window, then mines a block so the chain's clock passes the deadline. */
async function passDeadline(): Promise<void> {
  await sleep(Number(WINDOW) * 1000 + 1500);
  await mineBlock();
}

/** Alice opens a MON tab with web Bob (Bob asked for `peer`, which he accepts in the dialog), then both are live. */
async function liveTab(alice: Calyptra, bob: Page, amount: string, peer?: string): Promise<string> {
  const invite = decodeInvite(await createInvite(bob));
  const opening = alice.channels.open(invite, {
    token: 0n, amount: parseEther(amount), ...(peer ? { peerAmount: parseEther(peer) } : {}), window: WINDOW, relayer: alice.relayer(),
  });
  if (peer) await popup(bob, 'Tab request').getByRole('button', { name: 'Accept' }).click();
  const { id } = await opening;
  await tickUntil(alice, id, 'live');
  await expect(tabStatus(await openTab(bob))).toHaveText('Live', { timeout: 120_000 });
  return id;
}

test('UI-D1: the website settles without the other side with its latest balances; both get their share', async ({ newUser }) => {
  const alice = await frameworkAlice();
  try {
    const bob = await devWallet(newUser, 'bob');
    const id = await liveTab(alice, bob, '0.02');
    const bobTab = await openTab(bob);
    await alice.channels.pay(id, parseEther('0.01'));
    await expect(bobTab.getByTestId('channel-mine')).toHaveText('0.01 MON');
    const before = shielded(alice);

    await bobTab.getByRole('button', { name: 'Settle without the other side' }).click();
    await popup(bob, 'Settle without the other side').getByRole('button', { name: 'Settle without them' }).click();
    await expect(tabStatus(bobTab)).toHaveText('Settling without them', { timeout: 120_000 });
    const latestNonce = alice.channels.get(id).history.at(-1)?.[3];
    await expect.poll(() => disputedNonce(alice, id), { timeout: 60_000 }).toBe(latestNonce);

    await passDeadline();
    await expect(tabStatus(bobTab)).toHaveText('Settled', { timeout: 120_000 }); // the open wallet finalizes on its own
    await openWallet(bob);
    await expect(bob.getByTestId('shielded-native')).toHaveText('0.01 MON');
    await tickUntil(alice, id, 'settled');
    await alice.pool.sync();
    expect(shielded(alice)).toBe(before + alice.channels.get(id).latest.state.balA);
  } finally {
    await alice.lock();
  }
});

test('UI-D2: the website answers an old balance with its latest one by itself, then finalizes', async ({ newUser }) => {
  const alice = await frameworkAlice();
  try {
    const bob = await devWallet(newUser, 'bob');
    const id = await liveTab(alice, bob, '0.02');
    const bobTab = await openTab(bob);
    await alice.channels.pay(id, parseEther('0.01'));
    await expect(bobTab.getByTestId('channel-mine')).toHaveText('0.01 MON');
    const latestNonce = alice.channels.get(id).latest.state.nonce;

    await alice.channels.update(id, (r) => { r.latest = r.state0; }); // Alice cheats with the opening balances
    await alice.disputes.start(id, alice.relayer());
    await expect(tabStatus(bobTab)).toHaveText('Settling without them', { timeout: 120_000 });
    await expect.poll(() => disputedNonce(alice, id), { timeout: 60_000 }).toBe(latestNonce); // Bob's wallet answered

    await passDeadline();
    await expect(tabStatus(bobTab)).toHaveText('Settled', { timeout: 120_000 });
    await openWallet(bob);
    await expect(bob.getByTestId('shielded-native')).toHaveText('0.01 MON');
    await tickUntil(alice, id, 'settled');
  } finally {
    await alice.lock();
  }
});

test('UI-D3: a wallet restored after the other side settled with old balances takes back its own money', async ({ newUser }, testInfo) => {
  const alice = await frameworkAlice();
  try {
    const bob = await devWallet(newUser, 'bob', '0.1');
    const id = await liveTab(alice, bob, '0.02', '0.01');
    expect(alice.channels.get(id).status).toBe('live');
    const bobTab = await openTab(bob);
    await alice.channels.pay(id, parseEther('0.005'));
    await expect(bobTab.getByTestId('channel-mine')).toHaveText('0.015 MON');

    await openSettings(bob, 'Backup');
    const download = bob.waitForEvent('download');
    await card(bob, 'Export').getByRole('button', { name: 'Download export file' }).click();
    const file = testInfo.outputPath('bob-export.json');
    await (await download).saveAs(file);
    await bob.context().close();

    await alice.channels.update(id, (r) => { r.latest = r.state0; }); // state 0 leaves out Bob's contribution
    await alice.disputes.start(id, alice.relayer());
    await passDeadline();
    await tickUntil(alice, id, 'settled');

    const restored = await newUser('bob-restored');
    await restored.goto('/');
    await restored.getByRole('button', { name: 'Use a recovery phrase instead' }).click();
    await restored.getByRole('button', { name: 'Restore from an export file' }).click();
    await restored.getByLabel('Export file', { exact: true }).setInputFiles(file);
    await restored.getByLabel('Password of the export file').fill(PASSWORD);
    await restored.getByRole('button', { name: 'Restore' }).click();
    await expect(restored.getByRole('button', { name: 'Lock' })).toBeVisible();
    await expect(tabStatus(await openTab(restored))).toHaveText('Settled', { timeout: 120_000 });
    await openWallet(restored);
    // 0.1 - 0.01 put in - 0.0001 fee + (0.01 taken back - 0.0001 fee); the 0.005 Alice paid is lost.
    await expect(restored.getByTestId('shielded-native')).toHaveText('0.0998 MON');
  } finally {
    await alice.lock();
  }
});
