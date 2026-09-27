import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  auth: {
    signInWithOtp: vi.fn(),
    verifyOtp: vi.fn(),
    signOut: vi.fn(),
  },
  stored: false,
  cleared: 0,
  configured: true,
}));

vi.mock('./client', () => ({
  getClient: () => (fake.configured ? Promise.resolve({ auth: fake.auth }) : Promise.reject(new Error('Sync is not configured in this build.'))),
  hasStoredSession: () => fake.stored,
  clearStoredSession: () => {
    fake.cleared++;
    fake.stored = false;
  },
}));

import {
  SIGN_IN_MESSAGES,
  SignInError,
  isValidEmail,
  normalizeCode,
  normalizeEmail,
  parseCodeInput,
  parseSignInLink,
  sendCode,
  signOut,
  toSignInError,
  verifyCode,
} from './auth';

async function failure(p: Promise<unknown>): Promise<SignInError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SignInError) return e;
    throw e;
  }
  throw new Error('expected a SignInError');
}

beforeEach(() => {
  fake.auth.signInWithOtp.mockReset().mockResolvedValue({ data: {}, error: null });
  fake.auth.verifyOtp.mockReset();
  fake.auth.signOut.mockReset().mockResolvedValue({ error: null });
  fake.stored = false;
  fake.cleared = 0;
  fake.configured = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('email and code input', () => {
  it('normalizes and validates emails', () => {
    expect(normalizeEmail('  Me@Example.COM ')).toBe('me@example.com');
    expect(isValidEmail('me@example.com')).toBe(true);
    expect(isValidEmail(' me@mail.example.co.uk ')).toBe(true);
    for (const bad of ['', 'me', 'me@', '@example.com', 'me@example', 'me@@example.com', 'me @example.com', 'me@example..com']) {
      expect(isValidEmail(bad), bad).toBe(false);
    }
  });

  it('accepts 6 to 10 digits, ignoring spaces and dashes', () => {
    expect(normalizeCode('123456')).toBe('123456');
    expect(normalizeCode(' 123 456 ')).toBe('123456');
    expect(normalizeCode('123-456')).toBe('123456');
    expect(normalizeCode('1234 5678')).toBe('12345678');
    expect(normalizeCode('1234567890')).toBe('1234567890');
    expect(normalizeCode('12345')).toBeNull();
    expect(normalizeCode('12345678901')).toBeNull();
    expect(normalizeCode('12a456')).toBeNull();
    expect(normalizeCode('')).toBeNull();
  });
});

describe('parseSignInLink', () => {
  it('reads token and type from the default verify link', () => {
    expect(parseSignInLink('https://abcd.supabase.co/auth/v1/verify?token=pkce_or_hash_123&type=magiclink&redirect_to=https://app.example.com')).toEqual({
      tokenHash: 'pkce_or_hash_123',
      type: 'magiclink',
    });
  });

  it('prefers token_hash and reads the hash too', () => {
    expect(parseSignInLink('https://app.example.com/auth/confirm?token_hash=th_1&type=email&token=other')).toEqual({ tokenHash: 'th_1', type: 'email' });
    expect(parseSignInLink('https://app.example.com/#token_hash=th_2&type=signup')).toEqual({ tokenHash: 'th_2', type: 'signup' });
    expect(parseSignInLink('https://app.example.com/#/confirm?token_hash=th_3')).toEqual({ tokenHash: 'th_3', type: 'email' });
  });

  it('finds the link inside pasted text and trims trailing punctuation', () => {
    expect(parseSignInLink('Log in: <https://abcd.supabase.co/auth/v1/verify?type=magiclink&token=abc>.')).toEqual({ tokenHash: 'abc', type: 'magiclink' });
    expect(parseSignInLink('(https://x.co/v?token_hash=t9&type=magiclink).')).toEqual({ tokenHash: 't9', type: 'magiclink' });
  });

  it('defaults unknown types to email and ignores links without a token', () => {
    expect(parseSignInLink('https://x.co/v?token_hash=t&type=weird')).toEqual({ tokenHash: 't', type: 'email' });
    expect(parseSignInLink('https://x.co/v?type=magiclink')).toBeNull();
    expect(parseSignInLink('123456')).toBeNull();
    expect(parseSignInLink('not a link')).toBeNull();
  });

  it('tells codes, links, and neither apart', () => {
    expect(parseCodeInput('123 456')).toEqual({ kind: 'code', token: '123456' });
    expect(parseCodeInput('https://x.co/v?token=abc&type=magiclink')).toEqual({ kind: 'link', tokenHash: 'abc', type: 'magiclink' });
    expect(parseCodeInput('123')).toEqual({ kind: 'invalid' });
  });
});

describe('toSignInError', () => {
  const noDash = (e: SignInError) => expect(e.message).not.toMatch(/—|–/);

  it('maps rate limits', () => {
    const e = toSignInError({ name: 'AuthApiError', status: 429, code: 'over_email_send_rate_limit', message: 'For security purposes...' }, 'send', true);
    expect(e.code).toBe('rate_limit');
    expect(e.message).toBe('Too many codes requested. Wait a minute, then try again.');
    expect(toSignInError({ status: 429, code: 'over_request_rate_limit' }, 'verify', true).code).toBe('rate_limit');
    noDash(e);
  });

  it('maps emails that are not set up', () => {
    for (const err of [
      { status: 422, code: 'otp_disabled', message: 'Signups not allowed for otp' },
      { status: 422, code: 'signup_disabled' },
      { status: 422, message: 'Signups not allowed for otp' },
      // Supabase's built-in email only sends to the project's team members.
      { status: 400, code: 'email_address_not_authorized', message: 'Email address "x@y.co" cannot be used as it is not authorized' },
    ]) {
      const e = toSignInError({ name: 'AuthApiError', ...err }, 'send', true);
      expect(e.code).toBe('not_allowed');
      expect(e.message).toBe("This email isn't set up for sync. Use the email you added in Supabase.");
    }
  });

  it('maps wrong or expired codes and links', () => {
    const e = toSignInError({ name: 'AuthApiError', status: 403, code: 'otp_expired', message: 'Token has expired or is invalid' }, 'verify', true);
    expect(e.code).toBe('invalid_code');
    expect(e.message).toBe("That code didn't work. Check it, or request a new one.");
    expect(toSignInError({ status: 403, code: 'otp_expired' }, 'link', true).message).toBe(SIGN_IN_MESSAGES.bad_link);
  });

  it('maps network trouble', () => {
    const offline = toSignInError({ name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' }, 'send', true);
    expect(offline.code).toBe('offline');
    expect(offline.message).toBe("You're offline. Connect, then try again.");
    expect(toSignInError({ status: 400, code: 'otp_expired' }, 'verify', false).code).toBe('offline');
    expect(toSignInError(new TypeError('Failed to fetch dynamically imported module'), 'send', true).code).toBe('offline');
    expect(toSignInError({ name: 'AuthRetryableFetchError', status: 503, message: 'down' }, 'send', true).code).toBe('unreachable');
  });

  it('falls back to a generic message', () => {
    const e = toSignInError({ status: 418, code: 'teapot' }, 'send', true);
    expect(e.code).toBe('unknown');
    noDash(e);
  });
});

describe('sendCode', () => {
  it('checks the email before asking Supabase, and never creates users', async () => {
    expect((await failure(sendCode('nope'))).code).toBe('invalid_email');
    expect(fake.auth.signInWithOtp).not.toHaveBeenCalled();
    await sendCode('  Me@Example.com ');
    expect(fake.auth.signInWithOtp).toHaveBeenCalledWith({ email: 'me@example.com', options: { shouldCreateUser: false } });
  });

  it('turns Supabase errors into friendly ones', async () => {
    fake.auth.signInWithOtp.mockResolvedValue({ data: {}, error: { name: 'AuthApiError', status: 422, code: 'otp_disabled', message: 'Signups not allowed for otp' } });
    expect((await failure(sendCode('me@example.com'))).code).toBe('not_allowed');
    fake.auth.signInWithOtp.mockRejectedValue(new TypeError('Failed to fetch'));
    expect((await failure(sendCode('me@example.com'))).code).toBe('offline');
  });

  it('reports an unconfigured build', async () => {
    fake.configured = false;
    expect((await failure(sendCode('me@example.com'))).code).toBe('unconfigured');
  });
});

describe('verifyCode', () => {
  const session = { access_token: 'a', user: { id: 'u1', email: 'me@example.com' } };

  it('verifies a code as an email OTP', async () => {
    fake.auth.verifyOtp.mockResolvedValue({ data: { session, user: session.user }, error: null });
    expect(await verifyCode('Me@Example.com', '123 456')).toEqual({ id: 'u1', email: 'me@example.com' });
    expect(fake.auth.verifyOtp).toHaveBeenCalledWith({ email: 'me@example.com', token: '123456', type: 'email' });
  });

  it('verifies a pasted link by its token hash', async () => {
    fake.auth.verifyOtp.mockResolvedValue({ data: { session, user: session.user }, error: null });
    await verifyCode('', 'https://abcd.supabase.co/auth/v1/verify?token=hash1&type=magiclink');
    expect(fake.auth.verifyOtp).toHaveBeenCalledWith({ token_hash: 'hash1', type: 'magiclink' });
  });

  it('rejects input that is neither, without calling Supabase', async () => {
    expect((await failure(verifyCode('me@example.com', '12'))).code).toBe('invalid_code');
    expect(fake.auth.verifyOtp).not.toHaveBeenCalled();
  });

  it('maps a wrong code', async () => {
    fake.auth.verifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: { name: 'AuthApiError', status: 403, code: 'otp_expired', message: 'Token has expired or is invalid' } });
    const e = await failure(verifyCode('me@example.com', '000000'));
    expect(e.message).toBe("That code didn't work. Check it, or request a new one.");
  });
});

describe('signOut', () => {
  it('signs out locally only', async () => {
    await signOut();
    expect(fake.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(fake.cleared).toBe(0);
  });

  it('forgets the saved session itself when supabase-js could not (offline)', async () => {
    fake.stored = true;
    fake.auth.signOut.mockResolvedValue({ error: { name: 'AuthRetryableFetchError', status: 0 } });
    await signOut();
    expect(fake.cleared).toBe(1);
    expect(fake.stored).toBe(false);
  });

  it('still forgets the session when the client cannot load', async () => {
    fake.configured = false;
    fake.stored = true;
    await signOut();
    expect(fake.cleared).toBe(1);
  });
});
