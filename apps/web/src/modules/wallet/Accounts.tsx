import { useCallback, useState } from 'react';
import { useApp } from '../../app/context.ts';
import { startNode } from '../../app/settings.ts';
import { KeyIcon, PlusIcon } from '../../shared/icons.tsx';
import { Button, Card, ErrorNote, Field, Modal, useAction } from '../../shared/ui.tsx';

/** Settings › Accounts: switch, add (from the recovery phrase) or import (a private key) accounts. */
export function Accounts() {
  const { calyptra, refresh } = useApp();
  const wallet = calyptra.wallet;
  const active = wallet.activeAccount();
  const [importing, setImporting] = useState(false);
  const [key, setKey] = useState('');
  const use = useAction(useCallback(async (id: string) => {
    await wallet.setActiveAccount(id);
    await startNode(calyptra);
    refresh();
  }, [calyptra, wallet, refresh]));
  const add = useAction(useCallback(async () => {
    await wallet.addAccount();
    refresh();
  }, [wallet, refresh]));
  const importKey = useAction(useCallback(async () => {
    await wallet.importAccount(key);
    setKey('');
    setImporting(false);
    refresh();
  }, [wallet, key, refresh]));
  return (
    <Card title="Accounts">
      <ul className="rows">
        {wallet.accounts().map((a) => (
          <li key={a.id} className="row-item">
            <div className="row-main"><strong>{a.label}</strong><span className="mono muted">{a.address}</span></div>
            {a.id === active.id ? <span className="pill on">Active</span>
              : <Button className="ghost small" busy={use.busy} onClick={() => void use.perform(a.id)}>Use</Button>}
          </li>
        ))}
      </ul>
      <div className="row">
        {wallet.hasRecoveryPhrase() ? <Button className="secondary" busy={add.busy} onClick={() => void add.perform()}><PlusIcon />Add account</Button> : null}
        <Button className="secondary" onClick={() => { importKey.setError(null); setImporting(true); }}><KeyIcon />Import key</Button>
      </div>
      <ErrorNote error={add.error ?? use.error} />
      {importing ? (
        <Modal title="Import an account from a private key">
          <Field label="Private key">
            <input autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>
          <ErrorNote error={importKey.error} />
          <div className="stack">
            <Button className="primary wide" busy={importKey.busy} disabled={key.trim() === ''} onClick={() => void importKey.perform()}>Import</Button>
            <Button className="ghost wide" onClick={() => setImporting(false)}>Cancel</Button>
          </div>
        </Modal>
      ) : null}
    </Card>
  );
}
