// The shortcuts function end to end against an in-memory store: what a Shortcut sends, what Siri says back,
// and exactly which synced records get written.
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, healthLogId, type Goal, type LogEntry, type Person, type Quarter, type Touchpoint } from '@/domain';
import { generateToken, hashToken } from '@/shortcuts/token';
import { createShortcutsHandler } from './handler';
import type { ShortcutsStore, StoredRecord } from './store';

const U = 'user-1';
const T = '2026-10-01T12:00:00Z';
const NOW = new Date('2026-10-03T01:30:00Z'); // Oct 2, 20:30 in Chicago

const quarter: Quarter = { id: '2026-Q4', createdAt: T, updatedAt: T, intents: { family: 'high', friends: 'steady', health: 'high', work: 'low' }, intentHistory: [], status: 'active' };
const goal = (id: string, title: string, over: Partial<Goal> = {}): Goal => ({
  id, title, burner: 'family', type: 'habit', target: 2, habitPeriod: 'month', startDate: '2026-10-01', deadline: '2026-12-31',
  quarterId: '2026-Q4', order: 0, createdAt: T, updatedAt: T, ...over,
});
const person = (id: string, name: string): Person => ({ id, name, burner: 'friends', cadenceDays: 7, order: 0, createdAt: T, updatedAt: T });

class MemoryStore implements ShortcutsStore {
  tokens = new Map<string, { id: string; userId: string }>();
  used: string[] = [];
  settingsValue: unknown = DEFAULT_SETTINGS;
  tz: string | null = 'America/Chicago';
  goalList: Goal[] = [];
  peopleList: Person[] = [];
  rows = new Map<string, StoredRecord>();
  writes: { collection: string; record: Record<string, unknown> }[] = [];

  async tokenByHash(hash: string) {
    return this.tokens.get(hash) ?? null;
  }
  async markTokenUsed(id: string) {
    this.used.push(id);
  }
  async settings() {
    return this.settingsValue;
  }
  async latestTimeZone() {
    return this.tz;
  }
  async quarter(_u: string, id: string) {
    return id === quarter.id ? quarter : undefined;
  }
  async goals(_u: string, quarterId: string) {
    return this.goalList.filter((g) => g.quarterId === quarterId);
  }
  async people() {
    return this.peopleList;
  }
  async logsForGoal(_u: string, goalId: string) {
    return [...this.rows.entries()].filter(([k, r]) => k.startsWith('logs/') && !r.deleted && r.data.goalId === goalId).map(([, r]) => r.data as unknown as LogEntry);
  }
  async get(_u: string, collection: string, id: string) {
    return this.rows.get(`${collection}/${id}`) ?? null;
  }
  /** Same newer-wins rule as shortcuts_put_record. */
  async put(_u: string, collection: string, record: { id: string; updatedAt: string } & Record<string, unknown>) {
    const cur = this.rows.get(`${collection}/${record.id}`);
    if (cur && (cur.deleted || !(cur.updated_at < record.updatedAt))) return false;
    this.writes.push({ collection, record });
    this.rows.set(`${collection}/${record.id}`, { data: record, deleted: false, updated_at: record.updatedAt });
    return true;
  }
}

let store: MemoryStore;
let token: string;
let ids = 0;
beforeEach(async () => {
  store = new MemoryStore();
  token = generateToken();
  store.tokens.set(await hashToken(token), { id: 'tok-1', userId: U });
  ids = 0;
});

const handler = (now = NOW) => createShortcutsHandler({ store, now: () => now, newId: () => `id-${++ids}` });
async function send(body: unknown, auth = `Bearer ${token}`, now = NOW) {
  const res = await handler(now)(new Request('https://p.supabase.co/functions/v1/shortcuts', {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
  return { status: res.status, ...((await res.json()) as { ok: boolean; message: string; items?: string[] }) };
}

describe('token', () => {
  it('rejects a missing, malformed, wrong or revoked token', async () => {
    expect((await send({ action: 'ping' }, '')).status).toBe(401);
    expect((await send({ action: 'ping' }, 'Bearer nope')).status).toBe(401);
    const wrong = await send({ action: 'ping' }, `Bearer ${generateToken()}`);
    expect(wrong).toMatchObject({ status: 401, ok: false });
    expect(wrong.message).toMatch(/Settings > Shortcuts and Siri/);
    expect(store.used).toEqual([]);
  });

  it('answers a ping and records when the token was used', async () => {
    expect(await send({ action: 'ping' })).toMatchObject({ status: 200, ok: true, message: 'Connected. Four Burners is ready for Siri.' });
    expect(store.used).toEqual(['tok-1']);
  });

  it('refuses non-JSON, oversized and unknown requests', async () => {
    expect((await send('not json')).status).toBe(400);
    expect((await send({ action: 'log', note: 'x'.repeat(9000) })).status).toBe(413);
    expect(await send({ action: 'dance' })).toMatchObject({ status: 400, ok: false });
    const get = await handler()(new Request('https://x/shortcuts'));
    expect(get.status).toBe(405);
  });
});

describe('lists', () => {
  it('goals that can be logged by voice, in burner order, and people', async () => {
    store.goalList = [
      goal('w', 'Ship it', { burner: 'work' }),
      goal('d', 'Date night'),
      goal('m', 'Launch', { type: 'milestone' }),
      goal('x', 'Gone', { deleted: true }),
      goal('h', 'Run', { burner: 'health', type: 'number' }),
    ];
    store.peopleList = [person('s', 'Sam'), { ...person('a', 'Ana'), order: -1 }];
    expect((await send({ action: 'goals' })).items).toEqual(['Date night', 'Run', 'Ship it']);
    expect((await send({ action: 'people' })).items).toEqual(['Ana', 'Sam']);
  });
});

describe('log', () => {
  beforeEach(() => {
    store.goalList = [goal('d', 'Date night'), goal('r', 'Run 300 miles', { burner: 'health', type: 'number', target: 300, unit: 'miles' })];
  });

  it('logs a habit by name, dated by the phone, and says the progress', async () => {
    const r = await send({ action: 'log', goal: 'date night', at: '2026-10-02T20:15:00-05:00', note: 'Tacos' });
    expect(r).toMatchObject({ ok: true, message: 'Logged "Date night". 1 of 6 so far.' });
    expect(store.writes).toEqual([
      {
        collection: 'logs',
        record: {
          id: 'id-1', goalId: 'd', value: 1, at: '2026-10-03T01:15:00.000Z', offsetMin: -300, localDate: '2026-10-02',
          createdAt: '2026-10-03T01:15:00.000Z', updatedAt: NOW.toISOString(), source: 'shortcut', note: 'Tacos', notePrivate: false,
        },
      },
    ]);
  });

  it('without the phone time, uses the zone of the device seen last', async () => {
    await send({ action: 'log', goal: 'Date night' });
    expect(store.writes[0].record).toMatchObject({ offsetMin: -300, localDate: '2026-10-02', at: NOW.toISOString() });
    store.tz = null;
    await send({ action: 'log', goal: 'Date night' });
    expect(store.writes[1].record).toMatchObject({ offsetMin: 0, localDate: '2026-10-02' }); // 01:30 UTC, before the 3 AM boundary
  });

  it('asks for an amount on Number goals', async () => {
    expect(await send({ action: 'log', goal: 'run' })).toMatchObject({ ok: false, message: 'How much for "Run 300 miles"? Send an amount in miles.' });
    expect(await send({ action: 'log', goal: 'run', value: '3.1' })).toMatchObject({ ok: true, message: 'Logged 3.1 miles to "Run 300 miles". 3.1 of 300 so far.' });
    expect(store.writes).toHaveLength(1);
  });

  it('says what it could not find, or which ones it could mean', async () => {
    expect(await send({ action: 'log', goal: 'swim' })).toMatchObject({ ok: false, message: 'No goal matches "swim". Try one of: Date night, Run 300 miles.' });
    store.goalList.push(goal('l', 'Late night'));
    expect((await send({ action: 'log', goal: 'night' })).message).toMatch(/could be "?Date night/);
    expect(await send({ action: 'log' })).toMatchObject({ ok: false });
    expect(store.writes).toEqual([]);
  });
});

describe('touch', () => {
  it('logs a touchpoint by name and type', async () => {
    store.peopleList = [person('s', 'Sam Lee'), person('m', 'Mom')];
    expect(await send({ action: 'touch', person: 'sam', type: 'Phone call', at: '2026-10-02T19:00:00-05:00' })).toMatchObject({ ok: true, message: 'Logged a call with Sam Lee.' });
    expect(store.writes[0]).toEqual({
      collection: 'touchpoints',
      record: { id: 'id-1', personId: 's', type: 'call', at: '2026-10-03T00:00:00.000Z', offsetMin: -300, localDate: '2026-10-02', createdAt: '2026-10-03T00:00:00.000Z', updatedAt: NOW.toISOString(), source: 'shortcut' },
    });
    expect((await send({ action: 'touch', person: 'Dad' })).message).toBe('No person matches "Dad". Try one of: Sam Lee, Mom.');
  });
});

describe('health', () => {
  const steps = goal('steps', 'Walk 900k steps', { burner: 'health', type: 'number', target: 900_000, health: { metric: 'steps' } });
  const lift = goal('lift', 'Lift 3x a week', { burner: 'health', target: 3, habitPeriod: 'week', health: { metric: 'workouts' } });
  beforeEach(() => {
    store.goalList = [steps, lift, goal('d', 'Date night')];
  });

  it('applies a day to linked goals with one log per goal per day', async () => {
    const r = await send({ action: 'health', date: '2026-10-02', at: '2026-10-02T21:30:00-05:00', steps: '9,120', workouts: 1, sleepHours: 7 });
    expect(r).toMatchObject({ ok: true, message: 'Health for 2026-10-02: 9,120 steps to "Walk 900k steps"; "Lift 3x a week" counted.' });
    expect(store.writes.map((w) => [w.record.id, w.record.value, w.record.localDate, w.record.source])).toEqual([
      [healthLogId('steps', '2026-10-02'), 9120, '2026-10-02', 'health'],
      [healthLogId('lift', '2026-10-02'), 1, '2026-10-02', 'health'],
    ]);
  });

  it('a resend later that day updates the same log; an unchanged value writes nothing', async () => {
    await send({ action: 'health', date: '2026-10-02', steps: 5000 });
    await send({ action: 'health', date: '2026-10-02', steps: 5000 });
    expect(store.writes).toHaveLength(1);
    await send({ action: 'health', date: '2026-10-02', steps: 9000 });
    expect(store.writes).toHaveLength(2);
    expect(store.writes[1].record).toMatchObject({ id: healthLogId('steps', '2026-10-02'), value: 9000, createdAt: store.writes[0].record.createdAt });
    expect(Date.parse(store.writes[1].record.updatedAt as string)).toBeGreaterThan(Date.parse(store.writes[0].record.updatedAt as string) - 1);
  });

  it('beats a device clock that ran ahead, and leaves a log you deleted alone', async () => {
    const id = healthLogId('steps', '2026-10-02');
    const ahead = '2026-10-04T00:00:00.000Z';
    store.rows.set(`logs/${id}`, { data: { id, value: 10, createdAt: T, healthWrittenAt: ahead }, deleted: false, updated_at: ahead });
    await send({ action: 'health', date: '2026-10-02', steps: 9000 });
    expect(store.writes[0].record.updatedAt).toBe('2026-10-04T00:00:00.001Z');
    store.rows.set(`logs/${id}`, { data: { id, value: 10, deleted: true }, deleted: true, updated_at: T });
    store.writes = [];
    expect((await send({ action: 'health', date: '2026-10-02', steps: 9000 })).message).toMatch(/No linked goal/);
    expect(store.writes).toEqual([]);
  });

  it('keeps a Health log you edited in the app', async () => {
    await send({ action: 'health', date: '2026-10-02', steps: 5000 });
    const id = healthLogId('steps', '2026-10-02');
    const row = store.rows.get(`logs/${id}`)!;
    // A device corrected it to 6000 and synced (its updatedAt no longer matches the server's copy).
    store.rows.set(`logs/${id}`, { ...row, data: { ...row.data, value: 6000 }, updated_at: '2026-10-03T02:00:00.000Z' });
    const r = await send({ action: 'health', date: '2026-10-02', steps: 9000 });
    expect(store.writes).toHaveLength(1);
    expect(store.rows.get(`logs/${id}`)!.data.value).toBe(6000);
    expect(r.message).toMatch(/No linked goal/);
  });

  it('does not count a Habit day twice when you already logged it by hand', async () => {
    store.rows.set('logs/manual', { data: { id: 'manual', goalId: 'lift', value: 1, localDate: '2026-10-02' }, deleted: false, updated_at: T });
    const r = await send({ action: 'health', date: '2026-10-02', workouts: 1, steps: 100 });
    expect(store.writes.map((w) => w.record.goalId)).toEqual(['steps']);
    expect(r.message).not.toMatch(/Lift/);
  });

  it('a send just after midnight, before the day boundary, goes to the phone\'s calendar day', async () => {
    // 01:30 in Chicago on Oct 3: the lived day is still Oct 2.
    store.goalList = [steps];
    await send({ action: 'health', date: '2026-10-03', at: '2026-10-03T01:30:00-05:00', steps: 300 }, undefined, new Date('2026-10-03T06:30:00Z'));
    expect(store.writes[0].record).toMatchObject({ id: healthLogId('steps', '2026-10-03'), localDate: '2026-10-03', value: 300 });
  });

  it('says so when nothing usable came through', async () => {
    expect(await send({ action: 'health', steps: 'many' })).toMatchObject({ ok: false, message: expect.stringMatching(/^No Health numbers/) });
  });
});

describe('errors', () => {
  it('hides internal errors', async () => {
    store.goals = async () => {
      throw new Error('service key sb_secret_abc');
    };
    const r = await send({ action: 'goals' });
    expect(r.status).toBe(500);
    expect(r.message).not.toMatch(/sb_secret/);
  });
});

describe('records written', () => {
  it('are shaped exactly like the app writes them', async () => {
    store.goalList = [goal('d', 'Date night')];
    store.peopleList = [person('s', 'Sam')];
    await send({ action: 'log', goal: 'date night' });
    await send({ action: 'touch', person: 'Sam', type: 'text' });
    const log = store.writes[0].record as unknown as LogEntry;
    const tp = store.writes[1].record as unknown as Touchpoint;
    for (const r of [log, tp]) {
      expect(typeof r.id).toBe('string');
      expect(r.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isFinite(r.offsetMin)).toBe(true);
      expect(new Date(r.at).toISOString()).toBe(r.at);
      expect(new Date(r.updatedAt).toISOString()).toBe(r.updatedAt);
    }
    expect(log.goalId).toBe('d');
    expect(tp.type).toBe('text');
  });
});
