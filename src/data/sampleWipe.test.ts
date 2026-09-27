// Wiping sample data on a signed-in device: nothing the sample loader made may reach the account.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_INTENTS, type Quarter } from '@/domain';
import { createSyncEngine } from '@/sync/engine';
import { createMemoryRemote } from '@/sync/memoryRemote';
import { PREFILLED_UPDATED_AT, SEED_UPDATED_AT } from '@/sync/types';
import { setClockOffset, travelTo } from './clock';
import { FourBurnersDB, db } from './db';
import { addGoal, ensureCurrentQuarter, wipeAll } from './repo';
import { loadSampleData, wipeSampleData } from './sample';

const Q = '2026-Q3';
const seed = (patch: Partial<Quarter> = {}): Quarter => ({ id: Q, createdAt: '2026-07-01T12:00:00.000Z', updatedAt: SEED_UPDATED_AT, intents: { ...DEFAULT_INTENTS }, intentHistory: [], status: 'active', ...patch });

const opened: FourBurnersDB[] = [];

beforeEach(async () => {
  await wipeAll();
  travelTo('2026-09-20');
});
afterEach(async () => {
  setClockOffset(0);
  await Promise.all(opened.splice(0).map((d) => d.delete()));
});

/** Phone (the app's db) and iPad on one account; the iPad has `ipadQ3`, the phone an auto-created Q3. */
async function setup(ipadQ3: Quarter) {
  const remote = createMemoryRemote();
  const ipad = new FourBurnersDB(`ipad-${Math.random().toString(36).slice(2)}`);
  opened.push(ipad);
  const phoneSync = createSyncEngine({ db, remote, accountId: remote.userId });
  const ipadSync = createSyncEngine({ db: ipad, remote, accountId: remote.userId });
  await ipad.quarters.put(ipadQ3);
  await ipadSync.syncNow();
  await ensureCurrentQuarter();
  await phoneSync.syncNow();
  return { remote, ipad, phoneSync, ipadSync };
}

/** Load sample data, add a real goal to the sample-made current quarter (it syncs), then wipe. */
async function sampleThenRealGoalThenWipe(phoneSync: { syncNow(): Promise<unknown> }) {
  await loadSampleData();
  expect((await db.quarters.get(Q))!.theme).toBe('Present'); // the sample setup replaced the seed
  const real = await addGoal({ quarterId: Q, burner: 'work', title: 'Real goal', type: 'yesno' });
  await phoneSync.syncNow();
  await wipeSampleData();
  return real;
}

describe('wiping sample data', () => {
  it('keeps a sample-made quarter that has real goals only as a clean untouched quarter, which never reaches the account', async () => {
    const { remote, ipad, phoneSync, ipadSync } = await setup(seed());
    const real = await sampleThenRealGoalThenWipe(phoneSync);

    const kept = (await db.quarters.get(Q))! as Quarter & { _dirty?: number };
    expect(kept).toMatchObject({ updatedAt: SEED_UPDATED_AT, intents: DEFAULT_INTENTS, intentHistory: [], status: 'active', _dirty: 0 });
    for (const field of ['theme', 'setupAt', 'closedAt', 'summary'] as const) expect(kept[field], field).toBeUndefined();
    expect(await db.quarters.get('2026-Q2')).toBeUndefined(); // no real goals there, so it is gone

    await phoneSync.syncNow();
    await ipadSync.syncNow();
    for (const d of [db, ipad]) {
      const q = (await d.quarters.get(Q))!;
      expect(q.theme).toBeUndefined();
      expect(q.setupAt).toBeUndefined();
      expect(q.intents).toEqual(DEFAULT_INTENTS);
      expect(q.intentHistory).toEqual([]);
    }
    expect(remote.row('quarters', Q)!.updated_at).toBe(SEED_UPDATED_AT);
    expect(remote.rows().some((r) => r.collection === 'quarters' && r.id === '2026-Q2')).toBe(false);
    expect((await ipad.goals.get(real.id))!.title).toBe('Real goal');
    expect(await phoneSync.pendingCount()).toBe(0);
  });

  it("brings back the account's own copy of the quarter (set up on another device) after the wipe", async () => {
    const { ipad, phoneSync, ipadSync } = await setup(seed());
    await loadSampleData();
    // Meanwhile the iPad sets up Q3 for real; the phone skips it while its Q3 is sample data.
    await ipad.quarters.put(seed({ theme: 'Strong', intents: { family: 'high', friends: 'steady', health: 'high', work: 'low' }, updatedAt: new Date().toISOString(), setupAt: new Date().toISOString() }));
    await ipadSync.syncNow();
    await addGoal({ quarterId: Q, burner: 'work', title: 'Real goal', type: 'yesno' });
    await phoneSync.syncNow();
    expect((await db.quarters.get(Q))!.theme).toBe('Present');

    await wipeSampleData();
    await phoneSync.syncNow();
    for (const d of [db, ipad]) expect((await d.quarters.get(Q))!).toMatchObject({ theme: 'Strong', intents: { family: 'high', health: 'high', work: 'low' } });
  });

  it('treats a pre-filled quarter as auto-created: the sample takes it over, and the account copy comes back after the wipe', async () => {
    const prefilled = seed({ intents: { family: 'high', friends: 'low', health: 'steady', work: 'steady' }, updatedAt: PREFILLED_UPDATED_AT });
    const { phoneSync } = await setup(prefilled);
    expect((await db.quarters.get(Q))!.updatedAt).toBe(PREFILLED_UPDATED_AT);
    await sampleThenRealGoalThenWipe(phoneSync);
    await phoneSync.syncNow();
    expect((await db.quarters.get(Q))!).toMatchObject({ intents: prefilled.intents, updatedAt: PREFILLED_UPDATED_AT });
    expect((await db.quarters.get(Q))!.theme).toBeUndefined();
  });
});
