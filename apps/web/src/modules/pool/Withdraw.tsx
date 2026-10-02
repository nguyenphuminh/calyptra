import { useCallback, useState } from 'react';
import { isAddress, type Address } from 'viem';
import { useApp } from '../../app/context.ts';
import { DEFAULT_TOKEN, parseAmount, tokenId, type TokenName } from '../../shared/amounts.ts';
import { AmountField, closeTo, Field, Modal, Notice, RelayedSubmit } from '../../shared/ui.tsx';
import { TokenSelect } from '../public/index.ts';
import { presetsOf } from './Deposit.tsx';

/** The typed amount with its currency, as a confirmation repeats it. */
export const typedAmount = (token: TokenName, text: string): string => (token === 'stablecoin' ? `$${text.trim()}` : `${text.trim()} MON`);

/** Cash out: a withdrawal from the private balance to an address the user enters (BRD 2.2.5). */
export function Withdraw() {
  const { calyptra, refresh } = useApp();
  const network = calyptra.network();
  const [token, setToken] = useState<TokenName>(DEFAULT_TOKEN);
  const [amount, setAmount] = useState('');
  const [address, setAddress] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const parsed = parseAmount(token, amount);
  const run = useCallback(async (relayer: Parameters<typeof calyptra.pool.withdraw>[3]) => {
    if (parsed === null) return;
    await calyptra.pool.withdraw(tokenId(token, network), parsed, address as Address, relayer);
    setDone(address);
  }, [calyptra, network, token, parsed, address]);
  return (
    <Modal title="Cash out" onClose={closeTo('#/wallet')}>
      <TokenSelect value={token} onChange={setToken} />
      <AmountField label="Amount" token={token} value={amount} onChange={setAmount} presets={presetsOf(token)} />
      <Field label="Recipient address" hint="Use an address with no history linking it to you, for example a new account in MetaMask.">
        <input placeholder="0x…" spellCheck={false} value={address} onChange={(e) => setAddress(e.target.value.trim())} />
      </Field>
      <Notice>Tip: waiting longer between adding money and cashing out makes the two harder to link.</Notice>
      <RelayedSubmit label="Cash out" token={token} tokenId={tokenId(token, network)} relayer={() => calyptra.relayer()}
        disabled={parsed === null || !isAddress(address)}
        details={<>Cash out <strong>{typedAmount(token, amount)}</strong> to {address}. The recipient pays no network fee.</>}
        run={run}
        onDone={() => { setAmount(''); refresh(); }} />
      {done ? <Notice tone="ok">Cashed out to {done}.</Notice> : null}
    </Modal>
  );
}
