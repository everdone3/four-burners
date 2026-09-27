import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PREFILLED_UPDATED_AT, SEED_UPDATED_AT, SYNCED_COLLECTIONS } from '@/sync/types';
import { setClockOffset, travelTo } from './clock';
import { db } from './db';
import {
  addAction,
  addGoal,
  addPerson,
  carriedGoalId,
  checkTimeZoneChange,
  closeQuarter,
  currentToday,
  decideGoal,
  editLog,
  ensureCurrentQuarter,
  ensureQuarter,
  getOrCreateReview,
  logProgress,
  saveOnboarding,
  saveProfile,
  saveReview,
  saveSettings,
  setEnergy,
  setIntent,
  setTheme,
  streakMilestoneReached,
  toggleAction,
  updateGoal,
  wipeAll,
} from './repo';
import { nextUpdatedAt } from './stamp';
import { EMPTY_PROFILE_FIELDS } from '@/domain';

// Later than the real clock, so stamps issued by earlier tests never exceed it.
const FROZEN = new Date('2031-03-02T15:00:00.000Z');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const dirty = (r: unknown) => (r as { _dirty?: number } | undefined)?._dirty;

/** Mark every record clean, as the sync engine does after a push. */
async function markAllClean() {
  await db.transaction('rw', SYNCED_COLLECTIONS.map((c) => db.table(c)), async () => {
    for (const c of SYNCED_COLLECTIONS) {
      const t = db.table(c);
      for (const key of await t.toCollection().primaryKeys()) await t.update(key, { _dirty: 0 });
    }
  });
}

beforeEach(async () => {
  await wipeAll();
  travelTo('2026-09-20');
});
afterEach(() => {
  vi.useRealTimers();
  setClockOffset(0);
});

describe('monotonic updatedAt', () => {
  it('never repeats or goes back, even with a frozen or rewound clock, and keeps toISOString format', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FROZEN);
    const a = nextUpdatedAt();
    const b = nextUpdatedAt();
    const c = nextUpdatedAt();
    expect(Date.parse(b)).toBeGreaterThan(Date.parse(a));
    expect(Date.parse(c)).toBeGreaterThan(Date.parse(b));
    vi.setSystemTime(new Date(FROZEN.getTime() - 60_000)); // clock steps back a minute
    const d = nextUpdatedAt();
    expect(Date.parse(d)).toBe(Date.parse(c) + 1);
    for (const x of [a, b, c, d]) expect(x).toMatch(ISO);
    vi.setSystemTime(new Date(FROZEN.getTime() + 60_000)); // real time moves past it again
    expect(nextUpdatedAt()).toBe(new Date(FROZEN.getTime() + 60_000).toISOString());
  });

  it('two quick edits to one record get strictly increasing stamps, so the second one syncs', async () => {
    const q = await ensureCurrentQuarter();
    const g = await addGoal({ quarterId: q.id, burner: 'work', title: 'Read', type: 'number', target: 3 });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FROZEN);
    await updateGoal(g.id, { title: 'Read more' });
    const first = (await db.goals.get(g.id))!.updatedAt;
    await updateGoal(g.id, { title: 'Read the most' });
    const second = (await db.goals.get(g.id))!.updatedAt;
    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first));

    const a = await addAction('2026-09-14', 'Call Mom');
    await toggleAction(a.id);
    const done = (await db.actions.get(a.id))!.updatedAt;
    await toggleAction(a.id); // undo in the same millisecond
    expect(Date.parse((await db.actions.get(a.id))!.updatedAt)).toBeGreaterThan(Date.parse(done));
  });

  it('follows the real clock, not the dev pretend day; entry dates still follow the pretend day', async () => {
    travelTo('2045-12-25'); // pretend it is a Christmas far ahead of every stamp issued so far
    const q = await ensureQuarter('2045-Q4');
    const g = await addGoal({ quarterId: q.id, burner: 'health', title: 'Run', type: 'number', target: 10 });
    const before = Date.parse(nextUpdatedAt());
    const log = await logProgress(g, 2);
    expect(log.localDate).toBe('2045-12-25');
    expect(log.at.slice(0, 4)).toBe('2045');
    expect(Date.parse(log.updatedAt)).toBeGreaterThan(before);
    expect(Date.parse(log.updatedAt) - before).toBeLessThan(5_000);
  });

  it('the dated writes (logs, energy, touchpoints, intent changes) use the sync stamp for updatedAt', async () => {
    const q = await ensureCurrentQuarter();
    const g = await addGoal({ quarterId: q.id, burner: 'work', title: 'Ship', type: 'yesno' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FROZEN);
    travelTo('2026-09-21');
    const log = await logProgress(g, 1);
    await editLog(log.id, { value: 2 });
    const edited = (await db.logs.get(log.id))!;
    expect(Date.parse(edited.updatedAt)).toBeGreaterThan(Date.parse(log.updatedAt));

    await setEnergy(4);
    const e1 = (await db.energy.toArray())[0];
    await setEnergy(5);
    const e2 = (await db.energy.get(e1.id))!;
    expect(e2.rating).toBe(5);
    expect(Date.parse(e2.updatedAt)).toBeGreaterThan(Date.parse(e1.updatedAt));

    // Underway quarter: the intent change is recorded with a reason, and still gets a fresh stamp.
    const before = (await db.quarters.get(q.id))!.updatedAt;
    expect(await setIntent(q.id, 'work', 'low', 'Busy season')).toEqual({ ok: true });
    const after = (await db.quarters.get(q.id))!;
    expect(after.intentHistory).toHaveLength(1);
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(before));
  });
});

describe('seeded records never beat real data', () => {
  it('ensureCurrentQuarter and ensureQuarter create seeded quarters with a real createdAt', async () => {
    const q = await ensureCurrentQuarter();
    expect(q.updatedAt).toBe(SEED_UPDATED_AT);
    expect((await db.quarters.get(q.id))!.updatedAt).toBe(SEED_UPDATED_AT);
    expect(Date.parse(q.createdAt)).toBeGreaterThan(Date.parse('2020-01-01'));
    const next = await ensureQuarter('2026-Q4');
    expect(next.updatedAt).toBe(SEED_UPDATED_AT);
    expect(Date.parse(next.createdAt)).toBeGreaterThan(Date.parse('2020-01-01'));
    // Seeds still sync up (dirty), they just lose to anything real.
    expect(dirty(await db.quarters.get('2026-Q4'))).toBe(1);
  });

  it('never overwrites an existing quarter (for example one that arrived from another device)', async () => {
    const real = { id: '2026-Q3', createdAt: '2026-07-01T12:00:00.000Z', updatedAt: '2026-07-02T12:00:00.000Z', theme: 'Strong', intents: { family: 'high', friends: 'low', health: 'high', work: 'steady' }, intentHistory: [], status: 'active', setupAt: '2026-07-02T12:00:00.000Z' } as const;
    await db.quarters.put({ ...real, intents: { ...real.intents }, intentHistory: [] });
    const got = await ensureCurrentQuarter();
    expect(got).toMatchObject({ theme: 'Strong', updatedAt: real.updatedAt });
    await ensureQuarter('2026-Q3');
    expect((await db.quarters.get('2026-Q3'))!.theme).toBe('Strong');
  });

  it('the first real edit to a seeded quarter gets a real stamp', async () => {
    const q = await ensureCurrentQuarter();
    await setTheme(q.id, 'Present');
    const edited = (await db.quarters.get(q.id))!;
    expect(edited.updatedAt).not.toBe(SEED_UPDATED_AT);
    expect(Date.parse(edited.updatedAt)).toBeGreaterThan(Date.parse('2020-01-01'));
  });

  it('opening the weekly review creates a seeded review; saving progress gives it a real stamp', async () => {
    const r = await getOrCreateReview('2026-09-14');
    expect(r.updatedAt).toBe(SEED_UPDATED_AT);
    expect(Date.parse(r.createdAt)).toBeGreaterThan(Date.parse('2020-01-01'));
    await saveReview(r.id, { step: 2 });
    expect((await db.reviews.get(r.id))!.updatedAt).not.toBe(SEED_UPDATED_AT);
    // Opening it again does not touch it.
    const stamp = (await db.reviews.get(r.id))!.updatedAt;
    await getOrCreateReview('2026-09-14');
    expect((await db.reviews.get(r.id))!.updatedAt).toBe(stamp);
  });

  it('closing a quarter seeds the next one it creates, and pre-filling a seeded next quarter keeps it seeded', async () => {
    const q = await ensureCurrentQuarter();
    const g = await addGoal({ quarterId: q.id, burner: 'health', title: 'Run', type: 'number', target: 100 });
    await decideGoal(g.id, 'carry');
    await setIntent(q.id, 'family', 'high', 'Kids first');
    const summary = { progressScore: 50, consistencyScore: 50, longestStreak: 3, checkInDays: 20 };

    await closeQuarter(q.id, summary);
    const next = (await db.quarters.get('2026-Q4'))!;
    expect(next.updatedAt).toBe(PREFILLED_UPDATED_AT);
    expect(next.intents.family).toBe('high');
    // The real parts of the close carry real stamps.
    expect((await db.quarters.get(q.id))!.updatedAt).not.toBe(SEED_UPDATED_AT);
    const carried = (await db.goals.where('quarterId').equals('2026-Q4').toArray())[0];
    expect(carried.updatedAt).not.toBe(SEED_UPDATED_AT);

    // Next quarter auto-created first (e.g. the app opened on day one of it), then the close pre-fills it.
    await wipeAll();
    const q2 = await ensureCurrentQuarter();
    await setIntent(q2.id, 'work', 'high');
    await ensureQuarter('2026-Q4');
    await closeQuarter(q2.id, summary);
    const next2 = (await db.quarters.get('2026-Q4'))!;
    expect(next2.intents.work).toBe('high');
    expect(next2.updatedAt).toBe(PREFILLED_UPDATED_AT);
  });

  it('closing on two devices carries each goal into one shared record, not duplicates', async () => {
    const q = await ensureCurrentQuarter();
    const g = await addGoal({ quarterId: q.id, burner: 'health', title: 'Run', type: 'number', target: 100 });
    await decideGoal(g.id, 'carry');
    const summary = { progressScore: 50, consistencyScore: 50, longestStreak: 3, checkInDays: 20 };
    await closeQuarter(q.id, summary);
    const id = carriedGoalId(g.id, '2026-Q4');
    expect((await db.goals.get(g.id))!.carriedToId).toBe(id);
    expect(await db.goals.get(id)).toMatchObject({ quarterId: '2026-Q4', carriedFromId: g.id, title: 'Run' });

    // The other device's copy arrived (and was edited) before this device learned the source was carried.
    await updateGoal(id, { title: 'Run 120' });
    await db.goals.update(g.id, { carriedToId: undefined });
    await closeQuarter(q.id, summary);
    expect(await db.goals.where('quarterId').equals('2026-Q4').count()).toBe(1);
    expect((await db.goals.get(id))!.title).toBe('Run 120');
    expect((await db.goals.get(g.id))!.carriedToId).toBe(id);
  });

  it('launch-time checks write only device-local kv keys, and the time zone check writes only on a change', async () => {
    const synced = async () => {
      const out: string[] = [];
      for (const c of SYNCED_COLLECTIONS) {
        for (const r of await db.table(c).toArray()) {
          if (c === 'kv' && !['settings', 'onboarding'].includes(r.key)) continue;
          out.push(`${c}:${r.id ?? r.key}:${r.updatedAt}`);
        }
      }
      return out.sort();
    };
    await ensureCurrentQuarter();
    const before = await synced();
    await checkTimeZoneChange();
    await streakMilestoneReached(9);
    await ensureCurrentQuarter();
    expect(await synced()).toEqual(before);

    const row = await db.kv.get('lastOffsetMin');
    await checkTimeZoneChange();
    expect((await db.kv.get('lastOffsetMin'))!.updatedAt).toBe(row!.updatedAt);
  });
});

describe('merged data', () => {
  it('clearing energy clears every copy for the day (two devices can each rate it before syncing)', async () => {
    const localDate = await currentToday();
    const base = { rating: 3 as const, localDate, at: '2026-09-20T13:00:00.000Z', offsetMin: -240, createdAt: '2026-09-20T13:00:00.000Z' };
    await db.energy.bulkPut([
      { ...base, id: 'phone', updatedAt: '2026-09-20T13:00:00.000Z' },
      { ...base, id: 'ipad', rating: 4, updatedAt: '2026-09-20T14:00:00.000Z' },
    ]);
    await setEnergy(null);
    expect((await db.energy.toArray()).every((e) => e.deleted)).toBe(true);
  });
});

describe('every write syncs', () => {
  it('replacing a clean record keeps it dirty (settings, onboarding, profile)', async () => {
    await saveSettings({ haptics: false });
    await saveOnboarding({ step: 2 });
    await saveProfile(EMPTY_PROFILE_FIELDS, 'edited');
    await markAllClean();
    expect(dirty(await db.kv.get('settings'))).toBe(0);

    await saveSettings({ haptics: true });
    await saveOnboarding({ step: 3 });
    await saveProfile({ ...EMPTY_PROFILE_FIELDS, lifeContext: 'Busy dad' }, 'edited');
    expect(dirty(await db.kv.get('settings'))).toBe(1);
    expect(dirty(await db.kv.get('onboarding'))).toBe(1);
    expect(dirty(await db.profiles.get('me'))).toBe(1);
  });

  it('every repo write sets a fresh updatedAt and marks the record dirty', async () => {
    const q = await ensureCurrentQuarter();
    const g = await addGoal({ quarterId: q.id, burner: 'work', title: 'Read', type: 'number', target: 3 });
    const p = await addPerson({ name: 'Jake', burner: 'friends', cadenceDays: 14 }, [g.id]);
    const log = await logProgress(g, 1);
    await markAllClean();
    const stampOf = async (c: string, id: string) => ((await db.table(c).get(id)) as { updatedAt: string }).updatedAt;
    const writes: Array<[string, string, () => Promise<unknown>]> = [
      ['quarters', q.id, () => setTheme(q.id, 'Focus')],
      ['goals', g.id, () => updateGoal(g.id, { title: 'Read 4' })],
      ['logs', log.id, () => editLog(log.id, { value: 3 })],
      ['people', p.id, async () => (await import('./repo')).updatePerson(p.id, { cadenceDays: 7 })],
      ['kv', 'settings', () => saveSettings({ graceDaysPerWeek: 2 })],
    ];
    for (const [c, id, write] of writes) {
      const before = (await db.table(c).get(id)) as { updatedAt?: string } | undefined;
      await write();
      const after = await db.table(c).get(id);
      expect(dirty(after), `${c} dirty`).toBe(1);
      if (before?.updatedAt) expect(Date.parse(await stampOf(c, id)), `${c} stamp`).toBeGreaterThan(Date.parse(before.updatedAt));
    }
  });
});
