import { describe, expect, it } from 'vitest';
import { RECIPES, REQUEST_STEPS } from '@/shortcuts/recipes';
import { tokenError } from '@/shortcuts/client';
import { linkHint, tokenLine } from './ShortcutsSettings';

const NOW = Date.parse('2026-10-02T20:00:00Z');

describe('shortcuts settings copy', () => {
  it('describes a token', () => {
    expect(tokenLine({ id: '1', label: 'iPhone', createdAt: '2026-10-01T12:00:00Z' }, NOW)).toBe('Made Oct 1, 2026. Not used yet.');
    expect(tokenLine({ id: '1', label: 'iPhone', createdAt: '2026-10-01T12:00:00Z', lastUsedAt: '2026-10-02T18:00:00Z' }, NOW)).toMatch(/Last used 2 hr ago\.$/);
  });

  it('says what a Health link does', () => {
    expect(linkHint({ type: 'number' }, { metric: 'steps' })).toBe("Adds each day's steps to this goal.");
    expect(linkHint({ type: 'habit' }, { metric: 'sleepHours' })).toBe('Counts a day with at least 7 hours.');
    expect(linkHint({ type: 'yesno' }, { metric: 'activeMinutes', min: 45 })).toBe('Counts a day with at least 45 minutes.');
  });

  it('turns server errors into plain words', () => {
    expect(tokenError(new Error('shortcut_token_create: at most 10 tokens; revoke one first'))).toMatch(/10 tokens/);
    expect(tokenError(new Error('Could not find the function public.shortcut_tokens_list without parameters in the schema cache'))).toMatch(/isn't set up/);
    expect(tokenError(new Error('shortcut_token_create: not signed in'))).toMatch(/Sign in/);
    expect(tokenError(new TypeError('Failed to fetch'))).toMatch(/Couldn't reach/);
  });

  it('recipes cover every action, send the phone time, and use no em dashes', () => {
    const all = RECIPES.flatMap((r) => [r.title, r.summary, r.siri ?? '', ...r.steps]).join('\n');
    expect(all).not.toMatch(/—/);
    for (const action of ['log', 'goals', 'people', 'touch', 'health']) expect(all).toContain(`action = ${action}`);
    for (const r of RECIPES) expect(r.steps.some((s) => s.includes('ISO 8601')), r.id).toBe(true);
    expect(REQUEST_STEPS.join(' ')).toMatch(/Authorization/);
  });
});
