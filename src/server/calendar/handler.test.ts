import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bundleFunction, outputOf } from '../../../scripts/build-functions.mjs';
import { createCalendarHandler, fetchFeed, FEED_MESSAGES } from './handler';

const ICS = [
  'BEGIN:VCALENDAR',
  'X-WR-CALNAME:Travel',
  'BEGIN:VEVENT',
  'SUMMARY:Denver trip',
  'DTSTART;VALUE=DATE:20261005',
  'DTEND;VALUE=DATE:20261009',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:Last year',
  'DTSTART;VALUE=DATE:20251005',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;
function net(route: Route) {
  const calls: string[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push(url);
    return route(url, init);
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const handler = (fetchFn: typeof fetch) =>
  createCalendarHandler({ userFromToken: async (t) => (t === 'good' ? 'u1' : null), fetch: fetchFn, now: () => new Date('2026-10-06T12:00:00Z') });
const post = (body: unknown, token = 'good') =>
  new Request('https://p.supabase.co/functions/v1/calendar', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

describe('fetchFeed', () => {
  it('returns the calendar text', async () => {
    const n = net(() => new Response(ICS));
    expect(await fetchFeed('https://calendar.example.com/a.ics', n.fetchFn)).toEqual({ ok: true, text: ICS });
  });

  it('follows a few redirects, re-checking each one', async () => {
    const ok = net((u) => (u.includes('/old') ? new Response(null, { status: 302, headers: { location: '/new.ics' } }) : new Response(ICS)));
    expect((await fetchFeed('https://calendar.example.com/old', ok.fetchFn)).ok).toBe(true);
    expect(ok.calls).toEqual(['https://calendar.example.com/old', 'https://calendar.example.com/new.ics']);

    const sneaky = net(() => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }));
    expect(await fetchFeed('https://calendar.example.com/a.ics', sneaky.fetchFn)).toEqual({ ok: false, code: 'bad_url' });
    expect(sneaky.calls).toHaveLength(1);

    const internal = net(() => new Response(null, { status: 301, headers: { location: 'https://localhost/x' } }));
    expect(await fetchFeed('https://calendar.example.com/a.ics', internal.fetchFn)).toEqual({ ok: false, code: 'bad_url' });

    const loop = net(() => new Response(null, { status: 302, headers: { location: '/again' } }));
    expect(await fetchFeed('https://calendar.example.com/a.ics', loop.fetchFn)).toEqual({ ok: false, code: 'unavailable' });
    expect(loop.calls).toHaveLength(4);
  });

  it('refuses names that resolve to private addresses, and non-standard ports', async () => {
    const n = net(() => new Response(ICS));
    const resolve = async (h: string) => (h === 'evil.example.com' ? ['127.0.0.1'] : ['93.184.216.34']);
    expect(await fetchFeed('https://evil.example.com/a.ics', n.fetchFn, resolve)).toEqual({ ok: false, code: 'bad_url' });
    expect(await fetchFeed('https://c.example.com:8443/a.ics', n.fetchFn, resolve)).toEqual({ ok: false, code: 'bad_url' });
    expect(n.calls).toEqual([]);
    const hop = net((u) => (u.includes('c.example') ? new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x' } }) : new Response(ICS)));
    expect(await fetchFeed('https://c.example.com/a.ics', hop.fetchFn, resolve)).toEqual({ ok: false, code: 'bad_url' });
    expect(hop.calls).toEqual(['https://c.example.com/a.ics']);
    expect((await fetchFeed('https://c.example.com/a.ics', n.fetchFn, resolve)).ok).toBe(true);
    // A runtime that can't look names up falls back to the name checks.
    expect((await fetchFeed('https://c.example.com/a.ics', n.fetchFn, async () => null)).ok).toBe(true);
  });

  it('a malformed redirect is a refusal, not a crash', async () => {
    const n = net(() => new Response(null, { status: 302, headers: { location: 'https://[bad' } }));
    expect(await fetchFeed('https://c.example.com/a.ics', n.fetchFn)).toEqual({ ok: false, code: 'bad_url' });
  });

  it('never fetches an internal address in the first place', async () => {
    const n = net(() => new Response(ICS));
    for (const u of ['https://127.0.0.1/a.ics', 'https://10.1.2.3/a', 'https://localhost/a', 'https://db.internal/a']) {
      expect(await fetchFeed(u, n.fetchFn)).toEqual({ ok: false, code: 'bad_url' });
    }
    expect(n.calls).toEqual([]);
  });

  it('maps failures to plain codes', async () => {
    const status = (s: number) => net(() => new Response('x', { status: s })).fetchFn;
    expect(await fetchFeed('https://c.example.com/a', status(403))).toEqual({ ok: false, code: 'refused' });
    expect(await fetchFeed('https://c.example.com/a', status(404))).toEqual({ ok: false, code: 'not_found' });
    expect(await fetchFeed('https://c.example.com/a', status(503))).toEqual({ ok: false, code: 'unavailable' });
    expect(await fetchFeed('https://c.example.com/a', net(() => new Response('<html>login</html>')).fetchFn)).toEqual({ ok: false, code: 'not_calendar' });
    const down = net(() => Promise.reject(new TypeError('fetch failed')));
    expect(await fetchFeed('https://c.example.com/a', down.fetchFn)).toEqual({ ok: false, code: 'unavailable' });
  });

  it('stops reading past 5 MB, whether or not the size is declared', async () => {
    const declared = net(() => new Response('BEGIN:VCALENDAR', { headers: { 'content-length': String(6 * 1024 * 1024) } }));
    expect(await fetchFeed('https://c.example.com/a', declared.fetchFn)).toEqual({ ok: false, code: 'too_large' });
    const chunk = new Uint8Array(1024 * 1024).fill(65);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ < 8) c.enqueue(chunk);
        else c.close();
      },
    });
    const undeclared = net(() => new Response(stream));
    expect(await fetchFeed('https://c.example.com/a', undeclared.fetchFn)).toEqual({ ok: false, code: 'too_large' });
    expect(sent).toBeLessThanOrEqual(7);
  });
});

describe('calendar handler', () => {
  it('needs a sign-in', async () => {
    const n = net(() => new Response(ICS));
    expect((await handler(n.fetchFn)(post({ url: 'https://c.example.com/a' }, 'bad'))).status).toBe(401);
    expect(n.calls).toEqual([]);
  });

  it('returns the events near today, shifted to the device offset', async () => {
    const n = net(() => new Response(ICS));
    const res = await handler(n.fetchFn)(post({ url: 'webcal://c.example.com/a.ics', today: '2026-10-06', offsetMin: -300 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      name: 'Travel',
      events: [{ summary: 'Denver trip', start: '2026-10-05', end: '2026-10-08', allDay: true, free: false }],
      skippedRecurring: 0,
    });
    expect(n.calls).toEqual(['https://c.example.com/a.ics']);
  });

  it('explains problems in plain words, without em dashes', async () => {
    const n = net(() => new Response('nope', { status: 404 }));
    const bad = await (await handler(n.fetchFn)(post({ url: 'http://c.example.com/a' }))).json();
    expect(bad).toEqual({ ok: false, code: 'bad_url', message: FEED_MESSAGES.bad_url });
    expect((await (await handler(n.fetchFn)(post({ url: 'https://c.example.com/a' }))).json()).code).toBe('not_found');
    for (const m of Object.values(FEED_MESSAGES)) expect(m).not.toMatch(/—/);
  });

  it('answers CORS preflight', async () => {
    const res = await handler(net(() => new Response()).fetchFn)(new Request('https://x/calendar', { method: 'OPTIONS' }));
    expect(res.status).toBe(204);
  });
});

describe('calendar bundle', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is up to date (run `npm run build:functions`)', async () => {
    expect(readFileSync(outputOf('calendar'), 'utf8').replace(/\r\n/g, '\n') === (await bundleFunction('calendar'))).toBe(true);
  }, 30_000);

  it('boots in a Deno-like runtime and checks the sign-in with the Auth server', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'fb-cal-')), 'index.mjs');
    writeFileSync(file, readFileSync(outputOf('calendar'), 'utf8'));
    let h: ((r: Request) => Promise<Response>) | undefined;
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (u: string) => {
      urls.push(u);
      return new Response('{}', { status: 401 });
    });
    vi.stubGlobal('Deno', {
      env: { get: (n: string) => ({ SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SECRET_KEYS: '{"default":"sb_secret_x"}' })[n] },
      serve: (fn: typeof h) => (h = fn),
    });
    await import(/* @vite-ignore */ pathToFileURL(file).href);
    const res = await h!(post({ url: 'https://c.example.com/a' }, 'tok'));
    expect(res.status).toBe(401);
    expect(urls).toEqual(['https://p.supabase.co/auth/v1/user']);
    const src = readFileSync(outputOf('calendar'), 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
  });
});
