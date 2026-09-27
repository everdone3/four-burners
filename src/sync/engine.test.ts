import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FourBurnersDB } from '@/data/db';
import {
  EPOCH_KEY,
  SYNC_SCHEMA,
  cleanString,
  createSyncEngine,
  cursorKey,
  joinStartedKey,
  joinedKey,
  schemaKey,
  syncStateKeys,
  toRemoteRow,
  type SyncEngineOptions,
} from './engine';
import { SyncError, isSyncError } from './remote';
import { SAMPLE_QUARTERS_KEY, isLocalOnly, loadSampleQuarterIds } from './localOnly';
import { createMemoryRemote, type MemoryRemote } from './memoryRemote';
import { PREFILLED_UPDATED_AT, SEED_UPDATED_AT, SYNCED_COLLECTIONS, primaryKeyOf, type Collection } from './types';

// Two devices (separate IndexedDB databases over fake-indexeddb) share one account on an in-memory server
// that behaves like the Supabase SQL. Records are loosely typed on purpose: sync treats them as opaque JSON.

type Rec = Record<string, unknown>;

/** Client timestamps: minutes after 2026-07-01 09:00 UTC. */
const T = (min: number) => new Date(Date.UTC(2026, 6, 1, 9) + min * 60_000).toISOString();

const opened: FourBurnersDB[] = [];
let seq = 0;
function device(): FourBurnersDB {
  const d = new FourBurnersDB(`t-engine-${++seq}-${Math.random().toString(36).slice(2)}`);
  opened.push(d);
  return d;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(opened.splice(0).map((d) => d.delete()));
});

/** Set the clock the engine reads (Date only: IndexedDB keeps its real timers). */
const setClock = (iso: string) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse(iso));
};

const engine = (db: FourBurnersDB, remote: MemoryRemote, extra: Partial<SyncEngineOptions> = {}) =>
  createSyncEngine({ db, remote, accountId: remote.userId, ...extra });

const goal = (id: string, updatedAt: string, patch: Rec = {}): Rec => ({
  id,
  createdAt: T(0),
  updatedAt,
  quarterId: '2026-Q3',
  burner: 'work',
  title: `Goal ${id}`,
  type: 'yesno',
  startDate: '2026-07-01',
  deadline: '2026-09-30',
  order: 0,
  ...patch,
});
const quarter = (id: string, updatedAt: string, patch: Rec = {}): Rec => ({
  id,
  createdAt: T(0),
  updatedAt,
  intents: { family: 'high', friends: 'steady', health: 'steady', work: 'low' },
  intentHistory: [],
  status: 'active',
  ...patch,
});
const profile = (updatedAt: string, patch: Rec = {}): Rec => ({ id: 'me', createdAt: T(0), updatedAt, lifeContext: '', source: 'edited', ...patch });
const log = (id: string, goalId: string, updatedAt: string, patch: Rec = {}): Rec => ({
  id,
  goalId,
  createdAt: T(0),
  updatedAt,
  at: updatedAt,
  localDate: '2026-07-01',
  value: 1,
  ...patch,
});
const kv = (key: string, value: unknown, updatedAt: string): Rec => ({ key, value, updatedAt });

const put = (db: FourBurnersDB, collection: Collection, ...records: Rec[]) => db.table(collection).bulkPut(records);
const edit = (db: FourBurnersDB, collection: Collection, key: string, patch: Rec) => db.table(collection).update(key, patch);
const get = (db: FourBurnersDB, collection: Collection, key: string) => db.table(collection).get(key) as Promise<Rec | undefined>;

/** Every synced (not local-only) record on a device, keyed "collection/id", without _dirty. */
async function synced(db: FourBurnersDB): Promise<Record<string, Rec>> {
  const sampleQuarters = await loadSampleQuarterIds(db);
  const out: Record<string, Rec> = {};
  for (const c of SYNCED_COLLECTIONS) {
    for (const r of (await db.table(c).toArray()) as Rec[]) {
      if (isLocalOnly(c, r, sampleQuarters)) continue;
      const copy = { ...r };
      delete copy._dirty;
      out[`${c}/${String(r[primaryKeyOf(c)])}`] = copy;
    }
  }
  return out;
}

/** "collection/id" of synced records still waiting to be pushed. */
async function dirty(db: FourBurnersDB): Promise<string[]> {
  const sampleQuarters = await loadSampleQuarterIds(db);
  const out: string[] = [];
  for (const c of SYNCED_COLLECTIONS) {
    for (const r of (await db.table(c).toArray()) as Rec[]) {
      if (r._dirty !== 0 && !isLocalOnly(c, r, sampleQuarters)) out.push(`${c}/${String(r[primaryKeyOf(c)])}`);
    }
  }
  return out.sort();
}

const remoteKeys = (remote: MemoryRemote) => remote.rows().map((r) => `${r.collection}/${r.id}`).sort();
const lastServerTime = (remote: MemoryRemote) => remote.rows().at(-1)!.server_updated_at;
const overlapTs = (cursor: string, ms = 300_000) => new Date(Date.parse(cursor.slice(0, 23) + 'Z') - ms).toISOString();

/** A device with a bit of everything that syncs. */
async function fillDevice(db: FourBurnersDB) {
  await put(db, 'quarters', quarter('2026-Q3', T(1), { theme: 'Build' }));
  await put(db, 'goals', goal('g1', T(1)), goal('g2', T(2)));
  await put(db, 'profiles', profile(T(1), { lifeContext: 'Two kids, one job' }));
  await put(db, 'kv', kv('settings', { dayBoundaryHour: 3 }, T(1)), kv('onboarding', { done: true }, T(1)));
}

describe('sync engine: joining', () => {
  it('first device pushes everything, and its own echo leaves it clean', async () => {
    const remote = createMemoryRemote();
    const a = device();
    await fillDevice(a);
    const engA = engine(a, remote);
    expect(await engA.pendingCount()).toBe(6);

    expect(await engA.syncNow()).toEqual({ pushed: 6, pulled: 0, applied: 0 });
    expect(await engA.pendingCount()).toBe(0);
    expect(await dirty(a)).toEqual([]);
    expect(remoteKeys(remote)).toEqual(['goals/g1', 'goals/g2', 'kv/onboarding', 'kv/settings', 'profiles/me', 'quarters/2026-Q3']);
    const g1 = remote.row('goals', 'g1')!;
    expect(g1.data).toEqual(goal('g1', T(1)));
    expect(g1).toMatchObject({ updated_at: T(1), deleted: false });
    expect(remote.row('kv', 'settings')!.data).toEqual(kv('settings', { dayBoundaryHour: 3 }, T(1)));
    expect((await a.kv.get(joinedKey('user-1')))?.value).toBe(true);

    // The next run pulls its own rows back; nothing is rewritten and nothing turns dirty.
    expect(await engA.syncNow()).toEqual({ pushed: 0, pulled: 6, applied: 0 });
    expect(await dirty(a)).toEqual([]);
    expect((await a.kv.get(cursorKey('user-1')))?.value).toBe(lastServerTime(remote));
  });

  it('second device joins and gets everything, clean', async () => {
    const remote = createMemoryRemote();
    const a = device();
    const b = device();
    await fillDevice(a);
    await engine(a, remote).syncNow();

    const engB = engine(b, remote);
    expect(await engB.syncNow()).toEqual({ pushed: 0, pulled: 6, applied: 6 });
    expect(await synced(b)).toEqual(await synced(a));
    expect(await dirty(b)).toEqual([]);
    expect(await engB.pendingCount()).toBe(0);
    expect((await b.kv.get(joinedKey('user-1')))?.value).toBe(true);
    expect((await b.kv.get(cursorKey('user-1')))?.value).toBe(lastServerTime(remote));
    // Records are exactly the remote data (no _dirty leaks into the server copy either).
    expect(await get(b, 'goals', 'g2')).toEqual({ ...goal('g2', T(2)), _dirty: 0 });
  });

  it('join: remote wins over the joining device newer conflicting records, and its unique records are pushed', async () => {
    const remote = createMemoryRemote();
    const a = device();
    const b = device();
    await put(a, 'quarters', quarter('2026-Q3', T(1), { theme: 'Real theme' }));
    await put(a, 'kv', kv('settings', { dayBoundaryHour: 3 }, T(1)), kv('onboarding', { done: true }, T(1)));
    await put(a, 'profiles', profile(T(1), { lifeContext: 'Real profile' }));
    await put(a, 'goals', goal('gA', T(1)));
    const engA = engine(a, remote);
    await engA.syncNow();

    // A fresh device: auto-created quarter, default settings, a restarted onboarding, all NEWER than the account's.
    await put(b, 'quarters', quarter('2026-Q3', T(50)));
    await put(b, 'kv', kv('settings', { dayBoundaryHour: 0 }, T(50)), kv('onboarding', { done: false }, T(50)));
    await put(b, 'profiles', profile(T(50), { lifeContext: 'Fresh' }));
    await put(b, 'goals', goal('gB', T(50)));
    await put(b, 'logs', log('lB', 'gB', T(50)));
    const engB = engine(b, remote);

    expect(await engB.syncNow()).toEqual({ pushed: 2, pulled: 5, applied: 5 });
    expect(await get(b, 'quarters', '2026-Q3')).toEqual({ ...quarter('2026-Q3', T(1), { theme: 'Real theme' }), _dirty: 0 });
    expect(await get(b, 'kv', 'settings')).toEqual({ ...kv('settings', { dayBoundaryHour: 3 }, T(1)), _dirty: 0 });
    expect(await get(b, 'kv', 'onboarding')).toEqual({ ...kv('onboarding', { done: true }, T(1)), _dirty: 0 });
    expect(await get(b, 'profiles', 'me')).toEqual({ ...profile(T(1), { lifeContext: 'Real profile' }), _dirty: 0 });
    expect(await dirty(b)).toEqual([]);
    // The server kept the account's data and gained B's unique records.
    expect(remote.row('profiles', 'me')!.updated_at).toBe(T(1));
    expect(remote.row('quarters', '2026-Q3')!.data.theme).toBe('Real theme');
    expect(remote.row('goals', 'gB')!.data).toEqual(goal('gB', T(50)));
    expect(remote.row('logs', 'lB')).toBeDefined();

    await engA.syncNow();
    expect(await synced(a)).toEqual(await synced(b));
    expect(await dirty(a)).toEqual([]);
  });

  it('an interrupted join resumes from its cursor and still resolves remote-wins', async () => {
    const remote = createMemoryRemote();
    const a = device();
    const b = device();
    await put(a, 'quarters', quarter('2026-Q3', T(1), { theme: 'Real theme' }));
    await put(a, 'goals', goal('g1', T(1)), goal('g2', T(1)), goal('g3', T(1)));
    await put(a, 'profiles', profile(T(1), { lifeContext: 'Real profile' }));
    await put(a, 'kv', kv('settings', { dayBoundaryHour: 3 }, T(1)));
    // Batches of 2 commit separately: [quarter, g1] [g2, g3] [profile, settings].
    const engA = engine(a, remote, { batchSize: 2 });
    await engA.syncNow();
    expect(new Set(remote.rows().map((r) => r.server_updated_at)).size).toBe(3);

    await put(b, 'quarters', quarter('2026-Q3', T(50)));
    await put(b, 'profiles', profile(T(50), { lifeContext: 'Fresh' }));
    await put(b, 'kv', kv('settings', { dayBoundaryHour: 0 }, T(50)));
    await put(b, 'goals', goal('gB', T(50)));
    const engB = engine(b, remote, { batchSize: 2 });

    // Page 1 arrives, page 2 fails (the train enters a tunnel).
    remote.failNextPull({ skip: 1 });
    const pushesBefore = remote.calls.push.length;
    await expect(engB.syncNow()).rejects.toThrow('Network request failed');
    const firstPage = remote.rows().slice(0, 2);
    expect((await b.kv.get(cursorKey('user-1')))?.value).toBe(firstPage[1].server_updated_at);
    expect(await b.kv.get(joinedKey('user-1'))).toBeUndefined();
    expect(remote.calls.push.length).toBe(pushesBefore); // nothing pushed before the join completes
    expect((await get(b, 'quarters', '2026-Q3'))!.theme).toBe('Real theme'); // page 1 applied remote-wins
    expect((await get(b, 'profiles', 'me'))!.lifeContext).toBe('Fresh'); // not reached yet
    expect(remote.row('profiles', 'me')!.data.lifeContext).toBe('Real profile');

    const pullsBefore = remote.calls.pull.length;
    expect(await engB.syncNow()).toEqual({ pushed: 1, pulled: 6, applied: 6 });
    expect(remote.calls.pull[pullsBefore].after).toEqual({ ts: overlapTs(firstPage[1].server_updated_at), collection: '', id: '' });
    expect((await get(b, 'profiles', 'me'))!.lifeContext).toBe('Real profile');
    expect((await get(b, 'kv', 'settings'))!.value).toEqual({ dayBoundaryHour: 3 });
    expect((await b.kv.get(joinedKey('user-1')))?.value).toBe(true);
    expect(await dirty(b)).toEqual([]);
    expect(remote.row('goals', 'gB')).toBeDefined();
    expect(remote.row('profiles', 'me')!.data.lifeContext).toBe('Real profile');

    await engA.syncNow();
    expect(await synced(a)).toEqual(await synced(b));
  });

  it('an edit made between an interrupted join and its resume is kept, pushed, and saved on the server', async () => {
    const remote = createMemoryRemote();
    const phone = device();
    const ipad = device();
    // Batches of 2 commit separately: [g1, g2] [g3, g4] [settings].
    await put(phone, 'goals', goal('g1', T(1)), goal('g2', T(1)), goal('g3', T(1)), goal('g4', T(1)));
    await put(phone, 'kv', kv('settings', { dayBoundaryHour: 3 }, T(1)));
    const engPhone = engine(phone, remote, { batchSize: 2 });
    await engPhone.syncNow();
    // Left on the iPad from before it signed in: still loses to the account's copy.
    await put(ipad, 'kv', kv('settings', { dayBoundaryHour: 0 }, T(50)));

    // The join starts at T(100). Page 1 arrives, then the network drops.
    setClock(T(100));
    remote.failNextPull({ skip: 1 });
    await expect(engine(ipad, remote, { batchSize: 2 }).syncNow()).rejects.toThrow('Network request failed');
    expect(await ipad.kv.get(joinedKey('user-1'))).toBeUndefined();
    expect((await ipad.kv.get(joinStartedKey('user-1')))?.value).toBe(T(100));
    expect(await get(ipad, 'goals', 'g1')).toMatchObject({ title: 'Goal g1', _dirty: 0 });

    // Offline, the user renames g1.
    setClock(T(110));
    await edit(ipad, 'goals', 'g1', { title: 'Renamed on iPad', updatedAt: T(110) });

    // Back online (after signing out and in again, so a new engine): the resumed join re-reads page 1.
    setClock(T(120));
    remote.advance(60_000);
    const pulls = remote.calls.pull.length;
    expect(await engine(ipad, remote, { batchSize: 2 }).syncNow()).toMatchObject({ pushed: 1 });
    expect(remote.calls.pull[pulls].after).not.toBeNull();
    expect(await get(ipad, 'goals', 'g1')).toMatchObject({ title: 'Renamed on iPad', updatedAt: T(110), _dirty: 0 });
    expect(remote.row('goals', 'g1')!.data.title).toBe('Renamed on iPad');
    expect(await get(ipad, 'kv', 'settings')).toMatchObject({ value: { dayBoundaryHour: 3 }, _dirty: 0 });
    expect((await ipad.kv.get(joinedKey('user-1')))?.value).toBe(true);
    expect(await ipad.kv.get(joinStartedKey('user-1'))).toBeUndefined();
    expect(await dirty(ipad)).toEqual([]);

    await engPhone.syncNow();
    expect(await get(phone, 'goals', 'g1')).toMatchObject({ title: 'Renamed on iPad', _dirty: 0 });
  });

  it('join: an edit made while the join is running is kept even when that run fails', async () => {
    const remote = createMemoryRemote();
    const a = device();
    const b = device();
    await put(a, 'goals', goal('g1', T(1)), goal('g2', T(1)), goal('g3', T(1)));
    await engine(a, remote, { batchSize: 2 }).syncNow();

    setClock(T(100));
    const engB = engine(b, remote, { batchSize: 2 });
    // While page 2 is on its way (it then fails), the user edits g1 from page 1.
    remote.beforePull = async (after) => {
      if (!after) return;
      remote.beforePull = undefined;
      await edit(b, 'goals', 'g1', { title: 'Edited mid-join', updatedAt: T(101) });
      remote.failNextPull();
    };
    await expect(engB.syncNow()).rejects.toThrow('Network request failed');
    expect(await engB.syncNow()).toMatchObject({ pushed: 1 });
    expect(await get(b, 'goals', 'g1')).toMatchObject({ title: 'Edited mid-join', _dirty: 0 });
    expect(remote.row('goals', 'g1')!.data.title).toBe('Edited mid-join');
  });

  it('join: a leftover edited during an interrupted join still loses to the account copy', async () => {
    const remote = createMemoryRemote();
    const phone = device();
    const ipad = device();
    // Batches of 2 commit separately: [g1, g2] [g3, g4] [settings].
    await put(phone, 'goals', goal('g1', T(1)), goal('g2', T(1)), goal('g3', T(1)), goal('g4', T(1)));
    await put(phone, 'kv', kv('settings', { dayBoundaryHour: 3, sensitiveTerms: ['Dana'] }, T(1)));
    await engine(phone, remote, { batchSize: 2 }).syncNow();
    await put(ipad, 'kv', kv('settings', { dayBoundaryHour: 0, sensitiveTerms: [] }, T(50)));

    setClock(T(100));
    const engIpad = engine(ipad, remote, { batchSize: 2 });
    remote.failNextPull({ skip: 1 });
    await expect(engIpad.syncNow()).rejects.toThrow('Network request failed');
    // The join has not brought settings over yet. A change now is made to the iPad's own copy.
    setClock(T(110));
    await edit(ipad, 'kv', 'settings', { value: { dayBoundaryHour: 5, sensitiveTerms: [] }, updatedAt: T(110) });

    setClock(T(120));
    remote.advance(60_000);
    expect(await engIpad.syncNow()).toMatchObject({ pushed: 0 });
    expect(await get(ipad, 'kv', 'settings')).toMatchObject({ value: { dayBoundaryHour: 3, sensitiveTerms: ['Dana'] }, _dirty: 0 });
    expect(remote.row('kv', 'settings')!.data.value).toEqual({ dayBoundaryHour: 3, sensitiveTerms: ['Dana'] });
  });

  it('join: a leftover that shares the saved cursor time, but was not pulled yet, still loses', async () => {
    const remote = createMemoryRemote();
    const phone = device();
    const ipad = device();
    // One push, so all four rows share one server time: pages [g1, g2] [g3, settings].
    await put(phone, 'goals', goal('g1', T(1)), goal('g2', T(1)), goal('g3', T(1)));
    await put(phone, 'kv', kv('settings', { dayBoundaryHour: 3 }, T(1)));
    await engine(phone, remote, { batchSize: 4 }).syncNow();
    // Changed on the iPad before it signed in (newer than the account's copy).
    await put(ipad, 'kv', kv('settings', { dayBoundaryHour: 0 }, T(50)));

    setClock(T(100));
    const engIpad = engine(ipad, remote, { batchSize: 2 });
    remote.failNextPull({ skip: 1 });
    await expect(engIpad.syncNow()).rejects.toThrow('Network request failed');
    expect((await ipad.kv.get(cursorKey('user-1')))?.value).toBe(remote.row('kv', 'settings')!.server_updated_at);

    setClock(T(120));
    expect(await engIpad.syncNow()).toMatchObject({ pushed: 0 });
    expect(await get(ipad, 'kv', 'settings')).toMatchObject({ value: { dayBoundaryHour: 3 }, _dirty: 0 });
    expect(remote.row('kv', 'settings')!.data.value).toEqual({ dayBoundaryHour: 3 });
  });

  it('join: two tabs joining at once keep an edit to a record the first tab already pulled', async () => {
    const remote = createMemoryRemote();
    const phone = device();
    await put(phone, 'goals', goal('g1', T(1)), goal('g2', T(1)), goal('g3', T(1)), goal('g4', T(1)));
    await engine(phone, remote, { batchSize: 2 }).syncNow();
    const name = `t-engine-join-tabs-${++seq}-${Math.random().toString(36).slice(2)}`;
    const tabA = new FourBurnersDB(name);
    const tabB = new FourBurnersDB(name);
    opened.push(tabA, tabB);

    // Each tab talks to the server through its own handle (same account).
    const remoteB = remote.forUser('user-1');
    const hold = () => {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let reached!: () => void;
      const waiting = new Promise<void>((r) => (reached = r));
      const wait = () => {
        reached();
        return held;
      };
      return { release, waiting, wait };
    };
    const firstB = hold();
    const secondA = hold();
    // Tab B's first page is slow, so tab A's page 1 lands first. Then tab A's page 2 request hangs.
    remoteB.beforePull = () => {
      remoteB.beforePull = undefined;
      return firstB.wait();
    };
    remote.beforePull = (after) => {
      if (!after) return;
      remote.beforePull = undefined;
      return secondA.wait();
    };

    setClock(T(100));
    const runB = engine(tabB, remoteB, { batchSize: 2 }).syncNow();
    await firstB.waiting;
    const runA = engine(tabA, remote, { batchSize: 2 }).syncNow();
    await secondA.waiting;
    setClock(T(101));
    await edit(tabA, 'goals', 'g1', { title: 'Edited in tab A', updatedAt: T(101) });
    // Tab B's page 1 (read from the beginning) has the old g1: it goes by the cursor tab A saved.
    firstB.release();
    expect(await runB).toMatchObject({ pushed: 1 });
    expect(remoteB.calls.pull[0].after).toBeNull();
    secondA.release();
    await runA;
    expect(await get(tabA, 'goals', 'g1')).toMatchObject({ title: 'Edited in tab A', _dirty: 0 });
    expect(remote.row('goals', 'g1')!.data.title).toBe('Edited in tab A');
  });

  it('join: a pre-filled row on the server counts as a seed (it never replaces a real local edit)', async () => {
    const remote = createMemoryRemote();
    const phone = device();
    const mac = device();
    const ipad = device();
    // The phone closed Q3: next quarter was auto-created and pre-filled with Q3's intents.
    await put(phone, 'quarters', quarter('2026-Q4', PREFILLED_UPDATED_AT, { theme: 'Pre-filled' }));
    await engine(phone, remote).syncNow();
    // The Mac only has its own untouched seed: the pre-fill wins there.
    await put(mac, 'quarters', quarter('2026-Q4', SEED_UPDATED_AT));
    expect(await engine(mac, remote).syncNow()).toEqual({ pushed: 0, pulled: 1, applied: 1 });
    expect(await get(mac, 'quarters', '2026-Q4')).toMatchObject({ theme: 'Pre-filled', updatedAt: PREFILLED_UPDATED_AT, _dirty: 0 });
    // The iPad set Q4 up for real before signing in: that setup is kept and wins on the server.
    await put(ipad, 'quarters', quarter('2026-Q4', T(10), { theme: 'Real setup' }));
    expect(await engine(ipad, remote).syncNow()).toEqual({ pushed: 1, pulled: 1, applied: 0 });
    expect(await get(ipad, 'quarters', '2026-Q4')).toMatchObject({ theme: 'Real setup', _dirty: 0 });
    expect(remote.row('quarters', '2026-Q4')!.data.theme).toBe('Real setup');
  });

  it('join: a seeded row on the server never replaces a real local edit, which is pushed instead', async () => {
    const remote = createMemoryRemote();
    const mac = device();
    const phone = device();
    // The Mac signs in first with only what the app created on its own: this quarter and this week's review.
    await put(mac, 'quarters', quarter('2026-Q3', SEED_UPDATED_AT));
    await put(mac, 'reviews', { id: 'rev-2026-06-29', weekStart: '2026-06-29', step: 0, wins: [], createdAt: T(0), updatedAt: SEED_UPDATED_AT });
    await put(mac, 'kv', kv('settings', { dayBoundaryHour: 0 }, T(2)));
    const engMac = engine(mac, remote);
    await engMac.syncNow();

    // The phone was set up for real before it ever signed in.
    await put(phone, 'quarters', quarter('2026-Q3', T(10), { theme: 'Real theme' }));
    await put(phone, 'reviews', { id: 'rev-2026-06-29', weekStart: '2026-06-29', step: 3, wins: ['Ran twice'], createdAt: T(0), updatedAt: T(11) });
    await put(phone, 'kv', kv('settings', { dayBoundaryHour: 4 }, T(12)));
    const engPhone = engine(phone, remote);

    expect(await engPhone.syncNow()).toEqual({ pushed: 2, pulled: 3, applied: 1 });
    expect(await get(phone, 'quarters', '2026-Q3')).toMatchObject({ theme: 'Real theme', updatedAt: T(10), _dirty: 0 });
    expect(await get(phone, 'reviews', 'rev-2026-06-29')).toMatchObject({ step: 3, updatedAt: T(11), _dirty: 0 });
    // A real row on the server still wins the join, even over a newer local one.
    expect(await get(phone, 'kv', 'settings')).toMatchObject({ value: { dayBoundaryHour: 0 }, _dirty: 0 });
    expect(remote.row('quarters', '2026-Q3')!.data.theme).toBe('Real theme');
    expect(remote.row('reviews', 'rev-2026-06-29')!.updated_at).toBe(T(11));

    await engMac.syncNow();
    expect(await synced(mac)).toEqual(await synced(phone));
    expect(await dirty(mac)).toEqual([]);
    expect(await dirty(phone)).toEqual([]);
  });

  it('join: a clean local record (synced to another account) is kept over a seeded row but not pushed', async () => {
    const remote = createMemoryRemote();
    const a = device();
    const b = device();
    await put(a, 'quarters', quarter('2026-Q3', SEED_UPDATED_AT));
    await engine(a, remote).syncNow();
    await put(b, 'quarters', { ...quarter('2026-Q3', T(10), { theme: 'Other account' }), _dirty: 0 });
    expect(await engine(b, remote).syncNow()).toEqual({ pushed: 0, pulled: 1, applied: 0 });
    expect(await get(b, 'quarters', '2026-Q3')).toMatchObject({ theme: 'Other account', _dirty: 0 });
    expect(remote.row('quarters', '2026-Q3')!.updated_at).toBe(SEED_UPDATED_AT);
  });

  it('join: a seeded local record still loses to the seeded server copy (remote wins on a tie)', async () => {
    const remote = createMemoryRemote();
    const a = device();
    const b = device();
    await put(a, 'quarters', quarter('2026-Q3', SEED_UPDATED_AT, { createdAt: T(1) }));
    await engine(a, remote).syncNow();
    await put(b, 'quarters', quarter('2026-Q3', SEED_UPDATED_AT, { createdAt: T(5) }));
    expect(await engine(b, remote).syncNow()).toEqual({ pushed: 0, pulled: 1, applied: 1 });
    expect(await get(b, 'quarters', '2026-Q3')).toEqual({ ...quarter('2026-Q3', SEED_UPDATED_AT, { createdAt: T(1) }), _dirty: 0 });
  });
});

describe('sync engine: normal sync', () => {
  async function pair(batchSize?: number) {
    const remote = createMemoryRemote();
    const a = device();
    const b = device();
    await put(a, 'goals', goal('g1', T(1)), goal('g2', T(1)), goal('g3', T(1)), goal('g4', T(1)));
    const engA = engine(a, remote, { batchSize });
    const engB = engine(b, remote, { batchSize });
    await engA.syncNow();
    await engB.syncNow();
    return { remote, a, b, engA, engB };
  }

  it('last write wins in both directions, and concurrent edits converge to the newer on both devices', async () => {
    const { remote, a, b, engA, engB } = await pair();

    await edit(a, 'goals', 'g1', { title: 'From A', updatedAt: T(10) });
    await engA.syncNow();
    await engB.syncNow();
    expect((await get(b, 'goals', 'g1'))!.title).toBe('From A');

    await edit(b, 'goals', 'g2', { title: 'From B', updatedAt: T(11) });
    await engB.syncNow();
    await engA.syncNow();
    expect((await get(a, 'goals', 'g2'))!.title).toBe('From B');

    // Same record edited on both devices; the older edit reaches the server first.
    await edit(a, 'goals', 'g3', { title: 'A at 20', updatedAt: T(20) });
    await edit(b, 'goals', 'g3', { title: 'B at 21', updatedAt: T(21) });
    await engA.syncNow();
    await engB.syncNow();
    await engA.syncNow();
    expect((await get(a, 'goals', 'g3'))!.title).toBe('B at 21');
    expect((await get(b, 'goals', 'g3'))!.title).toBe('B at 21');

    // The newer edit reaches the server first; the older push is ignored there, then overwritten locally.
    await edit(a, 'goals', 'g4', { title: 'A at 30', updatedAt: T(30) });
    await edit(b, 'goals', 'g4', { title: 'B at 31', updatedAt: T(31) });
    await engB.syncNow();
    expect(await engA.syncNow()).toEqual({ pushed: 1, pulled: expect.any(Number), applied: 1 });
    expect(remote.lastApplied).toBe(0);
    expect((await get(a, 'goals', 'g4'))!.title).toBe('B at 31');
    expect(remote.row('goals', 'g4')!.updated_at).toBe(T(31));

    await engB.syncNow();
    expect(await synced(a)).toEqual(await synced(b));
    expect(await dirty(a)).toEqual([]);
    expect(await dirty(b)).toEqual([]);
  });

  it('soft deletes propagate as edits (the record stays, marked deleted)', async () => {
    const { remote, a, b, engA, engB } = await pair();
    await edit(a, 'goals', 'g1', { deleted: true, updatedAt: T(10) });
    await engA.syncNow();
    expect(remote.row('goals', 'g1')).toMatchObject({ deleted: true, updated_at: T(10) });
    await engB.syncNow();
    expect(await get(b, 'goals', 'g1')).toMatchObject({ id: 'g1', deleted: true, updatedAt: T(10), _dirty: 0 });
    expect(await b.goals.count()).toBe(4);
  });

  it('a failed push keeps changes queued (dirty) and a later sync delivers them', async () => {
    const { remote, a, engA } = await pair();
    await edit(a, 'goals', 'g1', { title: 'Offline 1', updatedAt: T(10) });
    await edit(a, 'goals', 'g2', { title: 'Offline 2', updatedAt: T(10) });
    expect(await engA.pendingCount()).toBe(2);

    remote.failNextPush();
    const pullsBefore = remote.calls.pull.length;
    await expect(engA.syncNow()).rejects.toThrow('Network request failed');
    expect(await engA.pendingCount()).toBe(2);
    expect(await dirty(a)).toEqual(['goals/g1', 'goals/g2']);
    expect(remote.row('goals', 'g1')!.data.title).toBe('Goal g1');
    expect(remote.calls.pull.length).toBe(pullsBefore); // no pull after a failed push

    expect(await engA.syncNow()).toMatchObject({ pushed: 2, applied: 0 });
    expect(await engA.pendingCount()).toBe(0);
    expect(remote.row('goals', 'g1')!.data.title).toBe('Offline 1');

    // The server applies a push but the response is lost: the retry is harmless and ends clean.
    await edit(a, 'goals', 'g1', { title: 'Lost reply', updatedAt: T(20) });
    remote.failNextPush({ afterApply: true });
    await expect(engA.syncNow()).rejects.toThrow();
    expect(remote.row('goals', 'g1')!.data.title).toBe('Lost reply');
    expect(await engA.pendingCount()).toBe(1);
    expect(await engA.syncNow()).toMatchObject({ pushed: 1, applied: 0 });
    expect(remote.lastApplied).toBe(0);
    expect(await engA.pendingCount()).toBe(0);
  });

  it('an edit made while a push is in flight stays dirty and goes next time', async () => {
    const { remote, a, engA } = await pair();
    await edit(a, 'goals', 'g1', { title: 'Before push', updatedAt: T(10) });
    await edit(a, 'goals', 'g2', { title: 'Before push', updatedAt: T(10) });
    await edit(a, 'goals', 'g3', { title: 'Before push', updatedAt: T(10) });
    remote.beforePush = async () => {
      remote.beforePush = undefined;
      await edit(a, 'goals', 'g1', { title: 'During push', updatedAt: T(11) });
      // Same updatedAt, different content: the full-record comparison still keeps it dirty. (App writes
      // always move updatedAt forward; with an unchanged stamp the server would ignore the retry as a tie.)
      await edit(a, 'goals', 'g2', { title: 'Sneaky' });
    };

    expect(await engA.syncNow()).toMatchObject({ pushed: 3 });
    expect(remote.row('goals', 'g1')!.data.title).toBe('Before push');
    expect(await get(a, 'goals', 'g1')).toMatchObject({ title: 'During push', _dirty: 1 });
    expect(await get(a, 'goals', 'g2')).toMatchObject({ title: 'Sneaky', _dirty: 1 });
    expect(await dirty(a)).toEqual(['goals/g1', 'goals/g2']);
    expect(await engA.pendingCount()).toBe(2);

    await engA.syncNow();
    expect(remote.row('goals', 'g1')!.data.title).toBe('During push');
    expect(await get(a, 'goals', 'g1')).toMatchObject({ title: 'During push', _dirty: 0 });
  });

  it('a pulled record that overwrites an already-clean local record stays clean', async () => {
    const { a, b, engA, engB } = await pair();
    await put(a, 'kv', kv('settings', { dayBoundaryHour: 3 }, T(5)));
    await engA.syncNow();
    await engB.syncNow();
    expect((await get(b, 'goals', 'g1'))!._dirty).toBe(0);
    expect((await get(b, 'kv', 'settings'))!._dirty).toBe(0);

    await edit(a, 'goals', 'g1', { title: 'Changed', updatedAt: T(10) });
    // A whole-record put over a synced record sets _dirty: 1 itself, like repo.ts (see the note there).
    await put(a, 'kv', { ...kv('settings', { dayBoundaryHour: 4 }, T(10)), _dirty: 1 });
    await engA.syncNow();
    expect(await engB.syncNow()).toMatchObject({ pushed: 0, applied: 2 });
    expect(await get(b, 'goals', 'g1')).toMatchObject({ title: 'Changed', _dirty: 0 });
    expect(await get(b, 'kv', 'settings')).toEqual({ ...kv('settings', { dayBoundaryHour: 4 }, T(10)), _dirty: 0 });
    expect(await engB.pendingCount()).toBe(0);
    expect(await dirty(b)).toEqual([]);
    // And the next run has nothing to push.
    expect(await engB.syncNow()).toMatchObject({ pushed: 0 });
  });

  it('a pull overwrites a dirty local record only when the remote row is newer', async () => {
    const { remote, a, b, engA, engB } = await pair();
    await edit(b, 'goals', 'g1', { title: 'B at 20', updatedAt: T(20) });
    await edit(b, 'goals', 'g2', { title: 'B at 40', updatedAt: T(40) });
    await engB.syncNow();
    // A edits both while its push is on the way, so they are still dirty when the pull applies.
    remote.beforePull = async () => {
      remote.beforePull = undefined;
      await edit(a, 'goals', 'g1', { title: 'A at 10', updatedAt: T(10) });
      await edit(a, 'goals', 'g2', { title: 'A at 50', updatedAt: T(50) });
    };
    expect(await engA.syncNow()).toMatchObject({ pushed: 0, applied: 1 });
    expect(await get(a, 'goals', 'g1')).toMatchObject({ title: 'B at 20', _dirty: 0 });
    expect(await get(a, 'goals', 'g2')).toMatchObject({ title: 'A at 50', _dirty: 1 });
    expect(await engA.pendingCount()).toBe(1);

    await engA.syncNow();
    await engB.syncNow();
    expect(await get(b, 'goals', 'g2')).toMatchObject({ title: 'A at 50', _dirty: 0 });
    expect(await synced(a)).toEqual(await synced(b));
  });

  it('a record stamped SEED_UPDATED_AT loses to any real edit, whichever reaches the server first', async () => {
    const { remote, a, b, engA, engB } = await pair();
    // Next quarter auto-created on A, set up for real on B. A syncs first.
    await put(a, 'quarters', quarter('2026-Q4', SEED_UPDATED_AT));
    await put(b, 'quarters', quarter('2026-Q4', T(70), { theme: 'Real' }));
    await engA.syncNow();
    expect(remote.row('quarters', '2026-Q4')!.updated_at).toBe(SEED_UPDATED_AT);
    await engB.syncNow();
    await engA.syncNow();
    // The quarter after that: B syncs first, A's seeded copy is ignored by the server.
    await put(a, 'quarters', quarter('2027-Q1', SEED_UPDATED_AT));
    await put(b, 'quarters', quarter('2027-Q1', T(71), { theme: 'Real too' }));
    await engB.syncNow();
    await engA.syncNow();
    expect(remote.lastApplied).toBe(0);

    for (const d of [a, b]) {
      expect(await get(d, 'quarters', '2026-Q4')).toMatchObject({ theme: 'Real', updatedAt: T(70), _dirty: 0 });
      expect(await get(d, 'quarters', '2027-Q1')).toMatchObject({ theme: 'Real too', updatedAt: T(71), _dirty: 0 });
    }
    expect(remote.row('quarters', '2026-Q4')!.updated_at).toBe(T(70));
    expect(remote.row('quarters', '2027-Q1')!.updated_at).toBe(T(71));
  });

  it('two tabs on one database: a record another tab already cleaned is not re-dirtied', async () => {
    const { remote, a, engA } = await pair();
    const tab2 = engine(a, remote);
    await edit(a, 'goals', 'g1', { title: 'Two tabs', updatedAt: T(10) });
    remote.beforePush = async () => {
      remote.beforePush = undefined;
      await tab2.syncNow(); // the other tab pushes the same record and marks it clean first
    };
    await engA.syncNow();
    expect(await get(a, 'goals', 'g1')).toMatchObject({ title: 'Two tabs', _dirty: 0 });
    expect(await engA.pendingCount()).toBe(0);
    expect(remote.row('goals', 'g1')!.data.title).toBe('Two tabs');
  });

  it('concurrent syncNow calls share one run', async () => {
    const { remote, a, engA } = await pair();
    await edit(a, 'goals', 'g1', { title: 'x', updatedAt: T(10) });
    const pushes = remote.calls.push.length;
    const pulls = remote.calls.pull.length;
    const p1 = engA.syncNow();
    const p2 = engA.syncNow();
    expect(p2).toBe(p1);
    expect(await p2).toMatchObject({ pushed: 1 });
    expect(remote.calls.push.length).toBe(pushes + 1);
    expect(remote.calls.pull.length).toBe(pulls + 1);
    // Once settled, the next call is a new run.
    const p3 = engA.syncNow();
    expect(p3).not.toBe(p1);
    await p3;
  });
});

describe('sync engine: what syncs', () => {
  it('local-only records are never pushed and never overwritten by pulls', async () => {
    const remote = createMemoryRemote();
    const a = device();
    await put(a, 'kv', kv(SAMPLE_QUARTERS_KEY, ['2026-Q2'], T(1)), kv('lastOffsetMin', -300, T(1)), kv('syncCursor:someone', 'x', T(1)));
    await put(a, 'quarters', quarter('2026-Q2', T(1), { theme: 'Sample' }), quarter('2026-Q3', T(1)));
    await put(a, 'goals', goal('sample-g1', T(1)), goal('g-real', T(1)));
    await put(a, 'people', { id: 'sample-p1', name: 'Jake', burner: 'friends', order: 0, createdAt: T(0), updatedAt: T(1) });
    await put(a, 'logs', log('l-on-sample', 'sample-g1', T(1)));
    await put(a, 'touchpoints', { id: 'tp-on-sample', personId: 'sample-p1', type: 'call', createdAt: T(0), updatedAt: T(1) });
    const engA = engine(a, remote);
    expect(await engA.pendingCount()).toBe(2);

    expect(await engA.syncNow()).toMatchObject({ pushed: 2 });
    expect(remoteKeys(remote)).toEqual(['goals/g-real', 'quarters/2026-Q3']);
    expect(await engA.pendingCount()).toBe(0);

    const before = {
      quarter: await get(a, 'quarters', '2026-Q2'),
      goal: await get(a, 'goals', 'sample-g1'),
      log: await get(a, 'logs', 'l-on-sample'),
      touchpoint: await get(a, 'touchpoints', 'tp-on-sample'),
      offset: await get(a, 'kv', 'lastOffsetMin'),
      other: await get(a, 'kv', 'syncCursor:someone'),
      samples: await get(a, 'kv', SAMPLE_QUARTERS_KEY),
      joined: await get(a, 'kv', joinedKey('user-1')),
    };
    // Rows that would clobber them, all newer (they cannot come from this app, but the server must not be trusted blindly).
    const newer = T(99);
    remote.seed([
      { collection: 'quarters', id: '2026-Q2', data: quarter('2026-Q2', newer, { theme: 'Remote' }), updated_at: newer },
      { collection: 'goals', id: 'sample-g1', data: goal('sample-g1', newer, { title: 'Remote' }), updated_at: newer },
      { collection: 'logs', id: 'l-on-sample', data: log('l-on-sample', 'sample-g1', newer, { value: 9 }), updated_at: newer },
      { collection: 'logs', id: 'l-new-on-sample', data: log('l-new-on-sample', 'sample-g1', newer), updated_at: newer },
      { collection: 'touchpoints', id: 'tp-on-sample', data: { id: 'tp-on-sample', personId: 'sample-p1', updatedAt: newer }, updated_at: newer },
      { collection: 'kv', id: 'lastOffsetMin', data: kv('lastOffsetMin', 60, newer), updated_at: newer },
      { collection: 'kv', id: 'syncCursor:someone', data: kv('syncCursor:someone', 'y', newer), updated_at: newer },
      { collection: 'kv', id: SAMPLE_QUARTERS_KEY, data: kv(SAMPLE_QUARTERS_KEY, [], newer), updated_at: newer },
      { collection: 'kv', id: cursorKey('user-1'), data: kv(cursorKey('user-1'), 'bogus', newer), updated_at: newer },
      { collection: 'kv', id: joinedKey('user-1'), data: kv(joinedKey('user-1'), false, newer), updated_at: newer },
    ]);
    expect(await engA.syncNow()).toEqual({ pushed: 0, pulled: 12, applied: 0 });
    expect({
      quarter: await get(a, 'quarters', '2026-Q2'),
      goal: await get(a, 'goals', 'sample-g1'),
      log: await get(a, 'logs', 'l-on-sample'),
      touchpoint: await get(a, 'touchpoints', 'tp-on-sample'),
      offset: await get(a, 'kv', 'lastOffsetMin'),
      other: await get(a, 'kv', 'syncCursor:someone'),
      samples: await get(a, 'kv', SAMPLE_QUARTERS_KEY),
      joined: await get(a, 'kv', joinedKey('user-1')),
    }).toEqual(before);
    expect(await get(a, 'logs', 'l-new-on-sample')).toBeUndefined();
    expect((await a.kv.get(cursorKey('user-1')))?.value).toBe(lastServerTime(remote));
  });

  it('ignores unknown collections and unsynced kv keys, but still moves the cursor past them', async () => {
    const remote = createMemoryRemote();
    const b = device();
    const row = (collection: string, id: string) => ({ collection, id, data: { id, key: id, value: 1, updatedAt: T(1) }, updated_at: T(1) });
    remote.seed([row('widgets', 'w1'), row('Goals', 'g1'), row('kv', 'backupSnoozedUntil'), row('kv', 'lastBackupAt')]);
    remote.seed([{ collection: 'goals', id: 'g-ok', data: goal('g-ok', T(1)), updated_at: T(1) }]);
    remote.seed([row('future_table', 'f1')]);
    const engB = engine(b, remote);

    expect(await engB.syncNow()).toEqual({ pushed: 0, pulled: 6, applied: 1 });
    expect(Object.keys(await synced(b))).toEqual(['goals/g-ok']);
    expect(await b.kv.get('backupSnoozedUntil')).toBeUndefined();
    expect(await b.kv.get('lastBackupAt')).toBeUndefined();
    expect(await b.goals.get('g1')).toBeUndefined();
    expect((await b.kv.get(cursorKey('user-1')))?.value).toBe(remote.row('future_table', 'f1')!.server_updated_at);
  });

  it('toRemoteRow strips local fields, keys kv by key, and stamps SEED_UPDATED_AT when updatedAt is missing', () => {
    expect(toRemoteRow('goals', { ...goal('g1', T(1), { deleted: true }), _dirty: 1 })).toEqual({
      collection: 'goals',
      id: 'g1',
      data: goal('g1', T(1), { deleted: true }),
      updated_at: T(1),
      deleted: true,
    });
    expect(toRemoteRow('kv', { key: 'settings', value: { a: 1 }, _dirty: 1 })).toEqual({
      collection: 'kv',
      id: 'settings',
      data: { key: 'settings', value: { a: 1 } },
      updated_at: SEED_UPDATED_AT,
      deleted: false,
    });
    expect(toRemoteRow('goals', { id: 'g2', updatedAt: 'not a date' }).updated_at).toBe(SEED_UPDATED_AT);
  });

  it('toRemoteRow sends updated_at only in a form the server and every device read the same way', () => {
    const at = (updatedAt: unknown) => toRemoteRow('goals', { id: 'g', updatedAt });
    // No time zone: JS reads local time, Postgres reads UTC. Treated like any unreadable stamp.
    expect(at('2026-07-01T09:00:00').updated_at).toBe(SEED_UPDATED_AT);
    expect(at('Tue Jul 01 2026 09:00:00').updated_at).toBe(SEED_UPDATED_AT);
    expect(at(1751360400000).updated_at).toBe(SEED_UPDATED_AT);
    // Offsets and extra precision are normalized to toISOString (milliseconds, like every client compares).
    expect(at('2026-07-01T11:00:00+02:00').updated_at).toBe('2026-07-01T09:00:00.000Z');
    expect(at('2026-07-01T09:00:00.123456Z').updated_at).toBe('2026-07-01T09:00:00.123Z');
    expect(at(T(1)).updated_at).toBe(T(1));
    // The record body itself is sent as is.
    expect(at('2026-07-01T11:00:00+02:00').data.updatedAt).toBe('2026-07-01T11:00:00+02:00');
  });

  it('a local stamp without a time zone never beats a real pulled edit', async () => {
    const remote = createMemoryRemote();
    const a = device();
    const b = device();
    await put(a, 'goals', goal('g1', T(1)));
    await engine(a, remote).syncNow();
    const engB = engine(b, remote);
    await engB.syncNow();
    // A stamp without a zone counts as the seed here too (as on the server), so it cannot win forever.
    await put(b, 'goals', { ...goal('g1', '2099-01-01T00:00:00', { title: 'Odd stamp' }), _dirty: 0 });
    await edit(a, 'goals', 'g1', { title: 'Real edit', updatedAt: T(30) });
    await engine(a, remote).syncNow();
    expect(await engB.syncNow()).toMatchObject({ applied: 1 });
    expect(await get(b, 'goals', 'g1')).toMatchObject({ title: 'Real edit', _dirty: 0 });
  });
});

describe('sync engine: pulling', () => {
  it('pages by keyset with batchSize 2 over rows that share one server_updated_at', async () => {
    const remote = createMemoryRemote();
    const a = device();
    const b = device();
    await put(a, 'goals', ...['g1', 'g2', 'g3', 'g4', 'g5'].map((id) => goal(id, T(1))));
    await engine(a, remote).syncNow();
    const ts = remote.rows()[0].server_updated_at;
    expect(remote.rows().every((r) => r.server_updated_at === ts)).toBe(true);
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

    const pulls = remote.calls.pull.length;
    expect(await engine(b, remote, { batchSize: 2 }).syncNow()).toEqual({ pushed: 0, pulled: 5, applied: 5 });
    expect(remote.calls.pull.slice(pulls)).toEqual([
      { after: null, limit: 2 },
      { after: { ts, collection: 'goals', id: 'g2' }, limit: 2 },
      { after: { ts, collection: 'goals', id: 'g4' }, limit: 2 },
    ]);
    expect(Object.keys(await synced(b)).sort()).toEqual(['goals/g1', 'goals/g2', 'goals/g3', 'goals/g4', 'goals/g5']);

    // An exact multiple of the page size ends with one empty page.
    await put(a, 'goals', goal('g6', T(2)));
    await engine(a, remote).syncNow();
    const c = device();
    const before = remote.calls.pull.length;
    expect(await engine(c, remote, { batchSize: 3 }).syncNow()).toEqual({ pushed: 0, pulled: 6, applied: 6 });
    expect(remote.calls.pull.length - before).toBe(3);
  });

  it('the overlap window picks up a row that committed late with an older server time', async () => {
    const remote = createMemoryRemote();
    const a = device();
    const b = device();
    await put(a, 'goals', goal('g1', T(1)));
    await engine(a, remote).syncNow();
    const engB = engine(b, remote);
    await engB.syncNow();
    const cursor = (await b.kv.get(cursorKey('user-1')))!.value as string;

    remote.advance(1_000);
    // A transaction that took its now() a minute ago commits only now.
    expect(remote.pushLate([toRemoteRow('goals', goal('g-late', T(5)))], 60_000)).toBe(1);
    expect(remote.row('goals', 'g-late')!.server_updated_at < cursor).toBe(true);

    // Without an overlap the row is skipped for good...
    expect(await engine(b, remote, { overlapMs: 0 }).syncNow()).toMatchObject({ applied: 0 });
    expect(await b.goals.get('g-late')).toBeUndefined();
    // ...with the default 5 minutes it arrives.
    const pulls = remote.calls.pull.length;
    expect(await engB.syncNow()).toMatchObject({ applied: 1 });
    expect(remote.calls.pull[pulls].after).toEqual({ ts: overlapTs(cursor), collection: '', id: '' });
    expect(await get(b, 'goals', 'g-late')).toMatchObject({ title: 'Goal g-late', _dirty: 0 });
    expect((await b.kv.get(cursorKey('user-1')))!.value).toBe(cursor); // the cursor never moves backwards
  });

  it('a damaged saved cursor falls back to a full pull once, then is replaced by a real one', async () => {
    const remote = createMemoryRemote();
    const a = device();
    await put(a, 'goals', goal('g1', T(1)), goal('g2', T(1)));
    const engA = engine(a, remote);
    await engA.syncNow();
    for (const bad of ['garbage', 42, '2026-07-01T12:00:00.000Z']) {
      await a.kv.put({ key: cursorKey('user-1'), value: bad, updatedAt: T(1) });
      const pulls = remote.calls.pull.length;
      expect(await engA.syncNow()).toEqual({ pushed: 0, pulled: 2, applied: 0 });
      expect(remote.calls.pull[pulls].after).toBeNull();
      expect((await a.kv.get(cursorKey('user-1')))?.value).toBe(lastServerTime(remote));
    }
  });

  it('a cursor saved under another sync schema means one full pull (last write wins), then the cursor again', async () => {
    const remote = createMemoryRemote();
    const a = device();
    const b = device();
    await put(a, 'goals', goal('g1', T(1)), goal('g2', T(1)));
    await engine(a, remote).syncNow();
    const engB = engine(b, remote);
    await engB.syncNow();
    expect((await b.kv.get(schemaKey('user-1')))?.value).toBe(SYNC_SCHEMA);
    const cursor = (await b.kv.get(cursorKey('user-1')))!.value as string;

    // A row the build that saved the cursor skipped (say, a collection it did not know yet), long before the cursor.
    remote.advance(60 * 60_000);
    remote.seed([{ collection: 'goals', id: 'g-skipped', data: goal('g-skipped', T(1)), updated_at: T(1), server_updated_at: '2026-06-01T00:00:00.000000Z' }]);
    // Same schema: the cursor stands, so the row is never read.
    let pulls = remote.calls.pull.length;
    expect(await engB.syncNow()).toEqual({ pushed: 0, pulled: 2, applied: 0 });
    expect(remote.calls.pull[pulls].after).toEqual({ ts: overlapTs(cursor), collection: '', id: '' });
    expect(await b.goals.get('g-skipped')).toBeUndefined();

    // Saved by a build that synced something else (or before signatures existed): one full pull.
    for (const old of ['goals,kv;settings', undefined]) {
      if (old) await b.kv.put({ key: schemaKey('user-1'), value: old, updatedAt: T(1) });
      else await b.kv.delete(schemaKey('user-1'));
      await b.goals.delete('g-skipped');
      pulls = remote.calls.pull.length;
      // Last write wins, not the join rule: only the missing row is written.
      expect(await engB.syncNow()).toEqual({ pushed: 0, pulled: 3, applied: 1 });
      expect(remote.calls.pull[pulls].after).toBeNull();
      expect(await get(b, 'goals', 'g-skipped')).toMatchObject({ title: 'Goal g-skipped', _dirty: 0 });
      expect((await b.kv.get(schemaKey('user-1')))?.value).toBe(SYNC_SCHEMA);
      expect((await b.kv.get(cursorKey('user-1')))?.value).toBe(cursor);
      // And the next run resumes from the cursor.
      pulls = remote.calls.pull.length;
      await engB.syncNow();
      expect(remote.calls.pull[pulls].after).toEqual({ ts: overlapTs(cursor), collection: '', id: '' });
    }

    // A join an older build started (a cursor, no signature) starts over from the beginning too.
    const c = device();
    await c.kv.put({ key: cursorKey('user-1'), value: cursor, updatedAt: T(1) });
    pulls = remote.calls.pull.length;
    expect(await engine(c, remote).syncNow()).toEqual({ pushed: 0, pulled: 3, applied: 3 });
    expect(remote.calls.pull[pulls].after).toBeNull();
  });

  it('keeps batchSize within what the server allows (1..1000)', { timeout: 60_000 }, async () => {
    const remote = createMemoryRemote();
    const a = device();
    const b = device();
    const ids = Array.from({ length: 1001 }, (_, i) => `g${String(i).padStart(4, '0')}`);
    await put(a, 'goals', ...ids.map((id) => goal(id, T(1))));
    // push_records takes at most 1000 rows, and pull_records returns at most 1000 however many are asked for.
    expect(await engine(a, remote, { batchSize: 5000 }).syncNow()).toMatchObject({ pushed: 1001 });
    expect(remote.calls.push.map((p) => p.length)).toEqual([1000, 1]);
    expect(await engine(b, remote, { batchSize: 5000 }).syncNow()).toEqual({ pushed: 0, pulled: 1001, applied: 1001 });
    expect(remote.calls.pull.slice(-2).map((p) => p.limit)).toEqual([1000, 1000]);
    expect(await b.goals.count()).toBe(1001);
  });

  it('falls back to safe options instead of skipping rows or looping', async () => {
    const remote = createMemoryRemote();
    const a = device();
    await put(a, 'goals', goal('g1', T(1)), goal('g2', T(1)));
    await engine(a, remote).syncNow();
    const c = device();
    await put(c, 'goals', goal('c1', T(2)));
    const engC = engine(c, remote, { batchSize: Number.NaN, overlapMs: -60_000 });
    expect(await engC.syncNow()).toEqual({ pushed: 1, pulled: 2, applied: 2 });
    expect(remote.calls.pull.at(-1)!.limit).toBe(200);
    const cursor = (await c.kv.get(cursorKey('user-1')))!.value as string;
    const pulls = remote.calls.pull.length;
    // A negative overlap would start after the cursor and skip rows; it counts as 0.
    await engC.syncNow();
    expect(remote.calls.pull[pulls].after).toEqual({ ts: overlapTs(cursor, 0), collection: '', id: '' });
  });

  it('SyncResult counts rows sent, rows received (overlap re-reads included), and rows written', async () => {
    const remote = createMemoryRemote();
    const a = device();
    const b = device();
    await put(a, 'goals', goal('g1', T(1)), goal('g2', T(1)), goal('g3', T(1)));
    const engA = engine(a, remote);
    expect(await engA.syncNow()).toEqual({ pushed: 3, pulled: 0, applied: 0 });
    expect(await engA.syncNow()).toEqual({ pushed: 0, pulled: 3, applied: 0 });

    remote.advance(10 * 60_000);
    await put(b, 'goals', goal('g1', T(9), { title: 'Newer but joining' }), goal('gB', T(9)));
    expect(await engine(b, remote).syncNow()).toEqual({ pushed: 1, pulled: 3, applied: 3 });

    // A's cursor is its own push, so the overlap re-reads those 3 rows along with B's new one.
    expect(await engA.syncNow()).toEqual({ pushed: 0, pulled: 4, applied: 1 });
    remote.advance(10 * 60_000);
    expect(await engA.syncNow()).toEqual({ pushed: 0, pulled: 1, applied: 0 });
    expect(await engA.syncNow()).toEqual({ pushed: 0, pulled: 1, applied: 0 });
  });
});

describe('sync engine: accounts', () => {
  it('forget() clears the account keys, and the next sync is a join again (remote wins)', async () => {
    const remote = createMemoryRemote();
    const a = device();
    const b = device();
    await put(a, 'profiles', profile(T(1), { lifeContext: 'Account' }));
    await engine(a, remote).syncNow();
    const engB = engine(b, remote);
    await engB.syncNow();
    await engB.syncNow();
    expect(await b.kv.get(cursorKey('user-1'))).toBeDefined();

    await edit(b, 'profiles', 'me', { lifeContext: 'Local only change', updatedAt: T(60) });
    expect(await b.kv.get(EPOCH_KEY)).toBeDefined();
    expect(await b.kv.get(schemaKey('user-1'))).toBeDefined();
    await engB.forget();
    expect(syncStateKeys('user-1')).toEqual([cursorKey('user-1'), joinedKey('user-1'), joinStartedKey('user-1'), schemaKey('user-1'), EPOCH_KEY]);
    expect(await b.kv.bulkGet(syncStateKeys('user-1'))).toEqual([undefined, undefined, undefined, undefined, undefined]);

    const pulls = remote.calls.pull.length;
    expect(await engB.syncNow()).toEqual({ pushed: 0, pulled: 1, applied: 1 });
    expect(remote.calls.pull[pulls].after).toBeNull();
    expect(await get(b, 'profiles', 'me')).toMatchObject({ lifeContext: 'Account', _dirty: 0 });
    expect((await b.kv.get(joinedKey('user-1')))?.value).toBe(true);
  });

  it('a run in flight writes nothing after forget()', async () => {
    const remote = createMemoryRemote();
    const a = device();
    const c = device();
    await put(a, 'goals', goal('g1', T(1)));
    await engine(a, remote).syncNow();

    const engC = engine(c, remote);
    remote.beforePull = async () => {
      remote.beforePull = undefined;
      await engC.forget(); // "Erase all data on this device" while the first page is on its way
    };
    await expect(engC.syncNow()).rejects.toThrow('Sync was reset on this device.');
    expect(await c.goals.count()).toBe(0);
    expect(await c.kv.get(cursorKey('user-1'))).toBeUndefined();
    expect(await c.kv.get(joinedKey('user-1'))).toBeUndefined();

    expect(await engC.syncNow()).toEqual({ pushed: 0, pulled: 1, applied: 1 });
  });

  it('a run sends no further batches after forget(), even when the reset lands between batches', async () => {
    const remote = createMemoryRemote();
    const a = device();
    await put(a, 'goals', goal('g1', T(1)), goal('g2', T(1)), goal('g3', T(1)));
    const engA = engine(a, remote, { batchSize: 1 });
    // The erase arrives while batch 1 is being marked clean (after that step's own check passed).
    let reset = false;
    a.goals.hook('updating', (mods) => {
      if (!reset && (mods as Rec)._dirty === 0) {
        reset = true;
        void engA.forget();
      }
      return undefined;
    });
    await expect(engA.syncNow()).rejects.toThrow('Sync was reset on this device.');
    expect(reset).toBe(true);
    expect(remote.calls.push).toHaveLength(1);
    expect(remoteKeys(remote)).toEqual(['goals/g1']);
    expect(await dirty(a)).toEqual(['goals/g2', 'goals/g3']);
    expect(await a.kv.get(joinedKey('user-1'))).toBeUndefined();
  });

  it('an erase in another tab stops a run in this tab before it writes rows or a cursor', async () => {
    const remote = createMemoryRemote();
    const phone = device();
    await put(phone, 'goals', goal('g1', T(1)), goal('g2', T(1)), goal('g3', T(1)), goal('g4', T(1)));
    const engPhone = engine(phone, remote);
    await engPhone.syncNow();
    remote.advance(86_400_000);
    // Two tabs on the Mac: two connections to one database, each with its own engine.
    const name = `t-engine-tabs-${++seq}-${Math.random().toString(36).slice(2)}`;
    const tabA = new FourBurnersDB(name);
    const tabB = new FourBurnersDB(name);
    opened.push(tabA, tabB);
    const engA = engine(tabA, remote);
    const engB = engine(tabB, remote);
    await engA.syncNow();
    remote.advance(86_400_000);
    await edit(phone, 'goals', 'g4', { title: 'Edited on phone', updatedAt: T(3000) });
    await engPhone.syncNow();

    // Tab B's interval pull is on its way when tab A erases the device (forget, then the wipe).
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const pulling = new Promise<void>((r) => (reached = r));
    remote.beforePull = async () => {
      remote.beforePull = undefined;
      reached();
      await held;
    };
    const runB = engB.syncNow().catch((e: unknown) => e);
    await pulling;
    await engA.forget();
    await tabA.transaction('rw', tabA.tables, async () => {
      await Promise.all(tabA.tables.map((t) => t.clear()));
    });
    release();
    expect(String(await runB)).toContain('Sync was reset on this device.');
    expect(await tabA.goals.count()).toBe(0);
    expect(await tabA.kv.count()).toBe(0);

    // Signing in again is a full join: nothing older is skipped.
    await engine(tabA, remote).syncNow();
    expect((await tabA.goals.toArray()).map((g) => g.id).sort()).toEqual(['g1', 'g2', 'g3', 'g4']);
  });

  it('keeps cursor and join state per account, and each account only sees its own rows', async () => {
    const remote = createMemoryRemote({ userId: 'user-1' });
    const other = remote.forUser('user-2');
    const a = device();
    await put(a, 'goals', goal('g1', T(1)));
    const eng1 = engine(a, remote);
    await eng1.syncNow();
    await eng1.syncNow();
    const cursor1 = (await a.kv.get(cursorKey('user-1')))!.value;
    expect(cursor1).toBe(lastServerTime(remote));

    other.seed([{ collection: 'goals', id: 'g-other', data: goal('g-other', T(1)), updated_at: T(1) }]);
    expect(remoteKeys(remote)).toEqual(['goals/g1']);
    expect(remoteKeys(other)).toEqual(['goals/g-other']);

    const eng2 = engine(a, other);
    const pulls = other.calls.pull.length;
    expect(await eng2.syncNow()).toEqual({ pushed: 0, pulled: 1, applied: 1 });
    expect(other.calls.pull[pulls].after).toBeNull(); // a join, even though user-1 joined long ago
    expect((await a.kv.get(joinedKey('user-2')))?.value).toBe(true);
    expect((await a.kv.get(cursorKey('user-2')))!.value).toBe(lastServerTime(other));
    expect((await a.kv.get(cursorKey('user-1')))!.value).toBe(cursor1);
    expect((await a.kv.get(joinedKey('user-1')))?.value).toBe(true);

    await eng2.forget();
    expect((await a.kv.get(joinedKey('user-1')))?.value).toBe(true);
    expect((await a.kv.get(cursorKey('user-1')))!.value).toBe(cursor1);
  });
});

describe('memory remote', () => {
  it('applies strictly newer rows, keeps the newest duplicate, and stamps one server time per push', async () => {
    const remote = createMemoryRemote();
    const row = (id: string, updatedAt: string, title: string) => toRemoteRow('goals', goal(id, updatedAt, { title }));
    await remote.push([row('g1', T(2), 'new'), row('g1', T(1), 'old'), row('g2', T(1), 'x')]);
    expect(remote.lastApplied).toBe(2);
    expect(remote.row('goals', 'g1')!.data.title).toBe('new');
    expect(remote.row('goals', 'g1')!.server_updated_at).toBe(remote.row('goals', 'g2')!.server_updated_at);
    await remote.push([row('g1', T(2), 'same time'), row('g2', T(0), 'older')]);
    expect(remote.lastApplied).toBe(0);
    expect(remote.row('goals', 'g1')!.data.title).toBe('new');
    // A bad row rejects the whole call.
    await expect(remote.push([row('g3', T(5), 'ok'), { ...row('g4', T(5), 'bad'), updated_at: 'nope' }])).rejects.toThrow();
    expect(remote.row('goals', 'g3')).toBeUndefined();
  });

  it('orders pulls by server time, then collection and id bytewise, strictly after the cursor', async () => {
    const remote = createMemoryRemote();
    const r = (collection: string, id: string) => ({ collection, id, data: {}, updated_at: T(1) });
    remote.seed([r('goals', 'b'), r('goals', 'B'), r('goals', 'a'), r('kv', 'settings'), r('Zeta', 'x'), r('goals', 'é'), r('goals', 'z')]);
    const ts = remote.rows()[0].server_updated_at;
    expect(remote.rows().map((x) => `${x.collection}/${x.id}`)).toEqual(['Zeta/x', 'goals/B', 'goals/a', 'goals/b', 'goals/z', 'goals/é', 'kv/settings']);
    expect((await remote.pull({ ts, collection: 'goals', id: 'a' }, 2)).map((x) => x.id)).toEqual(['b', 'z']);
    // A plain toISOString lower bound (the overlap start) sorts before every 6-digit time in that millisecond.
    expect(await remote.pull({ ts: ts.slice(0, 23) + 'Z', collection: '', id: '' }, 1000)).toHaveLength(7);
    expect(await remote.pull({ ts, collection: 'kv', id: 'settings' }, 10)).toEqual([]);
    expect(await remote.pull(null, 0)).toHaveLength(1); // limit clamps to 1..1000
  });

  it('rejects what push_records rejects: more than 1000 rows, and ids or collections outside 1..200 characters', async () => {
    const remote = createMemoryRemote();
    const row = (id: string) => toRemoteRow('goals', goal(id, T(1)));
    await expect(remote.push(Array.from({ length: 1001 }, (_, i) => row(`g${i}`)))).rejects.toThrow();
    await expect(remote.push([row('ok'), row('x'.repeat(201))])).rejects.toThrow();
    await expect(remote.push([{ ...row('ok'), collection: '' as never }])).rejects.toThrow();
    expect(remote.rows()).toEqual([]);
    // char_length counts characters, not UTF-16 units.
    await remote.push([row('😀'.repeat(200))]);
    await remote.push(Array.from({ length: 1000 }, (_, i) => row(`g${i}`)));
    expect(remote.rows()).toHaveLength(1001);
  });
});

describe('sync engine: one bad record never blocks the rest', () => {
  it('cleanString drops NUL and replaces lone surrogates, keeping real emoji', () => {
    expect(cleanString('a\u0000b')).toBe('ab');
    expect(cleanString('ok 😀')).toBe('ok 😀');
    expect(cleanString('cut \uD83D')).toBe('cut �');
    expect(cleanString('\uDE00 tail')).toBe('� tail');
    const row = toRemoteRow('goals', { id: 'g', updatedAt: T(1), title: 'x\u0000', notes: ['\uD83D'], nested: { ['k\u0000']: 'v' } });
    expect(row.data).toMatchObject({ title: 'x', notes: ['�'], nested: { k: 'v' } });
  });

  it('an updatedAt outside years 1 to 9999 is sent as the seed stamp', () => {
    expect(toRemoteRow('goals', { id: 'g', updatedAt: '+010000-01-01T00:00:00.000Z' }).updated_at).toBe(SEED_UPDATED_AT);
    expect(toRemoteRow('goals', { id: 'g', updatedAt: new Date(Date.UTC(10000, 0, 1)).toISOString() }).updated_at).toBe(SEED_UPDATED_AT);
  });

  it('a record the server refuses is isolated: everything else syncs, it stays dirty, and the run reports it', async () => {
    const remote = createMemoryRemote();
    const a = device();
    const b = device();
    await put(a, 'goals', goal('g1', T(1)), goal('bad', T(1)), goal('g3', T(1)), goal('g4', T(1)), goal('g5', T(1)));
    remote.beforePush = (rows) => {
      if (rows.some((r) => r.id === 'bad')) throw new SyncError('server', { status: 400, rejected: true });
    };
    const engA = engine(a, remote);
    const err = await engA.syncNow().catch((e) => e);
    expect(isSyncError(err) && err.rejected).toBe(true);
    expect(String(err.message)).toContain("1 change couldn't be saved");
    expect(Object.keys(await synced(a)).length).toBe(5);
    expect(remote.rows().map((r) => r.id).sort()).toEqual(['g1', 'g3', 'g4', 'g5']);
    expect(await dirty(a)).toEqual(['goals/bad']);
    // The joining pull still ran, and a second device gets everything that was saved.
    await engine(b, remote).syncNow();
    expect(Object.keys(await synced(b)).sort()).toEqual(['goals/g1', 'goals/g3', 'goals/g4', 'goals/g5']);
    // Once the server accepts it (for example after an edit), it syncs like anything else.
    remote.beforePush = undefined;
    await edit(a, 'goals', 'bad', { title: 'Fixed', updatedAt: T(5) });
    expect(await engA.syncNow()).toMatchObject({ pushed: 1 });
    expect(await engA.pendingCount()).toBe(0);
  });

  it('a network failure is not treated as a refused record (nothing is split, the error propagates)', async () => {
    const remote = createMemoryRemote();
    const a = device();
    await put(a, 'goals', goal('g1', T(1)), goal('g2', T(1)));
    const engA = engine(a, remote);
    await engA.syncNow();
    await edit(a, 'goals', 'g1', { title: 'x', updatedAt: T(2) });
    await edit(a, 'goals', 'g2', { title: 'y', updatedAt: T(2) });
    const pushesBefore = remote.calls.push.length;
    remote.failNextPush({ error: new SyncError('offline') });
    await expect(engA.syncNow()).rejects.toMatchObject({ kind: 'offline' });
    expect(remote.calls.push.length - pushesBefore).toBe(1);
    expect(await engA.pendingCount()).toBe(2);
  });

  it('caps each push request at about 512 KB of JSON', async () => {
    const remote = createMemoryRemote();
    const a = device();
    const big = 'x'.repeat(200 * 1024);
    await put(a, 'goals', goal('g1', T(1), { notes: big }), goal('g2', T(1), { notes: big }), goal('g3', T(1), { notes: big }), goal('g4', T(1)));
    await engine(a, remote).syncNow();
    expect(remote.calls.push.map((rows) => rows.length)).toEqual([2, 2]);
    expect(remote.rows()).toHaveLength(4);
  });
});
