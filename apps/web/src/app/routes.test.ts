import { describe, expect, it } from 'vitest';
import { isChatOpen, routeOf } from './routes.ts';

describe('routeOf', () => {
  it('maps the baseline routes, with Tabs (channels) as the default', () => {
    expect(routeOf('/invite/abc')).toEqual({ section: 'channels', view: { kind: 'open', invite: 'abc' } });
    expect(routeOf('/channels/new')).toEqual({ section: 'channels', view: { kind: 'open', invite: '' } });
    expect(routeOf('/channels/invite')).toEqual({ section: 'channels', view: { kind: 'invite' } });
    expect(routeOf('/channels/0123')).toEqual({ section: 'channels', view: { kind: 'channel', id: '0123' } });
    expect(routeOf('/wallet')).toEqual({ section: 'wallet', dialog: null });
    expect(routeOf('/withdraw')).toEqual({ section: 'wallet', dialog: 'withdraw' });
    expect(routeOf('/settings')).toEqual({ section: 'settings', category: null });
    expect(routeOf('/settings/network')).toEqual({ section: 'settings', category: 'network' });
    for (const path of ['/', '/channels', '/nowhere']) expect(routeOf(path)).toEqual({ section: 'channels', view: { kind: 'none' } });
  });

  it('maps the services routes, merchant links and payment links', () => {
    expect(routeOf('/services')).toEqual({ section: 'services', view: { kind: 'none' } });
    expect(routeOf('/services/abcd')).toEqual({ section: 'services', view: { kind: 'session', id: 'abcd' } });
    expect(routeOf('/merchant/xyz')).toEqual({ section: 'services', view: { kind: 'subscribe', code: 'xyz' } });
    expect(routeOf('/send/cal00')).toEqual({ section: 'wallet', dialog: 'send', sendTo: 'cal00' });
  });

  it('opens a conversation full screen on phones only for a tab or a session', () => {
    expect(isChatOpen(routeOf('/channels/0123'))).toBe(true);
    expect(isChatOpen(routeOf('/services/abcd'))).toBe(true);
    expect(isChatOpen(routeOf('/services'))).toBe(false);
    expect(isChatOpen(routeOf('/wallet'))).toBe(false);
  });
});
