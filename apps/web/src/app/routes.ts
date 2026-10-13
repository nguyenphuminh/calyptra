import type { ChannelsView } from '../modules/channels/index.ts';
import type { WalletDialog } from '../modules/home/index.ts';
import type { ServicesView } from '../modules/services/index.ts';
import type { SettingsCategory } from '../modules/settings/index.ts';

export type Route =
  | { section: 'channels'; view: ChannelsView }
  | { section: 'services'; view: ServicesView }
  | { section: 'wallet'; dialog: WalletDialog | null; sendTo?: string }
  | { section: 'settings'; category: SettingsCategory | null };

const WALLET_DIALOGS = ['deposit', 'withdraw', 'receive', 'send'] satisfies WalletDialog[];
const SETTINGS_CATEGORIES = ['accounts', 'backup', 'network', 'appearance'] satisfies SettingsCategory[];

const isWalletDialog = (value: string): value is WalletDialog => (WALLET_DIALOGS as string[]).includes(value);
const isSettingsCategory = (value: string): value is SettingsCategory => (SETTINGS_CATEGORIES as string[]).includes(value);

/**
 * The screen a hash path shows, first match wins. Tabs (channels) are the start screen, so they are also
 * the default. Also the Services routes, merchant links and payment links to a Calyptra ID.
 */
export function routeOf(path: string): Route {
  if (path.startsWith('/invite/')) return { section: 'channels', view: { kind: 'open', invite: path.slice('/invite/'.length) } };
  if (path === '/channels/new') return { section: 'channels', view: { kind: 'open', invite: '' } };
  if (path === '/channels/invite') return { section: 'channels', view: { kind: 'invite' } };
  if (path.startsWith('/channels/')) return { section: 'channels', view: { kind: 'channel', id: path.slice('/channels/'.length) } };
  if (path === '/wallet') return { section: 'wallet', dialog: null };
  if (path.startsWith('/send/')) return { section: 'wallet', dialog: 'send', sendTo: path.slice('/send/'.length) };
  const dialog = path.slice(1);
  if (isWalletDialog(dialog)) return { section: 'wallet', dialog };
  if (path === '/services') return { section: 'services', view: { kind: 'none' } };
  if (path.startsWith('/services/')) return { section: 'services', view: { kind: 'session', id: path.slice('/services/'.length) } };
  if (path.startsWith('/merchant/')) return { section: 'services', view: { kind: 'subscribe', code: path.slice('/merchant/'.length) } };
  if (path === '/settings') return { section: 'settings', category: null };
  if (path.startsWith('/settings/')) {
    const category = path.slice('/settings/'.length);
    return { section: 'settings', category: isSettingsCategory(category) ? category : null };
  }
  return { section: 'channels', view: { kind: 'none' } };
}

/** Whether a route shows one conversation full screen on phones (the shell then hides its top bar). */
export const isChatOpen = (route: Route): boolean =>
  (route.section === 'channels' && route.view.kind === 'channel') || (route.section === 'services' && route.view.kind === 'session');
