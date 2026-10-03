// Personal tokens for Apple Shortcuts. Made on your device and shown once; the server only ever stores its
// SHA-256 hash (shortcut_tokens.token_hash), so a database leak does not reveal a usable token.
// Shared by the app (Settings) and the shortcuts Edge Function. WebCrypto only.
import { b64urlEncode } from '@/server/notify/webpush';

const PREFIX = 'fb_';
const TOKEN_RE = /^fb_[A-Za-z0-9_-]{43}$/;

/** A fresh token: 'fb_' and 256 random bits, base64url. */
export function generateToken(): string {
  return PREFIX + b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export function isTokenFormat(s: unknown): s is string {
  return typeof s === 'string' && TOKEN_RE.test(s);
}

/** Lowercase hex SHA-256 of the token. */
export async function hashToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}
