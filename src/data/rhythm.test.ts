import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { quarterOf, nextQuarterId } from '@/domain';
import { setClockOffset, travelTo } from './clock';
import { db } from './db';
import {
  addAction,
  addGoal,
  closeQuarter,
  decideGoal,
  endCrunch,
  ensureCurrentQuarter,
  getOrCreateReview,
  logProgress,
  reviewId,
  saveReview,
  startCrunch,
  streakMilestoneReached,
  toggleAction,
  wipeAll,
} from './repo';

beforeEach(async () => {
  await wipeAll();
  travelTo('2026-09-20');
});
afterEach(() => setClockOffset(0));

describe('weekly review storage', () => {
  it('one review per week, resumable step and drafts', async () => {
    const r = await getOrCreateReview('2026-09-14');
    expect(r.id).toBe(reviewId('2026-09-14'));
    await saveReview(r.id, { step: 3, wins: ['Ran 12 miles'], drafts: { miss: 'Half typ' } });
    const again = await getOrCreateReview('2026-09-14');
    expect(again).toMatchObject({ step: 3, wins: ['Ran 12 miles'], drafts: { miss: 'Half typ' } });
    expect(await db.reviews.count()).toBe(1);
  });
});

describe('actions', () => {
  it('toggle done and back; done actions carry a check-in stamp', async () => {
    const a = await addAction('2026-09-21', 'Book date night', 'family');
    expect(await toggleAction(a.id)).toBe(true);
    expect((await db.actions.get(a.id))!.done?.localDate).toBe('2026-09-20');
    expect(await toggleAction(a.id)).toBe(false);
    expect((await db.actions.get(a.id))!.done).toBeUndefined();
  });
});

describe('crunch mode', () => {
  it('starts today with an optional end; ending the same day removes it, later keeps today', async () => {
    await startCrunch({ end: '2026-09-25', label: 'Travel' });
    let p = (await db.crunch.toArray())[0];
    expect(p).toMatchObject({ start: '2026-09-20', end: '2026-09-25', label: 'Travel' });
    await endCrunch();
    expect((await db.crunch.get(p.id))!.deleted).toBe(true);

    await startCrunch();
    travelTo('2026-09-23');
    await endCrunch();
    p = (await db.crunch.filter((x) => !x.deleted).toArray())[0];
    expect(p).toMatchObject({ start: '2026-09-20', end: '2026-09-23' });
  });
});

describe('quarter close', () => {
  it('carries and modifies forward, drops the rest, freezes the summary, and is idempotent', async () => {
    const q = await ensureCurrentQuarter();
    expect(q.id).toBe('2026-Q3');
    const run = await addGoal({ quarterId: q.id, burner: 'health', title: 'Run', type: 'number', target: 100, why: 'Strong' });
    const read = await addGoal({ quarterId: q.id, burner: 'work', title: 'Read', type: 'number', target: 3 });
    const drop = await addGoal({ quarterId: q.id, burner: 'work', title: 'Old habit', type: 'yesno' });
    await logProgress(run, 40);
    await decideGoal(run.id, 'carry');
    await decideGoal(read.id, 'modify');
    await decideGoal(drop.id, 'drop');

    travelTo('2026-10-03'); // closing a couple of days late
    const nextId = await closeQuarter(q.id, { progressScore: 70, consistencyScore: 80, longestStreak: 12, checkInDays: 60 });
    expect(nextId).toBe(nextQuarterId('2026-Q3'));
    await closeQuarter(q.id, { progressScore: 70, consistencyScore: 80, longestStreak: 12, checkInDays: 60 });

    const closed = await db.quarters.get(q.id);
    expect(closed).toMatchObject({ status: 'closed', summary: { progressScore: 70 } });
    const next = await db.goals.where('quarterId').equals('2026-Q4').toArray();
    expect(next.map((g) => g.title).sort()).toEqual(['Read', 'Run']);
    const carried = next.find((g) => g.title === 'Run')!;
    expect(carried).toMatchObject({ why: 'Strong', target: 100, carriedFromId: run.id, startDate: '2026-10-03', deadline: '2026-12-31' });
    expect((await db.goals.get(run.id))!.carriedToId).toBe(carried.id);
    // Next quarter exists with intents pre-filled from the closed one.
    expect((await db.quarters.get('2026-Q4'))!.intents).toEqual(q.intents);
    expect(quarterOf('2026-10-03').id).toBe('2026-Q4');
  });
});

describe('streak milestones', () => {
  it('first check records quietly; later climbs celebrate once', async () => {
    expect(await streakMilestoneReached(40)).toBeNull(); // first sighting
    expect(await streakMilestoneReached(41)).toBeNull();
    expect(await streakMilestoneReached(50)).toBe(50);
    expect(await streakMilestoneReached(51)).toBeNull();
    expect(await streakMilestoneReached(2)).toBeNull(); // reset after a break
    expect(await streakMilestoneReached(7)).toBe(7);
    // A big jump (e.g. data arriving from another device) does not celebrate a milestone crossed long ago.
    expect(await streakMilestoneReached(176)).toBeNull();
    expect(await streakMilestoneReached(200)).toBe(200);
  });
});

describe('time zone change notice', () => {
  it('stays quiet on first run, reports a change once, then stays quiet', async () => {
    const { checkTimeZoneChange } = await import('./repo');
    expect(await checkTimeZoneChange()).toBeNull(); // first run records the offset
    expect(await checkTimeZoneChange()).toBeNull(); // unchanged
    const here = -new Date().getTimezoneOffset();
    await db.kv.put({ key: 'lastOffsetMin', value: here + 540, updatedAt: 'x' }); // pretend we were 9h away
    expect(await checkTimeZoneChange()).toEqual({ from: here + 540, to: here });
    expect(await checkTimeZoneChange()).toBeNull();
  });
});
