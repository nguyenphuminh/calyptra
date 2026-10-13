import { decodeShieldedAddress } from '@calyptra/framework';
import { useCallback, useState } from 'react';
import { useApp } from '../../app/context.ts';
import { DEFAULT_TOKEN, parseAmount, tokenId, typedAmount, type TokenName } from '../../shared/amounts.ts';
import { AmountField, closeTo, Field, Modal, RelayedSubmit } from '../../shared/ui.tsx';
import { TokenSelect } from '../public/index.ts';

/** The Calyptra ID in the user's text: a bare ID or a payment link (…#/send/<id>). */
export const calyptraIdOf = (text: string): string => text.trim().split('/send/').pop() ?? '';

const isCalyptraId = (text: string): boolean => {
  try {
    decodeShieldedAddress(calyptraIdOf(text));
    return true;
  } catch {
    return false;
  }
};

/** Send: a private transfer to a Calyptra ID (the shielded address), relayed. */
export function SendPrivately({ initialTo = '' }: { initialTo?: string }) {
  const { calyptra, refresh } = useApp();
  const network = calyptra.network();
  const [to, setTo] = useState(initialTo.trim());
  const [token, setToken] = useState<TokenName>(DEFAULT_TOKEN);
  const [amount, setAmount] = useState('');
  const parsed = parseAmount(token, amount);
  const run = useCallback(async (relayer: Parameters<typeof calyptra.pool.transfer>[3]) => {
    if (parsed === null) return;
    await calyptra.pool.transfer(calyptraIdOf(to), tokenId(token, network), parsed, relayer);
  }, [calyptra, network, token, parsed, to]);
  return (
    <Modal title="Send" onClose={closeTo('#/wallet')}>
      <p className="muted small">
        Pays someone from your private balance, to their Calyptra ID. Nobody else can see the amount or who paid whom. For repeated
        payments to the same person, a tab is cheaper.
      </p>
      <Field label="To Calyptra ID">
        <input placeholder="cal…" spellCheck={false} value={to} onChange={(e) => setTo(e.target.value.trim())} />
      </Field>
      <TokenSelect value={token} onChange={setToken} />
      <AmountField label="Amount" token={token} value={amount} onChange={setAmount} />
      <RelayedSubmit label="Send" token={token} tokenId={tokenId(token, network)} relayer={() => calyptra.relayer()}
        disabled={!isCalyptraId(to) || parsed === null}
        details={<>Send <strong>{typedAmount(token, amount)}</strong> to this Calyptra ID. Nobody else can see the amount or the recipient.</>}
        run={run}
        onDone={() => { setAmount(''); refresh(); location.hash = '#/wallet'; }} />
    </Modal>
  );
}
