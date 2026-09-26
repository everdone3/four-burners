import { describe, expect, it } from 'vitest';
import { canSetIntent, changeIntent, intentOn, validateIntents } from '../intents';
import type { Quarter } from '../types';

const q = (intents: Quarter['intents']): Quarter => ({
  id: '2026-Q3',
  createdAt: '2026-07-01T12:00:00Z',
  updatedAt: '2026-07-01T12:00:00Z',
  intents,
  intentHistory: [],
  status: 'active',
});

describe('High cap', () => {
  const two = { family: 'high', friends: 'steady', health: 'high', work: 'low' } as const;

  it('allows up to 2 High burners', () => {
    const r = canSetIntent({ ...two, health: 'steady' }, 'health', 'high');
    expect(r.ok).toBe(true);
  });

  it('blocks a 3rd High burner', () => {
    const r = canSetIntent(two, 'work', 'high');
    expect(r.ok).toBe(false);
  });

  it('re-setting an already-High burner to High is fine', () => {
    expect(canSetIntent(two, 'family', 'high').ok).toBe(true);
  });

  it('lowering is always allowed', () => {
    expect(canSetIntent(two, 'family', 'low').ok).toBe(true);
  });

  it('validateIntents rejects 3 or 4 Highs', () => {
    expect(validateIntents({ family: 'high', friends: 'high', health: 'high', work: 'low' }).ok).toBe(false);
    expect(validateIntents({ family: 'high', friends: 'high', health: 'high', work: 'high' }).ok).toBe(false);
    expect(validateIntents(two).ok).toBe(true);
  });
});

describe('mid-quarter intent changes', () => {
  it('requires a reason', () => {
    const r = changeIntent(q({ family: 'high', friends: 'steady', health: 'steady', work: 'low' }), 'work', 'steady', '  ', 'x', '2026-08-01');
    expect(r.ok).toBe(false);
  });

  it('enforces the cap', () => {
    const r = changeIntent(q({ family: 'high', friends: 'steady', health: 'high', work: 'low' }), 'work', 'high', 'Big launch', 'x', '2026-08-01');
    expect(r.ok).toBe(false);
  });

  it('records history and reconstructs past intent', () => {
    const start = q({ family: 'high', friends: 'steady', health: 'steady', work: 'low' });
    const r1 = changeIntent(start, 'work', 'high', 'Deal season', '2026-08-01T12:00:00Z', '2026-08-01');
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = changeIntent(r1.value, 'work', 'steady', 'Deal closed', '2026-09-01T12:00:00Z', '2026-09-01');
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.intentHistory).toHaveLength(2);
    expect(r2.value.intentHistory[0]).toMatchObject({ from: 'low', to: 'high', reason: 'Deal season' });
    expect(intentOn(r2.value, 'work', '2026-07-15')).toBe('low');
    expect(intentOn(r2.value, 'work', '2026-08-15')).toBe('high');
    expect(intentOn(r2.value, 'work', '2026-09-15')).toBe('steady');
  });
});
