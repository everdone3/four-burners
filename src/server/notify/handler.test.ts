// The notify function end to end, minus the network: an in-memory store stands in for the database, and a
// fake push service decrypts every message the way the browser would (http_ece), so what a device would
// show is exactly what is asserted.
import { createECDH, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_NOTIFY_PREFS, DEFAULT_SETTINGS, type LocalDate, type NotifyData, type NotifyState, type Settings } from '@/domain';
import { createHandler, readConfig, runTick, type HandlerDeps } from './handler';
import type { ClaimField, DataRequest, NotifyStore, SubscriptionRow } from './store';
import { b64urlEncode, generateVapidKeys, type VapidKeys } from './webpush';

const ece = createRequire(import.meta.url)('http_ece') as {
  decrypt(buf: Buffer, params: { version: string; privateKey: unknown; authSecret: Buffer }): Buffer;
};

const U = 'user-1';
const SECRET = 'a'.repeat(64);

interface Device {
  sub: SubscriptionRow;
  open(body: Uint8Array): string;
}

function device(endpoint: string, over: Partial<SubscriptionRow> = {}): Device {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    sub: {
      endpoint,
      user_id: U,
      p256dh: b64urlEncode(ecdh.getPublicKey()),
      auth: b64urlEncode(auth),
      device: 'iPhone',
      time_zone: 'America/Chicago',
      last_seen_at: '2026-10-01T12:00:00Z',
      ...over,
    },
    open: (body) => ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: ecdh, authSecret: auth }).toString('utf8'),
  };
}

class MemoryStore implements NotifyStore {
  subs: (SubscriptionRow & { gone_at?: string; last_sent_at?: string; last_error?: string })[] = [];
  states = new Map<string, NotifyState>();
  settingsValue: unknown = DEFAULT_SETTINGS;
  records: NotifyData = { goals: [], logs: [], energy: [], people: [], touchpoints: [], crunch: [], actions: [], reviews: [] };
  requests: DataRequest[] = [];
  tokens = new Map<string, string>([['good-token', U]]);
  /** Simulates another run claiming first. */
  stolen = new Set<ClaimField>();

  async cronSecretOk(s: string) {
    return s === SECRET;
  }
  async userFromToken(t: string) {
    return this.tokens.get(t) ?? null;
  }
  async subscriptions() {
    return this.subs.filter((s) => !s.gone_at).map((s) => ({ ...s }));
  }
  async state(userId: string) {
    return { ...(this.states.get(userId) ?? {}) };
  }
  async claim(userId: string, field: ClaimField, value: LocalDate) {
    if (this.stolen.has(field)) return false;
    const key = ({ daily_date: 'dailyDate', weekly_week: 'weeklyWeek', nudge_date: 'nudgeDate' } as const)[field];
    const s = this.states.get(userId) ?? {};
    if (s[key] === value) return false;
    this.states.set(userId, { ...s, [key]: value });
    return true;
  }
  async saveNudged(userId: string, nudged: Record<string, LocalDate>) {
    this.states.set(userId, { ...(this.states.get(userId) ?? {}), nudged });
  }
  async settings(_userId?: string) {
    return this.settingsValue;
  }
  async data(_u: string, req: DataRequest) {
    this.requests.push(req);
    return this.records;
  }
  private sub(endpoint: string) {
    return this.subs.find((s) => s.endpoint === endpoint)!;
  }
  async markSent(endpoint: string, at: string) {
    Object.assign(this.sub(endpoint), { last_sent_at: at, last_error: undefined });
  }
  async markError(endpoint: string, reason: string) {
    this.sub(endpoint).last_error = reason;
  }
  async markGone(endpoint: string, at: string) {
    this.sub(endpoint).gone_at = at;
  }
  async pruneGone(before: string) {
    this.subs = this.subs.filter((s) => !s.gone_at || s.gone_at >= before);
  }
}

/** A push service: records what each endpoint received; some endpoints can be set to fail. */
function pushService(devices: Device[]) {
  const inbox = new Map<string, { title: string; body: string; url: string; tag: string }[]>();
  const status = new Map<string, number>();
  const fetchFn = (async (url: string, init: RequestInit) => {
    const d = devices.find((x) => x.sub.endpoint === url);
    if (!d) return new Response('no such endpoint', { status: 404 });
    const s = status.get(url) ?? 201;
    if (s < 300) inbox.set(url, [...(inbox.get(url) ?? []), JSON.parse(d.open(init.body as Uint8Array))]);
    return new Response(s < 300 ? null : 'nope', { status: s });
  }) as unknown as typeof fetch;
  return { fetchFn, inbox, status };
}

let vapid: VapidKeys;
beforeEach(async () => {
  vapid ??= { ...(await generateVapidKeys()), subject: 'mailto:me@example.com' };
});

/** Chicago wall-clock time in daylight time. */
const chicago = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00-05:00`);

function setup(opts: { devices?: Device[]; settings?: Partial<Settings> } = {}) {
  const devices = opts.devices ?? [device('https://web.push.apple.com/one')];
  const store = new MemoryStore();
  store.subs = devices.map((d) => ({ ...d.sub }));
  store.settingsValue = { ...DEFAULT_SETTINGS, ...opts.settings };
  const svc = pushService(devices);
  let now = chicago('2026-10-02', '20:00');
  const deps: HandlerDeps = { store, vapid, fetch: svc.fetchFn, now: () => now };
  return { store, svc, deps, devices, at: (d: Date) => (now = d) };
}

describe('scheduled run', () => {
  it('sends the daily reminder once, to every device, at the time in your zone', async () => {
    const two = [device('https://web.push.apple.com/phone'), device('https://fcm.googleapis.com/mac')];
    const t = setup({ devices: two });
    t.at(chicago('2026-10-02', '19:55'));
    expect((await runTick(t.deps)).sent).toEqual([]);
    t.at(chicago('2026-10-02', '20:00'));
    expect((await runTick(t.deps)).sent).toEqual([{ kind: 'daily', devices: 2, delivered: 2 }]);
    t.at(chicago('2026-10-02', '20:05'));
    expect((await runTick(t.deps)).sent).toEqual([]);
    for (const d of two) {
      expect(t.svc.inbox.get(d.sub.endpoint)).toEqual([{ title: 'Time to check in', body: 'Two taps keeps your burners lit.', url: '/#/', tag: 'daily' }]);
    }
    expect(t.store.subs.every((s) => s.last_sent_at)).toBe(true);
    expect(t.store.states.get(U)?.dailyDate).toBe('2026-10-02');
  });

  it('uses the time zone of the device seen most recently', async () => {
    const t = setup({
      devices: [
        device('https://web.push.apple.com/phone', { time_zone: 'Asia/Tokyo', last_seen_at: '2026-10-02T10:00:00Z' }),
        device('https://web.push.apple.com/ipad', { time_zone: 'America/Chicago', last_seen_at: '2026-09-20T10:00:00Z' }),
      ],
    });
    t.at(new Date('2026-10-02T11:00:00Z')); // 20:00 in Tokyo, 06:00 in Chicago
    expect((await runTick(t.deps)).sent).toEqual([{ kind: 'daily', devices: 2, delivered: 2 }]);
  });

  it('marks the day handled but sends nothing when you already checked in', async () => {
    const t = setup();
    t.store.records.energy = [{ id: 'e', rating: 4, localDate: '2026-10-02', at: '2026-10-02T14:00:00Z', offsetMin: -300, createdAt: 'x', updatedAt: 'x' }];
    expect((await runTick(t.deps)).sent).toEqual([]);
    expect(t.store.states.get(U)?.dailyDate).toBe('2026-10-02');
    expect(t.store.requests[0]).toEqual({ quarterId: '2026-Q4', since: '2025-08-28', reviewWeek: undefined });
  });

  it('never sends twice when another run claimed it first', async () => {
    const t = setup();
    t.store.stolen.add('daily_date');
    expect((await runTick(t.deps)).sent).toEqual([]);
  });

  it('respects quiet hours and settings that turn reminders off', async () => {
    const t = setup({ settings: { notify: { ...DEFAULT_NOTIFY_PREFS, quiet: { on: true, start: '19:30', end: '07:00' } } } });
    expect((await runTick(t.deps)).sent).toEqual([]);
    expect(t.store.requests).toEqual([]); // nothing due: no data was even loaded
    const off = setup({ settings: { notify: { ...DEFAULT_NOTIFY_PREFS, daily: { on: false, time: '20:00' } } } });
    expect((await runTick(off.deps)).sent).toEqual([]);
  });

  it('sends the weekly review reminder on review day, unless the review is done', async () => {
    const t = setup();
    t.at(chicago('2026-10-04', '17:00')); // Sunday
    expect((await runTick(t.deps)).sent).toEqual([{ kind: 'weekly', devices: 1, delivered: 1 }]);
    expect(t.store.requests.at(-1)?.reviewWeek).toBe('2026-09-28');

    const done = setup();
    done.store.records.reviews = [
      { id: 'review-2026-09-28', weekStart: '2026-09-28', step: 6, wins: [], misses: [], focus: '', focusBurners: [], completedAt: 'x', createdAt: 'x', updatedAt: 'x' },
    ];
    done.at(chicago('2026-10-04', '17:00'));
    expect((await runTick(done.deps)).sent).toEqual([]);
    expect(done.store.states.get(U)?.weeklyWeek).toBe('2026-09-28');
  });

  it('sends at most one nudge a day and remembers it for the cooldown', async () => {
    const t = setup();
    t.store.records.people = [{ id: 'sam', name: 'Sam', burner: 'friends', cadenceDays: 7, order: 0, createdAt: '2026-08-01T00:00:00Z', updatedAt: 'x' }];
    t.at(chicago('2026-10-02', '11:00'));
    expect((await runTick(t.deps)).sent).toEqual([{ kind: 'nudge', devices: 1, delivered: 1 }]);
    expect(t.svc.inbox.get(t.devices[0].sub.endpoint)?.[0]).toMatchObject({ title: 'Reach out to Sam?', url: '/#/burner/friends', tag: 'nudge' });
    expect(t.store.states.get(U)).toMatchObject({ nudgeDate: '2026-10-02', nudged: { 'person:sam': '2026-10-02' } });
    t.at(chicago('2026-10-02', '15:00'));
    expect((await runTick(t.deps)).sent).toEqual([]);
    // Next day: Sam is resting (cooldown), so no nudge, but the day is still marked as considered.
    t.at(chicago('2026-10-03', '11:00'));
    expect((await runTick(t.deps)).sent).toEqual([]);
    expect(t.store.states.get(U)?.nudgeDate).toBe('2026-10-03');
  });

  it('stops sending to a subscription the push service dropped, and records other failures', async () => {
    const devices = [device('https://web.push.apple.com/gone'), device('https://web.push.apple.com/broken'), device('https://web.push.apple.com/fine')];
    const t = setup({ devices });
    t.svc.status.set(devices[0].sub.endpoint, 410);
    t.svc.status.set(devices[1].sub.endpoint, 403);
    expect((await runTick(t.deps)).sent).toEqual([{ kind: 'daily', devices: 3, delivered: 1 }]);
    const [gone, broken, fine] = t.store.subs;
    expect(gone.gone_at).toBeTruthy();
    expect(broken.last_error).toBe('403: nope');
    expect(fine.last_sent_at).toBeTruthy();
    // Weeks later the gone row is deleted for good.
    t.at(chicago('2026-11-15', '20:00'));
    await runTick(t.deps);
    expect(t.store.subs.map((s) => s.endpoint)).not.toContain(devices[0].sub.endpoint);
  });

  it('one account failing does not stop the others', async () => {
    const t = setup({ devices: [device('https://web.push.apple.com/a'), device('https://web.push.apple.com/b', { user_id: 'user-2' })] });
    const orig = t.store.settings.bind(t.store);
    t.store.settings = async (u: string) => {
      if (u === U) throw new Error('boom');
      return orig();
    };
    const out = await runTick(t.deps);
    expect(out.errors).toBe(1);
    expect(out.sent).toEqual([{ kind: 'daily', devices: 1, delivered: 1 }]);
  });
});

describe('requests', () => {
  const post = (headers: Record<string, string>, body?: unknown) =>
    new Request('https://x.supabase.co/functions/v1/notify', { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });

  it('runs the schedule only with the right secret', async () => {
    const t = setup();
    const h = createHandler(t.deps);
    expect((await h(post({ 'x-notify-secret': 'wrong' }))).status).toBe(401);
    expect(t.svc.inbox.size).toBe(0);
    const res = await h(post({ 'x-notify-secret': SECRET }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accounts: 1, errors: 0, sent: [{ kind: 'daily', devices: 1, delivered: 1 }] });
  });

  it('sends a test only to the signed-in user’s own device', async () => {
    const mine = device('https://web.push.apple.com/mine');
    const theirs = device('https://web.push.apple.com/theirs', { user_id: 'user-2' });
    const t = setup({ devices: [mine, theirs] });
    const h = createHandler(t.deps);
    expect((await h(post({ authorization: 'Bearer bad-token' }, { action: 'test', endpoint: mine.sub.endpoint }))).status).toBe(401);
    expect((await h(post({}, { action: 'test', endpoint: mine.sub.endpoint }))).status).toBe(401);
    expect((await h(post({ authorization: 'Bearer good-token' }, { action: 'test', endpoint: theirs.sub.endpoint }))).status).toBe(404);
    expect((await h(post({ authorization: 'Bearer good-token' }, { action: 'nope' }))).status).toBe(400);
    const res = await h(post({ authorization: 'Bearer good-token' }, { action: 'test', endpoint: mine.sub.endpoint }));
    expect(await res.json()).toEqual({ endpoint: mine.sub.endpoint, ok: true, status: 201 });
    expect(t.svc.inbox.get(mine.sub.endpoint)).toEqual([{ title: 'Four Burners', body: 'Notifications work on this device.', url: '/#/settings', tag: 'test' }]);
    expect(t.svc.inbox.get(theirs.sub.endpoint)).toBeUndefined();
  });

  it('answers CORS preflight and refuses other methods', async () => {
    const h = createHandler(setup().deps);
    const pre = await h(new Request('https://x/notify', { method: 'OPTIONS' }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toMatch(/authorization/);
    expect((await h(new Request('https://x/notify'))).status).toBe(405);
  });

  it('hides internal errors', async () => {
    const t = setup();
    t.store.cronSecretOk = async () => {
      throw new Error('db password is hunter2');
    };
    const res = await createHandler(t.deps)(post({ 'x-notify-secret': SECRET }));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toMatch(/hunter2/);
  });
});

describe('configuration', () => {
  const envOf = (vars: Record<string, string>) => (n: string) => vars[n];
  const vapidVars = { VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 'k', VAPID_SUBJECT: 'mailto:a@b.c' };

  it('names whatever is missing', () => {
    expect(readConfig(envOf({}))).toEqual({
      ok: false,
      missing: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'],
    });
  });

  it('prefers the default secret key, falling back to the legacy service role key', () => {
    expect(readConfig(envOf({ SUPABASE_URL: 'u', SUPABASE_SERVICE_ROLE_KEY: 'eyJx', SUPABASE_SECRET_KEYS: '{"default":"sb_secret_1"}', ...vapidVars }))).toMatchObject({ ok: true, serviceKey: 'sb_secret_1' });
    expect(readConfig(envOf({ SUPABASE_URL: 'u', SUPABASE_SERVICE_ROLE_KEY: 'eyJx', ...vapidVars }))).toMatchObject({ ok: true, serviceKey: 'eyJx' });
    expect(readConfig(envOf({ SUPABASE_URL: 'u', SUPABASE_SECRET_KEYS: '{"default":"sb_secret_1"}', ...vapidVars }))).toMatchObject({ ok: true, serviceKey: 'sb_secret_1' });
    expect(readConfig(envOf({ SUPABASE_URL: 'u', SUPABASE_SECRET_KEYS: 'garbage', ...vapidVars }))).toMatchObject({ ok: false, missing: ['SUPABASE_SERVICE_ROLE_KEY'] });
  });
});
