import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './db';
import { addGoal, logProgress, wipeAll } from './repo';
import { hasSampleData, loadSampleData, wipeSampleData } from './sample';

describe('sample data', () => {
  beforeEach(async () => {
    await wipeAll();
  });

  it('loads a previous and current quarter with goals, logs, people, energy, and a travel week', async () => {
    await loadSampleData();
    expect(await hasSampleData()).toBe(true);
    expect(await db.quarters.count()).toBe(2);
    expect(await db.goals.count()).toBeGreaterThanOrEqual(18);
    expect(await db.logs.count()).toBeGreaterThan(100);
    expect(await db.people.count()).toBe(7);
    expect(await db.energy.count()).toBeGreaterThan(50);
    expect(await db.crunch.count()).toBeGreaterThanOrEqual(1);
  });

  it('wipes sample data, including logs made on sample goals, but keeps real data', async () => {
    await loadSampleData();
    const q = (await db.quarters.toArray()).find((x) => x.status === 'active')!;
    const sampleGoal = (await db.goals.toArray()).find((g) => g.quarterId === q.id)!;
    await logProgress(sampleGoal, 1);
    const real = await addGoal({ quarterId: q.id, burner: 'work', title: 'Real goal', type: 'yesno' });
    await logProgress(real, 1);

    await wipeSampleData();

    expect(await hasSampleData()).toBe(false);
    expect((await db.goals.toArray()).map((g) => g.title)).toEqual(['Real goal']);
    const logs = await db.logs.toArray();
    expect(logs).toHaveLength(1);
    expect(logs[0].goalId).toBe(real.id);
    expect(await db.people.count()).toBe(0);
    expect(await db.quarters.get(q.id)).toBeDefined(); // has a real goal, so it stays
  });
});
