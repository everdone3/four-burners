// The calendar Edge Function: fetch a calendar feed (ICS) for the signed-in app and return the events near
// today. Browsers can't fetch most calendar feeds themselves (no CORS), so this is a pass-through: the feed
// address arrives with each request and is never stored, logged or kept; the feed itself is parsed and dropped.
//
// POST with the user's sign-in token, body {url, today, offsetMin}. Answers
//   {ok: true, name?, events: CalEvent[], skippedRecurring} or {ok: false, code, message}.
// Only https feeds on public host names, on the standard port, are fetched: no IP literals or internal names,
// and the name must resolve to public addresses only (all re-checked on every redirect). At most 5 MB, 15 s.
import { addDays, isPrivateAddress, isPublicFeedHost, normalizeFeedUrl, parseIcs } from '@/domain';

export interface CalendarDeps {
  /** The signed-in user behind an access token, or null. */
  userFromToken(token: string): Promise<string | null>;
  fetch: typeof fetch;
  /**
   * The addresses a host name resolves to (A and AAAA); each must be public before it is fetched. null when
   * the runtime can't look names up: then only the name checks apply.
   */
  resolve?: (hostname: string) => Promise<string[] | null>;
  now: () => Date;
  log?: (msg: string) => void;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export type FeedErrorCode = 'bad_url' | 'refused' | 'not_found' | 'not_calendar' | 'too_large' | 'unavailable';

export const FEED_MESSAGES: Record<FeedErrorCode, string> = {
  bad_url: "That doesn't look like a calendar link. Use the https or webcal address from your calendar's sharing settings.",
  refused: 'The calendar refused that link. It may have been reset: copy a fresh one.',
  not_found: 'No calendar at that link. It may have been reset or unshared: copy a fresh one.',
  not_calendar: "That link didn't return a calendar file (ICS).",
  too_large: 'That calendar is too large to read (over 5 MB).',
  unavailable: "Couldn't reach the calendar right now. It will try again later.",
};

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15_000;
/** Events this far back and ahead of today come back (a trip under way, and the next couple of months). */
const WINDOW = { back: 7, ahead: 60 };

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
const fail = (code: FeedErrorCode) => reply(200, { ok: false, code, message: FEED_MESSAGES[code] });

async function readCapped(res: Response): Promise<string | 'too_large'> {
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_BYTES) return 'too_large';
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return 'too_large';
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  return new TextDecoder().decode(all);
}

/** Whether a host is safe to fetch: a public name on port 443 whose addresses are all public. */
async function safeHost(u: URL, resolve?: (h: string) => Promise<string[] | null>): Promise<boolean> {
  if (u.protocol !== 'https:' || (u.port && u.port !== '443') || !isPublicFeedHost(u.hostname)) return false;
  if (!resolve) return true;
  const addrs = await resolve(u.hostname).catch(() => null);
  return addrs === null || !addrs.some(isPrivateAddress);
}

/** Fetch the feed text, following up to 3 redirects, each re-checked. */
export async function fetchFeed(
  url: string,
  fetchFn: typeof fetch,
  resolve?: (hostname: string) => Promise<string[] | null>,
): Promise<{ ok: true; text: string } | { ok: false; code: FeedErrorCode }> {
  let next = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let u: URL;
    try {
      u = new URL(next);
    } catch {
      return { ok: false, code: 'bad_url' };
    }
    if (!(await safeHost(u, resolve))) return { ok: false, code: 'bad_url' };
    let res: Response;
    try {
      res = await fetchFn(u.toString(), {
        redirect: 'manual',
        headers: { Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5', 'User-Agent': 'FourBurners/1 (calendar feed)' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return { ok: false, code: 'unavailable' };
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { ok: false, code: 'unavailable' };
      let target: string | null = null;
      try {
        target = normalizeFeedUrl(new URL(loc, u).toString());
      } catch {
        // malformed Location
      }
      if (!target) return { ok: false, code: 'bad_url' };
      next = target;
      continue;
    }
    if (res.status === 401 || res.status === 403) return { ok: false, code: 'refused' };
    if (res.status === 404 || res.status === 410) return { ok: false, code: 'not_found' };
    if (!res.ok) return { ok: false, code: 'unavailable' };
    let text: string | 'too_large';
    try {
      text = await readCapped(res);
    } catch {
      return { ok: false, code: 'unavailable' };
    }
    if (text === 'too_large') return { ok: false, code: 'too_large' };
    if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 4096))) return { ok: false, code: 'not_calendar' };
    return { ok: true, text };
  }
  return { ok: false, code: 'unavailable' };
}

export function createCalendarHandler(deps: CalendarDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return reply(405, { ok: false, message: 'POST only' });
    try {
      const token = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
      const userId = token ? await deps.userFromToken(token) : null;
      if (!userId) return reply(401, { ok: false, message: 'Sign in required' });
      const body = (await req.json().catch(() => ({}))) as { url?: unknown; today?: unknown; offsetMin?: unknown; dayBoundaryHour?: unknown };
      const url = normalizeFeedUrl(body.url);
      if (!url) return fail('bad_url');
      const now = deps.now();
      const offsetMin = typeof body.offsetMin === 'number' && Math.abs(body.offsetMin) <= 14 * 60 ? Math.round(body.offsetMin) : 0;
      const today = typeof body.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.today) ? body.today : now.toISOString().slice(0, 10);
      const boundary = typeof body.dayBoundaryHour === 'number' && Number.isInteger(body.dayBoundaryHour) && body.dayBoundaryHour >= 0 && body.dayBoundaryHour <= 23 ? body.dayBoundaryHour : 0;
      const feed = await fetchFeed(url, deps.fetch, deps.resolve);
      if (!feed.ok) return fail(feed.code);
      const parsed = parseIcs(feed.text, { from: addDays(today, -WINDOW.back), to: addDays(today, WINDOW.ahead) }, offsetMin, boundary);
      return reply(200, { ok: true, ...parsed });
    } catch (e) {
      // Never log the request: the feed address is a secret.
      deps.log?.(`calendar request failed: ${e instanceof Error ? e.name : 'error'}`);
      return reply(500, { ok: false, message: 'Server error' });
    }
  };
}
