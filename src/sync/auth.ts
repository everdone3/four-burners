// Email-code sign-in (Supabase OTP). Codes, not magic links: iOS opens links in Safari instead of the
// installed app. As a fallback, a pasted sign-in link (projects still sending the default link email)
// is verified in place from its token hash.
import { clearStoredSession, getClient, hasStoredSession } from './client';
import { PAUSED_MESSAGE, browserOnline } from './remote';

export type SignInErrorCode = 'invalid_email' | 'invalid_code' | 'rate_limit' | 'not_allowed' | 'offline' | 'unreachable' | 'unconfigured' | 'unknown';

export class SignInError extends Error {
  readonly code: SignInErrorCode;
  constructor(code: SignInErrorCode, message: string) {
    super(message);
    this.name = 'SignInError';
    this.code = code;
  }
}

export const SIGN_IN_MESSAGES = {
  invalid_email: 'Enter a valid email address.',
  invalid_code: 'Enter the code from the email.',
  rate_limit_send: 'Too many codes requested. Wait a minute, then try again.',
  rate_limit_verify: 'Too many tries. Wait a minute, then try again.',
  not_allowed: "This email isn't set up for sync. Use the email you added in Supabase.",
  bad_code: "That code didn't work. Check it, or request a new one.",
  bad_link: "That link didn't work. Request a new code.",
  offline: "You're offline. Connect, then try again.",
  unreachable: PAUSED_MESSAGE,
  unconfigured: "Sync isn't set up in this build yet.",
  unknown: 'Something went wrong. Try again in a moment.',
} as const;

// ---------- Input helpers (pure) ----------

export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

export function isValidEmail(input: string): boolean {
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(normalizeEmail(input));
}

/** Digits of a typed or pasted code (spaces and dashes removed), or null unless it is 6 to 10 digits. */
export function normalizeCode(input: string): string | null {
  const digits = input.trim().replace(/[\s\-‐-―.]/g, '');
  return /^\d{6,10}$/.test(digits) ? digits : null;
}

const LINK_TYPES = ['email', 'magiclink', 'signup', 'invite', 'recovery', 'email_change'] as const;
export type LinkType = (typeof LINK_TYPES)[number];

/**
 * The token hash and type from a pasted sign-in link: `token_hash` (custom templates) or `token` (the
 * default /auth/v1/verify link), read from the query or the hash. Null when the text has no such link.
 */
export function parseSignInLink(text: string): { tokenHash: string; type: LinkType } | null {
  const m = text.match(/https?:\/\/[^\s<>"']+/i);
  if (!m) return null;
  let url: URL;
  try {
    url = new URL(m[0].replace(/[)\].,;]+$/, ''));
  } catch {
    return null;
  }
  const hash = url.hash.replace(/^#/, '');
  const sources = [url.searchParams, new URLSearchParams(hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : hash)];
  const get = (k: string) => sources.map((s) => s.get(k)).find((v) => !!v) ?? null;
  const tokenHash = get('token_hash') ?? get('token');
  if (!tokenHash) return null;
  const t = get('type');
  return { tokenHash, type: (LINK_TYPES as readonly string[]).includes(t ?? '') ? (t as LinkType) : 'email' };
}

export type CodeInput = { kind: 'code'; token: string } | { kind: 'link'; tokenHash: string; type: LinkType } | { kind: 'invalid' };

/** What the code field holds: a code, a pasted sign-in link, or neither yet. */
export function parseCodeInput(input: string): CodeInput {
  const link = parseSignInLink(input);
  if (link) return { kind: 'link', ...link };
  const token = normalizeCode(input);
  return token ? { kind: 'code', token } : { kind: 'invalid' };
}

// ---------- Error mapping ----------

interface AuthLikeError {
  name?: string;
  message?: string;
  status?: number;
  code?: string;
}

/** A Supabase auth error (or anything thrown) as a friendly SignInError. */
export function toSignInError(e: unknown, step: 'send' | 'verify' | 'link', online = browserOnline()): SignInError {
  if (e instanceof SignInError) return e;
  const err = (e && typeof e === 'object' ? e : {}) as AuthLikeError;
  const code = err.code ?? '';
  const status = err.status ?? 0;
  const message = err.message ?? '';
  const network = err.name === 'AuthRetryableFetchError' || err.name === 'TypeError' || /failed to fetch|load failed|networkerror|dynamically imported module/i.test(message);
  if (!online || (network && status === 0)) return new SignInError('offline', SIGN_IN_MESSAGES.offline);
  if (network || status >= 500) return new SignInError('unreachable', SIGN_IN_MESSAGES.unreachable);
  if (status === 429 || code.startsWith('over_')) {
    return new SignInError('rate_limit', step === 'send' ? SIGN_IN_MESSAGES.rate_limit_send : SIGN_IN_MESSAGES.rate_limit_verify);
  }
  if (code === 'email_address_invalid' || (step === 'send' && code === 'validation_failed')) return new SignInError('invalid_email', SIGN_IN_MESSAGES.invalid_email);
  // email_address_not_authorized: Supabase's built-in email only sends to the project's team members.
  if (['otp_disabled', 'signup_disabled', 'user_not_found', 'email_provider_disabled', 'user_banned', 'email_address_not_authorized'].includes(code) || /signups not allowed/i.test(message) || (step === 'send' && status === 422)) {
    return new SignInError('not_allowed', SIGN_IN_MESSAGES.not_allowed);
  }
  if (step !== 'send' && (code === 'otp_expired' || code === 'validation_failed' || /expired|invalid/i.test(message) || status === 400 || status === 401 || status === 403 || status === 422)) {
    return new SignInError('invalid_code', step === 'link' ? SIGN_IN_MESSAGES.bad_link : SIGN_IN_MESSAGES.bad_code);
  }
  return new SignInError('unknown', SIGN_IN_MESSAGES.unknown);
}

async function client(step: 'send' | 'verify' | 'link') {
  try {
    return await getClient();
  } catch (e) {
    if (e instanceof Error && /not configured/i.test(e.message)) throw new SignInError('unconfigured', SIGN_IN_MESSAGES.unconfigured);
    throw toSignInError(e, step);
  }
}

// ---------- Actions ----------

/** Email a sign-in code. Only emails already added in Supabase get one (no sign-ups from the app). */
export async function sendCode(email: string): Promise<void> {
  if (!isValidEmail(email)) throw new SignInError('invalid_email', SIGN_IN_MESSAGES.invalid_email);
  const c = await client('send');
  let error: unknown;
  try {
    ({ error } = await c.auth.signInWithOtp({ email: normalizeEmail(email), options: { shouldCreateUser: false } }));
  } catch (e) {
    error = e;
  }
  if (error) throw toSignInError(error, 'send');
}

export interface SignedInUser {
  id: string;
  email?: string;
}

/** Verify a typed code (or a pasted sign-in link). Resolves with the signed-in user. */
export async function verifyCode(email: string, input: string): Promise<SignedInUser> {
  const parsed = parseCodeInput(input);
  if (parsed.kind === 'invalid') throw new SignInError('invalid_code', SIGN_IN_MESSAGES.invalid_code);
  const step = parsed.kind === 'link' ? 'link' : 'verify';
  if (parsed.kind === 'code' && !isValidEmail(email)) throw new SignInError('invalid_email', SIGN_IN_MESSAGES.invalid_email);
  const c = await client(step);
  let result: Awaited<ReturnType<typeof c.auth.verifyOtp>>;
  try {
    result =
      parsed.kind === 'code'
        ? await c.auth.verifyOtp({ email: normalizeEmail(email), token: parsed.token, type: 'email' })
        : await c.auth.verifyOtp({ token_hash: parsed.tokenHash, type: parsed.type });
  } catch (e) {
    throw toSignInError(e, step);
  }
  if (result.error) throw toSignInError(result.error, step);
  const user = result.data.session?.user ?? result.data.user;
  if (!user || !result.data.session) throw new SignInError('unknown', SIGN_IN_MESSAGES.unknown);
  return { id: user.id, email: user.email ?? undefined };
}

/**
 * Sign out on this device only (other devices stay signed in). Local data stays. Offline, supabase-js
 * cannot reach the server and keeps the session, so it is removed from storage here instead.
 */
export async function signOut(): Promise<void> {
  let failed = false;
  try {
    const c = await getClient();
    const { error } = await c.auth.signOut({ scope: 'local' });
    failed = !!error;
  } catch {
    failed = true;
  }
  if (failed || hasStoredSession()) clearStoredSession();
}
