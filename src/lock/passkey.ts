// WebAuthn ceremonies for the app lock: create (enroll) and get (unlock) with this device's platform
// passkey, verified locally by webauthnLocal.ts.
//
// THE FACE ID LOCK IS AN ACCESS GATE, NOT ENCRYPTION. A passing ceremony only tells the lock screen to let
// you through; it decrypts nothing. Full statement: webauthnLocal.ts.
//
// Rules (from the WebKit source research for Phase 6):
// - One ceremony at a time. Starting one aborts the one in flight (rapid repeated get() calls confuse iOS,
//   WebKit bug 291258).
// - Our own 120 s watchdog: Safari's modern passkey path ignores options.timeout, and a get() can hang
//   forever (WebKit bug 273712). Every ceremony settles when we abort it, even if the browser's promise
//   never does.
// - allowCredentials pins this device's credential with transports ['internal'], which hides "use another
//   device" (QR) and security keys. Never copy getTransports() into it.
// - Never call PublicKeyCredential.signal* (WebKit bugs delete other passkeys).
// - The busy registry (src/ui/busy.ts) is held while a prompt is up, so an app update never reloads under it.
// - navigator.credentials.* is called synchronously inside the caller's task (a tap stays a tap).
import { holdBusy } from '../ui/busy';
import type { LockRecord } from './types';
import {
  base64urlDecode,
  COSE_ALG_ES256,
  COSE_ALG_RS256,
  newChallenge,
  verifyAssertion,
  verifyRegistration,
  type AssertionCredentialLike,
  type RegistrationCredentialLike,
  type StoredPasskey,
  type SupportedAlg,
} from './webauthnLocal';

export const CEREMONY_TIMEOUT_MS = 120_000;
export const RP_NAME = 'Four Burners';

/**
 * Why a ceremony was aborted. hidden: the page went to the background. superseded: a newer ceremony started.
 * timeout: our watchdog fired. cancel: the app called it off. external: the browser aborted it on its own.
 */
export type AbortReason = 'hidden' | 'superseded' | 'timeout' | 'cancel' | 'external';

/**
 * not-focused: WebKit's "The document is not focused." (a NotAllowedError, but nothing was shown).
 * not-allowed: cancelled or failed Face ID (WebAuthn does not tell the two apart).
 * invalid: the browser returned a credential that did not pass local verification.
 * error: anything else (SecurityError, NotSupportedError, InvalidStateError, no WebAuthn at all).
 */
export type CeremonyFailure =
  | { kind: 'aborted'; reason: AbortReason }
  | { kind: 'not-focused' | 'not-allowed' | 'invalid' | 'error'; name: string; message: string };

export type CeremonyResult<T> = { ok: true; value: T } | ({ ok: false } & CeremonyFailure);

class VerificationError extends Error {
  override name = 'VerificationError';
}

interface Ceremony {
  kind: 'get' | 'create';
  abort(reason: AbortReason): void;
}

let current: Ceremony | null = null;

/** True while a create() or get() is in flight. */
export function isCeremonyActive(): boolean {
  return current !== null;
}

/** Aborts the ceremony in flight, if any. Its promise settles right away with { kind: 'aborted', reason }. */
export function abortCeremony(reason: AbortReason): boolean {
  const c = current;
  if (!c) return false;
  c.abort(reason);
  return true;
}

export function classifyError(e: unknown): CeremonyFailure {
  const obj = e && typeof e === 'object' ? (e as { name?: unknown; message?: unknown }) : null;
  const name = obj && typeof obj.name === 'string' ? obj.name : 'Error';
  const message = obj && typeof obj.message === 'string' ? obj.message : String(e);
  if (e instanceof VerificationError) return { kind: 'invalid', name, message };
  if (name === 'NotAllowedError' && /not focused/i.test(message)) return { kind: 'not-focused', name, message };
  if (name === 'NotAllowedError') return { kind: 'not-allowed', name, message };
  if (name === 'AbortError') return { kind: 'aborted', reason: 'external' };
  return { kind: 'error', name, message };
}

/** A short line for the diagnostics log. */
export function describeFailure(f: CeremonyFailure): string {
  return f.kind === 'aborted' ? `aborted (${f.reason})` : `${f.kind}: ${f.name}: ${f.message}`;
}

function run<T>(kind: Ceremony['kind'], start: (signal: AbortSignal) => Promise<T>): Promise<CeremonyResult<T>> {
  // Hold first, then abort the old one: busy.ts must never see a gap (its idle listeners may start an
  // update reload) between two back-to-back prompts.
  const release = holdBusy(kind === 'get' ? 'Face ID unlock' : 'Face ID setup');
  current?.abort('superseded');
  const ac = new AbortController();
  let settled = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let resolve!: (r: CeremonyResult<T>) => void;
  const done = new Promise<CeremonyResult<T>>((r) => (resolve = r));
  const me: Ceremony = {
    kind,
    abort(reason) {
      if (settled) return;
      // Settle first: a hung browser promise must never keep the lock waiting.
      finish({ ok: false, kind: 'aborted', reason });
      try {
        ac.abort();
      } catch {
        // already aborted
      }
    },
  };
  function finish(r: CeremonyResult<T>) {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    if (current === me) current = null;
    release();
    resolve(r);
  }
  current = me;
  watchdog = setTimeout(() => me.abort('timeout'), CEREMONY_TIMEOUT_MS);
  let work: Promise<T>;
  try {
    work = start(ac.signal);
  } catch (e) {
    work = Promise.reject(e);
  }
  work.then(
    (value) => finish({ ok: true, value }),
    (e: unknown) => finish({ ok: false, ...classifyError(e) }),
  );
  return done;
}

function credentials(): CredentialsContainer {
  const c = typeof navigator === 'undefined' ? undefined : navigator.credentials;
  if (!c) throw Object.assign(new Error('Passkeys are not available in this browser.'), { name: 'NotSupportedError' });
  return c;
}

function origin(): string {
  return location.origin;
}

function storedFrom(record: LockRecord): StoredPasskey {
  return {
    credentialId: record.credentialId,
    alg: record.alg as SupportedAlg,
    publicKeyJwk: record.publicKey,
    rpId: record.rpId,
    signCount: 0, // synced passkeys always report 0; the counter is not enforced
    backupEligible: true,
  };
}

/** Unlock: a get() pinned to this device's credential, then local verification (UV required). */
export function getAssertion(record: LockRecord): Promise<CeremonyResult<{ signCount: number; flags: number }>> {
  return run('get', async (signal) => {
    const challenge = newChallenge();
    const publicKey: PublicKeyCredentialRequestOptions = {
      challenge,
      rpId: record.rpId,
      allowCredentials: [{ type: 'public-key', id: base64urlDecode(record.credentialId), transports: ['internal'] }],
      userVerification: 'required',
      timeout: CEREMONY_TIMEOUT_MS,
    };
    const cred = await credentials().get({ publicKey, signal });
    if (!cred || cred.type !== 'public-key') throw new VerificationError('no passkey returned');
    const r = await verifyAssertion(cred as unknown as AssertionCredentialLike, {
      expectedChallenge: challenge,
      expectedOrigin: origin(),
      expectedRpId: record.rpId,
      stored: storedFrom(record),
      requireUserVerification: true,
    });
    if (!r.ok) throw new VerificationError(r.reason);
    return { signCount: r.signCount, flags: r.flags };
  });
}

export interface CreateParams {
  rpId: string;
  /** This device's user handle (store.userId()). */
  userId: Uint8Array<ArrayBuffer>;
  /** Passkey name, e.g. "Four Burners lock · iPhone" (user.name and user.displayName). */
  label: string;
}

/** Enroll: create() a platform passkey, verify it locally, and build the record (not saved here). */
export function createCredential(p: CreateParams): Promise<CeremonyResult<LockRecord>> {
  return run('create', async (signal) => {
    const challenge = newChallenge();
    const publicKey: PublicKeyCredentialCreationOptions = {
      rp: { id: p.rpId, name: RP_NAME },
      user: { id: p.userId, name: p.label, displayName: p.label },
      challenge,
      pubKeyCredParams: [
        { type: 'public-key', alg: COSE_ALG_ES256 },
        { type: 'public-key', alg: COSE_ALG_RS256 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
      attestation: 'none',
      timeout: CEREMONY_TIMEOUT_MS,
    };
    const cred = await credentials().create({ publicKey, signal });
    if (!cred || cred.type !== 'public-key') throw new VerificationError('no passkey created');
    let stored: StoredPasskey;
    try {
      // Key from getPublicKey() (Safari 16+, ES256), CBOR attestationObject as the fallback.
      stored = await verifyRegistration(cred as unknown as RegistrationCredentialLike, {
        challenge,
        origin: origin(),
        rpId: p.rpId,
        requireUserVerification: true,
      });
    } catch (e) {
      throw new VerificationError(e instanceof Error ? e.message : String(e));
    }
    const record: LockRecord = {
      v: 1,
      rpId: p.rpId,
      credentialId: stored.credentialId,
      publicKey: stored.publicKeyJwk,
      alg: stored.alg,
      label: p.label,
      createdAt: new Date().toISOString(),
    };
    return record;
  });
}
