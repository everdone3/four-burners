// The calendar link and its results on this device: saved and checked through the calendar function,
// never synced, never in backups.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
let syncState = 'idle';
vi.mock('@/sync/client', async (orig) => ({ ...(await orig<typeof import('@/sync/client')>()), getClient: async () => ({ functions: { invoke } }) }));
vi.mock('@/sync/manager', async (orig) => ({ ...(await orig<typeof import('@/sync/manager')>()), getSyncStatus: () => ({ state: syncState, pending: 0 }) }));

const { db } = await import('@/data/db');
const { wipeAll } = await import('@/data/repo');
const { buildBackupFile } = await import('@/data/backup');
const { createSyncEngine } = await import('@/sync/engine');
const { createMemoryRemote } = await import('@/sync/memoryRemote');
const { travelTo, setClockOffset } = await import('@/data/clock');
const feed = await import('./feed');

const EVENTS = [{ summary: 'Denver trip', start: '2026-10-05', end: '2026-10-08', allDay: true, free: false }];
const cache = async () => (await db.kv.get(feed.CALENDAR_CACHE_KEY))?.value as import('./feed').CalendarCache | undefined;

beforeEach(async () => {
  await wipeAll();
  invoke.mockReset();
  invoke.mockResolvedValue({ data: { ok: true, name: 'Travel', events: EVENTS }, error: null });
  syncState = 'idle';
  setClockOffset(0);
});

describe('calendar link', () => {
  it('saves only real calendar addresses, as https', async () => {
    expect(await feed.saveFeed('my calendar')).toBe(false);
    expect(await feed.saveFeed('http://insecure.example/cal.ics')).toBe(false);
    expect(await feed.saveFeed('webcal://p01-caldav.icloud.com/published/2/abc')).toBe(true);
    expect((await feed.getFeed())?.url).toBe('https://p01-caldav.icloud.com/published/2/abc');
  });

  it('checks through the calendar function and keeps the result', async () => {
    await feed.saveFeed('https://c.example.com/a.ics');
    await feed.refreshCalendar();
    expect(invoke).toHaveBeenCalledWith('calendar', {
      body: expect.objectContaining({ url: 'https://c.example.com/a.ics', today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), offsetMin: expect.any(Number), dayBoundaryHour: 3 }),
    });
    expect(await cache()).toMatchObject({ name: 'Travel', events: EVENTS });
  });

  it('checks at most every 6 hours on its own; Check now always checks', async () => {
    await feed.saveFeed('https://c.example.com/a.ics');
    await feed.refreshCalendar();
    await feed.refreshCalendar();
    expect(invoke).toHaveBeenCalledTimes(1);
    await feed.refreshCalendar({ force: true });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('Check now waits for an automatic check in progress, then checks', async () => {
    await feed.saveFeed('https://c.example.com/a.ics');
    await feed.refreshCalendar();
    const auto = feed.refreshCalendar(); // throttled: returns without checking
    await feed.refreshCalendar({ force: true });
    await auto;
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('after a failure, tries again in 30 minutes rather than 6 hours', async () => {
    await feed.saveFeed('https://c.example.com/a.ics');
    invoke.mockRejectedValue(new TypeError('Failed to fetch'));
    await feed.refreshCalendar();
    expect(invoke).toHaveBeenCalledTimes(1);
    await feed.refreshCalendar();
    expect(invoke).toHaveBeenCalledTimes(1);
    const c = await cache();
    await db.kv.put({ key: feed.CALENDAR_CACHE_KEY, value: { ...c, error: { ...c!.error!, at: new Date(Date.now() - feed.CALENDAR_RETRY_MS).toISOString() } }, updatedAt: 'x' });
    await feed.refreshCalendar();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('a failed check keeps the last good trips and says why', async () => {
    await feed.saveFeed('https://c.example.com/a.ics');
    await feed.refreshCalendar();
    invoke.mockResolvedValue({ data: { ok: false, code: 'not_found', message: 'No calendar at that link.' }, error: null });
    await feed.refreshCalendar({ force: true });
    expect(await cache()).toMatchObject({ events: EVENTS, error: { message: 'No calendar at that link.' } });
    invoke.mockRejectedValue(new TypeError('Failed to fetch'));
    await feed.refreshCalendar({ force: true });
    expect((await cache())?.error?.message).toMatch(/Couldn't reach the calendar function/);
    expect((await cache())?.events).toEqual(EVENTS);
  });

  it('does nothing without a link, or when signed out', async () => {
    await feed.refreshCalendar({ force: true });
    await feed.saveFeed('https://c.example.com/a.ics');
    syncState = 'signedOut';
    await feed.refreshCalendar({ force: true });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('a new link drops the old results, and Remove forgets everything', async () => {
    await feed.saveFeed('https://c.example.com/a.ics');
    await feed.refreshCalendar();
    await feed.dismissSuggestion('2026-10-05_2026-10-08');
    await feed.saveFeed('https://c.example.com/b.ics');
    expect(await cache()).toBeUndefined();
    await feed.removeFeed();
    expect(await db.kv.bulkGet([feed.CALENDAR_FEED_KEY, feed.CALENDAR_CACHE_KEY, feed.CALENDAR_DISMISSED_KEY])).toEqual([undefined, undefined, undefined]);
  });

  it('never syncs and never goes into a backup', async () => {
    await feed.saveFeed('https://c.example.com/secret-token-123.ics');
    await feed.refreshCalendar();
    await feed.dismissSuggestion('k');
    const remote = createMemoryRemote();
    await createSyncEngine({ db, remote, accountId: remote.userId }).syncNow();
    const pushed = JSON.stringify(await remote.pull(null, 1000));
    expect(pushed).not.toContain('secret-token-123');
    expect(pushed).not.toContain('Denver trip');
    const backup = await (await buildBackupFile()).text();
    expect(backup).not.toContain('secret-token-123');
    expect(backup).not.toContain(feed.CALENDAR_CACHE_KEY);
  });
});

describe('acting on a suggestion', () => {
  it('turns Travel/Crunch on from the trip start (backdated) through its end', async () => {
    travelTo('2026-10-06');
    await feed.acceptSuggestion({ period: { start: '2026-10-05', end: '2026-10-08', label: 'Denver trip', key: 'k' }, start: '2026-10-05', end: '2026-10-08' });
    const live = (await db.crunch.toArray()).filter((c) => !c.deleted);
    expect(live).toEqual([expect.objectContaining({ start: '2026-10-05', end: '2026-10-08', label: 'Travel' })]);
  });

  it('remembers "not this time" (the last 50)', async () => {
    for (let i = 0; i < 55; i++) await feed.dismissSuggestion(`k${i}`);
    await feed.dismissSuggestion('k54');
    const d = (await db.kv.get(feed.CALENDAR_DISMISSED_KEY))?.value as string[];
    expect(d).toHaveLength(50);
    expect(d.at(-1)).toBe('k54');
    expect(d[0]).toBe('k5');
  });
});
