import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { FourBurnersDB } from './db';

describe('sync change tracking (_dirty)', () => {
  it('marks created and updated records dirty, and respects explicit _dirty writes', async () => {
    const db = new FourBurnersDB('dirty-test-' + Math.random());
    await db.goals.put({ id: 'g', createdAt: 'x', updatedAt: 'x', quarterId: '2026-Q3', burner: 'work', title: 't', type: 'yesno', startDate: '2026-07-01', deadline: '2026-09-30', order: 0 });
    expect(((await db.goals.get('g')) as unknown as { _dirty: number })._dirty).toBe(1);
    // The sync engine marks it clean explicitly.
    await db.goals.update('g', { _dirty: 0 } as never);
    expect(((await db.goals.get('g')) as unknown as { _dirty: number })._dirty).toBe(0);
    // A normal edit makes it dirty again.
    await db.goals.update('g', { title: 'u' });
    expect(((await db.goals.get('g')) as unknown as { _dirty: number })._dirty).toBe(1);
    // A pulled record written with _dirty: 0 stays clean (create and overwrite).
    await db.goals.put({ ...(await db.goals.get('g'))!, title: 'remote', _dirty: 0 } as never);
    expect(((await db.goals.get('g')) as unknown as { _dirty: number })._dirty).toBe(0);
    await db.kv.put({ key: 'settings', value: {}, updatedAt: 'x' });
    expect(((await db.kv.get('settings')) as unknown as { _dirty: number })._dirty).toBe(1);
    db.close();
  });

  it('a put of a fresh object (no _dirty) over a clean record marks it dirty again', async () => {
    const db = new FourBurnersDB('dirty-test-fresh-' + Math.random());
    const base = { id: 'g', createdAt: 'x', updatedAt: 'x', quarterId: '2026-Q3', burner: 'work', title: 't', type: 'yesno', startDate: '2026-07-01', deadline: '2026-09-30', order: 0 } as const;
    await db.goals.put({ ...base });
    await db.goals.update('g', { _dirty: 0 } as never);
    expect(((await db.goals.get('g')) as unknown as { _dirty: number })._dirty).toBe(0);
    await db.goals.put({ ...base, title: 'edited elsewhere in the app' });
    expect(((await db.goals.get('g')) as unknown as { _dirty: number })._dirty).toBe(1);
    db.close();
  });
});
