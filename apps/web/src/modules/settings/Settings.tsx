import { chainIdAt, defaultRpcUrls, MIN_PASSWORD_LENGTH } from '@calyptra/framework';
import { useCallback, useState, type ReactNode } from 'react';
import { useApp } from '../../app/context.ts';
import { readSettings, startNode, writeSettings, type WebSettings } from '../../app/settings.ts';
import { chooseTheme, themeChoice, type ThemeChoice } from '../../app/theme.ts';
import { BackIcon, KeyIcon, SettingsIcon, ShieldIcon, ThemeIcon } from '../../shared/icons.tsx';
import { passkeyErrorText, passkeyPhrase, isPasskeyCancelled } from '../../shared/passkey.ts';
import { Button, Card, ErrorNote, Field, Notice, useAction, useLoad } from '../../shared/ui.tsx';
import { ResetWallet, RestoreWallet } from '../onboarding/index.ts';
import { Accounts, NetworkSelect } from '../wallet/index.ts';

export type SettingsCategory = 'accounts' | 'backup' | 'network' | 'appearance';

/** The categories; "network" keeps its route and holds the advanced settings (§11.6: network, RPC, relays). */
const CATEGORIES: { id: SettingsCategory; title: string; description: string; icon: ReactNode }[] = [
  { id: 'accounts', title: 'Accounts', description: 'Switch, add or import accounts', icon: <KeyIcon /> },
  { id: 'backup', title: 'Backup', description: 'Export everything, or restore a file', icon: <ShieldIcon /> },
  { id: 'network', title: 'Advanced', description: 'Network, endpoints and relays', icon: <SettingsIcon /> },
  { id: 'appearance', title: 'Appearance', description: 'Light, dark or like this device', icon: <ThemeIcon /> },
];

export function Settings({ category }: { category: SettingsCategory | null }) {
  const { version } = useApp();
  const shown = category ?? 'accounts';
  const current = CATEGORIES.find((c) => c.id === shown) ?? CATEGORIES[0];
  return (
    <div className={category ? 'settings has-detail' : 'settings'} data-version={version}>
      <nav className="settings-menu" aria-label="Settings categories">
        <h1>Settings</h1>
        <ul>
          {CATEGORIES.map((c) => (
            <li key={c.id}>
              <a className={c.id === shown ? 'settings-item on' : 'settings-item'} href={`#/settings/${c.id}`} aria-current={c.id === shown ? 'page' : undefined}>
                <span className="settings-icon">{c.icon}</span>
                <span className="settings-item-text"><strong>{c.title}</strong><span className="muted small">{c.description}</span></span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="settings-detail">
        <header className="page-head only-narrow">
          <a className="icon-button" href="#/settings" aria-label="Back to settings"><BackIcon /></a>
          <h2>{current?.title}</h2>
        </header>
        {shown === 'accounts' ? <Accounts /> : null}
        {shown === 'backup' ? <Backup /> : null}
        {shown === 'network' ? <Advanced /> : null}
        {shown === 'appearance' ? <Appearance /> : null}
      </div>
    </div>
  );
}

/** Export everything to one encrypted file; show or import the recovery phrase; restore a file. */
function Backup() {
  const { calyptra, refresh } = useApp();
  const onReady = useCallback(async () => {
    await startNode(calyptra);
    refresh();
  }, [calyptra, refresh]);
  return (
    <>
      <Export />
      <RecoveryPhrase onReady={onReady} />
      <RestoreWallet calyptra={calyptra} onReady={onReady} />
    </>
  );
}

/**
 * The export file is encrypted with a password: the wallet password, or for a passkey wallet (which has
 * none) an export password chosen here, so the file restores in any browser or the desktop client.
 */
function Export() {
  const { calyptra, refresh } = useApp();
  const wallet = calyptra.wallet;
  const last = wallet.lastExportAt();
  const method = useLoad(() => wallet.unlockMethod(), 'method');
  const passkey = method.data === 'passkey';
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const problem = password !== '' && password.length < MIN_PASSWORD_LENGTH
    ? `The password needs at least ${MIN_PASSWORD_LENGTH} characters.`
    : repeat !== '' && repeat !== password ? 'The passwords do not match.' : null;
  const ready = !passkey || (password.length >= MIN_PASSWORD_LENGTH && password === repeat);
  const download = useAction(useCallback(async () => {
    const content = passkey ? await wallet.exportFile(password) : await wallet.exportFile();
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `calyptra-wallet-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setPassword('');
    setRepeat('');
    refresh();
  }, [wallet, passkey, password, refresh]));
  return (
    <Card title="Export">
      <p data-testid="last-export">{last === null ? 'Last export: never' : `Last export: ${new Date(last).toLocaleString()}`}</p>
      <Notice tone="warn">
        The file holds everything, encrypted with {passkey ? 'the export password you choose here' : 'your wallet password'}. Payments in tabs
        and subscriptions made after the export are not in it; restoring an old file means acting on old balances.
      </Notice>
      {passkey ? (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); if (ready) void download.perform(); }}>
          <p className="muted small">
            Your wallet unlocks with a passkey, so the file gets a password of its own. You need this password to restore the file, and
            nobody can recover it for you.
          </p>
          <Field label="Export password">
            <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Repeat the export password">
            <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
          </Field>
          <ErrorNote error={problem} />
          <Button type="submit" className="primary wide" busy={download.busy} disabled={!ready}>Download export file</Button>
        </form>
      ) : (
        <Button className="primary wide" busy={download.busy} disabled={method.data === null} onClick={() => void download.perform()}>Download export file</Button>
      )}
      <ErrorNote error={download.error} />
    </Card>
  );
}

/** §11.4: a passkey wallet can show its recovery phrase; any wallet can be replaced by importing one. */
function RecoveryPhrase({ onReady }: { onReady: () => Promise<void> }) {
  const { calyptra } = useApp();
  const method = useLoad(() => calyptra.wallet.unlockMethod(), 'method');
  const [words, setWords] = useState<string[] | null>(null);
  const [importing, setImporting] = useState(false);
  const show = useAction(useCallback(async () => {
    try {
      setWords((await passkeyPhrase()).split(' '));
    } catch (err) {
      if (!isPasskeyCancelled(err)) throw new Error(passkeyErrorText(err), { cause: err });
    }
  }, []));
  return (
    <Card title="Recovery phrase">
      {method.data === 'passkey' ? (
        words ? (
          <>
            <Notice tone="warn">Anyone with these words controls your money. Keep them offline, and never type them anywhere but Calyptra&apos;s import form.</Notice>
            <ol className="phrase" aria-label="Recovery phrase">
              {words.map((word, i) => (
                <li key={i}><span className="phrase-index">{String(i + 1).padStart(2, '0')}</span><span className="phrase-word">{word}</span></li>
              ))}
            </ol>
            <Button className="secondary wide" onClick={() => setWords(null)}>Hide recovery phrase</Button>
          </>
        ) : (
          <>
            <p className="muted">Your passkey also gives a 24-word recovery phrase, which restores this wallet in Calyptra or any standard wallet.</p>
            <Button className="secondary wide" busy={show.busy} onClick={() => void show.perform()}>Show recovery phrase</Button>
          </>
        )
      ) : calyptra.wallet.hasRecoveryPhrase() ? (
        <p className="muted">This wallet&apos;s recovery phrase was shown once, when it was created.</p>
      ) : (
        <p className="muted">This wallet was imported from a private key, so it has no recovery phrase. Keep an export file as its backup.</p>
      )}
      <ErrorNote error={show.error} />
      {importing ? <ResetWallet calyptra={calyptra} onReady={onReady} />
        : <Button className="ghost wide" onClick={() => setImporting(true)}>Import a recovery phrase</Button>}
    </Card>
  );
}

/** Advanced: the network, its RPC endpoints, privacy relays (transaction relayers) and message relays (libp2p). */
function Advanced() {
  const { calyptra, refresh } = useApp();
  const network = calyptra.network();
  const settings = readSettings(calyptra);
  // Every change is saved in the encrypted wallet and restarts the node at once.
  const save = useCallback(async (next: WebSettings) => {
    await writeSettings(calyptra, next);
    refresh();
  }, [calyptra, refresh]);
  return (
    <>
      <Card title="Network">
        <NetworkSelect />
        <p className="muted small">Each network has its own balances, tabs and subscriptions.</p>
      </Card>
      <RpcEndpoints settings={settings} save={save} />
      <EditableList title={`Privacy relays on ${network.name}`} fixed={network.relayers} own={settings.relayers} placeholder="https://relayer.example"
        note="A privacy relay submits your private payments and pays their network fee, so they never come from an address of yours."
        check={(url) => (/^https?:\/\/\S+$/.test(url) ? null : 'Enter the privacy relay’s http(s) address')}
        onChange={(relayers) => save({ ...settings, relayers })} />
      <EditableList title={`Message relays on ${network.name}`} fixed={network.libp2pRelays} own={settings.libp2pRelays} placeholder="/dns4/relay.example/tcp/443/wss/p2p/12D3…"
        note="A message relay (libp2p) connects you with the other side of a tab or subscription without revealing your IP address."
        check={(address) => (address.startsWith('/') && address.includes('/p2p/') ? null : 'Enter the message relay’s address, like /dns4/relay.example/tcp/443/wss/p2p/12D3…')}
        onChange={(libp2pRelays) => save({ ...settings, libp2pRelays })} />
    </>
  );
}

function RpcEndpoints({ settings, save }: { settings: WebSettings; save: (next: WebSettings) => Promise<void> }) {
  const { calyptra } = useApp();
  const network = calyptra.network();
  const own = settings.rpcUrls;
  const [fallback, setFallback] = useState(settings.rpcFallback);
  const [url, setUrl] = useState('');
  const defaultsUsed = own.length === 0 || fallback;
  const change = useAction(save);
  const add = useAction(useCallback(async () => {
    if (!/^https?:\/\/\S+$/.test(url)) throw new Error('Enter the endpoint’s http(s) address');
    const chainId = await chainIdAt(url);
    if (chainId !== network.chainId) throw new Error(`This endpoint serves chain ${chainId}, not ${network.name} (${network.chainId})`);
    await save({ ...settings, rpcUrls: [...own, url] });
    setUrl('');
  }, [url, network, save, settings, own]));
  return (
    <Card title={`RPC endpoints on ${network.name}`}>
      <p className="muted">The wallet reads the chain through the first of these that answers, in this order.</p>
      <ul className="rows">
        {own.map((u) => (
          <li key={u} className="row-item">
            <code className="break">{u}</code>
            <Button className="ghost small" onClick={() => void change.perform({ ...settings, rpcUrls: own.filter((x) => x !== u) })}>Remove</Button>
          </li>
        ))}
        {defaultRpcUrls(network).map((u) => (
          <li key={u} className={defaultsUsed ? 'row-item' : 'row-item muted'}>
            <code className="break">{u}</code>
            <span className="pill">{defaultsUsed ? 'Network default' : 'Not used'}</span>
          </li>
        ))}
      </ul>
      {own.length > 0 ? (
        <label className="check">
          <input type="checkbox" checked={fallback} onChange={(e) => { setFallback(e.target.checked); void change.perform({ ...settings, rpcFallback: e.target.checked }); }} />
          Use the network’s endpoints when mine do not answer
        </label>
      ) : null}
      <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void add.perform(); }}>
        <Field label="Add your own">
          <input placeholder="https://rpc.example" value={url} onChange={(e) => setUrl(e.target.value.trim())} />
        </Field>
        <Button type="submit" className="secondary" busy={add.busy} disabled={url === '' || own.includes(url)}>Add</Button>
      </form>
      <ErrorNote error={add.error ?? change.error} />
      <Notice>
        Once you add endpoints, the wallet syncs through yours first, in this order. It uses the network&apos;s own (its event-history
        service, then the network&apos;s endpoints) only while the switch above is on. Your RPC provider sees your IP address and the public
        addresses you check. Add only endpoints you trust: a dishonest one could hide events from your wallet, such as a dispute it has
        to answer. An endpoint that is slow to page through event logs makes refreshing and dispute watching slow.
      </Notice>
    </Card>
  );
}

function EditableList({ title, fixed, own, placeholder, note, check, onChange }: {
  title: string; fixed: readonly string[]; own: readonly string[]; placeholder: string; note: string;
  /** The problem with an entry's format, or null when it can be added. */
  check: (entry: string) => string | null;
  onChange: (next: string[]) => Promise<void>;
}) {
  const [entry, setEntry] = useState('');
  const save = useAction(onChange);
  const add = useAction(useCallback(async () => {
    const problem = check(entry);
    if (problem) throw new Error(problem);
    await onChange([entry, ...own]);
    setEntry('');
  }, [check, onChange, entry, own]));
  return (
    <Card title={title}>
      <p className="muted small">{note}</p>
      {fixed.length === 0 && own.length === 0 ? <p className="muted">None yet.</p> : (
        <ul className="rows">
          {fixed.map((u) => <li key={`fixed-${u}`} className="row-item"><code className="break">{u}</code><span className="pill">Network default</span></li>)}
          {own.map((u) => (
            <li key={`own-${u}`} className="row-item">
              <code className="break">{u}</code>
              <Button className="ghost small" onClick={() => void save.perform(own.filter((x) => x !== u))}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
      <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void add.perform(); }}>
        <Field label="Add">
          <input placeholder={placeholder} value={entry} onChange={(e) => setEntry(e.target.value.trim())} />
        </Field>
        <Button type="submit" className="secondary" busy={add.busy} disabled={entry === '' || own.includes(entry)}>Add</Button>
      </form>
      <ErrorNote error={add.error ?? save.error} />
    </Card>
  );
}

function Appearance() {
  const [choice, setChoice] = useState<ThemeChoice>(themeChoice);
  const pick = (next: ThemeChoice) => {
    chooseTheme(next);
    setChoice(next);
  };
  const options: { id: ThemeChoice; label: string }[] = [
    { id: 'system', label: 'Same as this device' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
  ];
  return (
    <Card title="Theme">
      <div className="stack" role="radiogroup" aria-label="Theme">
        {options.map((o) => (
          <label key={o.id} className="check">
            <input type="radio" name="theme" checked={choice === o.id} onChange={() => pick(o.id)} />
            {o.label}
          </label>
        ))}
      </div>
      <p className="muted">Kept in this browser for every account, and stored unencrypted, since it says nothing about your wallet.</p>
    </Card>
  );
}
