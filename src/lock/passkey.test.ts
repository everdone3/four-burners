// WebAuthn ceremonies (passkey.ts) against a fake platform authenticator that signs with a real P-256 key
// (Node's WebCrypto), so every assertion goes through the real local verification.
// The lock is an access gate, not encryption: see the header of webauthnLocal.ts.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LockRecord } from './types';
import { base64urlDecode, base64urlEncode, concatBytes, toBytes } from './webauthnLocal';

type Bytes = Uint8Array<ArrayBuffer>;
const RP = 'four-burners.vercel.app';
const ORIGIN = 'https://four-burners.vercel.app';
const enc = new TextEncoder();
const ab = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b.slice()));

// ---------- test-only encoders ----------

function rawToDer(raw: Uint8Array): Bytes {
  const int = (v: Uint8Array) => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    let b = v.slice(i);
    if (b[0] & 0x80) b = concatBytes(new Uint8Array([0]), b);
    return concatBytes(new Uint8Array([0x02, b.length]), b);
  };
  const body = concatBytes(int(raw.subarray(0, 32)), int(raw.subarray(32)));
  return concatBytes(new Uint8Array([0x30, body.length]), body);
}
function cborHead(major: number, n: number): Bytes {
  if (n < 24) return new Uint8Array([(major << 5) | n]);
  if (n < 0x100) return new Uint8Array([(major << 5) | 24, n]);
  return new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff]);
}
type Enc = number | string | Uint8Array | Map<number | string, Enc>;
function cbor(v: Enc): Bytes {
  if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (typeof v === 'string') return concatBytes(cborHead(3, enc.encode(v).length), enc.encode(v));
  if (v instanceof Uint8Array) return concatBytes(cborHead(2, v.length), v);
  const parts: Uint8Array[] = [cborHead(5, v.size)];
  for (const [k, val] of v) parts.push(cbor(k), cbor(val));
  return concatBytes(...parts);
}

// ---------- fake platform authenticator ----------

type OkOpts = { challenge?: Uint8Array; origin?: string; flags?: number; rawId?: Uint8Array; foreignKey?: boolean; rpId?: string };
type Behavior =
  | ({ kind: 'ok' } & OkOpts)
  | { kind: 'reject'; name: string; message?: string }
  | { kind: 'hang' } // settles with AbortError once the signal aborts
  | { kind: 'hangForever' } // ignores the signal (WebKit bug 273712)
  | ({ kind: 'gate'; open: Promise<void> } & OkOpts);

class FakeAuthenticator {
  getQueue: Behavior[] = [];
  createQueue: Behavior[] = [];
  gets: CredentialRequestOptions[] = [];
  creates: CredentialCreationOptions[] = [];
  signals: AbortSignal[] = [];
  constructor(
    public keys: CryptoKeyPair,
    public foreign: CryptoKeyPair,
    public credId: Bytes,
  ) {}

  get = (opts: CredentialRequestOptions): Promise<unknown> => {
    this.gets.push(opts);
    if (opts.signal) this.signals.push(opts.signal);
    return this.act(this.getQueue.shift() ?? { kind: 'ok' }, opts.signal, (o) => this.assertion(opts.publicKey!, o));
  };

  create = (opts: CredentialCreationOptions): Promise<unknown> => {
    this.creates.push(opts);
    if (opts.signal) this.signals.push(opts.signal);
    return this.act(this.createQueue.shift() ?? { kind: 'ok' }, opts.signal, (o) => this.attestation(opts.publicKey!, o));
  };

  private act(b: Behavior, signal: AbortSignal | undefined | null, ok: (o: OkOpts) => Promise<unknown>): Promise<unknown> {
    switch (b.kind) {
      case 'reject':
        return Promise.reject(new DOMException(b.message ?? 'The operation either timed out or was not allowed.', b.name));
      case 'hang':
        return new Promise((_, reject) =>
          signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError'))),
        );
      case 'hangForever':
        return new Promise(() => {});
      case 'gate':
        return b.open.then(() => ok(b));
      default:
        return ok(b);
    }
  }

  private async assertion(pk: PublicKeyCredentialRequestOptions, o: OkOpts) {
    const challenge = o.challenge ?? toBytes(pk.challenge);
    const cData = enc.encode(
      JSON.stringify({ type: 'webauthn.get', challenge: base64urlEncode(challenge), origin: o.origin ?? ORIGIN, crossOrigin: false }),
    );
    const ad = concatBytes(await sha256(enc.encode(o.rpId ?? pk.rpId ?? RP)), new Uint8Array([o.flags ?? 0x1d]), new Uint8Array(4));
    const key = o.foreignKey ? this.foreign.privateKey : this.keys.privateKey;
    const p1363 = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, concatBytes(ad, await sha256(cData))));
    const rawId = o.rawId ?? this.credId;
    return {
      type: 'public-key',
      id: base64urlEncode(rawId),
      rawId: ab(rawId),
      response: { clientDataJSON: ab(cData), authenticatorData: ab(ad), signature: ab(rawToDer(p1363)), userHandle: null },
    };
  }

  private async attestation(pk: PublicKeyCredentialCreationOptions, o: OkOpts) {
    const challenge = o.challenge ?? toBytes(pk.challenge);
    const jwk = await crypto.subtle.exportKey('jwk', this.keys.publicKey);
    const cose = cbor(
      new Map<number | string, Enc>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, base64urlDecode(jwk.x!)],
        [-3, base64urlDecode(jwk.y!)],
      ]),
    );
    const attested = concatBytes(new Uint8Array(16), new Uint8Array([0, this.credId.length]), this.credId, cose);
    const ad = concatBytes(await sha256(enc.encode(o.rpId ?? pk.rp.id ?? RP)), new Uint8Array([o.flags ?? 0x5d]), new Uint8Array(4), attested);
    const attObj = cbor(new Map<number | string, Enc>([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]));
    const cData = enc.encode(
      JSON.stringify({ type: 'webauthn.create', challenge: base64urlEncode(challenge), origin: o.origin ?? ORIGIN, crossOrigin: false }),
    );
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', this.keys.publicKey));
    return {
      type: 'public-key',
      id: base64urlEncode(this.credId),
      rawId: ab(this.credId),
      response: {
        clientDataJSON: ab(cData),
        attestationObject: ab(attObj),
        getPublicKey: () => ab(spki),
        getPublicKeyAlgorithm: () => -7,
        getAuthenticatorData: () => ab(ad),
        getTransports: () => ['internal', 'hybrid'],
      },
    };
  }
}

const genKey = async () =>
  (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;

let keys: CryptoKeyPair;
let foreign: CryptoKeyPair;
let credId: Bytes;
let record: LockRecord;

beforeAll(async () => {
  keys = await genKey();
  foreign = await genKey();
  credId = crypto.getRandomValues(new Uint8Array(16));
  record = {
    v: 1,
    rpId: RP,
    credentialId: base64urlEncode(credId),
    publicKey: await crypto.subtle.exportKey('jwk', keys.publicKey),
    alg: -7,
    label: 'Four Burners lock · iPhone',
    createdAt: '2026-09-27T00:00:00.000Z',
  };
});

type PasskeyMod = typeof import('./passkey');
type BusyMod = typeof import('../ui/busy');
let pk: PasskeyMod;
let busy: BusyMod;
let auth: FakeAuthenticator;

beforeEach(async () => {
  vi.resetModules();
  auth = new FakeAuthenticator(keys, foreign, credId);
  vi.stubGlobal('location', { hostname: RP, origin: ORIGIN });
  vi.stubGlobal('navigator', { userAgent: 'test', maxTouchPoints: 0, credentials: { get: auth.get, create: auth.create } });
  pk = await import('./passkey');
  busy = await import('../ui/busy'); // the instance passkey.ts just loaded
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Tracks whether a promise has settled, without awaiting it. */
function track<T>(p: Promise<T>) {
  const t = { settled: false, value: undefined as T | undefined };
  void p.then((v) => {
    t.settled = true;
    t.value = v;
  });
  return t;
}

describe('unlock (get)', () => {
  it('pins this credential with transports internal, requires UV, uses a fresh challenge, and verifies', async () => {
    const r = await pk.getAssertion(record);
    expect(r.ok).toBe(true);
    const opts = auth.gets[0].publicKey!;
    expect(opts.rpId).toBe(RP);
    expect(opts.userVerification).toBe('required');
    expect(opts.allowCredentials).toHaveLength(1);
    const allowed = opts.allowCredentials![0];
    expect(allowed.type).toBe('public-key');
    expect(allowed.transports).toEqual(['internal']);
    expect(base64urlEncode(toBytes(allowed.id))).toBe(record.credentialId);
    expect(toBytes(opts.challenge)).toHaveLength(32);
    expect(auth.gets[0].signal).toBeInstanceOf(AbortSignal);
    expect((auth.gets[0] as { mediation?: string }).mediation).toBeUndefined();

    await pk.getAssertion(record);
    expect(base64urlEncode(toBytes(auth.gets[1].publicKey!.challenge))).not.toBe(base64urlEncode(toBytes(opts.challenge)));
  });

  it('rejects a wrong challenge, a missing UV flag, a wrong origin, a wrong credential, a foreign key and another rp', async () => {
    const cases: Array<[OkOpts, string]> = [
      [{ challenge: crypto.getRandomValues(new Uint8Array(32)) }, 'challenge mismatch'],
      [{ flags: 0x19 }, 'UV flag not set'], // UP|BE|BS, no UV
      [{ origin: 'https://four-burners-git-dev.vercel.app' }, 'origin mismatch'],
      [{ rawId: crypto.getRandomValues(new Uint8Array(16)) }, 'unknown credential'],
      [{ foreignKey: true }, 'bad signature'],
      [{ rpId: 'vercel.app' }, 'rpIdHash mismatch'],
    ];
    for (const [o, reason] of cases) {
      auth.getQueue.push({ kind: 'ok', ...o });
      const r = await pk.getAssertion(record);
      expect(r).toEqual({ ok: false, kind: 'invalid', name: 'VerificationError', message: reason });
    }
  });

  it('classifies browser errors', async () => {
    const run = async (b: Behavior) => {
      auth.getQueue.push(b);
      return pk.getAssertion(record);
    };
    expect(await run({ kind: 'reject', name: 'NotAllowedError' })).toMatchObject({ ok: false, kind: 'not-allowed', name: 'NotAllowedError' });
    expect(await run({ kind: 'reject', name: 'NotAllowedError', message: 'The document is not focused.' })).toMatchObject({
      ok: false,
      kind: 'not-focused',
    });
    expect(await run({ kind: 'reject', name: 'AbortError' })).toEqual({ ok: false, kind: 'aborted', reason: 'external' });
    expect(await run({ kind: 'reject', name: 'SecurityError', message: 'bad rp' })).toEqual({
      ok: false,
      kind: 'error',
      name: 'SecurityError',
      message: 'bad rp',
    });
  });

  it('never throws: a damaged record or a browser without WebAuthn is an error result', async () => {
    expect(await pk.getAssertion({ ...record, credentialId: '***' })).toMatchObject({ ok: false, kind: 'error' });
    vi.stubGlobal('navigator', { userAgent: 'test' });
    expect(await pk.getAssertion(record)).toMatchObject({ ok: false, kind: 'error', name: 'NotSupportedError' });
    expect(pk.isCeremonyActive()).toBe(false);
    expect(busy.isBusy()).toBe(false);
  });
});

describe('one ceremony at a time', () => {
  it('a second ceremony aborts the first', async () => {
    auth.getQueue.push({ kind: 'hang' }, { kind: 'ok' });
    const first = pk.getAssertion(record);
    const second = pk.getAssertion(record);
    expect(await first).toEqual({ ok: false, kind: 'aborted', reason: 'superseded' });
    expect(auth.signals[0].aborted).toBe(true);
    expect((await second).ok).toBe(true);
    expect(pk.isCeremonyActive()).toBe(false);
  });

  it('a new ceremony takes its busy hold before it aborts the old one (no idle gap between them)', async () => {
    const idle = vi.fn();
    busy.onIdle(idle);
    auth.getQueue.push({ kind: 'hang' }, { kind: 'hang' });
    const first = pk.getAssertion(record);
    const second = pk.getAssertion(record);
    expect(await first).toMatchObject({ ok: false, kind: 'aborted', reason: 'superseded' });
    expect(idle).not.toHaveBeenCalled();
    expect(busy.busyReasons()).toEqual(['Face ID unlock']);
    pk.abortCeremony('cancel');
    await second;
    expect(idle).toHaveBeenCalledTimes(1);
    expect(busy.isBusy()).toBe(false);
  });

  it('abortCeremony settles the ceremony right away with the reason', async () => {
    auth.getQueue.push({ kind: 'hangForever' });
    const p = pk.getAssertion(record);
    expect(pk.isCeremonyActive()).toBe(true);
    expect(pk.abortCeremony('hidden')).toBe(true);
    expect(await p).toEqual({ ok: false, kind: 'aborted', reason: 'hidden' });
    expect(auth.signals[0].aborted).toBe(true);
    expect(pk.abortCeremony('hidden')).toBe(false);
  });

  it('the watchdog aborts at 120 s even when the browser promise never settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    auth.getQueue.push({ kind: 'hangForever' });
    const t = track(pk.getAssertion(record));
    await vi.advanceTimersByTimeAsync(119_999);
    expect(t.settled).toBe(false);
    expect(busy.isBusy()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.value).toEqual({ ok: false, kind: 'aborted', reason: 'timeout' });
    expect(auth.signals[0].aborted).toBe(true);
    expect(pk.isCeremonyActive()).toBe(false);
    expect(busy.isBusy()).toBe(false);
  });

  it('holds the update registry busy while a prompt is up, and lets go either way', async () => {
    let open!: () => void;
    auth.getQueue.push({ kind: 'gate', open: new Promise<void>((r) => (open = r)) });
    const p = pk.getAssertion(record);
    expect(busy.busyReasons()).toEqual(['Face ID unlock']);
    open();
    expect((await p).ok).toBe(true);
    expect(busy.isBusy()).toBe(false);

    auth.getQueue.push({ kind: 'reject', name: 'NotAllowedError' });
    const failed = pk.getAssertion(record);
    expect(busy.isBusy()).toBe(true);
    await failed;
    expect(busy.isBusy()).toBe(false);
  });
});

describe('enroll (create)', () => {
  const label = 'Four Burners lock · iPhone';

  it('asks for a platform passkey exactly as the contract says and builds the record from getPublicKey()', async () => {
    const userId = crypto.getRandomValues(new Uint8Array(32));
    let open!: () => void;
    auth.createQueue.push({ kind: 'gate', open: new Promise<void>((r) => (open = r)) });
    const p = pk.createCredential({ rpId: RP, userId, label });
    expect(busy.busyReasons()).toEqual(['Face ID setup']);
    open();
    const r = await p;
    expect(busy.isBusy()).toBe(false);
    const opts = auth.creates[0].publicKey!;
    expect(opts.rp).toEqual({ id: RP, name: 'Four Burners' });
    expect(base64urlEncode(toBytes(opts.user.id))).toBe(base64urlEncode(userId));
    expect(opts.user.name).toBe(label);
    expect(opts.user.displayName).toBe(label);
    expect(opts.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -257]);
    expect(opts.authenticatorSelection).toEqual({
      authenticatorAttachment: 'platform',
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    });
    expect(opts.attestation).toBe('none');
    expect(opts.excludeCredentials).toBeUndefined();
    expect(toBytes(opts.challenge)).toHaveLength(32);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ v: 1, rpId: RP, credentialId: base64urlEncode(credId), alg: -7, label });
    expect(r.value.publicKey).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(Number.isNaN(Date.parse(r.value.createdAt))).toBe(false);
    // The new record unlocks.
    expect((await pk.getAssertion(r.value)).ok).toBe(true);
  });

  it('rejects a registration with the wrong challenge or without UV, and passes cancels through', async () => {
    const userId = crypto.getRandomValues(new Uint8Array(32));
    auth.createQueue.push(
      { kind: 'ok', challenge: crypto.getRandomValues(new Uint8Array(32)) },
      { kind: 'ok', flags: 0x59 }, // UP|BE|BS|AT, no UV
      { kind: 'ok', origin: 'https://evil.example' },
      { kind: 'reject', name: 'NotAllowedError' },
    );
    expect(await pk.createCredential({ rpId: RP, userId, label })).toMatchObject({ ok: false, kind: 'invalid', message: 'challenge mismatch' });
    expect(await pk.createCredential({ rpId: RP, userId, label })).toMatchObject({ ok: false, kind: 'invalid', message: 'UV flag not set' });
    expect(await pk.createCredential({ rpId: RP, userId, label })).toMatchObject({ ok: false, kind: 'invalid', message: 'origin mismatch' });
    expect(await pk.createCredential({ rpId: RP, userId, label })).toMatchObject({ ok: false, kind: 'not-allowed' });
  });
});
