// The quarter close across devices: next quarter's pre-filled intents reach every device, and carried
// goal ids stay short however many quarters a goal is carried.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_INTENTS, type Quarter } from '@/domain';
import { createSyncEngine } from '@/sync/engine';
import { createMemoryRemote, type MemoryRemote } from '@/sync/memoryRemote';
import { PREFILLED_UPDATED_AT, SEED_UPDATED_AT } from '@/sync/types';
import { setClockOffset, travelTo } from './clock';
import { FourBurnersDB, db } from './db';
import { addGoal, carriedGoalId, closeQuarter, decideGoal, ensureCurrentQuarter, setSetupIntents, setTheme, wipeAll } from './repo';

const SUMMARY = { progressScore: 50, consistencyScore: 50, longestStreak: 3, checkInDays: 20 };
const Q3_INTENTS = { family: 'high', friends: 'low', health: 'high', work: 'steady' } as const;
const UUID = '0b6f4a8e-1f2d-4c3b-9a7e-5d6c7b8a9f01';

const seed = (id: string): Quarter => ({ id, createdAt: '2026-10-01T12:00:00.000Z', updatedAt: SEED_UPDATED_AT, intents: { ...DEFAULT_INTENTS }, intentHistory: [], status: 'active' });

const opened: FourBurnersDB[] = [];
function ipadDb() {
  const d = new FourBurnersDB(`ipad-${Math.random().toString(36).slice(2)}`);
  opened.push(d);
  return d;
}

beforeEach(async () => {
  await wipeAll();
  travelTo('2026-09-20');
});
afterEach(async () => {
  setClockOffset(0);
  await Promise.all(opened.splice(0).map((d) => d.delete()));
});

/** The phone (the app's own db) and an iPad, signed in to one account, with Q3 set up on the phone. */
async function twoDevices() {
  const remote: MemoryRemote = createMemoryRemote();
  const ipad = ipadDb();
  const phoneSync = createSyncEngine({ db, remote, accountId: remote.userId });
  const ipadSync = createSyncEngine({ db: ipad, remote, accountId: remote.userId });
  const q3 = await ensureCurrentQuarter();
  expect(await setSetupIntents(q3.id, { ...Q3_INTENTS })).toEqual({ ok: true });
  const g = await addGoal({ quarterId: q3.id, burner: 'health', title: 'Run', type: 'number', target: 100 });
  await decideGoal(g.id, 'carry');
  await phoneSync.syncNow();
  await ipadSync.syncNow();
  return { remote, ipad, phoneSync, ipadSync, q3 };
}

describe('next quarter pre-filled at the close', () => {
  it('reaches a device that already pushed its own auto-created next quarter', async () => {
    const { remote, ipad, phoneSync, ipadSync, q3 } = await twoDevices();
    // Rollover: the iPad opens first in Q4 and its seed reaches the server; then the phone opens.
    await ipad.quarters.put(seed('2026-Q4'));
    await ipadSync.syncNow();
    travelTo('2026-10-02');
    await ensureCurrentQuarter();
    await phoneSync.syncNow();

    await closeQuarter(q3.id, SUMMARY);
    expect((await db.quarters.get('2026-Q4'))!).toMatchObject({ intents: Q3_INTENTS, updatedAt: PREFILLED_UPDATED_AT });
    await phoneSync.syncNow();
    await ipadSync.syncNow();

    expect(remote.row('quarters', '2026-Q4')!.data.intents).toEqual(Q3_INTENTS);
    expect((await ipad.quarters.get('2026-Q4'))!.intents).toEqual(Q3_INTENTS);
    expect(await phoneSync.pendingCount()).toBe(0);
    expect(await ipadSync.pendingCount()).toBe(0);
  });

  it('also when the close creates next quarter on this device', async () => {
    const { ipad, phoneSync, ipadSync, q3 } = await twoDevices();
    await ipad.quarters.put(seed('2026-Q4'));
    await ipadSync.syncNow();
    await closeQuarter(q3.id, SUMMARY); // still in Q3 on the phone, so Q4 is created here
    expect((await db.quarters.get('2026-Q4'))!.updatedAt).toBe(PREFILLED_UPDATED_AT);
    await phoneSync.syncNow();
    await ipadSync.syncNow();
    expect((await ipad.quarters.get('2026-Q4'))!.intents).toEqual(Q3_INTENTS);
  });

  it('still loses to a next quarter set up on another device', async () => {
    const { ipad, phoneSync, ipadSync, q3 } = await twoDevices();
    const real: Quarter = { ...seed('2026-Q4'), theme: 'Rest', intents: { family: 'steady', friends: 'high', health: 'steady', work: 'low' }, updatedAt: new Date().toISOString(), setupAt: new Date().toISOString() };
    await ipad.quarters.put(real);
    await ipadSync.syncNow();
    travelTo('2026-10-02');
    await ensureCurrentQuarter(); // the phone has not pulled the iPad's setup yet
    await closeQuarter(q3.id, SUMMARY);
    await phoneSync.syncNow();
    await ipadSync.syncNow();
    for (const d of [db, ipad]) expect((await d.quarters.get('2026-Q4'))!).toMatchObject({ theme: 'Rest', intents: real.intents });
  });

  it('a quarter another device pre-filled still counts as auto-created, so closing here never gives it a real stamp', async () => {
    const q3 = await ensureCurrentQuarter();
    await setSetupIntents(q3.id, { ...Q3_INTENTS });
    await db.quarters.put({ ...seed('2026-Q4'), updatedAt: PREFILLED_UPDATED_AT }); // arrived from the other device's close
    await closeQuarter(q3.id, SUMMARY);
    expect((await db.quarters.get('2026-Q4'))!).toMatchObject({ intents: Q3_INTENTS, updatedAt: PREFILLED_UPDATED_AT });
    // A real edit afterwards gets a real stamp, as for any seed.
    await setTheme('2026-Q4', 'Rest');
    expect(Date.parse((await db.quarters.get('2026-Q4'))!.updatedAt)).toBeGreaterThan(Date.parse('2020-01-01'));
  });
});

describe('carried goal ids', () => {
  it('stay short and unique when one goal is carried 25 quarters in a row', async () => {
    let q = await ensureCurrentQuarter();
    const root = await addGoal({ quarterId: q.id, burner: 'health', title: 'Strength', type: 'habit', target: 3, habitPeriod: 'week' });
    let id = root.id;
    const ids = [id];
    for (let i = 0; i < 25; i++) {
      await decideGoal(id, 'carry');
      const nextId = await closeQuarter(q.id, SUMMARY);
      const carried = (await db.goals.get(id))!.carriedToId!;
      expect(carried).toBe(`${root.id}-${nextId}`);
      expect((await db.goals.get(carried))!).toMatchObject({ quarterId: nextId, carriedFromId: id, title: 'Strength' });
      ids.push(carried);
      id = carried;
      q = (await db.quarters.get(nextId))!;
    }
    expect(Math.max(...ids.map((x) => x.length))).toBeLessThanOrEqual(root.id.length + 8);
    expect(new Set(ids).size).toBe(26);
  });

  it('a goal carried by an earlier build (one ending per carry) gets a short id on its next carry', async () => {
    const legacy = `${UUID}-2026-Q1-2026-Q2-2026-Q3`;
    expect(carriedGoalId(legacy, '2026-Q4')).toBe(`${UUID}-2026-Q4`);
    expect(carriedGoalId(`${UUID}-2026-Q3`, '2026-Q4')).toBe(carriedGoalId(UUID, '2026-Q4'));

    const q = await ensureCurrentQuarter();
    const g = await addGoal({ quarterId: q.id, burner: 'health', title: 'Run', type: 'number', target: 100 });
    await db.goals.put({ ...(await db.goals.get(g.id))!, id: legacy });
    await db.goals.delete(g.id);
    await decideGoal(legacy, 'carry');
    await closeQuarter(q.id, SUMMARY);
    expect((await db.goals.get(legacy))!.carriedToId).toBe(`${UUID}-2026-Q4`);
    expect((await db.goals.get(`${UUID}-2026-Q4`))!).toMatchObject({ quarterId: '2026-Q4', carriedFromId: legacy });
  });
});
