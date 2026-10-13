// What each kind of address is for, said the same way wherever it is shown.
// Consumer wording: the shielded address is the "Calyptra ID", the public address the
// account address; no blockchain is named, and MON is mentioned only for network fees.

export const SHIELDED_ADDRESS_TEXT = 'Your Calyptra ID. Share it to get paid privately: nobody else can see payments to it.';
export const PUBLIC_ADDRESS_TEXT =
  'Your account address. To add money, send AUSD here from another wallet, such as MetaMask, then move it into your private balance. Keep a little MON here for network fees. Everyone can see this address and its balance.';

/** An address short enough to read at a glance: its start and end, as wallets show them. The full one is copied. */
export function shortAddress(address: string): string {
  const [head, tail] = address.startsWith('0x') ? [6, 4] : [11, 8];
  return address.length <= head + tail + 1 ? address : `${address.slice(0, head)}…${address.slice(-tail)}`;
}
