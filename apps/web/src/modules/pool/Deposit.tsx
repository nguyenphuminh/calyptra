import { NATIVE_PRESETS, STABLECOIN_PRESETS } from '@calyptra/framework';
import { useCallback, useState } from 'react';
import { useApp } from '../../app/context.ts';
import { DEFAULT_TOKEN, formatMoney, MAX_NOTE_AMOUNT, parseAmount, tokenId, type TokenName } from '../../shared/amounts.ts';
import { AmountField, Button, closeTo, ErrorNote, Modal, Notice, useAction } from '../../shared/ui.tsx';
import { TokenSelect } from '../public/index.ts';

/** Preset amounts in powers of ten: dollars 1, 10, 100, 1000; MON 0.01, 0.1, 1, 10 (BRD 2.2.2). */
export const presetsOf = (token: TokenName): readonly bigint[] => (token === 'native' ? NATIVE_PRESETS : STABLECOIN_PRESETS);

/** Add money: moves public funds of the account into the private balance (a deposit, paid by the account). */
export function Deposit() {
  const { calyptra, refresh } = useApp();
  const network = calyptra.network();
  const [token, setToken] = useState<TokenName>(DEFAULT_TOKEN);
  const [amount, setAmount] = useState('');
  const parsed = parseAmount(token, amount);
  // §11.2: notes hold 64-bit amounts, so one MON deposit holds at most about 18.44 MON.
  const tooBig = token === 'native' && parsed !== null && parsed > MAX_NOTE_AMOUNT;
  const deposit = useAction(useCallback(async (value: bigint) => {
    if (token === 'stablecoin') {
      // Checked here: the approve before the deposit would otherwise be paid for, then the deposit refused.
      const held = await calyptra.chain.publicBalance(calyptra.wallet.activeAccount().address, tokenId(token, network));
      if (held < value) throw new Error(`Your account balance has ${formatMoney(token, held)}. Send AUSD to your account address first.`);
    }
    await calyptra.pool.deposit(tokenId(token, network), value);
    setAmount('');
    refresh();
    location.hash = '#/wallet';
  }, [calyptra, network, token, refresh]));
  return (
    <Modal title="Add money" onClose={closeTo('#/wallet')}>
      <Notice>
        Moves money from your account balance into your private balance. Your account pays the network fee in MON, so keep a little MON there.
      </Notice>
      <TokenSelect value={token} onChange={setToken} />
      <AmountField label="Amount" token={token} value={amount} onChange={setAmount} presets={presetsOf(token)} />
      {tooBig ? <ErrorNote error="The most you can add at once is 18.44 MON" /> : null}
      <Button className="primary wide" busy={deposit.busy} disabled={parsed === null || tooBig} onClick={() => { if (parsed !== null) void deposit.perform(parsed); }}>Add money</Button>
      <ErrorNote error={deposit.error} />
    </Modal>
  );
}
