// The Web Push crypto, checked against an independent implementation: http_ece (the library behind the
// web-push npm package) decrypts what encryptPayload produced, playing the browser. VAPID tokens are
// verified with Node's own crypto.
import { createECDH, createPublicKey, randomBytes, verify } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  b64urlDecode,
  b64urlEncode,
  encryptPayload,
  generateVapidKeys,
  importVapidKey,
  sendWebPush,
  vapidAuthorization,
  type PushSubscriptionKeys,
  type VapidKeys,
} from './webpush';

const ece = createRequire(import.meta.url)('http_ece') as {
  decrypt(buf: Buffer, params: { version: string; privateKey: unknown; authSecret: Buffer }): Buffer;
};

/** A browser: its key pair and auth secret, and the subscription it would hand to the app. */
function browser(endpoint = 'https://web.push.apple.com/QGx9abc') {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const sub: PushSubscriptionKeys = { endpoint, p256dh: b64urlEncode(ecdh.getPublicKey()), auth: b64urlEncode(auth) };
  const open = (body: Uint8Array) => ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: ecdh, authSecret: auth }).toString('utf8');
  return { sub, open };
}

async function vapid(): Promise<VapidKeys> {
  return { ...(await generateVapidKeys()), subject: 'mailto:me@example.com' };
}

function verifyJwt(header: string, publicKey: string) {
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
  expect(m).not.toBeNull();
  const [, h, c, s, k] = m!;
  expect(k).toBe(publicKey);
  const raw = b64urlDecode(publicKey);
  const key = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64urlEncode(raw.slice(1, 33)), y: b64urlEncode(raw.slice(33)) },
    format: 'jwk',
  });
  const ok = verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(b64urlDecode(s)));
  return { ok, head: JSON.parse(Buffer.from(b64urlDecode(h)).toString()), claims: JSON.parse(Buffer.from(b64urlDecode(c)).toString()) };
}

describe('base64url', () => {
  it('round-trips without padding', () => {
    for (const n of [0, 1, 2, 3, 16, 65]) {
      const bytes = new Uint8Array(randomBytes(n));
      const s = b64urlEncode(bytes);
      expect(s).not.toMatch(/[+/=]/);
      expect(b64urlDecode(s)).toEqual(bytes);
    }
  });
});

describe('payload encryption (RFC 8291)', () => {
  it('a browser can decrypt it', async () => {
    const b = browser();
    const msg = JSON.stringify({ title: 'Time to check in', body: 'Two taps keeps your burners lit. ✨' });
    const body = await encryptPayload(b.sub, new TextEncoder().encode(msg));
    expect(b.open(body)).toBe(msg);
  });

  it('writes the aes128gcm header: salt, 4096 record size, the sender key as key id', async () => {
    const b = browser();
    const salt = new Uint8Array(16).fill(7);
    const body = await encryptPayload(b.sub, new TextEncoder().encode('x'), { salt });
    expect(body.slice(0, 16)).toEqual(salt);
    expect(new DataView(body.buffer).getUint32(16)).toBe(4096);
    expect(body[20]).toBe(65);
    expect(body[21]).toBe(4);
    // header 86 + 1 byte + delimiter + 16 byte tag
    expect(body.length).toBe(86 + 2 + 16);
  });

  it('every message uses a fresh key and salt', async () => {
    const b = browser();
    const p = new TextEncoder().encode('same');
    const [x, y] = await Promise.all([encryptPayload(b.sub, p), encryptPayload(b.sub, p)]);
    expect(b64urlEncode(x)).not.toBe(b64urlEncode(y));
    expect(b.open(x)).toBe('same');
    expect(b.open(y)).toBe('same');
  });

  it('refuses bad keys and oversized payloads', async () => {
    const b = browser();
    await expect(encryptPayload({ ...b.sub, auth: 'AAAA' }, new Uint8Array(1))).rejects.toThrow(/auth/);
    await expect(encryptPayload({ ...b.sub, p256dh: b64urlEncode(new Uint8Array(33)) }, new Uint8Array(1))).rejects.toThrow();
    await expect(encryptPayload(b.sub, new Uint8Array(4000))).rejects.toThrow(/too large/);
  });
});

describe('VAPID (RFC 8292)', () => {
  it('signs an ES256 token for the push service origin, valid 12 hours', async () => {
    const keys = await vapid();
    const now = Date.UTC(2026, 9, 2, 12);
    const header = await vapidAuthorization('https://web.push.apple.com/QGx9abc?x=1', keys, await importVapidKey(keys), now);
    const { ok, head, claims } = verifyJwt(header, keys.publicKey);
    expect(ok).toBe(true);
    expect(head).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(claims).toEqual({ aud: 'https://web.push.apple.com', exp: now / 1000 + 12 * 3600, sub: 'mailto:me@example.com' });
  });

  it('rejects a malformed private key', async () => {
    const keys = await vapid();
    await expect(importVapidKey({ ...keys, privateKey: 'abc' })).rejects.toThrow(/32-byte/);
  });
});

describe('sendWebPush', () => {
  it('posts an encrypted, signed message the browser can read', async () => {
    const keys = await vapid();
    const b = browser();
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const out = await sendWebPush(b.sub, '{"title":"hi"}', keys, await importVapidKey(keys), fetchFn, Date.now(), { topic: 'daily!', urgency: 'high', ttl: 60 });
    expect(out).toEqual({ ok: true, status: 201 });
    const h = seen!.init.headers as Record<string, string>;
    expect(seen!.url).toBe(b.sub.endpoint);
    expect(h['Content-Encoding']).toBe('aes128gcm');
    expect(h.TTL).toBe('60');
    expect(h.Urgency).toBe('high');
    expect(h.Topic).toBe('daily');
    expect(verifyJwt(h.Authorization, keys.publicKey).ok).toBe(true);
    expect(b.open(seen!.init.body as Uint8Array)).toBe('{"title":"hi"}');
  });

  it('reports a gone subscription (404, 410) and other failures without throwing', async () => {
    const keys = await vapid();
    const key = await importVapidKey(keys);
    const b = browser();
    const respond = (status: number, text = '') => (async () => new Response(text, { status })) as unknown as typeof fetch;
    expect(await sendWebPush(b.sub, 'x', keys, key, respond(410), 0)).toMatchObject({ ok: false, gone: true, status: 410 });
    expect(await sendWebPush(b.sub, 'x', keys, key, respond(404), 0)).toMatchObject({ ok: false, gone: true });
    expect(await sendWebPush(b.sub, 'x', keys, key, respond(403, '{"reason":"BadJwtToken"}'), 0)).toMatchObject({
      ok: false,
      gone: false,
      reason: '{"reason":"BadJwtToken"}',
    });
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await sendWebPush(b.sub, 'x', keys, key, offline, 0)).toMatchObject({ ok: false, gone: false, reason: 'fetch failed' });
    expect(await sendWebPush({ ...b.sub, endpoint: 'http://insecure.example' }, 'x', keys, key, respond(201), 0)).toMatchObject({ ok: false, gone: true });
  });
});
