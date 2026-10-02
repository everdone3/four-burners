import { describe, expect, it } from 'vitest';
import { readPush, safeHash } from './payload';

describe('push payload', () => {
  it('reads what the server sends', () => {
    expect(readPush('{"title":"Weekly review","body":"Ten minutes.","url":"/#/review","tag":"weekly"}')).toEqual({
      title: 'Weekly review',
      body: 'Ten minutes.',
      tag: 'weekly',
      hash: '#/review',
    });
  });

  it('always shows something, even for a broken payload', () => {
    expect(readPush(null)).toEqual({ title: 'Four Burners', body: '', tag: undefined, hash: '#/' });
    expect(readPush('not json')).toMatchObject({ title: 'Four Burners' });
    expect(readPush('{"title":7,"body":["x"]}')).toMatchObject({ title: 'Four Burners', body: '' });
    expect(readPush(JSON.stringify({ title: 'x'.repeat(500) })).title).toHaveLength(80);
  });

  it('only ever opens a route inside the app', () => {
    expect(safeHash('/#/burner/health')).toBe('#/burner/health');
    expect(safeHash('#/settings')).toBe('#/settings');
    expect(safeHash('https://evil.example/#/review')).toBe('#/');
    expect(safeHash('//evil.example/#/x')).toBe('#/');
    expect(safeHash('/#/x?<script>')).toBe('#/');
    expect(safeHash('javascript:alert(1)')).toBe('#/');
    expect(safeHash(undefined)).toBe('#/');
  });
});
