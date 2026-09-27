// The lock gate, rendered to static markup for each lock state: on a locked cold start the app is not
// mounted at all; after the first unlock a re-lock keeps it mounted but inert and hidden from assistive
// tech. (The lock is an access gate, not encryption: see src/lock/webauthnLocal.ts.)
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LockState } from '@/lock/types';

let state: LockState;

vi.mock('@/lock/controller', () => ({
  unlock: vi.fn(async () => 'ok'),
  completeRecovery: vi.fn(),
  resetLock: vi.fn(),
  getLockState: () => state,
  subscribeLock: () => () => undefined,
}));
vi.mock('@/lock/useLock', () => ({ useLockState: () => state }));
vi.mock('@/sync/manager', () => ({
  getSyncStatus: () => ({ state: 'signedOut', pending: 0 }),
  subscribeSyncStatus: () => () => undefined,
  syncNow: async () => undefined,
  sendCode: async () => undefined,
  verifyCode: async () => ({ id: 'u1' }),
  eraseDeviceSync: async () => undefined,
}));
vi.mock('@/data/repo', () => ({ wipeAll: async () => undefined }));
vi.mock('@/data/backup', () => ({ buildBackupFile: async () => undefined, saveBackupFile: async () => 'shared' }));

const { LockGate, isOpenPhase } = await import('./LockGate');
const { lockEngaged } = await import('./ErrorBoundary');

function render(patch: Partial<LockState>): string {
  state = {
    phase: 'locked',
    idleMinutes: 5,
    coldStart: true,
    failures: 0,
    device: 'iphone',
    otherHost: false,
    available: 'yes',
    label: 'Four Burners lock · iPhone',
    ...patch,
  };
  return renderToString(createElement(LockGate, null, createElement('p', null, 'APP CONTENT')));
}

/** The opening tag of #app-layer. */
const appLayer = (html: string) => html.match(/<div[^>]*id="app-layer"[^>]*>/)?.[0] ?? '';

describe('LockGate', () => {
  it('always renders both layers', () => {
    for (const phase of ['off', 'unlocked', 'locked', 'unlocking'] as const) {
      const html = render({ phase });
      expect(html).toContain('id="app-layer"');
      expect(html).toContain('id="lock-layer"');
    }
  });

  it('locked cold start: only the lock screen, the app is not mounted at all', () => {
    for (const phase of ['locked', 'unlocking'] as const) {
      const html = render({ phase, coldStart: true });
      expect(html).toContain('Four Burners is locked');
      expect(html).not.toContain('APP CONTENT');
      expect(appLayer(html)).toContain('inert=""');
      expect(appLayer(html)).toContain('aria-hidden="true"');
    }
  });

  it('open: the app, no lock screen, nothing inert', () => {
    for (const phase of ['off', 'unlocked'] as const) {
      for (const coldStart of [true, false]) {
        const html = render({ phase, coldStart });
        expect(html).toContain('APP CONTENT');
        expect(html).not.toContain('Four Burners is locked');
        expect(appLayer(html)).not.toContain('inert');
        expect(appLayer(html)).not.toContain('aria-hidden');
      }
    }
  });

  it('re-locked after the first unlock: the app stays mounted, but inert and hidden, under the lock screen', () => {
    const html = render({ phase: 'locked', coldStart: false });
    expect(html).toContain('APP CONTENT');
    expect(html).toContain('Four Burners is locked');
    expect(appLayer(html)).toContain('inert=""');
    expect(appLayer(html)).toContain('aria-hidden="true"');
    // The lock screen comes after the app in the document, in its own layer.
    expect(html.indexOf('id="lock-layer"')).toBeGreaterThan(html.indexOf('APP CONTENT'));
  });

  it('knows which phases are open', () => {
    expect(isOpenPhase('off')).toBe(true);
    expect(isOpenPhase('unlocked')).toBe(true);
    expect(isOpenPhase('locked')).toBe(false);
    expect(isOpenPhase('unlocking')).toBe(false);
  });
});

describe('ErrorBoundary lockEngaged', () => {
  it('follows the lock phase, so the error screen never offers a backup past the lock', () => {
    render({ phase: 'locked' });
    expect(lockEngaged()).toBe(true);
    render({ phase: 'unlocking' });
    expect(lockEngaged()).toBe(true);
    render({ phase: 'unlocked' });
    expect(lockEngaged()).toBe(false);
    render({ phase: 'off' });
    expect(lockEngaged()).toBe(false);
  });
});
