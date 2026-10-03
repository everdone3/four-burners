import 'fake-indexeddb/auto';
import { liveQuery } from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_PROFILE_FIELDS } from '@/domain';
import { SAMPLE_QUARTERS_KEY } from '@/sync/localOnly';
import { SYNCED_COLLECTIONS, type Collection } from '@/sync/types';
import { setClockOffset, travelTo } from './clock';
import {
  BACKUP_FORMAT,
  BACKUP_REMINDER_START_KEY,
  BACKUP_SNOOZE_KEY,
  BACKUP_VERSION,
  BackupError,
  LAST_BACKUP_KEY,
  backupFileName,
  buildBackupFile,
  exportBackup,
  getBackupReminder,
  importBackup,
  markBackedUp,
  saveBackupFile,
  snoozeBackupReminder,
  type BackupFile,
} from './backup';
import { db } from './db';
import {
  addAction,
  addGoal,
  closeQuarter,
  completeReview,
  deleteGoal,
  editLog,
  getOrCreateReview,
  logProgress,
  logTouchpoint,
  saveCoachReply,
  saveOnboarding,
  saveProfile,
  saveReview,
  saveSettings,
  setEnergy,
  startCrunch,
  toggleAction,
} from './repo';
import { loadSampleData } from './sample';

// backup.ts uses the shared db singleton, so every test starts from empty tables.
beforeEach(async () => {
  await db.transaction('rw', db.tables, async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Row = Record<string, unknown>;
const T1 = '2026-07-01T10:00:00.000Z';
const T2 = '2026-08-01T10:00:00.000Z';
const T3 = '2026-09-01T10:00:00.000Z';

const quarter = (id: string, updatedAt: string, extra: Row = {}) => ({
  id,
  createdAt: T1,
  updatedAt,
  intents: { family: 'steady', friends: 'steady', health: 'steady', work: 'steady' },
  intentHistory: [],
  status: 'active',
  ...extra,
});
const goal = (id: string, updatedAt: string, extra: Row = {}) => ({
  id,
  createdAt: T1,
  updatedAt,
  quarterId: '2026-Q3',
  burner: 'work',
  title: `Goal ${id}`,
  type: 'yesno',
  startDate: '2026-07-01',
  deadline: '2026-09-30',
  order: 0,
  ...extra,
});
const log = (id: string, goalId: string, updatedAt: string, extra: Row = {}) => ({
  id,
  goalId,
  value: 1,
  at: updatedAt,
  offsetMin: -240,
  localDate: updatedAt.slice(0, 10),
  createdAt: updatedAt,
  updatedAt,
  ...extra,
});

async function put(collection: Collection, ...rows: Row[]) {
  await db.table(collection).bulkPut(rows);
}
const get = (collection: Collection, key: string) => db.table(collection).get(key) as Promise<Row | undefined>;
async function markAllClean() {
  await db.transaction('rw', db.tables, async () => {
    for (const c of SYNCED_COLLECTIONS) {
      const t = db.table(c);
      for (const key of await t.toCollection().primaryKeys()) await t.update(key, { _dirty: 0 });
    }
  });
}
async function counts() {
  return Object.fromEntries(await Promise.all(SYNCED_COLLECTIONS.map(async (c) => [c, await db.table(c).count()])));
}
const file = (tables: Row, extra: Row = {}) => JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, schemaVersion: 4, exportedAt: T3, app: { name: 'Four Burners' }, tables, ...extra });

/** A device with real data, sample data, device-local keys, and a soft-deleted goal. */
async function seedDevice() {
  await put('quarters', quarter('2026-Q3', T2, { theme: 'Strong' }), quarter('2026-Q2', T1, { theme: 'Sample' }));
  await put('goals', goal('g1', T2), goal('g2', T2, { deleted: true }), goal('sample-goal-1', T1));
  await put('logs', log('l1', 'g1', T2), log('l-on-sample', 'sample-goal-1', T2));
  await put('people', { id: 'p1', name: 'Jake', burner: 'friends', cadenceDays: 14, order: 0, createdAt: T1, updatedAt: T1 });
  await put(
    'kv',
    { key: 'settings', value: { reviewDay: 6 }, updatedAt: T2 },
    { key: 'onboarding', value: { step: 2 }, updatedAt: T2 },
    { key: 'lastOffsetMin', value: -240, updatedAt: T2 },
    { key: SAMPLE_QUARTERS_KEY, value: ['2026-Q2'], updatedAt: T2 },
    { key: LAST_BACKUP_KEY, value: T1, updatedAt: T1 },
  );
}

describe('exportBackup', () => {
  it('covers exactly what syncs: no local-only records, no _dirty, soft-deleted records included', async () => {
    await seedDevice();
    const now = new Date('2026-09-26T12:00:00.000Z');
    const b = await exportBackup(now);
    expect(b).toMatchObject({ format: BACKUP_FORMAT, version: BACKUP_VERSION, schemaVersion: db.verno, exportedAt: now.toISOString(), app: { name: 'Four Burners' } });
    expect(Object.keys(b.tables).sort()).toEqual([...SYNCED_COLLECTIONS].sort());
    const ids = (c: Collection) => (b.tables[c] ?? []).map((r) => r.id ?? r.key).sort();
    expect(ids('quarters')).toEqual(['2026-Q3']);
    expect(ids('goals')).toEqual(['g1', 'g2']);
    expect(ids('logs')).toEqual(['l1']);
    expect(ids('people')).toEqual(['p1']);
    expect(ids('kv')).toEqual(['onboarding', 'settings']);
    expect(b.tables.goals!.find((g) => g.id === 'g2')!.deleted).toBe(true);
    for (const c of SYNCED_COLLECTIONS) for (const r of b.tables[c]!) expect(r).not.toHaveProperty('_dirty');
  });

  it('builds a dated application/json file', async () => {
    await seedDevice();
    const f = await buildBackupFile(new Date(2026, 8, 26, 23, 59));
    expect(f.name).toBe('four-burners-backup-2026-09-26.json');
    expect(f.type).toBe('application/json');
    const parsed = JSON.parse(await f.text()) as BackupFile;
    expect(parsed.format).toBe(BACKUP_FORMAT);
    expect(parsed.tables.goals).toHaveLength(2);
  });

  it('can be built inside a live query (how the UI prebuilds it) and is rebuilt when data changes', async () => {
    await seedDevice();
    const files: File[] = [];
    const errors: unknown[] = [];
    const sub = liveQuery(() => buildBackupFile()).subscribe({ next: (f) => files.push(f), error: (e) => errors.push(e) });
    try {
      await vi.waitFor(() => expect(files.length).toBe(1));
      await put('goals', goal('g3', T3));
      await vi.waitFor(() => expect(files.length).toBe(2));
    } finally {
      sub.unsubscribe();
    }
    expect(errors).toEqual([]);
    const latest = JSON.parse(await files[1].text()) as BackupFile;
    expect(latest.tables.goals!.map((g) => g.id).sort()).toEqual(['g1', 'g2', 'g3']);
  });

  it('backupFileName uses the local date', () => {
    expect(backupFileName(new Date(2026, 0, 5, 0, 1))).toBe('four-burners-backup-2026-01-05.json');
    expect(backupFileName(new Date(2026, 11, 31, 23, 59))).toBe('four-burners-backup-2026-12-31.json');
  });
});

describe('importBackup', () => {
  it('round trips into an empty database, and imported records are dirty', async () => {
    await seedDevice();
    const text = JSON.stringify(await exportBackup());
    const original = Object.fromEntries(await Promise.all(SYNCED_COLLECTIONS.map(async (c) => [c, await db.table(c).toArray()])));
    await db.transaction('rw', db.tables, async () => {
      await Promise.all(db.tables.map((t) => t.clear()));
    });

    const summary = await importBackup(text);
    expect(summary).toEqual({ added: 7, updated: 0, skipped: 0 });
    for (const [c, key] of [['quarters', '2026-Q3'], ['goals', 'g1'], ['goals', 'g2'], ['logs', 'l1'], ['people', 'p1'], ['kv', 'settings'], ['kv', 'onboarding']] as const) {
      const before = (original[c] as Row[]).find((r) => (r.id ?? r.key) === key)!;
      const after = (await get(c, key))!;
      const { _dirty: _a, ...restBefore } = before;
      const { _dirty: _b, ...restAfter } = after;
      expect(restAfter).toEqual(restBefore);
      expect(after._dirty).toBe(1);
    }
    expect(await db.goals.count()).toBe(2);
    expect(await db.kv.get('lastOffsetMin')).toBeUndefined();
  });

  it('merges: adds missing, replaces only when strictly newer, never deletes; replaced records become dirty', async () => {
    await put('goals', goal('older', T1, { title: 'Local old' }), goal('newer', T3, { title: 'Local new' }), goal('same', T2, { title: 'Local same' }), goal('only-local', T1));
    await markAllClean();
    const summary = await importBackup(
      file({
        goals: [
          goal('older', T2, { title: 'From file' }),
          goal('newer', T2, { title: 'Stale file' }),
          goal('same', T2, { title: 'File same' }),
          goal('missing', T1, { title: 'Brand new', deleted: true }),
        ],
      }),
    );
    expect(summary).toEqual({ added: 1, updated: 1, skipped: 2 });
    expect(await get('goals', 'older')).toMatchObject({ title: 'From file', updatedAt: T2, _dirty: 1 });
    expect(await get('goals', 'newer')).toMatchObject({ title: 'Local new', _dirty: 0 });
    expect(await get('goals', 'same')).toMatchObject({ title: 'Local same', _dirty: 0 });
    expect(await get('goals', 'missing')).toMatchObject({ title: 'Brand new', deleted: true, _dirty: 1 });
    expect(await get('goals', 'only-local')).toBeDefined();
    expect(await db.goals.count()).toBe(5);
  });

  it('importing this device\'s own backup changes nothing and leaves clean records clean', async () => {
    await seedDevice();
    await markAllClean();
    const text = JSON.stringify(await exportBackup());
    expect(await importBackup(text)).toEqual({ added: 0, updated: 0, skipped: 7 });
    for (const c of SYNCED_COLLECTIONS) for (const r of (await db.table(c).toArray()) as Row[]) expect(r._dirty, `${c}`).toBe(0);
  });

  it('is all or nothing: a failed write rolls back the records already written', async () => {
    // Goals are written first; then the log write fails.
    const fail = () => {
      throw new Error('disk full');
    };
    db.logs.hook('creating', fail);
    try {
      await expect(importBackup(file({ goals: [goal('g', T1)], logs: [log('l', 'g', T1)] }))).rejects.toThrow('disk full');
    } finally {
      db.logs.hook('creating').unsubscribe(fail);
    }
    expect(await db.goals.count()).toBe(0);
    expect(await db.logs.count()).toBe(0);
  });

  it('keeps the newest copy when a file lists a record twice', async () => {
    const summary = await importBackup(file({ goals: [goal('g', T3, { title: 'Newest' }), goal('g', T1, { title: 'Old' })] }));
    expect(summary).toEqual({ added: 1, updated: 0, skipped: 0 });
    expect((await get('goals', 'g'))!.title).toBe('Newest');
  });

  it('never touches local-only records, and skips local-only records in the file', async () => {
    await seedDevice();
    await markAllClean();
    const summary = await importBackup(
      file({
        quarters: [quarter('2026-Q2', T3, { theme: 'From file' })], // a sample quarter on this device
        goals: [goal('sample-goal-9', T3)],
        logs: [log('l-real-on-sample', 'sample-goal-1', T3)],
        kv: [
          { key: 'lastOffsetMin', value: 600, updatedAt: T3 },
          { key: SAMPLE_QUARTERS_KEY, value: [], updatedAt: T3 },
          { key: LAST_BACKUP_KEY, value: T3, updatedAt: T3 },
          { key: 'settings', value: { reviewDay: 2 }, updatedAt: T3 },
        ],
      }),
    );
    expect(summary).toEqual({ added: 0, updated: 1, skipped: 6 });
    expect(await get('quarters', '2026-Q2')).toMatchObject({ theme: 'Sample', _dirty: 0 });
    expect(await get('goals', 'sample-goal-9')).toBeUndefined();
    expect(await get('logs', 'l-real-on-sample')).toBeUndefined();
    expect((await get('kv', 'lastOffsetMin'))!.value).toBe(-240);
    expect((await get('kv', SAMPLE_QUARTERS_KEY))!.value).toEqual(['2026-Q2']);
    expect((await get('kv', LAST_BACKUP_KEY))!.value).toBe(T1);
    expect((await get('kv', 'settings'))!.value).toEqual({ reviewDay: 2 });
  });

  it('ignores collections this build does not know', async () => {
    const summary = await importBackup(file({ widgets: 'not even an array', goals: [goal('g', T1)] }));
    expect(summary).toEqual({ added: 1, updated: 0, skipped: 0 });
  });

  it('rejects invalid files with a BackupError and writes nothing', async () => {
    await seedDevice();
    const before = await counts();
    const valid = goal('new-one', T3);
    const bad: Array<[string, string, RegExp]> = [
      ['not json', 'hello there', /not a Four Burners backup/],
      ['an array', '[]', /not a Four Burners backup/],
      ['wrong format', file({}, { format: 'something-else' }), /not a Four Burners backup/],
      ['newer version', file({}, { version: BACKUP_VERSION + 1 }), /newer version of Four Burners/],
      ['version as text', file({}, { version: '1' }), /damaged/],
      ['version zero', file({}, { version: 0 }), /damaged/],
      ['no tables', JSON.stringify({ format: BACKUP_FORMAT, version: 1 }), /damaged/],
      ['tables is an array', file({}, { tables: [] }), /damaged/],
      ['collection not an array', file({ goals: { g: valid } }), /damaged/],
      ['record not an object', file({ goals: [valid, 42] }), /damaged/],
      ['record is null', file({ goals: [null] }), /damaged/],
      ['record is an array', file({ goals: [[valid]] }), /damaged/],
      ['numeric id', file({ goals: [{ ...valid, id: 7 }] }), /damaged/],
      ['missing id', file({ goals: [{ ...valid, id: undefined }] }), /damaged/],
      ['kv without a string key', file({ kv: [{ id: 'settings', value: {}, updatedAt: T3 }] }), /damaged/],
      ['missing updatedAt', file({ goals: [{ ...valid, updatedAt: undefined }] }), /damaged/],
      ['unreadable updatedAt', file({ goals: [{ ...valid, updatedAt: 'yesterday' }] }), /damaged/],
      ['bad record after good ones', file({ goals: [valid], logs: [log('l9', 'g1', T3), { id: 'x' }] }), /damaged/],
    ];
    for (const [label, text, message] of bad) {
      const err = await importBackup(text).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, label).toBeInstanceOf(BackupError);
      expect((err as Error).message, label).toMatch(message);
      expect((err as Error).message, label).not.toMatch(/—/);
    }
    expect(await counts()).toEqual(before);
    expect(await get('goals', 'new-one')).toBeUndefined();
  });
});

describe('importBackup record shapes', () => {
  const steady = { family: 'steady', friends: 'steady', health: 'steady', work: 'steady' };

  it('a real round trip of sample-like data and every kind of app write imports in full', async () => {
    travelTo('2026-09-20');
    try {
      await loadSampleData();
      // Sample records are local-only (never exported), so turn them into ordinary records first.
      const all = await Promise.all(SYNCED_COLLECTIONS.map(async (c) => (await db.table(c).toArray()) as Row[]));
      const renamed = JSON.parse(JSON.stringify(all).replaceAll('sample-', 'demo-')) as Row[][];
      await db.transaction('rw', db.tables, async () => {
        for (const [i, c] of SYNCED_COLLECTIONS.entries()) {
          await db.table(c).clear();
          await db.table(c).bulkPut(renamed[i]);
        }
        await db.kv.delete(SAMPLE_QUARTERS_KEY);
      });
      // App writes the sample does not make.
      await saveSettings({ haptics: false, sensitiveTerms: ['Acme'] });
      await saveOnboarding({ step: 2, draft: { ...EMPTY_PROFILE_FIELDS, lifeContext: 'Two kids' }, quarterId: '2026-Q3', dismissedAt: new Date().toISOString() });
      await saveProfile({ ...EMPTY_PROFILE_FIELDS, travel: 'monthly' }, 'interview', { onboarded: true });
      await saveProfile({ ...EMPTY_PROFILE_FIELDS, crunch: 'Tax season' }, 'coach', { snapshot: true });
      const g = await addGoal({ quarterId: '2026-Q3', burner: 'friends', title: 'Visit Sam', type: 'milestone', milestones: [{ id: 'm1', title: 'Book it' }] });
      const l = await logProgress(g, 1, { note: 'Booked', notePrivate: true, milestoneId: 'm1' });
      await editLog(l.id, { value: 2, note: 'Booked the train' });
      await deleteGoal(g.id);
      await setEnergy(4);
      const person = (await db.people.toArray())[0];
      await logTouchpoint(person.id, 'text', 'Checked in', true);
      await startCrunch({ label: 'Trip' });
      const review = await getOrCreateReview('2026-09-14');
      await saveReview(review.id, { drafts: { win: 'Half typed' }, focusBurners: ['work'], coachSkipped: true });
      await completeReview(review.id);
      const action = await addAction('2026-09-14', 'Call Mom', 'family');
      await toggleAction(action.id);
      await saveCoachReply({ kind: 'checkin', scope: '2026-09-20', text: 'Nice', actions: ['Walk'], packetChars: 1200 });
      await closeQuarter('2026-Q3', { progressScore: 60, consistencyScore: 70, longestStreak: 9, checkInDays: 50 });
    } finally {
      setClockOffset(0);
    }
    const exported = await exportBackup();
    for (const c of SYNCED_COLLECTIONS) expect(exported.tables[c]!.length, c).toBeGreaterThan(0);
    const total = SYNCED_COLLECTIONS.reduce((n, c) => n + exported.tables[c]!.length, 0);
    await db.transaction('rw', db.tables, async () => {
      await Promise.all(db.tables.map((t) => t.clear()));
    });

    expect(await importBackup(JSON.stringify(exported))).toEqual({ added: total, updated: 0, skipped: 0 });
    expect((await exportBackup()).tables).toEqual(exported.tables);
  });

  it('accepts records from older versions (optional fields missing) and soft-deleted records', async () => {
    const { travel: _travel, ...noTravel } = EMPTY_PROFILE_FIELDS;
    const stamp = { at: T1, offsetMin: -240, localDate: '2026-07-01' };
    const text = file({
      quarters: [{ id: '2026-Q1', createdAt: T1, updatedAt: T1, intents: steady, intentHistory: [], status: 'closed' }],
      goals: [goal('g-old', T1), goal('g-gone', T2, { deleted: true, grade: 'B', closeDecision: 'drop' })],
      logs: [log('l-old', 'g-old', T1)],
      energy: [{ id: 'e1', rating: 3, ...stamp, createdAt: T1, updatedAt: T1 }],
      people: [{ id: 'p1', name: 'Jake', burner: 'friends', cadenceDays: 14, order: 0, createdAt: T1, updatedAt: T2, deleted: true }],
      touchpoints: [{ id: 't1', personId: 'p1', type: 'call', ...stamp, createdAt: T1, updatedAt: T1 }],
      crunch: [{ id: 'c1', start: '2026-07-01', createdAt: T1, updatedAt: T1 }],
      reviews: [{ id: 'review-2026-06-29', weekStart: '2026-06-29', step: 0, wins: [], misses: [], focus: '', focusBurners: [], createdAt: T1, updatedAt: T1 }],
      actions: [{ id: 'a1', weekStart: '2026-06-29', text: 'Call Mom', order: 0, createdAt: T1, updatedAt: T1 }],
      profiles: [{ id: 'me', createdAt: T1, updatedAt: T1, ...noTravel, source: 'interview' }],
      coachReplies: [{ id: 'r1', kind: 'weekly', scope: '2026-06-29', text: 'Good week', actions: [], createdAt: T1, updatedAt: T1 }],
      kv: [
        { key: 'settings', value: { dayBoundaryHour: 3, graceDaysPerWeek: 1 }, updatedAt: T1 },
        { key: 'onboarding', value: { step: 2 }, updatedAt: T1 },
      ],
    });
    expect(await importBackup(text)).toEqual({ added: 14, updated: 0, skipped: 0 });
  });

  it('rejects the whole file when a record would break a screen, and writes nothing', async () => {
    await seedDevice();
    const before = await counts();
    const q = quarter('2026-Q4', T3);
    const settings = (value: unknown) => ({ kv: [{ key: 'settings', value, updatedAt: T3 }] });
    const bad: Array<[string, Row]> = [
      ['settings with a text day boundary', settings({ dayBoundaryHour: 'x' })],
      ['settings that are not an object', settings('dark')],
      ['review day out of range', settings({ reviewDay: 9 })],
      ['sensitive terms that are not text', settings({ sensitiveTerms: [1] })],
      ['onboarding draft without burners', { kv: [{ key: 'onboarding', value: { step: 1, draft: { lifeContext: '' } }, updatedAt: T3 }] }],
      ['quarter without intents', { quarters: [{ id: '2026-Q3', updatedAt: T3 }] }],
      ['quarter missing a burner', { quarters: [{ ...q, intents: { family: 'high', friends: 'low', health: 'steady' } }] }],
      ['quarter with an unknown intent', { quarters: [{ ...q, intents: { ...steady, work: 'max' } }] }],
      ['quarter history that is not a list', { quarters: [{ ...q, intentHistory: {} }] }],
      ['quarter with a made-up id', { quarters: [quarter('next quarter', T3)] }],
      ['goal with an unknown burner', { goals: [goal('g9', T3, { burner: 'fun' })] }],
      ['goal with order as text', { goals: [goal('g9', T3, { order: '1' })] }],
      ['goal without a title', { goals: [goal('g9', T3, { title: undefined })] }],
      ['goal with an unreadable start date', { goals: [goal('g9', T3, { startDate: 'soon' })] }],
      ['goal steps that are not objects', { goals: [goal('g9', T3, { milestones: ['a'] })] }],
      ['goal with a null optional field', { goals: [goal('g9', T3, { unit: null })] }],
      ['log value as text', { logs: [log('l9', 'g1', T3, { value: '5' })] }],
      ['log without a local date', { logs: [log('l9', 'g1', T3, { localDate: undefined })] }],
      ['log with an unreadable time', { logs: [log('l9', 'g1', T3, { at: 'noon' })] }],
      ['log with an impossible time zone offset', { logs: [log('l9', 'g1', T3, { offsetMin: 1e300 })] }],
      ['energy rating out of range', { energy: [{ id: 'e9', rating: 6, at: T3, offsetMin: 0, localDate: '2026-09-01', updatedAt: T3 }] }],
      ['person with an unknown burner', { people: [{ id: 'p9', name: 'X', burner: 'work', cadenceDays: 7, order: 0, updatedAt: T3 }] }],
      ['review wins that are not a list', { reviews: [{ id: 'r9', weekStart: '2026-08-31', step: 0, wins: 'a', misses: [], focus: '', focusBurners: [], updatedAt: T3 }] }],
      ['profile without burners', { profiles: [{ id: 'me', updatedAt: T3, lifeContext: '', crunch: '', travel: null, source: 'edited' }] }],
      ['coach reply without actions', { coachReplies: [{ id: 'c9', kind: 'weekly', scope: '2026-08-31', text: 'Hi', updatedAt: T3 }] }],
      ['an id over 200 characters', { goals: [goal('g'.repeat(201), T3)] }],
      ['an empty id', { goals: [goal('', T3)] }],
      ['a __proto__ key', { goals: [{ ...goal('g9', T3), ['__proto__']: { polluted: true } }] }],
      ['a nested constructor key', { goals: [goal('g9', T3, { milestones: [{ id: 'm', title: 't', constructor: { polluted: true } }] })] }],
      ['a prototype key in settings', settings({ prototype: { polluted: true } })],
      ['notifications with a bad time', settings({ notify: { daily: { on: true, time: '25:00' }, weekly: { on: true, time: '17:00' }, nudges: true, quiet: { on: true, start: '22:00', end: '07:00' } } })],
      ['notifications missing quiet hours', settings({ notify: { daily: { on: true, time: '20:00' }, weekly: { on: true, time: '17:00' }, nudges: true } })],
      ['goal linked to an unknown Health metric', { goals: [goal('g9', T3, { health: { metric: 'heartRate' } })] }],
      ['goal Health minimum as text', { goals: [goal('g9', T3, { health: { metric: 'steps', min: 'lots' } })] }],
      ['log from an unknown source', { logs: [log('l9', 'g1', T3, { source: 'fax' })] }],
      ['absurd nesting', { goals: [goal('g9', T3, { extra: JSON.parse('['.repeat(40) + ']'.repeat(40)) })] }],
    ];
    for (const [label, tables] of bad) {
      const text = file(tables);
      const err = await importBackup(text).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, label).toBeInstanceOf(BackupError);
      expect((err as Error).message, label).toMatch(/damaged/);
      expect((err as Error).message, label).not.toMatch(/—/);
    }
    expect(await counts()).toEqual(before);
    expect(({} as Row).polluted).toBeUndefined();
    // The last good version of these records still imports.
    expect(await importBackup(file({ goals: [goal('g9', T3)], kv: [{ key: 'settings', value: { dayBoundaryHour: 4 }, updatedAt: T3 }] }))).toEqual({ added: 1, updated: 1, skipped: 0 });
    // Phase 7 and 8 fields in their real shapes import too.
    const notify = { daily: { on: true, time: '20:00' }, weekly: { on: false, time: '17:00' }, nudges: true, quiet: { on: true, start: '22:00', end: '07:00' } };
    expect(
      await importBackup(
        file({
          goals: [goal('g10', T3, { burner: 'health', health: { metric: 'steps', min: 8000 } })],
          logs: [log('l10', 'g10', T3, { source: 'health' })],
          kv: [{ key: 'settings', value: { dayBoundaryHour: 4, notify }, updatedAt: '2026-09-30T00:00:00.000Z' }],
        }),
      ),
    ).toMatchObject({ added: 2 });
  });
});

describe('backup reminder', () => {
  const DAY = 86_400_000;
  const t0 = new Date('2026-01-01T12:00:00.000Z');
  const at = (days: number) => new Date(t0.getTime() + days * DAY);

  it('starts counting on the first check, comes due after 30 days, snoozes 7 days, and resets on backup', async () => {
    expect(await getBackupReminder(t0)).toEqual({ due: false });
    expect((await get('kv', BACKUP_REMINDER_START_KEY))!.value).toBe(t0.toISOString());
    expect((await getBackupReminder(at(29.9))).due).toBe(false);
    expect((await getBackupReminder(at(30))).due).toBe(true);
    // Later checks never move the start.
    expect((await get('kv', BACKUP_REMINDER_START_KEY))!.value).toBe(t0.toISOString());

    await snoozeBackupReminder(at(30));
    expect((await get('kv', BACKUP_SNOOZE_KEY))!.value).toBe(at(37).toISOString());
    expect((await getBackupReminder(at(36))).due).toBe(false);
    expect((await getBackupReminder(at(37))).due).toBe(true);

    await markBackedUp(at(37));
    expect(await getBackupReminder(at(66))).toEqual({ due: false, lastBackupAt: at(37).toISOString() });
    expect(await getBackupReminder(at(67))).toEqual({ due: true, lastBackupAt: at(37).toISOString() });
  });

  it('uses the real clock by default, so time travel neither starts nor snoozes it in the future', async () => {
    travelTo('2027-06-01');
    try {
      await getBackupReminder();
      await snoozeBackupReminder();
    } finally {
      setClockOffset(0);
    }
    const start = Date.parse((await get('kv', BACKUP_REMINDER_START_KEY))!.value as string);
    const snoozed = Date.parse((await get('kv', BACKUP_SNOOZE_KEY))!.value as string);
    expect(Math.abs(start - Date.now())).toBeLessThan(60_000);
    expect(Math.abs(snoozed - (Date.now() + 7 * DAY))).toBeLessThan(60_000);
  });

  it('a device that already has an old backup date still waits 30 days from its first check', async () => {
    await markBackedUp(at(-90));
    expect(await getBackupReminder(t0)).toEqual({ due: false, lastBackupAt: at(-90).toISOString() });
    expect((await getBackupReminder(at(30))).due).toBe(true);
  });
});

describe('saveBackupFile', () => {
  const makeFile = () => new File(['{}'], 'four-burners-backup-2026-09-26.json', { type: 'application/json' });
  const lastBackup = async () => (await db.kv.get(LAST_BACKUP_KEY))?.value;

  function stubShare(result: () => Promise<void>, canShare = true) {
    const share = vi.fn(result);
    const nav = { canShare: vi.fn(() => canShare), share };
    vi.stubGlobal('navigator', nav);
    return nav;
  }

  function stubDocument() {
    const calls: string[] = [];
    const anchor = {
      href: '',
      download: '',
      rel: '',
      style: {} as Record<string, string>,
      click: vi.fn(() => calls.push('click')),
      remove: vi.fn(() => calls.push('remove')),
    };
    const doc = {
      createElement: vi.fn(() => anchor),
      body: { appendChild: vi.fn(() => calls.push('append')) },
    };
    vi.stubGlobal('document', doc);
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:backup');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    return { calls, anchor, doc, create, revoke };
  }

  it('shares synchronously with files only, and records the backup', async () => {
    const nav = stubShare(() => Promise.resolve());
    const f = makeFile();
    const pending = saveBackupFile(f);
    // Called before any await: iOS needs the tap's user gesture.
    expect(nav.share).toHaveBeenCalledTimes(1);
    expect(nav.share).toHaveBeenCalledWith({ files: [f] });
    expect(await pending).toBe('shared');
    expect(typeof (await lastBackup())).toBe('string');
  });

  it('a cancelled share sheet is quiet and records nothing', async () => {
    stubShare(() => Promise.reject(new DOMException('Share canceled', 'AbortError')));
    expect(await saveBackupFile(makeFile())).toBe('cancelled');
    expect(await lastBackup()).toBeUndefined();
  });

  it('an expired gesture asks for another tap and records nothing', async () => {
    stubShare(() => Promise.reject(new DOMException('Must be handling a user gesture', 'NotAllowedError')));
    expect(await saveBackupFile(makeFile())).toBe('retry');
    expect(await lastBackup()).toBeUndefined();
  });

  it('without file sharing, downloads through an attached <a download> and revokes the blob URL', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const nav = stubShare(() => Promise.resolve(), false);
    const { calls, anchor, create, revoke } = stubDocument();
    const f = makeFile();
    expect(await saveBackupFile(f)).toBe('downloaded');
    expect(nav.share).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(f);
    expect(anchor).toMatchObject({ href: 'blob:backup', download: f.name });
    expect(calls).toEqual(['append', 'click', 'remove']);
    expect(revoke).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith('blob:backup');
    expect(typeof (await lastBackup())).toBe('string');
  });

  it('with no share API at all, downloads', async () => {
    vi.stubGlobal('navigator', {});
    const { calls } = stubDocument();
    expect(await saveBackupFile(makeFile())).toBe('downloaded');
    expect(calls).toEqual(['append', 'click', 'remove']);
  });

  it('a second tap while the share sheet is open does not download or record anything', async () => {
    const nav = stubShare(() => Promise.reject(new DOMException('A share is already in progress', 'InvalidStateError')));
    const { calls } = stubDocument();
    expect(await saveBackupFile(makeFile())).toBe('cancelled');
    expect(nav.share).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
    expect(await lastBackup()).toBeUndefined();
  });

  it('records the real date, not the dev pretend day', async () => {
    travelTo('2027-03-01');
    try {
      stubShare(() => Promise.resolve());
      expect(await saveBackupFile(makeFile())).toBe('shared');
    } finally {
      setClockOffset(0);
    }
    const saved = Date.parse((await lastBackup()) as string);
    expect(Math.abs(saved - Date.now())).toBeLessThan(60_000);
  });

  it('when a desktop browser rejects the file for another reason, falls back to a download', async () => {
    stubShare(() => Promise.reject(new DOMException('Unsupported file type', 'DataError')));
    const { calls } = stubDocument();
    expect(await saveBackupFile(makeFile())).toBe('downloaded');
    expect(calls).toEqual(['append', 'click', 'remove']);
    expect(typeof (await lastBackup())).toBe('string');
  });
});
