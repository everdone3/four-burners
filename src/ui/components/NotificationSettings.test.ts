import { describe, expect, it } from 'vitest';
import { DEFAULT_NOTIFY_PREFS } from '@/domain';
import type { Availability } from '@/notify/push';
import { availabilityText, deviceStatusText, enableNote, quietClash } from './NotificationSettings';

const NOW = Date.parse('2026-10-02T20:00:00Z');

describe('notification settings copy', () => {
  it('explains every reason the device cannot turn notifications on', () => {
    const all: Availability[] = ['unconfigured', 'needsInstall', 'unsupported', 'signedOut', 'denied'];
    for (const av of all) {
      const text = availabilityText(av, 'iPhone');
      expect(text).toBeTruthy();
      expect(text).not.toMatch(/—/);
    }
    expect(availabilityText('ready', 'iPhone')).toBeNull();
    expect(availabilityText('needsInstall', 'iPad')).toMatch(/^On iPad/);
    expect(availabilityText('denied', 'Mac')).toMatch(/System Settings/);
    expect(availabilityText('denied', 'iPhone')).toMatch(/iOS Settings > Notifications > Four Burners/);
  });

  it('says how this device is doing', () => {
    const base = { availability: 'ready' as const, checking: false };
    expect(deviceStatusText({ ...base, subscribed: false }, 'iPhone', NOW)).toBe('Off');
    expect(deviceStatusText({ ...base, subscribed: false, server: { gone: true } }, 'iPhone', NOW)).toMatch(/Turn it on again/);
    expect(deviceStatusText({ ...base, subscribed: true }, 'iPhone', NOW)).toBe('On for this iPhone.');
    expect(deviceStatusText({ ...base, subscribed: true, server: { gone: false, lastSentAt: '2026-10-02T18:00:00Z' } }, 'iPad', NOW)).toBe('On for this iPad. Last one 2 hr ago.');
    const failed = { gone: false, lastSentAt: '2026-10-01T18:00:00Z', lastError: '403: BadJwtToken', lastErrorAt: '2026-10-02T19:00:00Z' };
    expect(deviceStatusText({ ...base, subscribed: true, server: failed }, 'iPhone', NOW)).toMatch(/didn't arrive/);
    // An error followed by a success is history.
    expect(deviceStatusText({ ...base, subscribed: true, server: { ...failed, lastSentAt: '2026-10-02T19:30:00Z' } }, 'iPhone', NOW)).toMatch(/^On for this iPhone/);
    expect(deviceStatusText({ ...base, checking: true, subscribed: false }, 'iPhone', NOW)).toBe('Checking...');
  });

  it('notes for each result of turning on', () => {
    for (const r of ['ok', 'denied', 'unavailable', 'failed'] as const) expect(enableNote(r).text).not.toMatch(/—/);
    expect(enableNote('ok').tone).toBe('ok');
  });

  it('flags a reminder set inside quiet hours', () => {
    const quiet = DEFAULT_NOTIFY_PREFS.quiet; // 22:00 to 07:00
    expect(quietClash({ on: true, time: '23:00' }, quiet)).toBe(true);
    expect(quietClash({ on: true, time: '20:00' }, quiet)).toBe(false);
    expect(quietClash({ on: false, time: '23:00' }, quiet)).toBe(false);
    expect(quietClash({ on: true, time: '23:00' }, { ...quiet, on: false })).toBe(false);
  });
});
