// Settings > App lock, rendered to static markup in each state against a stubbed lock controller, plus the
// copy helpers and the diagnostics text. (The lock is an access gate, not encryption: see
// src/lock/webauthnLocal.ts.)
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDLE_CHOICES, type LockDevice, type LockState } from '@/lock/types';

let state: LockState;

vi.mock('@/lock/controller', () => ({
  enableLock: vi.fn(async () => 'ok'),
  disableLock: vi.fn(async () => 'ok'),
  lockNow: vi.fn(),
  setIdleMinutes: vi.fn(),
  getLockLog: () => [],
}));
vi.mock('@/lock/useLock', () => ({ useLockState: () => state }));

const {
  LockSettings,
  OTHER_HOST_TEXT,
  biometricName,
  blurNote,
  disableNote,
  enableHint,
  enableNote,
  idleHint,
  idleLabel,
  lockExplainer,
  lockRowLabel,
  unavailableText,
} = await import('./LockSettings');
const { LockDiagnostics, describeLockState, fmtLogTime, formatLockLog } = await import('./LockDiagnostics');

const DEVICES: LockDevice[] = ['iphone', 'ipad', 'mac', 'other'];

function lockState(patch: Partial<LockState> = {}): LockState {
  return {
    phase: 'off',
    idleMinutes: 5,
    coldStart: false,
    failures: 0,
    device: 'iphone',
    otherHost: false,
    available: 'yes',
    label: 'Four Burners lock · iPhone',
    ...patch,
  };
}

function render(patch: Partial<LockState> = {}): string {
  state = lockState(patch);
  return renderToString(createElement(LockSettings));
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

beforeEach(() => {
  state = lockState();
});

describe('copy helpers', () => {
  it('labels the row for each device', () => {
    expect(lockRowLabel('iphone')).toBe('Lock with Face ID');
    expect(lockRowLabel('mac')).toBe('Lock with Touch ID');
    expect(lockRowLabel('ipad')).toBe('Lock with Face ID or Touch ID');
    expect(lockRowLabel('other')).toBe('Lock with Face ID or Touch ID');
    expect(biometricName('iphone')).toBe('Face ID');
  });

  it('labels every idle choice', () => {
    expect(IDLE_CHOICES.map(idleLabel)).toEqual(['Immediately', '1 minute', '5 minutes', '15 minutes', '1 hour']);
    expect(idleHint(0)).toMatch(/every time you leave the app/);
    // Not "when you leave": with a timeout, leaving only locks once you have been away that long.
    expect(idleHint(15)).toBe('Locks after this long away from the app or without a tap.');
    expect(idleHint(15)).not.toMatch(/when you leave/);
  });

  it('is upfront that the lock does not encrypt', () => {
    expect(lockExplainer('Four Burners lock · iPhone', 'iphone')).toBe(
      'Uses a passkey named "Four Burners lock · iPhone", saved in your Passwords. It locks the app on this device. It does not encrypt your data.',
    );
    expect(lockExplainer('x', 'other')).toMatch(/password manager/);
  });

  it('warns that setting up asks twice', () => {
    expect(enableHint('iphone')).toBe('iOS will ask for Face ID twice: once to create the passkey and once to test it.');
    expect(enableHint('mac')).toMatch(/^Your Mac will ask for Touch ID twice/);
  });

  it('explains how to delete the passkey after turning the lock off', () => {
    const ok = disableNote('ok', 'iphone');
    expect(ok.tone).toBe('ok');
    expect(ok.text).toMatch(/Passwords app/);
    expect(ok.text).toMatch(/search "Four Burners"/);
    expect(ok.text).toMatch(/Delete/);
    expect(disableNote('cancelled', 'iphone').text).toMatch(/still on/);
    expect(disableNote('failed', 'mac').tone).toBe('error');
    expect(enableNote('cancelled').text).toMatch(/still off/);
  });

  it('only mentions the app switcher on iPhone and iPad', () => {
    expect(blurNote('iphone')).toBe(
      'The app also blurs when you leave it. The app switcher preview is taken by iOS before any app can react, so it may still show your screen.',
    );
    expect(blurNote('mac')).toBe('The app also blurs when you leave it.');
  });

  it('never uses an em dash', () => {
    const all = [
      OTHER_HOST_TEXT,
      ...IDLE_CHOICES.flatMap((m) => [idleLabel(m), idleHint(m)]),
      ...DEVICES.flatMap((d) => [
        lockRowLabel(d),
        enableHint(d),
        unavailableText(d),
        blurNote(d),
        lockExplainer('x', d),
        disableNote('ok', d).text,
        disableNote('cancelled', d).text,
        disableNote('failed', d).text,
      ]),
      enableNote('ok').text,
      enableNote('cancelled').text,
      enableNote('failed').text,
    ];
    for (const s of all) expect(s).not.toMatch(/—/);
  });
});

describe('LockSettings', () => {
  it('off: a switch, what the passkey is, and that it does not encrypt', () => {
    const html = render();
    const t = text(html);
    expect(html).toMatch(/role="switch"[^>]*aria-checked="false"/);
    expect(t).toContain('Lock with Face ID');
    expect(t).toContain('It does not encrypt your data.');
    expect(t).toContain('iOS will ask for Face ID twice');
    expect(t).not.toContain('Lock after');
    expect(t).not.toContain('Lock now');
  });

  it('off and the platform says no: the reason, and Try anyway instead of the switch', () => {
    const html = render({ available: 'no' });
    const t = text(html);
    expect(t).toContain('Set a device passcode and turn on iCloud Keychain to use this.');
    expect(t).toContain('Try anyway');
    expect(html).not.toContain('role="switch"');
  });

  it('off, set up on another address: says so and offers to set it up here', () => {
    const t = text(render({ otherHost: true }));
    expect(t).toContain(OTHER_HOST_TEXT);
    expect(t).toContain('Set it up here');
  });

  it('on: lock after, lock now, the passkey name, and the blur line', () => {
    const html = render({ phase: 'unlocked', idleMinutes: 15 });
    const t = text(html);
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/);
    expect(t).toContain('Lock after');
    for (const m of IDLE_CHOICES) expect(t).toContain(idleLabel(m));
    expect(html).toMatch(/<option value="15" selected="">15 minutes<\/option>/);
    expect(t).toContain('Lock now');
    expect(t).toContain('Passkey: Four Burners lock · iPhone');
    expect(t).toContain('The app switcher preview is taken by iOS');
    expect(t).not.toContain('It does not encrypt your data.');
  });

  it.each(DEVICES)('reads right on %s, with readable instructional text', (device) => {
    for (const patch of [{}, { available: 'no' as const }, { otherHost: true }, { phase: 'unlocked' as const }]) {
      const html = render({ device, ...patch });
      expect(text(html)).toContain(lockRowLabel(device));
      expect(html).not.toContain('text-faint');
      expect(html).not.toMatch(/—/);
    }
  });
});

describe('LockDiagnostics', () => {
  it('formats the log for the clipboard, oldest first, with the state on top', () => {
    const s = lockState({ phase: 'locked', failures: 2 });
    const at = new Date(2026, 8, 27, 8, 4, 5, 7).getTime();
    const out = formatLockLog(
      [
        { at, event: 'launch', detail: 'locked (cold start)' },
        { at: at + 1000, event: 'unlock.fail' },
      ],
      s,
      ['env line'],
    );
    const lines = out.split('\n');
    expect(lines[0]).toBe('Four Burners lock diagnostics');
    expect(lines[1]).toBe('env line');
    expect(lines[2]).toBe(describeLockState(s));
    expect(lines[2]).toContain('phase=locked');
    expect(lines[2]).toContain('failures=2');
    expect(lines[4]).toMatch(/08:04:05\.007 {2}launch {2}locked \(cold start\)$/);
    expect(lines[5]).toMatch(/08:04:06\.007 {2}unlock\.fail$/);
    expect(formatLockLog([], s)).toContain('(no entries)');
    expect(fmtLogTime(Number.NaN)).toBe('?');
  });

  it('starts collapsed', () => {
    const html = renderToString(createElement(LockDiagnostics));
    expect(text(html)).toContain('Lock diagnostics');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('text-faint');
  });
});
