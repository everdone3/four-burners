// Web Push, sending side, with nothing but WebCrypto (works the same in the Supabase Edge runtime, Deno,
// and Node 20 for tests). Two standards:
//   RFC 8291 + RFC 8188: the payload is encrypted (aes128gcm) for one browser's subscription keys.
//   RFC 8292 (VAPID): a short-lived ES256 JWT proves the push comes from the holder of the app's key pair.
// The VAPID public key is built into the app (VITE_VAPID_PUBLIC_KEY); the private key lives only in the
// Edge Function's secrets.

export interface PushSubscriptionKeys {
  endpoint: string;
  /** Browser's P-256 public key, base64url (65 bytes uncompressed). */
  p256dh: string;
  /** Browser's auth secret, base64url (16 bytes). */
  auth: string;
}

export interface VapidKeys {
  /** base64url, 65-byte uncompressed P-256 point. */
  publicKey: string;
  /** base64url, 32-byte private scalar. */
  privateKey: string;
  /** mailto: or https: contact for the push service operators. */
  subject: string;
}

const enc = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hmac(key: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/** HKDF-SHA256 for outputs up to 32 bytes (one expand round), as RFC 8291 uses it. */
async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array, length: number) {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

function publicJwk(raw: Uint8Array): JsonWebKey {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('Expected an uncompressed P-256 public key.');
  return { kty: 'EC', crv: 'P-256', x: b64urlEncode(raw.slice(1, 33)), y: b64urlEncode(raw.slice(33, 65)), ext: true };
}

export interface EncryptOptions {
  /** Tests only: fixed sender key pair and salt instead of fresh random ones. */
  senderKeys?: CryptoKeyPair;
  salt?: Uint8Array<ArrayBuffer>;
}

/** Encrypt a payload for one subscription (RFC 8291, aes128gcm). Returns the full request body. */
export async function encryptPayload(
  sub: Pick<PushSubscriptionKeys, 'p256dh' | 'auth'>,
  payload: Uint8Array,
  opts: EncryptOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = b64urlDecode(sub.p256dh);
  const authSecret = b64urlDecode(sub.auth);
  if (authSecret.length < 16) throw new Error('The subscription auth secret is too short.');
  // Browsers cap a push message near 4 KB. One record holds the whole payload.
  if (payload.length > 3800) throw new Error('Push payload too large.');

  const sender =
    opts.senderKeys ?? ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', sender.publicKey));
  const uaKey = await crypto.subtle.importKey('jwk', publicJwk(uaPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, sender.privateKey, 256));

  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // Single record: payload, then the 0x02 delimiter that marks the last record (no padding).
  const plain = concat(payload, new Uint8Array([2]));
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, plain));

  // Header: salt (16) | record size (4, big endian) | key id length (1) | key id (the sender public key).
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

/** The VAPID private key as a signing key (needs the public key for x and y). */
export async function importVapidKey(keys: Pick<VapidKeys, 'publicKey' | 'privateKey'>): Promise<CryptoKey> {
  const d = b64urlDecode(keys.privateKey);
  if (d.length !== 32) throw new Error('VAPID_PRIVATE_KEY must be a 32-byte base64url value.');
  const jwk = { ...publicJwk(b64urlDecode(keys.publicKey)), d: b64urlEncode(d) };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** The VAPID Authorization header value for one push service origin (RFC 8292). */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, signingKey: CryptoKey, nowMs: number): Promise<string> {
  const aud = new URL(endpoint).origin;
  // Apple and Mozilla reject tokens valid for more than 24 hours. 12 hours leaves room for clock skew.
  const claims = { aud, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: keys.subject };
  const head = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64urlEncode(enc.encode(JSON.stringify(claims)));
  // WebCrypto ECDSA signatures are already raw r|s (64 bytes), which is exactly JWS ES256.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, enc.encode(`${head}.${body}`)));
  return `vapid t=${head}.${body}.${b64urlEncode(sig)}, k=${keys.publicKey}`;
}

export type PushOutcome =
  | { ok: true; status: number }
  /** gone: the subscription no longer exists (404/410); forget it. */
  | { ok: false; status: number; gone: boolean; reason: string };

export interface SendOptions {
  /** Seconds the push service may hold the message for an offline device. */
  ttl?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  /** Replaces a still-undelivered message with the same topic (e.g. 'daily'). */
  topic?: string;
}

/** Encrypt and deliver one message. Never throws for push service errors; reports them instead. */
export async function sendWebPush(
  sub: PushSubscriptionKeys,
  payload: string,
  keys: VapidKeys,
  signingKey: CryptoKey,
  fetchFn: typeof fetch,
  nowMs: number,
  opts: SendOptions = {},
): Promise<PushOutcome> {
  let url: URL;
  try {
    url = new URL(sub.endpoint);
  } catch {
    return { ok: false, status: 0, gone: true, reason: 'Invalid endpoint' };
  }
  if (url.protocol !== 'https:') return { ok: false, status: 0, gone: true, reason: 'Endpoint is not https' };
  const body = await encryptPayload(sub, enc.encode(payload));
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    TTL: String(opts.ttl ?? 4 * 3600),
    Urgency: opts.urgency ?? 'normal',
    Authorization: await vapidAuthorization(sub.endpoint, keys, signingKey, nowMs),
  };
  if (opts.topic) headers.Topic = opts.topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  let res: Response;
  try {
    res = await fetchFn(url.toString(), { method: 'POST', headers, body });
  } catch (e) {
    return { ok: false, status: 0, gone: false, reason: e instanceof Error ? e.message : 'Network error' };
  }
  if (res.ok) return { ok: true, status: res.status };
  const text = (await res.text().catch(() => '')).slice(0, 200);
  return { ok: false, status: res.status, gone: res.status === 404 || res.status === 410, reason: text || res.statusText || `HTTP ${res.status}` };
}

/** A fresh VAPID key pair (scripts/vapid-keys.mjs prints one). */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: b64urlEncode(pub), privateKey: jwk.d! };
}
