// The app's own icon set: simple 24 px line icons that follow the text colour, plus the brand mark.
import type { ReactNode, SVGProps } from 'react';

function Icon({ children, ...rest }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>{children}</svg>
  );
}

export const ChannelsIcon = () => <Icon><path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4 3.5V6a1 1 0 0 1 1-1z" /><path d="M9 9.5h6M9 12.5h4" /></Icon>;
export const SettingsIcon = () => <Icon><circle cx="12" cy="12" r="3" /><path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" /></Icon>;
export const DepositIcon = () => <Icon><path d="M12 3v11M7.5 9.5 12 14l4.5-4.5" /><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" /></Icon>;
export const WithdrawIcon = () => <Icon><path d="M12 14V3M7.5 7.5 12 3l4.5 4.5" /><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" /></Icon>;
export const SendIcon = () => <Icon><path d="M21 3 10.5 13.5M21 3l-6.5 18-4-7.5L3 9.5z" /></Icon>;
export const ReceiveIcon = () => <Icon><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><path d="M14 14h2v2h-2zM18 18h2v2h-2zM18 14h2M14 18v2" /></Icon>;
export const CopyIcon = () => <Icon><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a1 1 0 0 1 1-1h10" /></Icon>;
export const BackIcon = () => <Icon><path d="M15 5 8 12l7 7" /></Icon>;
export const LockIcon = () => <Icon><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></Icon>;
export const PlusIcon = () => <Icon><path d="M12 5v14M5 12h14" /></Icon>;
export const ShieldIcon = () => <Icon><path d="M12 3 5 6v5.5c0 4.2 3 7.8 7 9.5 4-1.7 7-5.3 7-9.5V6z" /><path d="m9 12 2 2 4-4" /></Icon>;
export const KeyIcon = () => <Icon><circle cx="8" cy="15" r="4" /><path d="M11 12 20 3M16.5 6.5 19 9M14 9l2 2" /></Icon>;
export const LinkIcon = () => <Icon><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></Icon>;
export const ArrowRightIcon = () => <Icon><path d="M5 12h14M13 6l6 6-6 6" /></Icon>;
export const WalletIcon = () => <Icon><path d="M4 7a2 2 0 0 1 2-2h11a1 1 0 0 1 1 1v2" /><path d="M4 7v11a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H6a2 2 0 0 1-2-2z" /><circle cx="16" cy="14" r="1.2" /></Icon>;
export const EyeIcon = () => <Icon><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></Icon>;
export const EditIcon = () => <Icon><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></Icon>;
export const CloseIcon = () => <Icon><path d="M6 6l12 12M18 6 6 18" /></Icon>;
export const ThemeIcon = () => <Icon><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /></Icon>;

// Icons of the consumer screens.
/** Services paid by the second: a clock face with a quick sweep. */
export const ServicesIcon = () => <Icon><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 2.5M10 2.5h4" /></Icon>;
/** A passkey: a fingerprint-like set of arcs. */
export const PasskeyIcon = () => <Icon><path d="M7.5 18.5c1-2 1.5-4 1.5-6.5a3 3 0 0 1 6 0c0 1.2-.1 2.4-.3 3.5" /><path d="M5 15.5c.6-1.2 1-2.3 1-3.5a6 6 0 0 1 12 0c0 3-.6 5.6-1.6 7.5" /><path d="M12 12c0 3-.8 5.6-2.3 8" /></Icon>;
export const PauseIcon = () => <Icon><path d="M9 5v14M15 5v14" /></Icon>;
export const PlayIcon = () => <Icon><path d="M7 5v14l11-7z" /></Icon>;
export const ActivityIcon = () => <Icon><path d="M3 12h4l3 7 4-14 3 7h4" /></Icon>;

/**
 * The brand mark: a "C" drawn as a 300° arc with round caps (open at the top right) around a soft coin.
 * Both use one holographic gradient, sky to violet to pink, whose stops come from the theme (--logo-0…3
 * in styles.css): deeper on light backgrounds, pastel on dark ones. public/favicon.svg is the same mark.
 */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="logo">
      <defs>
        <linearGradient id="calyptra-holo" x1="0.1" y1="0.1" x2="0.9" y2="0.95">
          <stop offset="0" style={{ stopColor: 'var(--logo-0, #5ec8f7)' }} />
          <stop offset="0.35" style={{ stopColor: 'var(--logo-1, #8b9cf9)' }} />
          <stop offset="0.62" style={{ stopColor: 'var(--logo-2, #a78bfa)' }} />
          <stop offset="1" style={{ stopColor: 'var(--logo-3, #f49ac2)' }} />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="13" fill="url(#calyptra-holo)" style={{ fillOpacity: 'var(--logo-coin, 0.7)' }} />
      <path d="M53.25 26.31A22 22 0 1 1 37.69 10.75" fill="none" stroke="url(#calyptra-holo)" strokeWidth="10" strokeLinecap="round" />
    </svg>
  );
}

/** A stable two-colour disc for a peer, so channels are easy to tell apart without names. */
export function Avatar({ seed, size = 44 }: { seed: string; size?: number }) {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0; // iterate code points, use first UTF-16 unit
  const a = hash % 360;
  const b = (a + 40 + ((hash >> 9) % 80)) % 360; // signed shift: may be negative for hash >= 2^31
  return (
    <span className="avatar" style={{ width: size, height: size,
      background: `linear-gradient(135deg, hsl(${a} 70% 62%), hsl(${b} 70% 48%))` }} aria-hidden="true" />
  );
}
