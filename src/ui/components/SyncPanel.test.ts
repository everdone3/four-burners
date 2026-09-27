// SyncPanel, rendered to static markup against a stubbed sync manager: the code step (email wrapping,
// readable helper line, rate-limit wording) and the signed-in status line's live region.
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIGN_IN_MESSAGES, SignInError } from '@/sync/auth';
import type { SyncStatus } from '@/sync/types';

let status: SyncStatus = { state: 'signedOut', pending: 0 };

vi.mock('@/sync/manager', () => ({
  getSyncStatus: () => status,
  subscribeSyncStatus: () => () => undefined,
  startSync: async () => undefined,
  syncNow: async () => undefined,
  sendCode: async () => undefined,
  verifyCode: async () => ({ id: 'u1' }),
  signOut: async () => undefined,
}));

const { SyncPanel, CODE_SENT_RECENTLY, sendFailure } = await import('./SyncPanel');

/** Opening tags of every element carrying aria-live="polite". */
function liveRegions(html: string): string[] {
  return html.match(/<[a-z]+[^>]*aria-live="polite"[^>]*>/g) ?? [];
}

describe('SyncPanel code step', () => {
  beforeEach(() => {
    const store = new Map<string, string>([['fb-sync-signin', JSON.stringify({ email: 'jordan@northwindwealth.com', sentAt: Date.now() })]]);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    status = { state: 'signedOut', pending: 0 };
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('wraps the email only between words, never mid-address', () => {
    const html = renderToString(createElement(SyncPanel));
    expect(html).toContain('jordan@northwindwealth.com');
    const span = html.match(/<span class="([^"]*)">jordan@northwindwealth\.com<\/span>/);
    expect(span).not.toBeNull();
    expect(span![1]).not.toContain('break-all');
    expect(span![1]).toContain('wrap-break-word');
  });

  it('shows the paste-a-link hint in readable text, not the faint style', () => {
    const html = renderToString(createElement(SyncPanel));
    const hint = html.match(/<p class="([^"]*)">Got a link instead of a code\? Paste it here\.<\/p>/);
    expect(hint).not.toBeNull();
    expect(hint![1]).toContain('text-dim');
    expect(hint![1]).not.toContain('text-faint');
  });
});

describe('sendFailure', () => {
  it('moves a rate-limited send to the code step with wording that asks for the code', () => {
    const f = sendFailure(new SignInError('rate_limit', SIGN_IN_MESSAGES.rate_limit_send));
    expect(f.codeStep).toBe(true);
    expect(f.message).toBe(CODE_SENT_RECENTLY);
    expect(f.message).not.toBe(SIGN_IN_MESSAGES.rate_limit_send);
    expect(f.message).toMatch(/Enter it here/);
    expect(f.message).not.toMatch(/—/);
  });

  it('keeps other failures on the email step with their own message', () => {
    expect(sendFailure(new SignInError('offline', SIGN_IN_MESSAGES.offline))).toEqual({ codeStep: false, message: SIGN_IN_MESSAGES.offline });
    expect(sendFailure(new Error('boom'))).toEqual({ codeStep: false, message: SIGN_IN_MESSAGES.unknown });
  });
});

describe('SyncPanel status line', () => {
  it('announces from one stable live region, not from the animated line that is swapped on each change', () => {
    status = { state: 'idle', email: 'me@example.com', lastSyncedAt: new Date().toISOString(), pending: 0 };
    const html = renderToString(createElement(SyncPanel));
    expect(html).toContain('Synced just now');
    const regions = liveRegions(html);
    expect(regions).toHaveLength(1);
    // The swapped line is a motion element with inline animation styles; the live region must not be it.
    expect(regions[0]).not.toContain('style=');
    const at = html.indexOf(regions[0]);
    expect(html.indexOf('Synced just now')).toBeGreaterThan(at);
  });
});
