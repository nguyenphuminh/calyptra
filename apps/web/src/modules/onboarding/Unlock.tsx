import type { Calyptra } from '@calyptra/framework';
import { useCallback, useState } from 'react';
import { ArrowRightIcon, PasskeyIcon } from '../../shared/icons.tsx';
import { isPasskeyCancelled, passkeyErrorText, passkeyUnlockKey } from '../../shared/passkey.ts';
import { Button, Card, ErrorNote, Field, Hero, Notice, useAction, useLoad } from '../../shared/ui.tsx';
import { AuthLayout, PhraseNotice } from './Onboarding.tsx';

/** The lock screen: a password, or the wallet's passkey (§11.4). The wallet unlocks once per tab. */
export function Unlock({ calyptra, onReady }: { calyptra: Calyptra; onReady: () => Promise<void> }) {
  const [resetting, setResetting] = useState(false);
  const [password, setPassword] = useState('');
  const method = useLoad(() => calyptra.wallet.unlockMethod(), 'unlock');
  const unlock = useAction(useCallback(async () => {
    await calyptra.wallet.unlock(password);
    await onReady();
  }, [calyptra, password, onReady]));
  const unlockWithPasskey = useAction(useCallback(async () => {
    let key: Uint8Array;
    try {
      key = await passkeyUnlockKey();
    } catch (err) {
      if (isPasskeyCancelled(err)) return;
      throw new Error(passkeyErrorText(err), { cause: err });
    }
    await calyptra.wallet.unlock(key);
    await onReady();
  }, [calyptra, onReady]));

  if (resetting) return <AuthLayout back={() => setResetting(false)}><ResetWallet calyptra={calyptra} onReady={onReady} /></AuthLayout>;
  const passkey = method.data === 'passkey';
  return (
    <AuthLayout>
      <section className="welcome" aria-label="Unlock">
        <Hero size={180} />
        <h1 className="title">Unlock your wallet</h1>
        <p className="tagline">
          {passkey ? 'Your wallet stays locked until you unlock it with your passkey in this tab.' : 'Your wallet stays locked until you enter its password in this tab.'}
        </p>
        {method.data === null && !method.error ? null : passkey ? (
          <div className="stack">
            <Button className="primary wide tall" busy={unlockWithPasskey.busy} onClick={() => void unlockWithPasskey.perform()}><PasskeyIcon />Unlock with passkey</Button>
            <ErrorNote error={unlockWithPasskey.error} />
            <Button className="link" onClick={() => setResetting(true)}>Can&apos;t use your passkey?</Button>
          </div>
        ) : (
          <>
            <form className="unlock-form" onSubmit={(e) => { e.preventDefault(); if (password) void unlock.perform(); }}>
              <Field label="Wallet password">
                {/* The lock screen has one task: focus its only field. */}
                <input type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
              <Button type="submit" className="primary round big" aria-label="Unlock" busy={unlock.busy} disabled={password === ''}><ArrowRightIcon /></Button>
            </form>
            <ErrorNote error={unlock.error ?? method.error} />
            <Button className="link" onClick={() => setResetting(true)}>Forgot the password?</Button>
          </>
        )}
      </section>
    </AuthLayout>
  );
}

/** A forgotten password (or a lost passkey): re-import the recovery phrase with a new password. */
export function ResetWallet({ calyptra, onReady }: { calyptra: Calyptra; onReady: () => Promise<void> }) {
  const [understood, setUnderstood] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [password, setPassword] = useState('');
  const reset = useAction(useCallback(async () => {
    await calyptra.wallet.reset(phrase, password);
    await onReady();
  }, [calyptra, phrase, password, onReady]));
  return (
    <Card title="Reset the wallet" className="auth-card">
      <Notice tone="warn">
        Resetting restores the accounts of your recovery phrase and their balances. Imported private keys, tabs and
        subscriptions are lost unless you also import an export file afterwards.
      </Notice>
      <label className="check">
        <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
        I understand that imported keys, tabs and subscriptions will be lost
      </label>
      {understood ? (
        <>
          <PhraseNotice />
          <Field label="Recovery phrase">
            <textarea rows={3} autoComplete="off" spellCheck={false} value={phrase} onChange={(e) => setPhrase(e.target.value)} />
          </Field>
          <Field label="New wallet password">
            <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button className="danger wide" busy={reset.busy} disabled={phrase.trim() === '' || password === ''} onClick={() => void reset.perform()}>Reset wallet</Button>
          <ErrorNote error={reset.error} />
        </>
      ) : null}
    </Card>
  );
}
