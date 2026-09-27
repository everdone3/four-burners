// Review follow-ups to syncSafety.test.ts: an edit must win last-write-wins even when the stored record
// carries a stamp later than this device's clock (a device whose clock runs ahead, a clock that stepped
// back between launches, or an old pretend-day stamp from dev time travel, which earlier builds wrote).
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SYNCED_COLLECTIONS } from '@/sync/types';
import { setClockOffset, travelTo } from './clock';
import { db } from './db';
import {
  addGoal,
  closeQuarter,
  currentToday,
  decideGoal,
  deleteGoal,
  editLog,
  ensureCurrentQuarter,
  finishSetup,
  logProgress,
  saveOnboarding,
  saveProfile,
  saveSettings,
  setEnergy,
  setTheme,
  updateGoal,
  wipeAll,
} from './repo';
import { nextUpdatedAt } from './stamp';
import { EMPTY_PROFILE_FIELDS } from '@/domain';

const DAY = 86_400_000;
const ahead = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const ms = (s: string) => Date.parse(s);
const dirty = (r: unknown) => (r as { _dirty?: number } | undefined)?._dirty;

/** As the sync engine leaves records after a push. */
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
afterEach(() => setClockOffset(0));

describe('nextUpdatedAt with a floor', () => {
  it('is newer than the stored stamp, and the floor never pushes later stamps for other records ahead', () => {
    const future = ahead(3);
    const a = nextUpdatedAt(future);
    expect(ms(a)).toBe(ms(future) + 1);
    expect(nextUpdatedAt(a)).toBe(new Date(ms(future) + 2).toISOString());
    const other = nextUpdatedAt();
    expect(ms(other)).toBeLessThan(ms(future));
    expect(Math.abs(ms(other) - Date.now())).toBeLessThan(5_000);
    // A stamp in the past, the seed, or garbage changes nothing.
    for (const floor of ['2020-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', 'yesterday', undefined, 42]) {
      expect(ms(nextUpdatedAt(floor))).toBeLessThan(ms(future));
    }
  });
});

describe('edits win over a stored stamp that is ahead of this device', () => {
  it('goal, quarter, settings, onboarding, profile, energy and log edits all get a newer stamp and stay dirty', async () => {
    const q = await ensureCurrentQuarter();
    const g = await addGoal({ quarterId: q.id, burner: 'work', title: 'Ship', type: 'number', target: 5 });
    const log = await logProgress(g, 1);
    await setEnergy(3);
    await saveSettings({ haptics: false });
    await saveOnboarding({ step: 1 });
    await saveProfile(EMPTY_PROFILE_FIELDS, 'edited');
    // Everything arrived from a device whose clock runs a day ahead, and was marked clean.
    const future = ahead(1);
    for (const c of SYNCED_COLLECTIONS) await db.table(c).toCollection().modify({ updatedAt: future });
    await markAllClean();

    const energyId = (await db.energy.toArray())[0].id;
    const writes: Array<[string, string, () => Promise<unknown>]> = [
      ['goals', g.id, () => updateGoal(g.id, { title: 'Ship it' })],
      ['quarters', q.id, () => setTheme(q.id, 'Focus')],
      ['kv', 'settings', () => saveSettings({ haptics: true })],
      ['kv', 'onboarding', () => saveOnboarding({ step: 2 })],
      ['profiles', 'me', () => saveProfile({ ...EMPTY_PROFILE_FIELDS, lifeContext: 'Busy' }, 'edited')],
      ['energy', energyId, () => setEnergy(5)],
      ['logs', log.id, () => editLog(log.id, { value: 4 })],
    ];
    for (const [c, id, write] of writes) {
      await write();
      const after = (await db.table(c).get(id)) as { updatedAt: string };
      expect(ms(after.updatedAt), `${c} stamp`).toBeGreaterThan(ms(future));
      expect(dirty(after), `${c} dirty`).toBe(1);
    }
    // The edit history keeps the real time of the correction, not the bumped stamp.
    const edited = (await db.logs.get(log.id))!;
    expect(edited.edits).toHaveLength(1);
    expect(ms(edited.edits![0].at)).toBeLessThan(ms(future));
  });

  it('soft deletes and quarter close win too', async () => {
    const q = await ensureCurrentQuarter();
    await setTheme(q.id, 'Strong');
    const g = await addGoal({ quarterId: q.id, burner: 'health', title: 'Run', type: 'number', target: 10 });
    const g2 = await addGoal({ quarterId: q.id, burner: 'health', title: 'Swim', type: 'number', target: 10 });
    await decideGoal(g2.id, 'carry');
    const future = ahead(2);
    for (const c of SYNCED_COLLECTIONS) await db.table(c).toCollection().modify({ updatedAt: future });
    await markAllClean();

    await deleteGoal(g.id);
    expect(ms((await db.goals.get(g.id))!.updatedAt)).toBeGreaterThan(ms(future));
    await closeQuarter(q.id, { progressScore: 1, consistencyScore: 1, longestStreak: 1, checkInDays: 1 });
    expect(ms((await db.quarters.get(q.id))!.updatedAt)).toBeGreaterThan(ms(future));
    expect(ms((await db.goals.get(g2.id))!.updatedAt)).toBeGreaterThan(ms(future));
    await finishSetup(q.id);
    expect(ms((await db.quarters.get(q.id))!.updatedAt)).toBeGreaterThan(ms(future));
  });

  it('a patch with undefined removes the field, as Dexie update does', async () => {
    const q = await ensureCurrentQuarter();
    await setTheme(q.id, 'Strong');
    await setTheme(q.id, '   ');
    expect(await db.quarters.get(q.id)).not.toHaveProperty('theme');
    const g = await addGoal({ quarterId: q.id, burner: 'work', title: 'Ship', type: 'number', target: 5, why: 'Because' });
    await updateGoal(g.id, { why: undefined });
    expect(await db.goals.get(g.id)).not.toHaveProperty('why');
  });

  it('clearing energy stamps each copy past its own stored stamp', async () => {
    const localDate = await currentToday();
    const base = { rating: 3 as const, localDate, at: '2026-09-20T13:00:00.000Z', offsetMin: -240, createdAt: '2026-09-20T13:00:00.000Z' };
    const future = ahead(1);
    await db.energy.bulkPut([
      { ...base, id: 'phone', updatedAt: '2026-09-20T13:00:00.000Z' },
      { ...base, id: 'ipad', rating: 4, updatedAt: future },
    ]);
    await setEnergy(null);
    const [ipad, phone] = await db.energy.bulkGet(['ipad', 'phone']);
    expect(ipad!.deleted && phone!.deleted).toBe(true);
    expect(ms(ipad!.updatedAt)).toBeGreaterThan(ms(future));
    expect(ms(phone!.updatedAt)).toBeLessThan(ms(future));
  });
});
