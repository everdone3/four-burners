import { afterEach, describe, expect, it, vi } from 'vitest';

async function load(storage: unknown) {
  vi.resetModules();
  vi.stubGlobal('navigator', storage === undefined ? {} : { storage });
  return import('./storagePersist');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('persistent storage request', () => {
  it('asks once, and Settings reads the same answer', async () => {
    const persist = vi.fn(async () => true);
    const m = await load({ persisted: vi.fn(async () => false), persist });
    expect(await m.requestPersistentStorage()).toBe(true);
    expect(await m.requestPersistentStorage()).toBe(true);
    expect(await m.storagePersisted()).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('does not ask again when already granted (Firefox would prompt)', async () => {
    const persist = vi.fn(async () => true);
    const m = await load({ persisted: vi.fn(async () => true), persist });
    expect(await m.storagePersisted()).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it('reports a refusal as false', async () => {
    const m = await load({ persisted: vi.fn(async () => false), persist: vi.fn(async () => false) });
    expect(await m.requestPersistentStorage()).toBe(false);
  });

  it('is unknown (null) when unsupported or failing, and never throws', async () => {
    expect(await (await load(undefined)).requestPersistentStorage()).toBeNull();
    expect(await (await load({})).requestPersistentStorage()).toBeNull();
    const m = await load({ persisted: vi.fn(async () => false), persist: vi.fn(async () => Promise.reject(new Error('denied'))) });
    expect(await m.requestPersistentStorage()).toBeNull();
    // No persisted() (older Safari): still asks.
    const persist = vi.fn(async () => true);
    expect(await (await load({ persist })).requestPersistentStorage()).toBe(true);
  });

  it('works where navigator does not exist at all', async () => {
    vi.resetModules();
    const m = await import('./storagePersist');
    expect(await m.requestPersistentStorage()).toBeNull();
  });
});
