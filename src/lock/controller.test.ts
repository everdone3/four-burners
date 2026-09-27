// The lock controller (controller.ts) against a fake page: document, window, storage and a fake platform
// authenticator that signs with a real P-256 key (Node's WebCrypto), with fake timers and a fake clock.
// The lock is an access gate, not encryption: see the header of webauthnLocal.ts.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LockRecord } from './types';
import { base64urlDecode, base64urlEncode, concatBytes, toBytes } from './webauthnLocal';

type Bytes = Uint8Array<ArrayBuffer>;
const RP = 'four-burners.vercel.app';
const ORIGIN = 'https://four-burners.vercel.app';
const T0 = Date.UTC(2026, 8, 27, 12, 0, 0);
const MIN = 60_000;
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15';
const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
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

type OkOpts = { challenge?: Uint8Array; origin?: string; flags?: number; rawId?: Uint8Array };
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
  /** What get() does when nothing is queued: wait until aborted, like a prompt nobody answers. */
  idle: Behavior = { kind: 'hang' };
  constructor(
    public keys: CryptoKeyPair,
    public credId: Bytes,
  ) {}

  get = (opts: CredentialRequestOptions): Promise<unknown> => {
    this.gets.push(opts);
    if (opts.signal) this.signals.push(opts.signal);
    return this.act(this.getQueue.shift() ?? this.idle, opts.signal, (o) => this.assertion(opts.publicKey!, o));
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
    const ad = concatBytes(await sha256(enc.encode(pk.rpId ?? RP)), new Uint8Array([o.flags ?? 0x1d]), new Uint8Array(4));
    const p1363 = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, concatBytes(ad, await sha256(cData))));
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
    const ad = concatBytes(await sha256(enc.encode(pk.rp.id ?? RP)), new Uint8Array([o.flags ?? 0x5d]), new Uint8Array(4), attested);
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
      },
    };
  }
}

// ---------- fake page ----------

class FakeEvent {
  isTrusted = true;
  defaultPrevented = false;
  stopped = false;
  persisted = false;
  constructor(
    public type: string,
    init: Partial<Pick<FakeEvent, 'isTrusted' | 'persisted'>> = {},
  ) {
    Object.assign(this, init);
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopImmediatePropagation() {
    this.stopped = true;
  }
  stopPropagation() {}
}

type Listener = (e: FakeEvent) => void;

class FakeTarget {
  private listeners = new Map<string, Array<{ fn: Listener; capture: boolean }>>();
  addEventListener(type: string, fn: Listener, opts?: boolean | { capture?: boolean }) {
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
    const list = this.listeners.get(type) ?? [];
    if (!list.some((l) => l.fn === fn && l.capture === capture)) list.push({ fn, capture });
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: Listener, opts?: boolean | { capture?: boolean }) {
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => !(l.fn === fn && l.capture === capture)),
    );
  }
  emit(type: string, init: Partial<Pick<FakeEvent, 'isTrusted' | 'persisted'>> = {}): FakeEvent {
    const e = new FakeEvent(type, init);
    for (const l of [...(this.listeners.get(type) ?? [])]) {
      l.fn(e);
      if (e.stopped) break;
    }
    return e;
  }
  count(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }
}

class FakeDocument extends FakeTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';
  focused = true;
  documentElement = { dataset: {} as Record<string, string | undefined> };
  activeElement: { blur: () => void } | null = null;
  hasFocus() {
    return this.focused;
  }
  hide() {
    this.visibilityState = 'hidden';
    this.focused = false;
    this.emit('visibilitychange');
  }
  show() {
    this.visibilityState = 'visible';
    this.emit('visibilitychange');
  }
}

class MemStorage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

// ---------- harness ----------

let keys: CryptoKeyPair;
let credId: Bytes;
let record: LockRecord;

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

interface SetupOptions {
  /** Store the enrolled record (default true), or a specific one. */
  record?: boolean | LockRecord;
  ua?: string;
  maxTouchPoints?: number;
  visible?: boolean;
  focused?: boolean;
  /** Reuse storage from an earlier page (a reload). */
  local?: MemStorage;
  session?: MemStorage;
  idle?: number;
  publicKeyCredential?: unknown;
}

async function setup(o: SetupOptions = {}) {
  vi.resetModules();
  const doc = new FakeDocument();
  doc.visibilityState = o.visible === false ? 'hidden' : 'visible';
  doc.focused = o.focused ?? o.visible !== false;
  const win = new FakeTarget();
  const local = o.local ?? new MemStorage();
  const session = o.session ?? new MemStorage();
  const auth = new FakeAuthenticator(keys, credId);
  if (o.record !== undefined ? o.record : true) local.setItem('fb-lock', JSON.stringify(o.record === undefined || o.record === true ? record : o.record));
  if (o.idle !== undefined) local.setItem('fb-lock-idle', String(o.idle));
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('location', { hostname: RP, origin: ORIGIN });
  vi.stubGlobal('navigator', {
    userAgent: o.ua ?? IPHONE_UA,
    maxTouchPoints: o.maxTouchPoints ?? 5,
    credentials: { get: auth.get, create: auth.create },
  });
  vi.stubGlobal('PublicKeyCredential', o.publicKeyCredential);
  const ctl = await import('./controller');
  const busy = await import('../ui/busy'); // the instance the controller just loaded
  const state = () => ctl.getLockState();
  const events = () => ctl.getLockLog().map((e) => e.event);
  return { doc, win, local, session, auth, ctl, busy, state, events, html: doc.documentElement.dataset };
}

type Env = Awaited<ReturnType<typeof setup>>;

/** Spins the real event loop until `pred` holds (WebCrypto finishes on the thread pool, not on a timer). */
async function waitFor(pred: () => boolean, what = 'condition') {
  for (let i = 0; i < 2000; i++) {
    if (pred()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Enrolled and unlocked, via a trusted reload a second after the last interaction. */
async function startUnlocked(o: SetupOptions = {}): Promise<Env> {
  const session = o.session ?? new MemStorage();
  const local = o.local ?? new MemStorage();
  session.setItem('fb-lock-reload', String(Date.now() - 1_000));
  local.setItem('fb-lock-active', String(Date.now() - 1_000));
  const env = await setup({ ...o, local, session });
  env.ctl.startLock();
  expect(env.state().phase).toBe('unlocked');
  return env;
}

/** Enrolled and locked on a cold start, with the automatic attempt already spent (no focus). */
async function startLocked(o: SetupOptions = {}): Promise<Env> {
  const env = await setup({ ...o, focused: false });
  env.ctl.startLock();
  await vi.advanceTimersByTimeAsync(1_500);
  expect(env.events()).toContain('focus timeout');
  env.doc.focused = true;
  expect(env.state()).toMatchObject({ phase: 'locked', failures: 0 });
  return env;
}

// ---------- tests ----------

describe('launch', () => {
  it('cold start: an enrolled device starts locked and makes one automatic attempt', async () => {
    const env = await setup();
    env.auth.getQueue.push({ kind: 'ok' });
    env.ctl.startLock();
    expect(env.state()).toMatchObject({ phase: 'locked', coldStart: true, failures: 0, device: 'iphone', label: 'Four Burners lock · iPhone' });
    expect(env.html.lock).toBe('locked');
    expect(env.auth.gets).toHaveLength(0); // deferred a tick, after the first render
    await vi.advanceTimersByTimeAsync(0);
    expect(env.auth.gets).toHaveLength(1);
    expect(env.state().phase).toBe('unlocking');
    await waitFor(() => env.state().phase === 'unlocked', 'unlock');
    expect(env.state()).toMatchObject({ coldStart: false, failures: 0 });
    expect(env.html.lock).toBeUndefined();
    expect(env.local.getItem('fb-lock-active')).toBe(String(T0));
    expect(env.events()).toEqual(expect.arrayContaining(['start', 'auto offered', 'unlock start', 'unlock result']));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(env.auth.gets).toHaveLength(1);
  });

  it('is idempotent', async () => {
    const env = await setup();
    env.ctl.startLock();
    env.ctl.startLock();
    expect(env.win.count('pagehide')).toBe(1);
    expect(env.doc.count('visibilitychange')).toBe(1);
    expect(env.events().filter((e) => e === 'start')).toHaveLength(1);
  });

  it('no record: the lock is off and nothing is hidden', async () => {
    const env = await setup({ record: false });
    env.ctl.startLock();
    expect(env.state()).toMatchObject({ phase: 'off', coldStart: false, otherHost: false });
    expect(env.html.lock).toBeUndefined();
    expect(await env.ctl.unlock()).toBe('ok');
  });

  it('a record made for another address is ignored here', async () => {
    const env = await setup({ record: { ...record, rpId: 'four-burners-git-dev.vercel.app' } });
    env.html.lock = 'locked'; // what a stale pre-paint would have done; the controller clears it
    env.ctl.startLock();
    expect(env.state()).toMatchObject({ phase: 'off', otherHost: true });
    expect(env.html.lock).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(env.auth.gets).toHaveLength(0);
  });

  it('a page that starts hidden starts with the shield on', async () => {
    const env = await setup({ visible: false });
    env.ctl.startLock();
    expect(env.html.shield).toBe('on');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(env.auth.gets).toHaveLength(0); // no automatic attempt while hidden
  });
});

describe('trusted reloads', () => {
  async function reloadWith(reloadAgo: number | null, activeAgo: number | null, idle = 5) {
    const local = new MemStorage();
    const session = new MemStorage();
    if (reloadAgo !== null) session.setItem('fb-lock-reload', String(T0 - reloadAgo));
    if (activeAgo !== null) local.setItem('fb-lock-active', String(T0 - activeAgo));
    const env = await setup({ local, session, idle });
    env.ctl.startLock();
    return env;
  }

  it('within 30 s the idle rule decides: recent activity stays unlocked', async () => {
    const env = await reloadWith(10_000, 1 * MIN);
    expect(env.state()).toMatchObject({ phase: 'unlocked', coldStart: false });
    expect(env.html.lock).toBeUndefined();
    expect(env.session.getItem('fb-lock-reload')).toBeNull(); // one launch only
    expect(env.ctl.getLockLog()[0].detail).toContain('trusted reload');
  });

  it('an old mark, an idle device, no activity, or a mark from the future all lock', async () => {
    expect((await reloadWith(31_000, 1 * MIN)).state()).toMatchObject({ phase: 'locked', coldStart: true });
    expect((await reloadWith(10_000, 6 * MIN)).state().phase).toBe('locked');
    expect((await reloadWith(10_000, null)).state().phase).toBe('locked');
    expect((await reloadWith(-5_000, 1 * MIN)).state().phase).toBe('locked');
    expect((await reloadWith(null, 1 * MIN)).state().phase).toBe('locked'); // a normal launch
  });

  it('markTrustedReload writes the stamp; the reload it marks while visible is not "leaving the screen"', async () => {
    const env = await startUnlocked({ idle: 0 });
    env.ctl.markTrustedReload();
    expect(env.session.getItem('fb-lock-reload')).toBe(String(T0));
    env.doc.hide(); // the reload's own unload
    env.win.emit('pagehide');
    expect(env.state().phase).toBe('unlocked');
    expect(env.local.getItem('fb-lock-active')).toBe(String(T0));
    // The next page load follows the idle rule and opens.
    const next = await setup({ local: env.local, session: env.session, idle: 0 });
    next.ctl.startLock();
    expect(next.state().phase).toBe('unlocked');
  });

  it('a reload marked after the app went to the background still locks with idle 0', async () => {
    const env = await startUnlocked({ idle: 0 });
    env.doc.hide();
    expect(env.state().phase).toBe('locked');
    env.ctl.markTrustedReload();
    const next = await setup({ local: env.local, session: env.session, idle: 0 });
    next.ctl.startLock();
    expect(next.state().phase).toBe('locked');
  });

  it('a trusted reload of a locked app stays locked (locking clears the activity stamp)', async () => {
    const env = await startLocked();
    env.ctl.markTrustedReload();
    const next = await setup({ local: env.local, session: env.session });
    next.ctl.startLock();
    expect(next.state().phase).toBe('locked');
  });

  it('a cold start drops the last session stamp, so marking its locked page cannot open the next load', async () => {
    const local = new MemStorage();
    local.setItem('fb-lock-active', String(T0 - 5_000)); // hidden 5 s ago while unlocked, then the app was closed
    const env = await setup({ local, focused: false });
    env.ctl.startLock();
    expect(env.state().phase).toBe('locked');
    expect(env.local.getItem('fb-lock-active')).toBeNull();
    env.ctl.markTrustedReload(); // a caller that forgot to check the phase
    const next = await setup({ local: env.local, session: env.session });
    next.ctl.startLock();
    expect(next.state()).toMatchObject({ phase: 'locked', coldStart: true });
  });

  it('with idle 0, a trusted reload that comes back hidden (you left while it loaded) starts locked', async () => {
    const reload = async (idle: number) => {
      const local = new MemStorage();
      const session = new MemStorage();
      session.setItem('fb-lock-reload', String(T0 - 2_000));
      local.setItem('fb-lock-active', String(T0 - 2_000));
      const env = await setup({ local, session, idle, visible: false });
      env.ctl.startLock();
      return env;
    };
    const zero = await reload(0);
    expect(zero.state()).toMatchObject({ phase: 'locked', coldStart: true });
    expect(zero.html).toMatchObject({ lock: 'locked', shield: 'on' });
    const five = await reload(5);
    expect(five.state().phase).toBe('unlocked'); // the idle rule decides on return
    expect(five.html.shield).toBe('on');
  });

  it('a mark made while locked gives no idle 0 exemption to the next hide', async () => {
    const env = await startLocked({ idle: 0 });
    env.ctl.markTrustedReload();
    env.auth.getQueue.push({ kind: 'ok' });
    expect(await env.ctl.unlock()).toBe('ok');
    env.doc.hide();
    expect(env.state().phase).toBe('locked');
  });
});

describe('shield', () => {
  it('goes up synchronously on hidden and pagehide and comes down on return when no lock is needed', async () => {
    const env = await startUnlocked();
    env.doc.hide();
    expect(env.html.shield).toBe('on'); // no await in between
    expect(env.state().phase).toBe('unlocked');
    env.doc.show();
    expect(env.html.shield).toBeUndefined();
    env.win.emit('pagehide', { persisted: true });
    expect(env.html.shield).toBe('on');
    env.win.emit('pageshow', { persisted: true });
    expect(env.html.shield).toBeUndefined();
    expect(env.events()).toEqual(expect.arrayContaining(['hidden', 'visible', 'pagehide (persisted)', 'pageshow (persisted)']));
  });

  it('works with the lock off too', async () => {
    const env = await setup({ record: false });
    env.ctl.startLock();
    env.doc.hide();
    expect(env.html.shield).toBe('on');
    env.doc.show();
    expect(env.html.shield).toBeUndefined();
  });

  it('never reacts to window blur', async () => {
    const env = await startUnlocked({ idle: 0 });
    env.win.emit('blur');
    expect(env.html.shield).toBeUndefined();
    expect(env.state().phase).toBe('unlocked');
  });
});

describe('idle', () => {
  it('locks on return after the idle time, keeps the shield, and tries one automatic unlock', async () => {
    const env = await startUnlocked({ idle: 5 });
    env.doc.hide();
    expect(env.local.getItem('fb-lock-active')).toBe(String(T0)); // recorded on hide
    await vi.advanceTimersByTimeAsync(2 * MIN);
    env.doc.focused = true;
    env.doc.show();
    expect(env.state().phase).toBe('unlocked');
    expect(env.auth.gets).toHaveLength(0);

    env.doc.hide();
    await vi.advanceTimersByTimeAsync(6 * MIN);
    env.doc.focused = true;
    env.auth.getQueue.push({ kind: 'ok' });
    env.doc.show();
    expect(env.html.shield).toBe('on');
    expect(env.html.lock).toBe('locked');
    expect(env.auth.gets).toHaveLength(1);
    expect(env.ctl.getLockLog().find((e) => e.event === 'lock')?.detail).toContain('on return');
    await waitFor(() => env.state().phase === 'unlocked', 'unlock');
    expect(env.html.shield).toBeUndefined();
    expect(env.state().coldStart).toBe(false);
  });

  it('a return that stays open counts as activity, so it does not lock seconds after you come back', async () => {
    const env = await startUnlocked({ idle: 5 });
    env.doc.hide();
    await vi.advanceTimersByTimeAsync(4 * MIN + 50_000);
    env.doc.focused = true;
    env.doc.show();
    expect(env.state().phase).toBe('unlocked');
    expect(env.local.getItem('fb-lock-active')).toBe(String(T0 + 4 * MIN + 50_000));
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(env.state().phase).toBe('unlocked');
    await vi.advanceTimersByTimeAsync(1 * MIN + 10_000);
    expect(env.state().phase).toBe('locked');
  });

  it('the foreground timer locks after the idle time without interaction; interaction keeps it open', async () => {
    const env = await startUnlocked({ idle: 5 });
    await vi.advanceTimersByTimeAsync(4 * MIN);
    env.win.emit('pointerdown');
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(env.state().phase).toBe('unlocked');
    await vi.advanceTimersByTimeAsync(1 * MIN + 10_000);
    expect(env.state().phase).toBe('locked');
    expect(env.ctl.getLockLog().find((e) => e.event === 'lock')?.detail).toContain('foreground timer');
    expect(env.auth.gets).toHaveLength(0); // no automatic attempt for a foreground lock
  });

  it('idle 0 locks on hide, and after 1 minute idle in the foreground', async () => {
    const env = await startUnlocked({ idle: 5 });
    env.ctl.setIdleMinutes(0);
    expect(env.local.getItem('fb-lock-idle')).toBe('0');
    const input = { blur: vi.fn() };
    env.doc.activeElement = input;
    env.doc.hide();
    expect(env.state().phase).toBe('locked');
    expect(env.html.lock).toBe('locked');
    expect(env.local.getItem('fb-lock-active')).toBeNull();
    expect(input.blur).toHaveBeenCalled();

    const fg = await startUnlocked({ idle: 0 });
    await vi.advanceTimersByTimeAsync(50_000);
    expect(fg.state().phase).toBe('unlocked');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fg.state().phase).toBe('locked');
  });

  it('a clock that moved back fails closed', async () => {
    const env = await startUnlocked();
    vi.setSystemTime(T0 - 60 * MIN);
    const e = env.win.emit('pointerdown');
    expect(env.state().phase).toBe('locked');
    expect(e.defaultPrevented).toBe(true);
    expect(env.ctl.getLockLog().find((x) => x.event === 'lock')?.detail).toContain('clock moved back');

    vi.setSystemTime(T0);
    const other = await startUnlocked();
    other.doc.hide();
    vi.setSystemTime(T0 - 10 * MIN);
    other.doc.show();
    expect(other.state().phase).toBe('locked');
  });

  it('interaction: check, then record; a stale tap locks and is swallowed with its click', async () => {
    const env = await startUnlocked({ idle: 5 });
    vi.setSystemTime(T0 + 4 * MIN); // moves the clock without running the foreground timer
    expect(env.win.emit('pointerdown').defaultPrevented).toBe(false);
    expect(env.local.getItem('fb-lock-active')).toBe(String(T0 + 4 * MIN));
    vi.setSystemTime(T0 + 8 * MIN);
    env.win.emit('keydown');
    expect(env.state().phase).toBe('unlocked');

    vi.setSystemTime(T0 + 14 * MIN);
    expect(env.win.emit('pointerdown', { isTrusted: false }).defaultPrevented).toBe(false); // untrusted: ignored
    expect(env.state().phase).toBe('unlocked');
    const tap = env.win.emit('pointerdown');
    expect(env.state().phase).toBe('locked');
    expect(tap.defaultPrevented).toBe(true);
    expect(tap.stopped).toBe(true);
    const click = env.win.emit('click');
    expect(click.defaultPrevented).toBe(true);
    expect(click.stopped).toBe(true);
    expect(env.win.emit('click').defaultPrevented).toBe(false); // only that one click
  });

  it('interaction writes to storage at most once a second', async () => {
    const env = await startUnlocked();
    const writes = vi.spyOn(env.local, 'setItem');
    for (let i = 0; i < 20; i++) {
      vi.setSystemTime(T0 + i * 50);
      env.win.emit('wheel');
    }
    expect(writes.mock.calls.filter(([k]) => k === 'fb-lock-active')).toHaveLength(1);
  });
});

describe('unlock ceremonies', () => {
  it('hidden aborts an in-flight ceremony quietly, and busy is held while it runs', async () => {
    const env = await startLocked();
    env.auth.getQueue.push({ kind: 'hang' });
    const p = env.ctl.unlock();
    expect(env.state().phase).toBe('unlocking');
    expect(env.busy.busyReasons()).toEqual(['Face ID unlock']);
    env.doc.hide();
    expect(env.state().phase).toBe('locked'); // synchronously
    expect(await p).toBe('cancelled');
    expect(env.state()).toMatchObject({ phase: 'locked', failures: 0 });
    expect(env.state().message).toBeUndefined();
    expect(env.auth.signals.at(-1)!.aborted).toBe(true);
    expect(env.busy.isBusy()).toBe(false);
    expect(env.ctl.getLockLog().find((e) => e.event === 'hidden')?.detail).toContain('prompt aborted');
  });

  it('single flight: a second unlock aborts the first', async () => {
    const env = await startLocked();
    env.auth.getQueue.push({ kind: 'hang' }, { kind: 'ok' });
    const first = env.ctl.unlock();
    const second = env.ctl.unlock();
    expect(await first).toBe('cancelled');
    expect(await second).toBe('ok');
    expect(env.auth.signals[0].aborted).toBe(true);
    expect(env.state()).toMatchObject({ phase: 'unlocked', failures: 0 });
  });

  it('the 120 s watchdog aborts a prompt that never answers, and it counts as a failure', async () => {
    const env = await startLocked();
    env.auth.getQueue.push({ kind: 'hangForever' });
    const p = env.ctl.unlock();
    await vi.advanceTimersByTimeAsync(119_999);
    expect(env.state().phase).toBe('unlocking');
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBe('failed');
    expect(env.state()).toMatchObject({ phase: 'locked', failures: 1 });
    expect(env.state().message).toBeTruthy();
    expect(env.auth.signals[0].aborted).toBe(true);
    expect(env.busy.isBusy()).toBe(false);
  });

  it('NotAllowedError counts a failure; "not focused" and AbortError do not; a bad assertion fails', async () => {
    const env = await startLocked();
    env.auth.getQueue.push({ kind: 'reject', name: 'NotAllowedError' });
    expect(await env.ctl.unlock()).toBe('cancelled');
    expect(env.state()).toMatchObject({ phase: 'locked', failures: 1 });
    expect(env.state().message).toBeTruthy();

    env.auth.getQueue.push({ kind: 'reject', name: 'NotAllowedError', message: 'The document is not focused.' });
    expect(await env.ctl.unlock()).toBe('not-focused');
    expect(env.state().failures).toBe(1);

    env.auth.getQueue.push({ kind: 'reject', name: 'AbortError' });
    expect(await env.ctl.unlock()).toBe('cancelled');
    expect(env.state().failures).toBe(1);

    env.auth.getQueue.push({ kind: 'ok', rawId: crypto.getRandomValues(new Uint8Array(16)) });
    expect(await env.ctl.unlock()).toBe('failed');
    env.auth.getQueue.push({ kind: 'ok', flags: 0x19 }); // no UV
    expect(await env.ctl.unlock()).toBe('failed');
    env.auth.getQueue.push({ kind: 'ok', origin: 'https://evil.example' });
    expect(await env.ctl.unlock()).toBe('failed');
    env.auth.getQueue.push({ kind: 'ok', challenge: crypto.getRandomValues(new Uint8Array(32)) });
    expect(await env.ctl.unlock()).toBe('failed');
    expect(env.state()).toMatchObject({ phase: 'locked', failures: 5 });

    // Never an automatic retry.
    const calls = env.auth.gets.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(env.auth.gets).toHaveLength(calls);

    const log = env.ctl.getLockLog().filter((e) => e.event === 'unlock result');
    expect(log[0].detail).toContain('NotAllowedError');
    expect(log[1].detail).toContain('The document is not focused.');
  });

  it('a successful unlock clears failures and the message; a later lock starts counting again', async () => {
    const env = await startLocked();
    env.auth.getQueue.push({ kind: 'reject', name: 'NotAllowedError' }, { kind: 'ok' });
    await env.ctl.unlock();
    expect(env.state().failures).toBe(1);
    expect(await env.ctl.unlock()).toBe('ok');
    expect(env.state()).toMatchObject({ phase: 'unlocked', failures: 0, coldStart: false });
    expect(env.state().message).toBeUndefined();
    env.ctl.lockNow();
    expect(env.state()).toMatchObject({ phase: 'locked', failures: 0, coldStart: false });
    expect(env.html.lock).toBe('locked');
    expect(await env.ctl.unlock({ auto: true })).toBe('cancelled'); // "Lock now" is no automatic opportunity
  });
});

describe('automatic attempts', () => {
  it('only with focus: waits up to 1.5 s, then leaves it to the button', async () => {
    const env = await setup({ focused: false });
    env.ctl.startLock();
    await vi.advanceTimersByTimeAsync(0);
    expect(env.events()).toContain('focus wait');
    await vi.advanceTimersByTimeAsync(1_499);
    expect(env.auth.gets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(env.events()).toContain('focus timeout');
    expect(env.auth.gets).toHaveLength(0);
    expect(env.state()).toMatchObject({ phase: 'locked', failures: 0 });
    env.doc.focused = true;
    expect(await env.ctl.unlock({ auto: true })).toBe('cancelled'); // the opportunity is spent
    expect(env.auth.gets).toHaveLength(0);
  });

  it('focus that arrives in time starts it after a short grace', async () => {
    const env = await setup({ focused: false });
    env.ctl.startLock();
    await vi.advanceTimersByTimeAsync(500);
    env.doc.focused = true;
    env.win.emit('focus');
    await vi.advanceTimersByTimeAsync(299);
    expect(env.auth.gets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(env.auth.gets).toHaveLength(1);
    expect(env.events()).toContain('focus arrived');
  });

  it('a tap during the wait takes over, so only one prompt starts', async () => {
    const env = await setup({ focused: false });
    env.ctl.startLock();
    await vi.advanceTimersByTimeAsync(200);
    env.doc.focused = true;
    env.win.emit('focus');
    env.auth.getQueue.push({ kind: 'ok' });
    const tap = env.ctl.unlock();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await tap).toBe('ok');
    expect(env.auth.gets).toHaveLength(1);
  });

  it('never an automatic retry: after a counted failure no resume prompts again until the button is used', async () => {
    const env = await setup();
    env.auth.getQueue.push({ kind: 'reject', name: 'NotAllowedError' });
    env.ctl.startLock();
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(() => env.state().failures === 1, 'failure');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(env.auth.gets).toHaveLength(1);
    expect(await env.ctl.unlock({ auto: true })).toBe('cancelled');
    expect(env.auth.gets).toHaveLength(1);

    // A trip to Mail for the recovery code and back: no system sheet on return.
    for (let i = 0; i < 3; i++) {
      env.doc.hide();
      await vi.advanceTimersByTimeAsync(5_000);
      env.doc.focused = true;
      env.doc.show();
    }
    expect(env.auth.gets).toHaveLength(1);
    expect(env.state()).toMatchObject({ phase: 'locked', failures: 1 }); // still the same lock screen
    expect(env.events()).toContain('auto skipped');

    // The button still works, and a later lock screen gets its automatic attempts back.
    env.auth.getQueue.push({ kind: 'ok' });
    expect(await env.ctl.unlock()).toBe('ok');
    env.ctl.setIdleMinutes(0);
    env.doc.hide();
    await vi.advanceTimersByTimeAsync(5_000);
    env.doc.focused = true;
    env.doc.show();
    expect(env.auth.gets).toHaveLength(3);
  });

  it('a prompt closed by leaving (not a failure) is offered again on the next resume', async () => {
    const env = await setup();
    env.ctl.startLock();
    await vi.advanceTimersByTimeAsync(0);
    expect(env.auth.gets).toHaveLength(1);
    env.doc.hide();
    await vi.advanceTimersByTimeAsync(5_000);
    env.doc.focused = true;
    env.doc.show();
    expect(env.auth.gets).toHaveLength(2);
    expect(env.state()).toMatchObject({ phase: 'unlocking', failures: 0 });
  });

  it('skips the automatic attempt when the last prompt started under 3 s ago (rapid app switching)', async () => {
    const env = await setup();
    env.ctl.startLock();
    await vi.advanceTimersByTimeAsync(0);
    expect(env.auth.gets).toHaveLength(1);
    env.doc.hide(); // aborts it
    await vi.advanceTimersByTimeAsync(1_000);
    env.doc.focused = true;
    env.doc.show();
    expect(env.auth.gets).toHaveLength(1);
    expect(env.events()).toContain('auto skipped');
  });

  it('pageshow after bfcache offers one attempt even when visibilitychange fires too', async () => {
    const env = await startLocked();
    await vi.advanceTimersByTimeAsync(5_000);
    env.doc.hide();
    env.win.emit('pagehide', { persisted: true });
    env.doc.focused = true;
    env.doc.show();
    env.win.emit('pageshow', { persisted: true });
    expect(env.auth.gets).toHaveLength(1);
  });
});

describe('enable and disable', () => {
  it('enable saves the record only after the test unlock passes, reusing this device user id', async () => {
    const env = await setup({ record: false });
    env.ctl.startLock();
    let open!: () => void;
    env.auth.createQueue.push({ kind: 'gate', open: new Promise<void>((r) => (open = r)) });
    env.auth.getQueue.push({ kind: 'reject', name: 'NotAllowedError' });
    const first = env.ctl.enableLock();
    expect(env.busy.busyReasons()).toEqual(['Face ID setup', 'Face ID setup']);
    open();
    expect(await first).toBe('cancelled');
    expect(env.local.getItem('fb-lock')).toBeNull();
    expect(env.state().phase).toBe('off');
    expect(env.busy.isBusy()).toBe(false);
    const userId = env.local.getItem('fb-lock-user-id');
    expect(userId).toBeTruthy();
    expect(base64urlDecode(userId!)).toHaveLength(32);

    env.auth.getQueue.push({ kind: 'ok' });
    expect(await env.ctl.enableLock()).toBe('ok');
    const saved = JSON.parse(env.local.getItem('fb-lock')!) as LockRecord;
    expect(saved).toMatchObject({ v: 1, rpId: RP, credentialId: base64urlEncode(credId), alg: -7, label: 'Four Burners lock · iPhone' });
    expect(env.state()).toMatchObject({ phase: 'unlocked', coldStart: false, otherHost: false });
    expect(env.auth.creates).toHaveLength(2);
    for (const c of env.auth.creates) expect(base64urlEncode(toBytes(c.publicKey!.user.id))).toBe(userId);
    expect(env.auth.gets.at(-1)!.publicKey!.allowCredentials![0].transports).toEqual(['internal']);
    expect(env.events().filter((e) => e === 'enable result')).toHaveLength(2);
  });

  it('enable: a cancelled create is "cancelled", a bad registration is "failed"', async () => {
    const env = await setup({ record: false });
    env.ctl.startLock();
    env.auth.createQueue.push({ kind: 'reject', name: 'NotAllowedError' }, { kind: 'ok', flags: 0x59 });
    expect(await env.ctl.enableLock()).toBe('cancelled');
    expect(await env.ctl.enableLock()).toBe('failed');
    expect(env.auth.gets).toHaveLength(0);
    expect(env.local.getItem('fb-lock')).toBeNull();
  });

  it('enable waits for focus before the test unlock', async () => {
    const env = await setup({ record: false });
    env.ctl.startLock();
    env.doc.focused = false;
    env.auth.getQueue.push({ kind: 'ok' });
    const p = env.ctl.enableLock();
    await waitFor(() => env.events().includes('focus wait'), 'focus wait');
    expect(env.auth.gets).toHaveLength(0);
    env.doc.focused = true;
    env.win.emit('focus');
    expect(await p).toBe('ok');
    expect(env.auth.gets).toHaveLength(1);
  });

  it('enable: when the test unlock finds no focus, the next tap only runs the test (no second passkey sheet)', async () => {
    const env = await setup({ record: false });
    env.ctl.startLock();
    env.auth.getQueue.push({ kind: 'reject', name: 'NotAllowedError', message: 'The document is not focused.' });
    expect(await env.ctl.enableLock()).toBe('failed');
    expect(env.local.getItem('fb-lock')).toBeNull(); // never saved untested
    expect(env.state().phase).toBe('off');
    expect(env.auth.creates).toHaveLength(1);
    expect(env.events().filter((e) => e === 'enable result').length).toBe(1);

    env.auth.getQueue.push({ kind: 'ok' });
    expect(await env.ctl.enableLock()).toBe('ok');
    expect(env.auth.creates).toHaveLength(1); // the same passkey, tested from the tap
    expect(env.auth.gets).toHaveLength(2);
    expect(JSON.parse(env.local.getItem('fb-lock')!).credentialId).toBe(base64urlEncode(credId));
    expect(env.state().phase).toBe('unlocked');
  });

  it('enable: a kept passkey expires after 5 minutes, and a cancelled test is never kept', async () => {
    const env = await setup({ record: false });
    env.ctl.startLock();
    env.auth.getQueue.push({ kind: 'reject', name: 'NotAllowedError', message: 'The document is not focused.' });
    expect(await env.ctl.enableLock()).toBe('failed');
    vi.setSystemTime(T0 + 5 * MIN);
    env.auth.getQueue.push({ kind: 'reject', name: 'NotAllowedError' });
    expect(await env.ctl.enableLock()).toBe('cancelled');
    expect(env.auth.creates).toHaveLength(2);
    env.auth.getQueue.push({ kind: 'ok' });
    expect(await env.ctl.enableLock()).toBe('ok');
    expect(env.auth.creates).toHaveLength(3);
  });

  it('enable: a reset during the focus wait cancels it and saves nothing', async () => {
    const env = await setup({ record: false });
    env.ctl.startLock();
    env.doc.focused = false;
    env.auth.getQueue.push({ kind: 'ok' });
    const p = env.ctl.enableLock();
    await waitFor(() => env.events().includes('focus wait'), 'focus wait');
    env.ctl.resetLock();
    expect(await p).toBe('cancelled');
    expect(env.auth.gets).toHaveLength(0);
    expect(env.local.getItem('fb-lock')).toBeNull();
    expect(env.state().phase).toBe('off');
    env.doc.focused = true;
    env.auth.getQueue.push({ kind: 'ok' });
    expect(await env.ctl.enableLock()).toBe('ok');
    expect(env.auth.creates).toHaveLength(2); // the reset dropped the untested passkey too
  });

  it('a lock while Disable shows its prompt closes the prompt and cancels the disable', async () => {
    const env = await startUnlocked({ idle: 1 });
    env.auth.getQueue.push({ kind: 'hang' });
    const p = env.ctl.disableLock();
    expect(env.ctl.getLockState().phase).toBe('unlocked');
    await vi.advanceTimersByTimeAsync(70_000); // the foreground idle timer fires under the prompt
    expect(env.state().phase).toBe('locked');
    expect(env.auth.signals[0].aborted).toBe(true);
    expect(await p).toBe('cancelled');
    expect(env.local.getItem('fb-lock')).not.toBeNull();
    expect(env.busy.isBusy()).toBe(false);
  });

  it('enable over a record for another address replaces it', async () => {
    const env = await setup({ record: { ...record, rpId: 'old.example' } });
    env.ctl.startLock();
    env.auth.getQueue.push({ kind: 'ok' });
    expect(await env.ctl.enableLock()).toBe('ok');
    expect(JSON.parse(env.local.getItem('fb-lock')!).rpId).toBe(RP);
    expect(env.state()).toMatchObject({ phase: 'unlocked', otherHost: false });
  });

  it('disable requires a successful ceremony and keeps the user id', async () => {
    const env = await startUnlocked();
    env.local.setItem('fb-lock-user-id', 'keep-me');
    env.auth.getQueue.push({ kind: 'reject', name: 'NotAllowedError' });
    expect(await env.ctl.disableLock()).toBe('cancelled');
    expect(env.local.getItem('fb-lock')).not.toBeNull();
    expect(env.state().phase).toBe('unlocked');

    env.auth.getQueue.push({ kind: 'ok' });
    expect(await env.ctl.disableLock()).toBe('ok');
    expect(env.local.getItem('fb-lock')).toBeNull();
    expect(env.local.getItem('fb-lock-user-id')).toBe('keep-me');
    expect(env.state().phase).toBe('off');
    expect(env.html.lock).toBeUndefined();
    env.doc.hide();
    env.doc.show();
    expect(env.state().phase).toBe('off');
  });
});

describe('recovery and reset', () => {
  it('completeRecovery unlocks and removes the record', async () => {
    const env = await startLocked();
    env.local.setItem('fb-lock-user-id', 'keep-me');
    env.ctl.completeRecovery();
    expect(env.state()).toMatchObject({ phase: 'off', coldStart: false, failures: 0 });
    expect(env.local.getItem('fb-lock')).toBeNull();
    expect(env.local.getItem('fb-lock-user-id')).toBe('keep-me');
    expect(env.html.lock).toBeUndefined();
    expect(await env.ctl.unlock()).toBe('ok');
    expect(env.events()).toContain('recovery');
  });

  it('completeRecovery during a prompt aborts it', async () => {
    const env = await startLocked();
    env.auth.getQueue.push({ kind: 'hang' });
    const p = env.ctl.unlock();
    env.ctl.completeRecovery();
    expect(await p).toBe('cancelled');
    expect(env.state().phase).toBe('off');
  });

  it('resetLock removes the record, keeps fb-lock-user-id, and clears another address too', async () => {
    const env = await startLocked();
    env.local.setItem('fb-lock-user-id', 'keep-me');
    env.ctl.resetLock();
    expect(env.local.getItem('fb-lock')).toBeNull();
    expect(env.local.getItem('fb-lock-user-id')).toBe('keep-me');
    expect(env.state().phase).toBe('off');

    const other = await setup({ record: { ...record, rpId: 'old.example' } });
    other.ctl.startLock();
    expect(other.state().otherHost).toBe(true);
    other.ctl.resetLock();
    expect(other.local.getItem('fb-lock')).toBeNull();
    expect(other.state().otherHost).toBe(false);
  });

  it('lockNow does nothing when the lock is off', async () => {
    const env = await setup({ record: false });
    env.ctl.startLock();
    env.ctl.lockNow();
    expect(env.state().phase).toBe('off');
    expect(env.html.lock).toBeUndefined();
  });
});

describe('environment', () => {
  it.each([
    [IPHONE_UA, 5, 'iphone', 'Four Burners lock · iPhone'],
    [IPAD_UA, 5, 'ipad', 'Four Burners lock · iPad'],
    [MAC_UA, 5, 'ipad', 'Four Burners lock · iPad'], // iPadOS asking for the desktop site
    [MAC_UA, 0, 'mac', 'Four Burners lock · Mac'],
    [WIN_UA, 0, 'other', 'Four Burners lock'],
  ])('detects the device from %s (touch points %i)', async (ua, maxTouchPoints, device, label) => {
    const env = await setup({ record: false, ua, maxTouchPoints });
    env.ctl.startLock();
    expect(env.state()).toMatchObject({ device, label });
  });

  it('asks isUserVerifyingPlatformAuthenticatorAvailable once, as a hint', async () => {
    const check = vi.fn(async () => true);
    const env = await setup({ record: false, publicKeyCredential: { isUserVerifyingPlatformAuthenticatorAvailable: check } });
    expect(env.state().available).toBe('unknown');
    env.ctl.startLock();
    await waitFor(() => env.state().available !== 'unknown', 'availability');
    expect(env.state().available).toBe('yes');
    expect(check).toHaveBeenCalledTimes(1);

    const none = await setup({ record: false });
    none.ctl.startLock();
    expect(none.state().available).toBe('no');
  });

  it('startLock notifies subscribers even when the phase stays off (device and label changed)', async () => {
    const env = await setup({ record: false, ua: MAC_UA, maxTouchPoints: 0 });
    const seen: string[] = [];
    env.ctl.subscribeLock(() => seen.push(env.state().device));
    env.ctl.startLock();
    expect(seen[0]).toBe('mac'); // then 'available' may follow
    expect(env.state()).toMatchObject({ phase: 'off', device: 'mac' });
  });

  it('notifies subscribers with a new state object on every change', async () => {
    const env = await setup();
    const seen: string[] = [];
    const stop = env.ctl.subscribeLock(() => seen.push(env.state().phase));
    const before = env.state();
    env.ctl.startLock();
    expect(env.state()).not.toBe(before);
    expect(seen).toContain('locked');
    stop();
    env.ctl.setIdleMinutes(15);
    expect(env.state().idleMinutes).toBe(15);
    expect(seen.at(-1)).toBe('locked');
  });

  it('keeps the diagnostics log to the last 60 entries', async () => {
    const env = await setup({ record: false });
    env.ctl.startLock();
    for (let i = 0; i < 70; i++) env.ctl.setIdleMinutes(i % 2 ? 1 : 5);
    const log = env.ctl.getLockLog();
    expect(log).toHaveLength(60);
    expect(log.at(-1)).toMatchObject({ event: 'idle setting', at: T0 });
  });
});
