// The lock screen and its recovery sheet, rendered to static markup against a stubbed lock controller and
// sync manager: the copy for each device, when "Can't unlock?" appears, and the plain warnings before a
// reset. (The lock is an access gate, not encryption: see src/lock/webauthnLocal.ts.)
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LockDevice, LockState } from '@/lock/types';
import type { SyncStatus } from '@/sync/types';

let sync: SyncStatus = { state: 'signedOut', pending: 0 };

vi.mock('@/lock/controller', () => ({
  unlock: vi.fn(async () => 'ok'),
  completeRecovery: vi.fn(),
  resetLock: vi.fn(),
  getLockState: () => ({ phase: 'locked' }),
}));
vi.mock('@/sync/manager', () => ({
  getSyncStatus: () => sync,
  subscribeSyncStatus: () => () => undefined,
  startSync: async () => undefined,
  syncNow: async () => undefined,
  sendCode: async () => undefined,
  verifyCode: async () => ({ id: 'u1' }),
  signOut: async () => undefined,
  eraseDeviceSync: async () => undefined,
}));
vi.mock('@/data/repo', () => ({ wipeAll: async () => undefined }));

const {
  LockScreen,
  RecoveryPanel,
  RECOVERY_AFTER_FAILURES,
  passkeyName,
  recoveryDoneText,
  recoveryEmail,
  resetWarning,
  restoreSteps,
  unlockCopy,
} = await import('./LockScreen');

const DEVICES: LockDevice[] = ['iphone', 'ipad', 'mac', 'other'];

function lockState(patch: Partial<LockState> = {}): LockState {
  return {
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
}

const screen = (patch: Partial<LockState> = {}) => renderToString(createElement(LockScreen, { state: lockState(patch), onRecovered: () => undefined }));
const panel = (view: 'menu' | 'code' | 'reset', patch: Partial<LockState> = {}) =>
  renderToString(createElement(RecoveryPanel, { state: lockState(patch), sync, initialView: view, onClose: () => undefined, onRecovered: () => undefined }));

/** Visible text of some markup, tags removed and entities decoded. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

beforeEach(() => {
  sync = { state: 'signedOut', pending: 0 };
});

describe('unlockCopy', () => {
  it('names the check each device actually uses', () => {
    expect(unlockCopy('iphone')).toEqual({ button: 'Unlock with Face ID' });
    expect(unlockCopy('ipad')).toEqual({ button: 'Unlock', subtitle: 'Face ID, Touch ID or your passcode' });
    expect(unlockCopy('mac')).toEqual({ button: 'Unlock with Touch ID', subtitle: 'or your Mac password' });
    expect(unlockCopy('other')).toEqual({ button: 'Unlock' });
  });
});

describe('recovery copy', () => {
  it('uses the signed-in email only while this device is signed in to sync', () => {
    expect(recoveryEmail({ state: 'idle', email: 'me@example.com', pending: 0 })).toBe('me@example.com');
    expect(recoveryEmail({ state: 'offline', email: 'me@example.com', pending: 2 })).toBe('me@example.com');
    expect(recoveryEmail({ state: 'error', email: 'me@example.com', pending: 0 })).toBe('me@example.com');
    expect(recoveryEmail({ state: 'syncing', email: 'me@example.com', pending: 0 })).toBe('me@example.com');
    expect(recoveryEmail({ state: 'signedOut', pending: 0 })).toBeNull();
    expect(recoveryEmail({ state: 'unconfigured', pending: 0 })).toBeNull();
    expect(recoveryEmail({ state: 'idle', pending: 0 })).toBeNull();
  });

  it('warns plainly before a reset: unsynced changes, or everything when not signed in', () => {
    expect(resetWarning({ state: 'idle', email: 'a@b.co', pending: 3 })).toMatch(/^3 changes on this device haven't synced and will be lost\./);
    expect(resetWarning({ state: 'offline', email: 'a@b.co', pending: 1 })).toMatch(/^1 change on this device hasn't synced and will be lost\./);
    expect(resetWarning({ state: 'signedOut', pending: 0 })).toBe('Everything on this device will be erased. Your data is gone unless you have a backup.');
    expect(resetWarning({ state: 'unconfigured', pending: 0 })).toBe('Everything on this device will be erased. Your data is gone unless you have a backup.');
    expect(resetWarning({ state: 'idle', email: 'a@b.co', pending: 0 })).toMatch(/Your sync account keeps its copy\./);
  });

  it('tells you how to restore the passkey by its name', () => {
    expect(passkeyName({ label: '' })).toBe('Four Burners lock');
    expect(passkeyName({ label: 'Four Burners lock · iPad' })).toBe('Four Burners lock · iPad');
    const steps = restoreSteps('Four Burners lock', 'iphone');
    expect(steps.join(' ')).toMatch(/Passwords app/);
    expect(steps.join(' ')).toMatch(/Recently Deleted/);
    expect(steps.join(' ')).toMatch(/Restore "Four Burners lock"/);
    expect(restoreSteps('Four Burners lock', 'other').join(' ')).toMatch(/password manager/);
  });

  it('says the lock is off after an email-code recovery, and how to get it back', () => {
    expect(recoveryDoneText('iphone')).toBe('Face ID lock is off. Turn it on again in Settings to make a new passkey.');
    expect(recoveryDoneText('mac')).toMatch(/^Touch ID lock is off\./);
    expect(recoveryDoneText('ipad')).toMatch(/^The app lock is off\./);
  });

  it('never uses an em dash', () => {
    const all = [
      ...DEVICES.flatMap((d) => [unlockCopy(d).button, unlockCopy(d).subtitle ?? '', recoveryDoneText(d), ...restoreSteps('x', d)]),
      resetWarning({ state: 'idle', email: 'a@b.co', pending: 2 }),
      resetWarning({ state: 'idle', email: 'a@b.co', pending: 0 }),
      resetWarning({ state: 'signedOut', pending: 0 }),
    ];
    for (const s of all) expect(s).not.toMatch(/—/);
  });
});

describe('LockScreen', () => {
  it.each(DEVICES)('shows the title and the %s unlock button', (device) => {
    const html = screen({ device });
    const t = text(html);
    expect(t).toContain('Four Burners is locked');
    expect(t).toContain(unlockCopy(device).button);
    if (unlockCopy(device).subtitle) expect(t).toContain(unlockCopy(device).subtitle);
    expect(html).not.toMatch(/—/);
  });

  it('keeps instructional copy readable (text-dim, never text-faint)', () => {
    const html = screen({ device: 'ipad' });
    expect(html).not.toContain('text-faint');
    expect(html).toMatch(/<p class="[^"]*text-dim[^"]*">Face ID, Touch ID or your passcode<\/p>/);
  });

  it('shows the controller message in a live region that is always there', () => {
    const quiet = screen();
    expect(quiet).toMatch(/role="status"[^>]*aria-live="polite"/);
    const html = screen({ message: "That didn't work. Try again.", failures: 1 });
    expect(text(html)).toContain("That didn't work. Try again.");
  });

  it(`offers "Can't unlock?" only after ${RECOVERY_AFTER_FAILURES} failed tries`, () => {
    expect(text(screen({ failures: 0 }))).not.toContain("Can't unlock?");
    expect(text(screen({ failures: RECOVERY_AFTER_FAILURES - 1 }))).not.toContain("Can't unlock?");
    expect(text(screen({ failures: RECOVERY_AFTER_FAILURES }))).toContain("Can't unlock?");
  });

  it('marks the button busy while the Face ID prompt is up', () => {
    expect(screen({ phase: 'unlocking' })).toMatch(/<button[^>]*aria-busy="true"/);
    expect(screen({ phase: 'locked' })).not.toContain('aria-busy');
  });
});

describe('RecoveryPanel', () => {
  it('offers the passkey restore and a reset, and the email code only when signed in', () => {
    const signedOut = text(panel('menu'));
    expect(signedOut).toContain('Restore the passkey');
    expect(signedOut).toContain('Four Burners lock · iPhone');
    expect(signedOut).toContain('Reset this device');
    expect(signedOut).not.toContain('Sign in with an email code');

    sync = { state: 'idle', email: 'jordan@northwindwealth.com', pending: 0 };
    const signedIn = text(panel('menu'));
    expect(signedIn).toContain('Sign in with an email code');
    expect(signedIn).toContain('jordan@northwindwealth.com');
  });

  it('asks for a numeric one-time code sent to the signed-in email', () => {
    sync = { state: 'idle', email: 'jordan@northwindwealth.com', pending: 0 };
    const html = panel('code');
    expect(html).toMatch(/autocomplete="one-time-code"/i);
    expect(html).toMatch(/inputmode="numeric"/i);
    expect(text(html)).toContain('Enter the code we emailed to jordan@northwindwealth.com');
    expect(html).not.toContain('text-faint');
    // Never disabled (that closes the iOS keyboard); read-only only while a code is being checked.
    const input = html.match(/<input[^>]*>/)?.[0] ?? '';
    expect(input).not.toMatch(/disabled|readonly/i);
  });

  it('explains when the code step no longer applies (signed out meanwhile)', () => {
    expect(text(panel('code'))).toContain("This device is no longer signed in to sync, so a code can't unlock it.");
  });

  it('warns before a reset in plain words', () => {
    sync = { state: 'idle', email: 'a@b.co', pending: 4 };
    expect(text(panel('reset'))).toContain("4 changes on this device haven't synced and will be lost.");
    sync = { state: 'signedOut', pending: 0 };
    const t = text(panel('reset'));
    expect(t).toContain('Everything on this device will be erased. Your data is gone unless you have a backup.');
    expect(t).toContain('Erase this device');
    expect(t).toContain('Cancel');
  });

  it('never shows an em dash in any view', () => {
    sync = { state: 'idle', email: 'a@b.co', pending: 2 };
    for (const v of ['menu', 'code', 'reset'] as const) {
      for (const device of DEVICES) expect(panel(v, { device })).not.toMatch(/—/);
    }
  });
});
