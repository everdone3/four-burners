import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateToken, hashToken, isTokenFormat } from './token';

describe('shortcut tokens', () => {
  it('are fb_ plus 256 random bits, and never repeat', () => {
    const a = generateToken();
    expect(a).toMatch(/^fb_[A-Za-z0-9_-]{43}$/);
    expect(isTokenFormat(a)).toBe(true);
    expect(new Set(Array.from({ length: 50 }, generateToken)).size).toBe(50);
    for (const bad of ['', 'fb_short', `xx_${a.slice(3)}`, `${a} `, null]) expect(isTokenFormat(bad)).toBe(false);
  });

  it('hash to hex SHA-256, the same as any other implementation', async () => {
    const t = generateToken();
    expect(await hashToken(t)).toBe(createHash('sha256').update(t).digest('hex'));
  });
});
