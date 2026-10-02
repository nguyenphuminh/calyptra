import { useCallback, type ReactNode } from 'react';
import { useApp } from '../../app/context.ts';
import { startNode } from '../../app/settings.ts';
import { LockIcon } from '../../shared/icons.tsx';
import { networkLogo } from '../../shared/networks.ts';
import { Button, ErrorNote, Field, useAction } from '../../shared/ui.tsx';

/** Switching account or network restarts the node on the new selection, then redraws every screen. */
function useSwitch() {
  const { calyptra, refresh } = useApp();
  return useAction(useCallback(async (apply: () => Promise<void>) => {
    await apply();
    await startNode(calyptra);
    refresh();
  }, [calyptra, refresh]));
}

/** The account select and the Lock button, under the navigation (a compact row on phones). */
export function AccountBar() {
  const { calyptra, lock } = useApp();
  const wallet = calyptra.wallet;
  const change = useSwitch();
  const active = wallet.activeAccount();
  return (
    <div className="account-bar">
      <Field label="Account">
        <select value={active.id} disabled={change.busy} onChange={(e) => { const id = e.target.value; void change.perform(() => wallet.setActiveAccount(id)); }}>
          {wallet.accounts().map((a) => (
            <option key={a.id} value={a.id}>{`${a.label} · ${a.address.slice(0, 6)}…${a.address.slice(-4)}`}</option>
          ))}
        </select>
      </Field>
      <Button className="ghost lock" aria-label="Lock" onClick={() => void lock()}><LockIcon /><span>Lock</span></Button>
      <ErrorNote error={change.error} />
    </div>
  );
}

/** A select with a logo drawn at its start (the network-logo slot, 7.13.2); the field's id goes to the select. */
function LogoSelect({ id, logo, value, disabled, onChange, children, ...rest }: {
  id?: string; 'aria-describedby'?: string; logo: string | null; value: string; disabled: boolean; onChange: (value: string) => void; children: ReactNode;
}) {
  return (
    <span className="logo-select">
      {logo ? <img className="logo-select-logo" src={logo} alt="" data-testid="network-logo" /> : null}
      <select id={id} aria-describedby={rest['aria-describedby']} className={logo ? 'has-logo' : undefined} value={value} disabled={disabled}
        onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </span>
  );
}

/**
 * The network the wallet works on, with the network's logo when it has one (7.13.2). On the consumer
 * screens it lives in Settings › Advanced (§11.6: networks are an advanced setting).
 */
export function NetworkSelect() {
  const { calyptra } = useApp();
  const wallet = calyptra.wallet;
  const change = useSwitch();
  return (
    <>
      <Field label="Network">
        <LogoSelect logo={networkLogo(calyptra.network())} value={wallet.networkId()} disabled={change.busy}
          onChange={(id) => void change.perform(() => wallet.setNetwork(id))}>
          {calyptra.networks().map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
        </LogoSelect>
      </Field>
      <ErrorNote error={change.error} />
    </>
  );
}
