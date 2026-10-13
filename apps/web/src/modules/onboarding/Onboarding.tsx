import { MIN_PASSWORD_LENGTH, type Calyptra } from '@calyptra/framework';
import { useCallback, useState, type FormEvent, type ReactNode } from 'react';
import { ChannelsIcon, CloseIcon, KeyIcon, PasskeyIcon, ShieldIcon } from '../../shared/icons.tsx';
import { createPasskeySecrets, isPasskeyCancelled, passkeyErrorText, passkeysSupported, restorePasskeySecrets } from '../../shared/passkey.ts';
import { Button, Card, ErrorNote, Field, Glows, Hero, Notice, useAction } from '../../shared/ui.tsx';

/** The product's one-liner, on the welcome screen and under the brand name in the sidebar. */
export const TAGLINE = 'Private dollars, paid by the second';

const PHRASE_NOTICE = 'Calyptra only ever asks for your recovery phrase when you import a wallet. Never type it anywhere else.';

/** The statement every form that imports, restores or resets a wallet shows; it cannot be closed there. */
export function PhraseNotice() {
  return <Notice tone="warn">{PHRASE_NOTICE}</Notice>;
}

const BANNER_KEY = 'calyptra.phraseBannerClosed';
function bannerClosed(): boolean {
  try {
    return localStorage.getItem(BANNER_KEY) === '1';
  } catch {
    return false;
  }
}

/** The same statement at the top of every unlocked page, closable once per browser. */
export function PhraseBanner() {
  const [closed, setClosed] = useState(bannerClosed);
  if (closed) return null;
  const close = () => {
    try {
      localStorage.setItem(BANNER_KEY, '1');
    } catch {
      /* storage refused: hidden until the next reload */
    }
    setClosed(true);
  };
  return (
    <div className="notice warn banner" role="note">
      <span>{PHRASE_NOTICE}</span>
      <button type="button" className="icon-button tiny" aria-label="Close this notice" onClick={close}><CloseIcon /></button>
    </div>
  );
}

/** Full-screen layout of the screens before unlock. */
export function AuthLayout({ children, back }: { children: ReactNode; back?: () => void }) {
  return (
    <div className="auth">
      <Glows />
      <div className="auth-column">
        {back ? <button type="button" className="link back-link" onClick={back}>← Back</button> : null}
        {children}
      </div>
    </div>
  );
}

/** Wallet password and its repetition; submits only when both match and are long enough. */
export function PasswordFields({ onSubmit, busy, label }: { onSubmit: (password: string) => void; busy: boolean; label: string }) {
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const problem = password !== '' && password.length < MIN_PASSWORD_LENGTH
    ? `The password needs at least ${MIN_PASSWORD_LENGTH} characters.`
    : repeat !== '' && repeat !== password ? 'The passwords do not match.' : null;
  const ready = password !== '' && password === repeat && password.length >= MIN_PASSWORD_LENGTH;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready && !problem) onSubmit(password);
  };
  return (
    <form className="stack" onSubmit={submit}>
      <Field label="Wallet password" hint="It encrypts everything this website stores. It cannot be recovered.">
        <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Field label="Repeat the password">
        <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
      </Field>
      <ErrorNote error={problem} />
      <Button type="submit" className="primary wide" busy={busy} disabled={!ready}>{label}</Button>
    </form>
  );
}

type Mode = 'choose' | 'passkey' | 'phrase' | 'create' | 'import' | 'restore';

/** First visit: a passkey by default, or a recovery phrase, a private key or an export file. */
export function Onboarding({ calyptra, onReady }: { calyptra: Calyptra; onReady: () => Promise<void> }) {
  const [mode, setMode] = useState<Mode>('choose');
  const back = () => setMode('choose');
  const toPhrase = () => setMode('phrase');
  if (mode === 'passkey') return <AuthLayout back={back}><PasskeyCreate calyptra={calyptra} onReady={onReady} onCancel={back} /></AuthLayout>;
  if (mode === 'phrase') return <AuthLayout back={back}><PhraseChoice onChoose={setMode} /></AuthLayout>;
  if (mode === 'create') return <AuthLayout back={toPhrase}><CreateWallet calyptra={calyptra} onReady={onReady} /></AuthLayout>;
  if (mode === 'import') return <AuthLayout back={toPhrase}><ImportWallet calyptra={calyptra} onReady={onReady} /></AuthLayout>;
  if (mode === 'restore') return <AuthLayout back={toPhrase}><RestoreWallet calyptra={calyptra} onReady={onReady} /></AuthLayout>;
  return (
    <AuthLayout>
      <section className="welcome" aria-label="Welcome to Calyptra">
        <Hero />
        <h1 className="display">Calyptra</h1>
        <p className="tagline">{TAGLINE}.</p>
        <div className="features">
          <details className="feature" open>
            <summary><span className="feature-icon"><ChannelsIcon /></span><strong>Pay as you go</strong></summary>
            <p>Pay a service by the second, or keep a tab with someone, and pay back and forth with no fee per payment.</p>
          </details>
          <details className="feature">
            <summary><span className="feature-icon"><ShieldIcon /></span><strong>Private by default</strong></summary>
            <p>Your balance and payments stay private: nobody else can see who paid whom, or how much.</p>
          </details>
          <details className="feature">
            <summary><span className="feature-icon"><KeyIcon /></span><strong>Your passkey is your key</strong></summary>
            <p>Calyptra unlocks with Face ID, Touch ID or a security key. Everything stays on this device, and nobody can move your money for you.</p>
          </details>
        </div>
        <div className="stack">
          <Button className="primary wide tall" onClick={() => setMode('passkey')}><PasskeyIcon />Continue with passkey</Button>
          <Button className="link" onClick={toPhrase}>Use a recovery phrase instead</Button>
        </div>
      </section>
    </AuthLayout>
  );
}

/** The recovery-phrase ways in: create with a phrase, import a phrase or key, restore an export file. */
function PhraseChoice({ onChoose }: { onChoose: (mode: Mode) => void }) {
  return (
    <Card title="Use a recovery phrase" className="auth-card">
      <p className="muted">A recovery phrase works in any standard wallet, such as MetaMask. You lock this wallet with a password.</p>
      <div className="stack">
        <Button className="primary wide tall" onClick={() => onChoose('create')}>Create a new wallet</Button>
        <Button className="secondary wide tall" onClick={() => onChoose('import')}>Import a recovery phrase or private key</Button>
        <Button className="ghost wide" onClick={() => onChoose('restore')}>Restore from an export file</Button>
      </div>
    </Card>
  );
}

/** Creates a passkey and a wallet from it, or rebuilds the wallet from a passkey the user already has. */
function PasskeyCreate({ calyptra, onReady, onCancel }: { calyptra: Calyptra; onReady: () => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (secrets: () => Promise<{ mnemonic: string; vaultKey: Uint8Array }>) => {
    setError(null);
    let created: { mnemonic: string; vaultKey: Uint8Array };
    try {
      created = await secrets();
    } catch (err) {
      if (isPasskeyCancelled(err)) onCancel(); // a cancelled ceremony returns to the first screen silently
      else setError(passkeyErrorText(err));
      return;
    }
    await calyptra.wallet.createFromPhrase(created.mnemonic, created.vaultKey);
    await onReady();
  }, [calyptra, onReady, onCancel]);
  const create = useAction(useCallback(() => run(() => createPasskeySecrets(name.trim())), [run, name]));
  const restore = useAction(useCallback(() => run(restorePasskeySecrets), [run]));
  const supported = passkeysSupported();
  return (
    <Card title="Create your passkey" className="auth-card">
      <p className="muted">
        Calyptra unlocks with a passkey: Face ID, Touch ID, Windows Hello or a security key. No password, and no phrase to write down
        now; you can see your recovery phrase later in Settings.
      </p>
      {supported ? null : <Notice tone="warn">Passkeys are not available in this browser. Continue with a recovery phrase instead.</Notice>}
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void create.perform(); }}>
        <Field label="Your name" hint="Your passkey manager shows it next to the passkey. It is never sent anywhere.">
          <input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Button type="submit" className="primary wide" busy={create.busy} disabled={!supported || name.trim() === '' || restore.busy}><PasskeyIcon />Create passkey</Button>
      </form>
      <Button className="secondary wide" busy={restore.busy} disabled={!supported || create.busy} onClick={() => void restore.perform()}>I already have a passkey</Button>
      <ErrorNote error={error ?? create.error ?? restore.error} />
    </Card>
  );
}

/** Create a wallet with a new 12-word phrase: show it once, confirm 3 words, then set the password. */
function CreateWallet({ calyptra, onReady }: { calyptra: Calyptra; onReady: () => Promise<void> }) {
  const wallet = calyptra.wallet;
  const [phrase, setPhrase] = useState(() => wallet.generatePhrase());
  const [step, setStep] = useState<'show' | 'confirm' | 'password'>('show');
  const [saved, setSaved] = useState(false);
  const [positions, setPositions] = useState<number[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [wrong, setWrong] = useState(false);
  const create = useAction(useCallback(async (password: string) => {
    await wallet.createFromPhrase(phrase, password);
    await onReady();
  }, [wallet, phrase, onReady]));

  if (step === 'show') {
    const words = phrase.split(' ');
    return (
      <Card title="Your recovery phrase" className="auth-card">
        <p className="muted">
          Write these {words.length} words down in order and keep them offline. They are shown only this once, and they are the only way
          to recover this wallet.
        </p>
        <ol className="phrase" aria-label="Recovery phrase">
          {words.map((word, i) => (
            <li key={i}><span className="phrase-index">{String(i + 1).padStart(2, '0')}</span><span className="phrase-word">{word}</span></li>
          ))}
        </ol>
        <label className="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I have written my recovery phrase down</label>
        <Button className="primary wide" disabled={!saved} onClick={() => { setPositions(wallet.pickConfirmationWords()); setStep('confirm'); }}>I wrote it down</Button>
      </Card>
    );
  }
  if (step === 'confirm') {
    const confirm = (e: FormEvent) => {
      e.preventDefault();
      if (wallet.confirmWords(phrase, answers)) setStep('password');
      else setWrong(true);
    };
    return (
      <Card title="Confirm your recovery phrase" className="auth-card">
        <p className="muted">Type the requested words, so we know the phrase is written down correctly.</p>
        <form className="stack" onSubmit={confirm}>
          <div className="word-inputs">
            {positions.map((p) => (
              <Field key={p} label={`Word #${p + 1}`}>
                <input autoComplete="off" value={answers[p] ?? ''} onChange={(e) => setAnswers({ ...answers, [p]: e.target.value })} />
              </Field>
            ))}
          </div>
          {wrong ? <ErrorNote error="Those words do not match your phrase. Try again." /> : null}
          <Button type="submit" className="primary wide">Confirm words</Button>
        </form>
        <Button className="ghost wide" onClick={() => { setPhrase(wallet.generatePhrase()); setAnswers({}); setWrong(false); setSaved(false); setStep('show'); }}>
          Start over with a new phrase
        </Button>
      </Card>
    );
  }
  return (
    <Card title="Set the wallet password" className="auth-card">
      <PasswordFields label="Create wallet" busy={create.busy} onSubmit={(password) => void create.perform(password)} />
      <ErrorNote error={create.error} />
    </Card>
  );
}

/** Import a recovery phrase (12 or 24 words) or a single private key. */
function ImportWallet({ calyptra, onReady }: { calyptra: Calyptra; onReady: () => Promise<void> }) {
  const [secret, setSecret] = useState('');
  const importWallet = useAction(useCallback(async (password: string) => {
    const isKey = /^(0x)?[0-9a-fA-F]{64}$/.test(secret.trim());
    if (isKey) await calyptra.wallet.importPrivateKey(secret.trim(), password);
    else await calyptra.wallet.createFromPhrase(secret, password);
    await onReady();
  }, [calyptra, secret, onReady]));
  return (
    <Card title="Import a wallet" className="auth-card">
      <PhraseNotice />
      <Field label="Recovery phrase or private key">
        <textarea rows={3} autoComplete="off" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} />
      </Field>
      <PasswordFields label="Import wallet" busy={importWallet.busy} onSubmit={(password) => void importWallet.perform(password)} />
      <ErrorNote error={importWallet.error} />
    </Card>
  );
}

/** Restore everything from an export file (also in Settings > Backup); it always opens with the file's password. */
export function RestoreWallet({ calyptra, onReady }: { calyptra: Calyptra; onReady: () => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const restore = useAction(useCallback(async () => {
    if (!file) return;
    await calyptra.wallet.importFile(await file.text(), password);
    await onReady();
  }, [calyptra, file, password, onReady]));
  return (
    <Card title="Restore from an export file" className="auth-card">
      <PhraseNotice />
      <Field label="Export file">
        <input type="file" accept=".json,application/json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </Field>
      <Field label="Password of the export file">
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Button className="primary wide" busy={restore.busy} disabled={!file || password === ''} onClick={() => void restore.perform()}>Restore</Button>
      <ErrorNote error={restore.error} />
    </Card>
  );
}
