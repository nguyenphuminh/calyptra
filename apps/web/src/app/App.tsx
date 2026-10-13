import type { Calyptra } from '@calyptra/framework';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ChannelsPage, nicknames, peerName, PendingOpens } from '../modules/channels/index.ts';
import { MyWallet } from '../modules/home/index.ts';
import { Onboarding, PhraseBanner, TAGLINE, Unlock } from '../modules/onboarding/index.ts';
import { ServicesPage, subscriptionsOf } from '../modules/services/index.ts';
import { Settings } from '../modules/settings/index.ts';
import { AccountBar } from '../modules/wallet/index.ts';
import { ChannelsIcon, Logo, ServicesIcon, SettingsIcon, WalletIcon } from '../shared/icons.tsx';
import { errorText, PROVING_TEXT } from '../shared/ui.tsx';
import { AppContext, type AppContextValue } from './context.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { artifactsBase, createCalyptra } from './node.ts';
import { PromptDialog } from './PromptDialog.tsx';
import { Prompts } from './prompts.ts';
import { isChatOpen, routeOf, type Route } from './routes.ts';
import { startNode } from './settings.ts';
import { WorkerProver } from './worker-prover.ts';

/** Which tab or subscription a background problem is about, by name rather than by id. */
function subjectOf(calyptra: Calyptra, channelId: string): string {
  const subscription = subscriptionsOf(calyptra).find((s) => s.channelId === channelId);
  if (subscription) return `Subscription to ${subscription.merchant}`;
  try {
    return `Tab with ${peerName(calyptra.channels.get(channelId).peer.peerId, nicknames(calyptra))}`;
  } catch {
    return 'A tab';
  }
}

/** Interval of the background tick: pool sync, channel progress, dispute watching (default 10 s). */
const TICK_MS = Number(import.meta.env.VITE_CALYPTRA_TICK_MS ?? 10_000);

type Section = Route['section'];
/** Main navigation: the sidebar on wide screens, the bottom tab bar on phones. */
const NAV: { section: Section; href: string; label: string; icon: ReactNode }[] = [
  { section: 'channels', href: '#/channels', label: 'Tabs', icon: <ChannelsIcon /> },
  { section: 'services', href: '#/services', label: 'Services', icon: <ServicesIcon /> },
  { section: 'wallet', href: '#/wallet', label: 'My wallet', icon: <WalletIcon /> },
  { section: 'settings', href: '#/settings', label: 'Settings', icon: <SettingsIcon /> },
];

/** The hash without '#', or '/' when empty; follows hashchange. */
function useHashPath(): string {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const update = () => setHash(location.hash);
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return hash.replace(/^#/, '') || '/';
}

function pageOf(route: Route): ReactNode {
  if (route.section === 'channels') return <ChannelsPage view={route.view} />;
  if (route.section === 'services') return <ServicesPage view={route.view} />;
  if (route.section === 'settings') return <Settings category={route.category} />;
  return <MyWallet dialog={route.dialog} sendTo={route.sendTo} />;
}

type Phase = 'loading' | 'onboarding' | 'locked' | 'ready';

export function App() {
  const prompts = useMemo(() => new Prompts(), []);
  const pendingOpens = useMemo(() => new PendingOpens(), []);
  const prover = useMemo(() => new WorkerProver(artifactsBase()), []);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const calyptra = useMemo(() => createCalyptra(prompts, prover, refresh), [prompts, prover, refresh]);
  const [phase, setPhase] = useState<Phase>('loading');
  const [problems, setProblems] = useState<string[]>([]);
  const [asked, setAsked] = useState(() => prompts.current());
  const route = routeOf(useHashPath());
  const proving = useSyncExternalStore(useCallback((listener: () => void) => prover.subscribe(listener), [prover]), () => prover.busy());

  useEffect(() => {
    let live = true;
    void calyptra.wallet.exists().then((exists) => { if (live) setPhase(exists ? 'locked' : 'onboarding'); });
    const unsubscribe = prompts.subscribe(() => {
      setAsked(prompts.current());
      refresh(); // channel requests also appear in the tab list
    });
    return () => { live = false; unsubscribe(); };
  }, [calyptra, prompts, refresh]);

  useEffect(() => pendingOpens.subscribe(refresh), [pendingOpens, refresh]);

  const onReady = useCallback(async () => {
    await startNode(calyptra);
    setPhase('ready');
    refresh();
    // Proof wait: load the transfer circuit's proving files (about 21 MB) before the first payment.
    prover.prefetch('transfer');
  }, [calyptra, prover, refresh]);

  const lock = useCallback(async () => {
    await calyptra.lock();
    setPhase('locked');
    pendingOpens.clear(); // after the phase change, so no wallet screen redraws against the stopped node
  }, [calyptra, pendingOpens]);

  // The background tick, only while unlocked; a tick still running skips the next one.
  useEffect(() => {
    if (phase !== 'ready') return;
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      calyptra.tick().then(
        (found) => setProblems(found.map((p) => `${subjectOf(calyptra, p.channelId)}: ${errorText(p.error)}`)),
        (err: unknown) => setProblems([errorText(err)]),
      ).finally(() => {
        running = false;
        refresh();
      });
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [phase, calyptra, refresh]);

  const context: AppContextValue | null = useMemo(
    () => (phase === 'ready' ? { calyptra, prompts, pendingOpens, version, refresh, lock } : null),
    [phase, calyptra, prompts, pendingOpens, version, refresh, lock],
  );

  if (phase === 'loading') return <div className="loading" aria-busy="true" />;
  if (phase === 'onboarding') return <Onboarding calyptra={calyptra} onReady={onReady} />;
  // While `lock()` stops the node, the wallet may already be locked: no wallet screen renders against it.
  if (phase === 'locked' || !context || !calyptra.wallet.isUnlocked) return <Unlock calyptra={calyptra} onReady={onReady} />;

  const full = route.section === 'channels' || route.section === 'services';
  return (
    <AppContext.Provider value={context}>
      <div className={`shell section-${route.section}${isChatOpen(route) ? ' chat-open' : ''}`}>
        <aside className="sidebar">
          <a className="brand" href="#/channels">
            <Logo size={34} />
            <span className="brand-text">
              <span>Calyptra</span>
              <small className="brand-tagline">{TAGLINE}</small>
            </span>
          </a>
          <nav className="nav" aria-label="Main">
            {NAV.map((n) => (
              <a key={n.section} href={n.href} aria-current={route.section === n.section ? 'page' : undefined}>
                {n.icon}<span>{n.label}</span>
              </a>
            ))}
          </nav>
          <AccountBar />
        </aside>
        <main className={full ? 'content full' : 'content'}>
          <PhraseBanner />
          {proving ? <p className="proving" role="status"><span className="spinner" aria-hidden="true" />{PROVING_TEXT}</p> : null}
          {problems.length > 0 ? (
            <ul className="problems" aria-label="Background problems">
              {problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          ) : null}
          <ErrorBoundary key={route.section} resetKey={version}>{pageOf(route)}</ErrorBoundary>
        </main>
      </div>
      {asked ? <PromptDialog asked={asked} /> : null}
    </AppContext.Provider>
  );
}
