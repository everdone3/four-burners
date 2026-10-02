// This device's push subscription, against a fake browser (PushManager, permission) and a fake server.
import { describe, expect, it } from 'vitest';
import { BEAT_INTERVAL_MS, availability, disableDevice, enableDevice, refreshDevice, sendTest, testFailure, type PushEnv } from './push';
import { b64urlDecode, b64urlEncode } from '@/server/notify/webpush';

const KEY = b64urlEncode(new Uint8Array(65).fill(4));
const OLD_KEY = b64urlEncode(new Uint8Array(65).fill(9));

class FakeSub {
  constructor(
    readonly endpoint: string,
    readonly options: { applicationServerKey: ArrayBuffer | null },
    private readonly mgr: FakeManager,
  ) {}
  toJSON() {
    return { endpoint: this.endpoint, keys: { p256dh: 'P'.repeat(87), auth: 'A'.repeat(22) } };
  }
  async unsubscribe() {
    if (this.mgr.current === this) this.mgr.current = null;
    return true;
  }
}

class FakeManager {
  current: FakeSub | null = null;
  n = 0;
  failSubscribe = false;
  async getSubscription() {
    return this.current as unknown as PushSubscription | null;
  }
  async subscribe(opts: PushSubscriptionOptionsInit) {
    if (this.failSubscribe) throw new DOMException('Not allowed', 'NotAllowedError');
    const key = opts.applicationServerKey as Uint8Array;
    this.current = new FakeSub(`https://web.push.apple.com/sub${++this.n}`, { applicationServerKey: key.slice().buffer }, this);
    return this.current as unknown as PushSubscription;
  }
  /** An existing subscription, e.g. from before (optionally made with another key). */
  existing(key = KEY) {
    this.current = new FakeSub(`https://web.push.apple.com/old${++this.n}`, { applicationServerKey: b64urlDecode(key).buffer }, this);
    return this.current;
  }
}

function setup(over: Partial<PushEnv> = {}) {
  const mgr = new FakeManager();
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const store = new Map<string, string>();
  let perm: NotificationPermission | 'unsupported' = 'default';
  let clock = 1_000_000;
  let tz = 'America/Chicago';
  let serverStatus: Record<string, unknown> = { last_sent_at: null, last_error: null, last_error_at: null, gone: false };
  let rpcFails = false;
  /** Endpoints the server reports as dropped by the push service. */
  const gone = new Set<string>();
  const env: PushEnv = {
    vapidKey: KEY,
    syncConfigured: true,
    signedIn: () => true,
    registration: async () => ({ pushManager: mgr as unknown as PushManager }),
    permission: () => perm,
    requestPermission: async () => (perm = 'granted'),
    isIosBrowserTab: () => false,
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      if (rpcFails) throw new Error('Failed to fetch');
      return fn === 'push_subscribe' ? { ...serverStatus, gone: gone.has(args.p_endpoint as string) } : true;
    },
    invokeNotify: async () => ({ ok: true, status: 201 }),
    timeZone: () => tz,
    device: () => 'iPhone',
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) },
    now: () => clock,
    ...over,
  };
  return {
    env,
    mgr,
    calls,
    setPerm: (p: typeof perm) => (perm = p),
    tick: (ms: number) => (clock += ms),
    setTz: (z: string) => (tz = z),
    setServer: (s: Record<string, unknown>) => (serverStatus = { ...serverStatus, ...s }),
    setRpcFails: (v: boolean) => (rpcFails = v),
    markGone: (endpoint: string) => gone.add(endpoint),
  };
}

describe('availability', () => {
  it('explains what is missing, most fundamental first', async () => {
    expect((await availability(setup({ vapidKey: null }).env)).availability).toBe('unconfigured');
    expect((await availability(setup({ syncConfigured: false }).env)).availability).toBe('unconfigured');
    const tab = setup({ isIosBrowserTab: () => true });
    tab.setPerm('unsupported');
    expect((await availability(tab.env)).availability).toBe('needsInstall');
    const old = setup();
    old.setPerm('unsupported');
    expect((await availability(old.env)).availability).toBe('unsupported');
    expect((await availability(setup({ registration: async () => undefined }).env)).availability).toBe('unsupported');
    expect((await availability(setup({ signedIn: () => false }).env)).availability).toBe('signedOut');
    const denied = setup();
    denied.setPerm('denied');
    expect((await availability(denied.env)).availability).toBe('denied');
    expect((await availability(setup().env)).availability).toBe('ready');
  });
});

describe('turning on', () => {
  it('asks permission, subscribes with the app key, and tells the server device and time zone', async () => {
    const t = setup();
    const out = await enableDevice(t.env);
    expect(out.result).toBe('ok');
    expect(out.state).toMatchObject({ subscribed: true, endpoint: 'https://web.push.apple.com/sub1' });
    expect(new Uint8Array(t.mgr.current!.options.applicationServerKey!)).toEqual(b64urlDecode(KEY));
    expect(t.calls).toEqual([
      {
        fn: 'push_subscribe',
        args: { p_endpoint: 'https://web.push.apple.com/sub1', p_p256dh: 'P'.repeat(87), p_auth: 'A'.repeat(22), p_device: 'iPhone', p_time_zone: 'America/Chicago' },
      },
    ]);
  });

  it('stops when permission is refused', async () => {
    const t = setup({ requestPermission: async () => 'denied' });
    expect((await enableDevice(t.env)).result).toBe('denied');
    expect(t.mgr.current).toBeNull();
    expect(t.calls).toEqual([]);
  });

  it('replaces a subscription made with an older key', async () => {
    const t = setup();
    t.setPerm('granted');
    t.mgr.existing(OLD_KEY);
    await enableDevice(t.env);
    expect(t.mgr.current!.endpoint).toBe('https://web.push.apple.com/sub2');
  });

  it('renews a subscription the server says is gone', async () => {
    const t = setup();
    t.markGone('https://web.push.apple.com/sub1');
    const out = await enableDevice(t.env);
    expect(out.result).toBe('ok');
    expect(t.calls.map((c) => c.args.p_endpoint)).toEqual(['https://web.push.apple.com/sub1', 'https://web.push.apple.com/sub2']);
  });

  it('reports a failure when the server cannot be reached', async () => {
    const t = setup();
    t.setRpcFails(true);
    expect((await enableDevice(t.env)).result).toBe('failed');
  });
});

describe('refreshing on app open', () => {
  async function onDevice() {
    const t = setup();
    await enableDevice(t.env);
    t.calls.length = 0;
    return t;
  }

  it('refreshes at most every 30 minutes, at once when the time zone changes', async () => {
    const t = await onDevice();
    expect(await refreshDevice(t.env)).toMatchObject({ subscribed: true, availability: 'ready' });
    expect(t.calls).toEqual([]);
    t.setTz('Asia/Tokyo');
    await refreshDevice(t.env);
    expect(t.calls.map((c) => c.args.p_time_zone)).toEqual(['Asia/Tokyo']);
    await refreshDevice(t.env);
    expect(t.calls).toHaveLength(1);
    t.tick(BEAT_INTERVAL_MS);
    await refreshDevice(t.env);
    expect(t.calls).toHaveLength(2);
    await refreshDevice(t.env, { force: true });
    expect(t.calls).toHaveLength(3);
  });

  it('shows what the server last recorded', async () => {
    const t = await onDevice();
    t.setServer({ last_sent_at: '2026-10-02T01:00:00Z', last_error: '403: BadJwtToken', last_error_at: '2026-10-02T02:00:00Z' });
    expect((await refreshDevice(t.env, { force: true })).server).toEqual({
      lastSentAt: '2026-10-02T01:00:00Z',
      lastError: '403: BadJwtToken',
      lastErrorAt: '2026-10-02T02:00:00Z',
      gone: false,
    });
  });

  it('quietly renews a dropped subscription and tells the server to forget the old one', async () => {
    const t = await onDevice();
    t.markGone('https://web.push.apple.com/sub1');
    const s = await refreshDevice(t.env, { force: true });
    expect(s).toMatchObject({ subscribed: true, endpoint: 'https://web.push.apple.com/sub2' });
    expect(t.calls.map((c) => c.fn)).toEqual(['push_subscribe', 'push_subscribe', 'push_unsubscribe']);
    expect(t.calls[2].args).toEqual({ p_endpoint: 'https://web.push.apple.com/sub1' });
  });

  it('asks you to turn it on again when the browser will not renew without a tap', async () => {
    const t = await onDevice();
    t.markGone('https://web.push.apple.com/sub1');
    t.mgr.failSubscribe = true;
    expect(await refreshDevice(t.env, { force: true })).toMatchObject({ subscribed: false, server: { gone: true } });
  });

  it('a renewal is also triggered by a new app key', async () => {
    const t = setup();
    t.setPerm('granted');
    t.mgr.existing(OLD_KEY);
    const s = await refreshDevice(t.env);
    expect(s.endpoint).toBe('https://web.push.apple.com/sub2');
  });

  it('offline: still subscribed, nothing breaks', async () => {
    const t = await onDevice();
    t.setRpcFails(true);
    expect(await refreshDevice(t.env, { force: true })).toMatchObject({ subscribed: true, endpoint: 'https://web.push.apple.com/sub1' });
  });

  it('never subscribes on its own', async () => {
    const t = setup();
    t.setPerm('granted');
    expect(await refreshDevice(t.env, { force: true })).toMatchObject({ subscribed: false });
    expect(t.mgr.current).toBeNull();
  });

  it('signed out: reports it, keeps the subscription, calls nothing', async () => {
    const t = await onDevice();
    const s = await refreshDevice({ ...t.env, signedIn: () => false }, { force: true });
    expect(s).toMatchObject({ availability: 'signedOut', subscribed: true });
    expect(t.calls).toEqual([]);
  });
});

describe('turning off', () => {
  it('the server forgets the device and the browser drops it, even offline', async () => {
    const t = setup();
    await enableDevice(t.env);
    t.setRpcFails(true);
    await disableDevice(t.env);
    expect(t.mgr.current).toBeNull();
    expect(t.calls.at(-1)).toEqual({ fn: 'push_unsubscribe', args: { p_endpoint: 'https://web.push.apple.com/sub1' } });
  });
});

describe('test notification', () => {
  it('needs a subscription, then reports what happened in plain words', async () => {
    const t = setup();
    expect(await sendTest(t.env)).toEqual({ ok: false, message: 'Turn notifications on first.' });
    await enableDevice(t.env);
    expect(await sendTest(t.env)).toEqual({ ok: true });
    expect(await sendTest({ ...t.env, invokeNotify: async () => ({ ok: false, status: 410 }) })).toEqual({ ok: false, message: testFailure(410) });
    const lost = await sendTest({ ...t.env, invokeNotify: async () => Promise.reject(new Error('This device is not subscribed.')) });
    expect(lost).toMatchObject({ ok: false, message: expect.stringMatching(/lost this device/) });
    const down = await sendTest({ ...t.env, invokeNotify: async () => Promise.reject(new Error('Failed to send a request')) });
    expect(down).toMatchObject({ ok: false, message: expect.stringMatching(/Couldn't reach/) });
    for (const s of [401, 403, 500, undefined]) expect(testFailure(s)).not.toMatch(/—/);
  });
});
