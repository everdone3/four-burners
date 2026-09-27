// The Welcome step's "Sign in to sync" entry: only a genuinely fresh device joining an account leaves the
// interview for home, and once signed in the entry stops inviting a sign-in.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { afterWelcomeSync, isFreshDevice, isSetupDone, syncEntryCopy } from './Onboarding';

type Input = Parameters<typeof isFreshDevice>[0];

function device(over: { profile?: boolean; goals?: number; people?: number; completed?: boolean; needsSetup?: boolean } = {}): Input {
  return {
    profile: over.profile ? ({ id: 'me' } as unknown as Input['profile']) : undefined,
    data: {
      allGoals: Array.from({ length: over.goals ?? 0 }, (_, i) => ({ id: `g${i}` })),
      people: Array.from({ length: over.people ?? 0 }, (_, i) => ({ id: `p${i}` })),
    } as unknown as Input['data'],
    onboarding: over.completed ? ({ step: 0, completedAt: '2026-09-01T00:00:00.000Z' } as Input['onboarding']) : undefined,
    needsSetup: over.needsSetup ?? true,
  };
}

describe('isFreshDevice', () => {
  it('is true only for a device with nothing of its own', () => {
    expect(isFreshDevice(device())).toBe(true);
  });

  it('is false for an existing user who opened the interview on purpose', () => {
    // "Tell it who you are" on Home: goals and a set-up quarter, no profile yet.
    expect(isFreshDevice(device({ goals: 3, needsSetup: false }))).toBe(false);
    // Redo the interview / Finish setting up: a profile already exists.
    expect(isFreshDevice(device({ profile: true }))).toBe(false);
    expect(isFreshDevice(device({ people: 2 }))).toBe(false);
    expect(isFreshDevice(device({ completed: true }))).toBe(false);
    expect(isFreshDevice(device({ needsSetup: false }))).toBe(false);
  });
});

describe('afterWelcomeSync', () => {
  it('sends a fresh device home once the account brings its setup over', () => {
    expect(afterWelcomeSync(true, true)).toBe('home');
  });

  it('tells a fresh device when the account has nothing set up yet', () => {
    expect(afterWelcomeSync(true, false)).toBe('nothingYet');
  });

  it('never bounces an existing user home, whatever local setup says', () => {
    const existing = device({ goals: 3, needsSetup: false });
    expect(isSetupDone(existing)).toBe(true);
    expect(afterWelcomeSync(isFreshDevice(existing), isSetupDone(existing))).toBe('stay');
    expect(afterWelcomeSync(false, false)).toBe('stay');
  });
});

describe('syncEntryCopy', () => {
  it('invites a sign-in while signed out', () => {
    expect(syncEntryCopy({ state: 'signedOut' })).toEqual({ lead: 'Already use Four Burners on another device?', action: 'Sign in to sync' });
  });

  it('stops offering a sign-in once signed in, in every signed-in state', () => {
    for (const state of ['idle', 'syncing', 'offline', 'error'] as const) {
      const copy = syncEntryCopy({ state, email: 'me@example.com' });
      expect(copy.action).not.toMatch(/sign in/i);
      expect(copy.lead).toContain('me@example.com');
    }
    expect(syncEntryCopy({ state: 'idle' }).action).toBe('Sync status');
  });
});
