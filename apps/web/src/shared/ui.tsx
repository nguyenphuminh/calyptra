// Shared components and hooks, styled only by the global classes of styles.css.
import { isRoundAmount, quotedFee, type RelayerPort } from '@calyptra/framework';
import QRCode from 'qrcode';
import {
  cloneElement, useCallback, useEffect, useId, useRef, useState,
  type ButtonHTMLAttributes, type ReactElement, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { DISPLAY_SYMBOL, formatAmount, formatMoney, parseAmount, type TokenName } from './amounts.ts';
import { friendlyError } from './errors.ts';
import { BackIcon, CloseIcon, CopyIcon, Logo } from './icons.tsx';

/** The message to show for anything thrown, in the website's own words (see errors.ts). */
export const errorText = (err: unknown): string => friendlyError(err);

/** Runs a user action: busy while it runs, its error kept for display, `null` returned on failure. */
export function useAction<A extends unknown[], T>(run: (...args: A) => Promise<T>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const perform = useCallback(async (...args: A): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await run(...args);
    } catch (err) {
      setError(errorText(err));
      return null;
    } finally {
      setBusy(false);
    }
  }, [run]);
  return { busy, error, perform, setError };
}

/** Loads data on mount and whenever `key` changes; stale results are dropped, a failure keeps the old data. */
export function useLoad<T>(load: () => Promise<T>, key: string): { data: T | null; error: string | null } {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  const latest = useRef(load);
  latest.current = load;
  const runs = useRef(0);
  useEffect(() => {
    const run = ++runs.current;
    latest.current().then(
      (data) => { if (run === runs.current) setState({ data, error: null }); },
      (err: unknown) => { if (run === runs.current) setState((s) => ({ data: s.data, error: errorText(err) })); },
    );
  }, [key]);
  return state;
}

export function Card({ title, children, actions, className }: { title: string; children?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={className ? `card ${className}` : 'card'} aria-label={title}>
      <div className="card-head"><h2>{title}</h2>{actions}</div>
      {children}
    </section>
  );
}

export function Page({ title, back, actions, children }: { title: string; back?: string; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page">
      <header className="page-head">
        {back ? <a className="icon-button" href={back} aria-label="Back"><BackIcon /></a> : null}
        <h1>{title}</h1>
        <div className="page-actions">{actions}</div>
      </header>
      {children}
    </div>
  );
}

/** A round action with a caption, as on the private balance card. */
export function ActionLink({ href, icon, label }: { href: string; icon: ReactNode; label: string }) {
  return <a className="action" href={href}><span className="action-icon">{icon}</span><span>{label}</span></a>;
}

/** The floating mark of the welcome and unlock screens. */
export function Hero({ size = 220 }: { size?: number }) {
  return (
    <div className="hero" style={{ width: size, height: size }} aria-hidden="true">
      <div className="hero-blob" />
      <div className="hero-ring" />
      <div className="hero-core"><Logo size={Math.round(size * 0.42)} /></div>
    </div>
  );
}

/** Soft background glows behind full-screen layouts. */
export function Glows() {
  return <div className="glows" aria-hidden="true"><span className="glow one" /><span className="glow two" /></div>;
}

/** A labelled control: the label names exactly the control, the hint describes it. */
export function Field({ label, children, hint }: { label: string; children: ReactElement<{ id?: string; 'aria-describedby'?: string }>; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id, 'aria-describedby': hint ? `${id}-hint` : undefined })}
      {hint ? <small id={`${id}-hint`} className="hint">{hint}</small> : null}
    </div>
  );
}

/** A button that shows a spinner and `busyText` (default "Working…") while busy. */
export function Button({ busy, busyText = 'Working…', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; busyText?: string }) {
  const round = (rest.className ?? '').split(/\s+/).includes('round');
  return (
    <button type="button" {...rest} disabled={rest.disabled || busy} aria-busy={busy || undefined}>
      {busy ? <><span className="spinner" aria-hidden="true" />{round ? null : busyText}</> : children}
    </button>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  return error ? <p className="error" role="alert">{error}</p> : null;
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' | 'ok' }) {
  return <p className={`notice ${tone}`}>{children}</p>;
}

/** An amount as the main screens show it (dollars for the stablecoin), with the exact amount on hover. */
export function Money({ token, value, testId }: { token: TokenName; value: bigint; testId?: string }) {
  return <span title={formatAmount(token, value)} data-testid={testId}>{formatMoney(token, value)}</span>;
}

export function Copy({ text, label = 'Copy', className = 'secondary small' }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopied(true);
  };
  return <button type="button" className={className} onClick={copy}><CopyIcon />{copied ? 'Copied' : label}</button>;
}

export function Qr({ text, label }: { text: string; label: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(text, { margin: 1, width: 192 }).then((data) => { if (live) setUrl(data); }, () => undefined);
    return () => { live = false; };
  }, [text]);
  return url ? <img className="qr" src={url} alt={label} width={192} height={192} /> : null;
}

/** A handler that closes a dialog with its own URL by going back to the page under it. */
export const closeTo = (hash: string) => () => { location.hash = hash; };

/** A dialog: a sheet on narrow screens, a panel on wide ones. Closed only by its X (when given) or its buttons. */
export function Modal({ title, children, onClose, wide }: { title: string; children?: ReactNode; onClose?: () => void; wide?: boolean }) {
  // Keyboard and screen-reader users start inside the dialog, not on the page under it.
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => { dialog.current?.focus(); }, []);
  return createPortal(
    <div className="backdrop">
      <div ref={dialog} tabIndex={-1} className={wide ? 'modal wide' : 'modal'} role="dialog" aria-modal="true" aria-label={title}>
        <span className="grabber" aria-hidden="true" />
        <div className="modal-head">
          <h2>{title}</h2>
          {onClose ? <button type="button" className="icon-button" aria-label="Close" onClick={onClose}><CloseIcon /></button> : null}
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** An amount input with optional preset chips (powers of ten) and the round-amount hint, which never blocks. */
export function AmountField({ label, token, value, onChange, presets }: { label: string; token: TokenName; value: string; onChange: (v: string) => void; presets?: readonly bigint[] }) {
  const parsed = parseAmount(token, value);
  const hint = value !== '' && parsed === null
    ? 'Enter a positive amount.'
    : presets && parsed !== null && !isRoundAmount(parsed)
      ? 'Round amounts (1, 10, 100…) are harder to trace. You can continue anyway.'
      : undefined;
  return (
    <div className="amount">
      {presets ? (
        <span className="presets" aria-label="Preset amounts">
          {presets.map((p) => {
            const text = formatAmount(token, p).split(' ')[0] ?? '';
            return <button key={text} type="button" className={value === text ? 'chip on' : 'chip'} onClick={() => onChange(text)}>{text}</button>;
          })}
        </span>
      ) : null}
      <Field label={`${label} (${DISPLAY_SYMBOL[token]})`} hint={hint}>
        <input inputMode="decimal" value={value} placeholder="0.0" onChange={(e) => onChange(e.target.value)} />
      </Field>
    </div>
  );
}

/** What a busy submit says while the proof of a private payment is built (§11.6, proof wait). */
export const PROVING_TEXT = 'Securing your payment privately…';

/**
 * The submit button of an action that goes through a transaction relayer: it first shows the quoted
 * fee next to what will happen, and submits only once the user confirms.
 */
export function RelayedSubmit({ label, token, tokenId, disabled, relayer, details, run, onDone, className = 'primary wide' }: {
  label: string;
  token: TokenName;
  tokenId: bigint;
  disabled?: boolean;
  relayer: () => RelayerPort;
  details: ReactNode;
  run: (relayer: RelayerPort) => Promise<unknown>;
  onDone?: () => void;
  className?: string;
}) {
  const [review, setReview] = useState<{ port: RelayerPort; fee: bigint } | null>(null);
  const quote = useAction(useCallback(async () => {
    const port = relayer();
    const fee = quotedFee(await port.info(), tokenId);
    setReview({ port, fee });
  }, [relayer, tokenId]));
  const submit = useAction(useCallback(async (port: RelayerPort) => {
    await run(port);
    setReview(null);
    onDone?.();
  }, [run, onDone]));
  return (
    <>
      <Button className={className} disabled={disabled} busy={quote.busy} onClick={() => void quote.perform()}>{label}</Button>
      <ErrorNote error={quote.error} />
      {review ? (
        <Modal title={`Confirm: ${label}`}>
          <div className="review">{details}</div>
          <p className="fee">Network fee: <strong><Money token={token} value={review.fee} /></strong><span className="muted"> · paid privately from your balance</span></p>
          <ErrorNote error={submit.error} />
          <div className="stack">
            <Button className="primary wide" busy={submit.busy} busyText={PROVING_TEXT} onClick={() => void submit.perform(review.port)}>Confirm</Button>
            <Button className="ghost wide" disabled={submit.busy} onClick={() => { setReview(null); submit.setError(null); }}>Cancel</Button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
