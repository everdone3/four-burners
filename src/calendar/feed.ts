// Calendar-aware crunch mode, on this device: the feed address, the last result, and "not this time".
// All three live in device-local kv keys: never synced, never in backups. The address is a secret (anyone
// with it can read the calendar), so it stays on this device and only travels, per check, to your own
// calendar Edge Function, which reads the feed and keeps nothing.
// Fully optional: with no address saved, nothing here runs.
import { useLiveQuery } from 'dexie-react-hooks';
import { deviceOffsetMin, normalizeFeedUrl, type CalEvent } from '@/domain';
import { db, type KV } from '@/data/db';
import { currentToday, getSettings, startCrunch } from '@/data/repo';
import { nextUpdatedAt } from '@/data/stamp';
import { getClient } from '@/sync/client';
import { getSyncStatus } from '@/sync/manager';
import type { CrunchSuggestion } from '@/domain';

export const CALENDAR_FEED_KEY = 'calendarFeed';
export const CALENDAR_CACHE_KEY = 'calendarCache';
export const CALENDAR_DISMISSED_KEY = 'calendarDismissed';

/** Checked at most this often on its own (opening Home). "Check now" in Settings always checks. */
export const CALENDAR_REFRESH_MS = 6 * 60 * 60_000;
/** After a failed check (offline, server asleep), try again sooner. */
export const CALENDAR_RETRY_MS = 30 * 60_000;

export interface CalendarFeed {
  url: string;
  savedAt: string;
}

export interface CalendarCache {
  fetchedAt?: string;
  name?: string;
  events: CalEvent[];
  /** The last check failed: the events above are from the last good one. */
  error?: { message: string; at: string };
}

function put(key: string, value: unknown) {
  return db.kv.put({ key, value, updatedAt: nextUpdatedAt() } as KV);
}

async function read<T>(key: string): Promise<T | undefined> {
  return (await db.kv.get(key))?.value as T | undefined;
}

export async function getFeed(): Promise<CalendarFeed | undefined> {
  return read<CalendarFeed>(CALENDAR_FEED_KEY);
}

/** Save an address (https or webcal). Returns false if it isn't one. Clears results from any older address. */
export async function saveFeed(input: string): Promise<boolean> {
  const url = normalizeFeedUrl(input);
  if (!url) return false;
  await db.transaction('rw', db.kv, async () => {
    await put(CALENDAR_FEED_KEY, { url, savedAt: new Date().toISOString() } satisfies CalendarFeed);
    await db.kv.delete(CALENDAR_CACHE_KEY);
  });
  return true;
}

export async function removeFeed(): Promise<void> {
  await db.kv.bulkDelete([CALENDAR_FEED_KEY, CALENDAR_CACHE_KEY, CALENDAR_DISMISSED_KEY]);
}

const signedIn = () => {
  const s = getSyncStatus().state;
  return s !== 'signedOut' && s !== 'unconfigured';
};

let inflight: Promise<void> | null = null;

/**
 * Read the calendar again through the calendar function, if an address is saved, you are signed in, and
 * the last check is older than CALENDAR_REFRESH_MS (or `force`). A failed check keeps the last good events.
 */
export async function refreshCalendar(opts: { force?: boolean } = {}): Promise<void> {
  // "Check now" must not just join an automatic run that may have stopped early on the throttle.
  if (opts.force && inflight) await inflight.catch(() => undefined);
  inflight ??= (async () => {
    const feed = await getFeed();
    if (!feed || !signedIn()) return;
    const cache = (await read<CalendarCache>(CALENDAR_CACHE_KEY)) ?? { events: [] };
    const wait = cache.error ? CALENDAR_RETRY_MS : CALENDAR_REFRESH_MS;
    const last = Date.parse(cache.error?.at ?? cache.fetchedAt ?? '') || 0;
    if (!opts.force && Date.now() - last < wait) return;
    const at = new Date().toISOString();
    type Answer = { ok?: boolean; name?: string; events?: CalEvent[]; message?: string };
    const out = await (async (): Promise<Answer | null> => {
      try {
        const { data, error } = await (await getClient()).functions.invoke('calendar', {
          body: { url: feed.url, today: await currentToday(), offsetMin: deviceOffsetMin(), dayBoundaryHour: (await getSettings()).dayBoundaryHour },
        });
        return error ? null : (data as Answer);
      } catch {
        return null;
      }
    })();
    // The address may have been removed or changed while this check ran.
    if ((await getFeed())?.url !== feed.url) return;
    if (out?.ok && Array.isArray(out.events)) {
      await put(CALENDAR_CACHE_KEY, { fetchedAt: at, ...(out.name ? { name: out.name } : {}), events: out.events } satisfies CalendarCache);
    } else {
      const message =
        out?.message ?? "Couldn't reach the calendar function. Check your connection, and that it is deployed (README > Calendar).";
      await put(CALENDAR_CACHE_KEY, { ...cache, error: { message, at } } satisfies CalendarCache);
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** "Not this time" for one trip. Remembers the last 50. */
export async function dismissSuggestion(key: string): Promise<void> {
  const cur = (await read<string[]>(CALENDAR_DISMISSED_KEY)) ?? [];
  await put(CALENDAR_DISMISSED_KEY, [...cur.filter((k) => k !== key), key].slice(-50));
}

/** Turn on Travel/Crunch for the suggested trip, from its first day (up to a week back) through its last. */
export async function acceptSuggestion(s: CrunchSuggestion): Promise<void> {
  await startCrunch({ start: s.start, end: s.end, label: 'Travel' });
}

export interface CalendarState {
  feed?: CalendarFeed;
  cache?: CalendarCache;
  dismissed: string[];
}

export function useCalendar(): CalendarState | undefined {
  return useLiveQuery(async () => {
    const [feed, cache, dismissed] = await db.kv.bulkGet([CALENDAR_FEED_KEY, CALENDAR_CACHE_KEY, CALENDAR_DISMISSED_KEY]);
    return {
      feed: feed?.value as CalendarFeed | undefined,
      cache: cache?.value as CalendarCache | undefined,
      dismissed: Array.isArray(dismissed?.value) ? (dismissed.value as string[]) : [],
    };
  }, []);
}
