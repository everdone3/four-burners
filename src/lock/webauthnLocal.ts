/**
 * webauthnLocal.ts - serverless WebAuthn checks for the Four Burners app lock.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS LOCK IS (AND IS NOT) - read before changing anything here
 * ---------------------------------------------------------------------------
 * The Face ID lock is an ACCESS GATE, NOT ENCRYPTION.
 *
 *  - Your goals, logs and notes are stored UNENCRYPTED in this browser's
 *    IndexedDB. Unlocking does not decrypt anything, and locking does not
 *    encrypt anything. The passkey never touches the data.
 *  - The lock stops someone who picks up your unlocked phone, iPad or Mac from
 *    casually opening the app and reading it. That is all.
 *  - It does NOT protect against: anyone who can run script in this origin
 *    (a malicious dependency, XSS, a hostile browser extension on the Mac);
 *    anyone with Web Inspector / DevTools attached to this page; anyone who can
 *    read the browser's storage directly (device backup, forensic tools, a
 *    jailbroken or compromised device). Any of those can read IndexedDB or just
 *    flip the "unlocked" flag without ever touching Face ID.
 *  - Face ID here is whatever the OS accepts as user verification: iOS falls
 *    back to the device passcode, macOS to Touch ID or the login password.
 *  - There is no server in this check. The passkey signature is verified here,
 *    in the page, against a public key saved in localStorage ('fb-lock', see
 *    store.ts) at enrolment. Local verification only makes the gate honest
 *    about what the authenticator returned (fresh challenge, this origin, this
 *    credential, user verified). It adds no protection against an attacker who
 *    already runs code here, because that attacker can skip this function.
 *  - If real at-rest confidentiality is ever needed, the right tool is the
 *    WebAuthn `prf` extension (Safari 18+) to derive an AES-GCM key and encrypt
 *    the IndexedDB records with it. This file does not do that.
 * ---------------------------------------------------------------------------
 *
 * Supported algorithms: ES256 (COSE -7, P-256) and RS256 (COSE -257).
 * Request exactly these in pubKeyCredParams so getPublicKey() never returns
 * null for "unknown algorithm" reasons.
 *
 * Used by passkey.ts (the ceremonies). Tests: webauthnLocal.test.ts (W3C
 * WebAuthn L3 vectors plus generated P-256 and RSA authenticators).
 */

export const COSE_ALG_ES256 = -7;
export const COSE_ALG_RS256 = -257;
export type SupportedAlg = typeof COSE_ALG_ES256 | typeof COSE_ALG_RS256;

/** authenticatorData flag bits (WebAuthn L3 section 6.1). */
export const FLAG_UP = 0x01; // user present
export const FLAG_UV = 0x04; // user verified (Face ID / Touch ID / passcode)
export const FLAG_BE = 0x08; // backup eligible (synced passkey)
export const FLAG_BS = 0x10; // backed up
export const FLAG_AT = 0x40; // attested credential data included
export const FLAG_ED = 0x80; // extension data included

type Bytes = Uint8Array<ArrayBuffer>;
type BinaryLike = ArrayBuffer | ArrayBufferView;

// ---------------------------------------------------------------------------
// Byte + base64url helpers
// ---------------------------------------------------------------------------

/** Copy any ArrayBuffer / view into a fresh Uint8Array backed by its own ArrayBuffer. */
export function toBytes(input: BinaryLike): Bytes {
  const src =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  const out = new Uint8Array(src.byteLength);
  out.set(src);
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** base64url (RFC 4648 section 5), no padding - the form used in clientDataJSON.challenge. */
export function base64urlEncode(input: BinaryLike): string {
  const bytes = toBytes(input);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(s: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) {
    throw new Error('invalid base64url');
  }
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 32 random bytes for navigator.credentials.get({ publicKey: { challenge } }). */
export function newChallenge(): Bytes {
  return crypto.getRandomValues(new Uint8Array(32));
}

async function sha256(data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', toBytes(data)));
}

// ---------------------------------------------------------------------------
// Minimal CBOR decoder (RFC 8949) - enough for attestationObject + COSE keys
// ---------------------------------------------------------------------------
// Supports: unsigned/negative ints (up to 2^53), byte strings, text strings,
// arrays, maps (returned as Map so integer COSE labels survive), tags (value
// passed through), false/true/null/undefined, and floats. Rejects indefinite
// lengths (CTAP2 canonical CBOR never uses them) and nesting deeper than 16.

export type CborValue =
  | number
  | string
  | boolean
  | null
  | undefined
  | Bytes
  | CborValue[]
  | Map<CborValue, CborValue>;

export function decodeCbor(input: BinaryLike, offset = 0): { value: CborValue; end: number } {
  const buf = toBytes(input);
  const view = new DataView(buf.buffer);
  let pos = offset;

  const need = (n: number) => {
    if (pos + n > buf.length) throw new Error('CBOR: truncated');
  };

  const readArg = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) { need(1); return buf[pos++]; }
    if (info === 25) { need(2); const v = view.getUint16(pos); pos += 2; return v; }
    if (info === 26) { need(4); const v = view.getUint32(pos); pos += 4; return v; }
    if (info === 27) {
      need(8);
      const hi = view.getUint32(pos);
      const lo = view.getUint32(pos + 4);
      pos += 8;
      if (hi > 0x1fffff) throw new Error('CBOR: integer exceeds 2^53');
      return hi * 0x100000000 + lo;
    }
    throw new Error('CBOR: indefinite length or reserved additional info not supported');
  };

  const item = (depth: number): CborValue => {
    if (depth > 16) throw new Error('CBOR: nesting too deep');
    need(1);
    const initial = buf[pos++];
    const major = initial >> 5;
    const info = initial & 0x1f;

    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      if (info === 23) return undefined;
      if (info === 25) { need(2); const h = view.getUint16(pos); pos += 2; return halfToFloat(h); }
      if (info === 26) { need(4); const f = view.getFloat32(pos); pos += 4; return f; }
      if (info === 27) { need(8); const f = view.getFloat64(pos); pos += 8; return f; }
      throw new Error('CBOR: unsupported simple value ' + info);
    }

    const arg = readArg(info);
    switch (major) {
      case 0: return arg;
      case 1: return -1 - arg;
      case 2: { need(arg); const b = buf.slice(pos, pos + arg); pos += arg; return b; }
      case 3: {
        need(arg);
        const s = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(pos, pos + arg));
        pos += arg;
        return s;
      }
      case 4: {
        const arr: CborValue[] = [];
        for (let i = 0; i < arg; i++) arr.push(item(depth + 1));
        return arr;
      }
      case 5: {
        const map = new Map<CborValue, CborValue>();
        for (let i = 0; i < arg; i++) {
          const k = item(depth + 1);
          if (map.has(k)) throw new Error('CBOR: duplicate map key');
          map.set(k, item(depth + 1));
        }
        return map;
      }
      case 6: return item(depth + 1); // tag: ignore the tag number, keep the value
      default: throw new Error('CBOR: bad major type');
    }
  };

  const value = item(0);
  return { value, end: pos };
}

function halfToFloat(h: number): number {
  const exp = (h >> 10) & 0x1f;
  const mant = h & 0x3ff;
  const sign = h & 0x8000 ? -1 : 1;
  if (exp === 0) return sign * 2 ** -14 * (mant / 1024);
  if (exp === 31) return mant ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + mant / 1024);
}

// ---------------------------------------------------------------------------
// authenticatorData + attestationObject parsing
// ---------------------------------------------------------------------------

export interface ParsedAuthData {
  rpIdHash: Bytes;
  flags: number;
  signCount: number;
  attested?: {
    aaguid: Bytes;
    credentialId: Bytes;
    coseKey: Map<CborValue, CborValue>;
  };
}

export function parseAuthenticatorData(input: BinaryLike): ParsedAuthData {
  const d = toBytes(input);
  if (d.length < 37) throw new Error('authenticatorData too short');
  const view = new DataView(d.buffer);
  const flags = d[32];
  const out: ParsedAuthData = {
    rpIdHash: d.slice(0, 32),
    flags,
    signCount: view.getUint32(33), // big-endian
  };
  let pos = 37;
  if (flags & FLAG_AT) {
    if (d.length < pos + 18) throw new Error('attestedCredentialData truncated');
    const aaguid = d.slice(pos, pos + 16);
    const idLen = view.getUint16(pos + 16);
    pos += 18;
    if (d.length < pos + idLen) throw new Error('credentialId truncated');
    const credentialId = d.slice(pos, pos + idLen);
    pos += idLen;
    // The COSE key is followed by optional extension CBOR, so decode exactly
    // one item and use its end offset.
    const { value, end } = decodeCbor(d, pos);
    if (!(value instanceof Map)) throw new Error('credentialPublicKey is not a CBOR map');
    pos = end;
    out.attested = { aaguid, credentialId, coseKey: value };
  }
  if (flags & FLAG_ED) {
    pos = decodeCbor(d, pos).end; // skip extensions map
  }
  if (pos !== d.length) throw new Error('trailing bytes in authenticatorData');
  return out;
}

/** COSE_Key (RFC 9052/9053) -> WebCrypto-importable JWK, restricted to ES256/RS256. */
export function coseToJwk(cose: Map<CborValue, CborValue>): { alg: SupportedAlg; jwk: JsonWebKey } {
  const kty = cose.get(1);
  const alg = cose.get(3);
  const bytesAt = (label: number): Bytes => {
    const v = cose.get(label);
    if (!(v instanceof Uint8Array)) throw new Error(`COSE label ${label} missing or not bytes`);
    return v;
  };
  if (kty === 2 && alg === COSE_ALG_ES256) {
    if (cose.get(-1) !== 1) throw new Error('ES256 key must use crv 1 (P-256)');
    const x = bytesAt(-2);
    const y = bytesAt(-3); // WebAuthn requires uncompressed points for ES256
    if (x.length !== 32 || y.length !== 32) throw new Error('bad P-256 coordinate length');
    return {
      alg: COSE_ALG_ES256,
      jwk: { kty: 'EC', crv: 'P-256', x: base64urlEncode(x), y: base64urlEncode(y), ext: true },
    };
  }
  if (kty === 3 && alg === COSE_ALG_RS256) {
    const stripZeros = (b: Bytes) => {
      let i = 0;
      while (i < b.length - 1 && b[i] === 0) i++;
      return b.slice(i);
    };
    return {
      alg: COSE_ALG_RS256,
      jwk: {
        kty: 'RSA',
        alg: 'RS256',
        n: base64urlEncode(stripZeros(bytesAt(-1))),
        e: base64urlEncode(stripZeros(bytesAt(-2))),
        ext: true,
      },
    };
  }
  throw new Error(`unsupported COSE key (kty=${String(kty)}, alg=${String(alg)})`);
}

export interface ParsedAttestation {
  fmt: string;
  authData: ParsedAuthData;
  credentialId: Bytes;
  alg: SupportedAlg;
  jwk: JsonWebKey;
}

/**
 * Parse an attestationObject (CBOR map {fmt, attStmt, authData}) and pull out
 * the credential public key. The attestation statement is ignored: we request
 * attestation: 'none', and this is a local gate, not an enterprise device check.
 */
export function parseAttestation(attestationObject: BinaryLike): ParsedAttestation {
  const { value, end } = decodeCbor(attestationObject);
  if (!(value instanceof Map)) throw new Error('attestationObject is not a CBOR map');
  if (end !== toBytes(attestationObject).length) throw new Error('trailing bytes after attestationObject');
  const fmt = value.get('fmt');
  const authDataBytes = value.get('authData');
  if (typeof fmt !== 'string' || !(authDataBytes instanceof Uint8Array)) {
    throw new Error('attestationObject missing fmt/authData');
  }
  const authData = parseAuthenticatorData(authDataBytes);
  if (!authData.attested) throw new Error('attestationObject has no attested credential data');
  const { alg, jwk } = coseToJwk(authData.attested.coseKey);
  return { fmt, authData, credentialId: authData.attested.credentialId, alg, jwk };
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/**
 * ASN.1 DER Ecdsa-Sig-Value (SEQUENCE { r INTEGER, s INTEGER }) -> raw r||s.
 * WebAuthn ES256 signatures are DER (L3 section 6.5.5); WebCrypto ECDSA verify
 * only accepts the fixed-length r||s form and silently returns false for DER.
 * `n` is the coordinate size in bytes: 32 for P-256.
 */
export function derToRaw(derInput: BinaryLike, n = 32): Bytes {
  const der = toBytes(derInput);
  let pos = 0;
  const readLen = (): number => {
    if (pos >= der.length) throw new Error('DER: truncated');
    const first = der[pos++];
    if (first < 0x80) return first;
    const count = first & 0x7f;
    if (count === 0 || count > 2) throw new Error('DER: unsupported length');
    let len = 0;
    for (let i = 0; i < count; i++) {
      if (pos >= der.length) throw new Error('DER: truncated');
      len = (len << 8) | der[pos++];
    }
    if (len < 0x80) throw new Error('DER: non-minimal length');
    return len;
  };
  const readInt = (): Bytes => {
    if (der[pos++] !== 0x02) throw new Error('DER: expected INTEGER');
    const len = readLen();
    if (len === 0 || pos + len > der.length) throw new Error('DER: bad INTEGER length');
    let v = der.subarray(pos, pos + len);
    pos += len;
    if (v[0] & 0x80) throw new Error('DER: negative INTEGER');
    while (v.length > 1 && v[0] === 0) v = v.subarray(1); // drop sign-padding 0x00
    if (v.length > n) throw new Error('DER: INTEGER longer than curve size');
    const out = new Uint8Array(n);
    out.set(v, n - v.length); // left-pad short values
    return out;
  };
  if (der[pos++] !== 0x30) throw new Error('DER: expected SEQUENCE');
  const seqLen = readLen();
  if (pos + seqLen !== der.length) throw new Error('DER: SEQUENCE length mismatch');
  const r = readInt();
  const s = readInt();
  if (pos !== der.length) throw new Error('DER: trailing bytes');
  return concatBytes(r, s);
}

async function importVerifyKey(alg: SupportedAlg, jwk: JsonWebKey): Promise<CryptoKey> {
  if (alg === COSE_ALG_ES256) {
    return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  }
  return crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}

async function verifySignature(alg: SupportedAlg, jwk: JsonWebKey, sig: Bytes, signed: Bytes): Promise<boolean> {
  const key = await importVerifyKey(alg, jwk);
  if (alg === COSE_ALG_ES256) {
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(sig, 32), signed);
  }
  return crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, sig, signed);
}

// ---------------------------------------------------------------------------
// Enrolment (registration)
// ---------------------------------------------------------------------------

/**
 * The public facts about an enrolled passkey that verification needs. Public data only. The app stores
 * these as a LockRecord in localStorage (types.ts, store.ts); passkey.ts converts between the two.
 */
export interface StoredPasskey {
  credentialId: string; // base64url(rawId)
  alg: SupportedAlg;
  publicKeyJwk: JsonWebKey;
  rpId: string;
  signCount: number;
  backupEligible: boolean;
}

/** Structural subset of AuthenticatorAttestationResponse (keeps this testable outside a browser). */
export interface AttestationResponseLike {
  clientDataJSON: ArrayBuffer;
  attestationObject: ArrayBuffer;
  getPublicKey?: () => ArrayBuffer | null;
  getPublicKeyAlgorithm?: () => number;
  getAuthenticatorData?: () => ArrayBuffer;
}

/**
 * Get the credential public key as a JWK. Preferred path: getPublicKey() (DER SPKI) +
 * getPublicKeyAlgorithm() (WebAuthn L2+, Safari 16+). Fallback: parse attestationObject.
 */
export async function publicKeyFromAttestation(
  response: AttestationResponseLike,
): Promise<{ alg: SupportedAlg; jwk: JsonWebKey; source: 'getPublicKey' | 'attestationObject' }> {
  if (typeof response.getPublicKey === 'function' && typeof response.getPublicKeyAlgorithm === 'function') {
    try {
      const spki = response.getPublicKey();
      const alg = response.getPublicKeyAlgorithm();
      if (spki && (alg === COSE_ALG_ES256 || alg === COSE_ALG_RS256)) {
        const params =
          alg === COSE_ALG_ES256
            ? { name: 'ECDSA', namedCurve: 'P-256' }
            : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
        const key = await crypto.subtle.importKey('spki', toBytes(spki), params, true, ['verify']);
        const jwk = await crypto.subtle.exportKey('jwk', key);
        return { alg, jwk, source: 'getPublicKey' };
      }
    } catch {
      // fall through to CBOR parsing
    }
  }
  const parsed = parseAttestation(response.attestationObject);
  return { alg: parsed.alg, jwk: parsed.jwk, source: 'attestationObject' };
}

export interface RegistrationCredentialLike {
  rawId: ArrayBuffer;
  response: AttestationResponseLike;
}

/** Local sanity checks on navigator.credentials.create() output, then build the record to store. */
export async function verifyRegistration(
  credential: RegistrationCredentialLike,
  expected: { challenge: Uint8Array; origin: string; rpId: string; requireUserVerification?: boolean },
): Promise<StoredPasskey> {
  const c = JSON.parse(new TextDecoder().decode(toBytes(credential.response.clientDataJSON)));
  if (c.type !== 'webauthn.create') throw new Error('clientData.type is not webauthn.create');
  if (c.challenge !== base64urlEncode(expected.challenge)) throw new Error('challenge mismatch');
  if (c.origin !== expected.origin) throw new Error('origin mismatch');
  // Prefer the browser's own extraction (getAuthenticatorData, Safari 16+); fall back to CBOR.
  const r = credential.response;
  const authData =
    typeof r.getAuthenticatorData === 'function'
      ? parseAuthenticatorData(r.getAuthenticatorData())
      : parseAttestation(r.attestationObject).authData;
  if (!bytesEqual(authData.rpIdHash, await sha256(new TextEncoder().encode(expected.rpId)))) {
    throw new Error('rpIdHash mismatch');
  }
  if (!(authData.flags & FLAG_UP)) throw new Error('UP flag not set');
  if ((expected.requireUserVerification ?? true) && !(authData.flags & FLAG_UV)) {
    throw new Error('UV flag not set');
  }
  if (!authData.attested || !bytesEqual(authData.attested.credentialId, toBytes(credential.rawId))) {
    throw new Error('credentialId mismatch');
  }
  const { alg, jwk } = await publicKeyFromAttestation(r);
  return {
    credentialId: base64urlEncode(credential.rawId),
    alg,
    publicKeyJwk: jwk,
    rpId: expected.rpId,
    signCount: authData.signCount,
    backupEligible: (authData.flags & FLAG_BE) !== 0,
  };
}

// ---------------------------------------------------------------------------
// Unlock (assertion)
// ---------------------------------------------------------------------------

/** Structural subset of PublicKeyCredential with an AuthenticatorAssertionResponse. */
export interface AssertionCredentialLike {
  rawId: ArrayBuffer;
  response: {
    clientDataJSON: ArrayBuffer;
    authenticatorData: ArrayBuffer;
    signature: ArrayBuffer;
    userHandle?: ArrayBuffer | null;
  };
}

export interface VerifyAssertionOptions {
  expectedChallenge: Uint8Array; // the 32 bytes we generated for this get()
  expectedOrigin: string; // location.origin
  expectedRpId: string; // the rp.id used at enrolment (location.hostname)
  stored: StoredPasskey;
  requireUserVerification?: boolean; // default true: the whole point is Face ID
}

export type VerifyAssertionResult =
  | { ok: true; signCount: number; flags: number; counterWentBackwards: boolean }
  | { ok: false; reason: string };

/**
 * WebAuthn L3 section 7.2 "Verifying an Authentication Assertion", minus the
 * server-only parts (user lookup, extensions, attestation).
 * Never throws: any malformed input is reported as { ok: false }.
 */
export async function verifyAssertion(
  credential: AssertionCredentialLike,
  opts: VerifyAssertionOptions,
): Promise<VerifyAssertionResult> {
  const fail = (reason: string): VerifyAssertionResult => ({ ok: false, reason });
  try {
    const { stored } = opts;
    if (base64urlEncode(credential.rawId) !== stored.credentialId) return fail('unknown credential');

    const cDataBytes = toBytes(credential.response.clientDataJSON);
    const authData = toBytes(credential.response.authenticatorData);
    const sig = toBytes(credential.response.signature);

    // TextDecoder strips a leading BOM, as the spec's "UTF-8 decode" requires.
    const c = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(cDataBytes));
    if (c.type !== 'webauthn.get') return fail('clientData.type is not webauthn.get');
    if (typeof c.challenge !== 'string' || c.challenge !== base64urlEncode(opts.expectedChallenge)) {
      return fail('challenge mismatch');
    }
    if (c.origin !== opts.expectedOrigin) return fail('origin mismatch');
    if (c.crossOrigin === true || c.topOrigin !== undefined) return fail('unexpected cross-origin use');

    const parsed = parseAuthenticatorData(authData);
    const expectedHash = await sha256(new TextEncoder().encode(opts.expectedRpId));
    if (!bytesEqual(parsed.rpIdHash, expectedHash)) return fail('rpIdHash mismatch');
    if (!(parsed.flags & FLAG_UP)) return fail('UP flag not set');
    if ((opts.requireUserVerification ?? true) && !(parsed.flags & FLAG_UV)) return fail('UV flag not set');
    if (!(parsed.flags & FLAG_BE) && parsed.flags & FLAG_BS) return fail('BS set without BE');

    const signed = concatBytes(authData, await sha256(cDataBytes));
    const valid = await verifySignature(stored.alg, stored.publicKeyJwk, sig, signed);
    if (!valid) return fail('bad signature');

    // Signature counter: synced passkeys (iCloud Keychain, Google Password
    // Manager) always report 0, so a 0/0 pair is normal and not checked. If a
    // device-bound authenticator ever reports a non-increasing counter we only
    // surface it; a local gate has no incident-response process to act on it.
    const counterWentBackwards =
      (parsed.signCount !== 0 || stored.signCount !== 0) && parsed.signCount <= stored.signCount;
    return { ok: true, signCount: parsed.signCount, flags: parsed.flags, counterWentBackwards };
  } catch (e) {
    return fail('malformed assertion: ' + (e instanceof Error ? e.message : String(e)));
  }
}
