// Busy holds (busy.ts): counted, released once each, and announced when the last one goes.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Mod = typeof import('./busy');
let busy: Mod;

beforeEach(async () => {
  vi.resetModules();
  busy = await import('./busy');
});

describe('busy holds', () => {
  it('is busy while any hold is open', () => {
    expect(busy.isBusy()).toBe(false);
    const share = busy.holdBusy('share sheet');
    const restore = busy.holdBusy('restore');
    expect(busy.isBusy()).toBe(true);
    expect(busy.busyReasons()).toEqual(['share sheet', 'restore']);
    share();
    expect(busy.isBusy()).toBe(true);
    restore();
    expect(busy.isBusy()).toBe(false);
    expect(busy.busyReasons()).toEqual([]);
  });

  it('a release only counts once, so a double release cannot drop someone else', () => {
    const picker = busy.holdBusy('file picker');
    const restore = busy.holdBusy('restore');
    picker();
    picker();
    expect(busy.isBusy()).toBe(true);
    restore();
    expect(busy.isBusy()).toBe(false);
  });

  it('holdBusyUntil holds while the work runs and lets go when it settles, either way', async () => {
    let finish!: (v: string) => void;
    const shared = busy.holdBusyUntil('share sheet', new Promise<string>((r) => (finish = r)));
    expect(busy.busyReasons()).toEqual(['share sheet']);
    finish('shared');
    expect(await shared).toBe('shared');
    expect(busy.isBusy()).toBe(false);

    const failed = busy.holdBusyUntil('share sheet', Promise.reject(new Error('no')));
    expect(busy.isBusy()).toBe(true);
    await expect(failed).rejects.toThrow('no');
    expect(busy.isBusy()).toBe(false);
  });

  it('tells listeners when the last hold is released, and only then', () => {
    const idle = vi.fn();
    const stop = busy.onIdle(idle);
    const a = busy.holdBusy('a');
    const b = busy.holdBusy('b');
    a();
    expect(idle).not.toHaveBeenCalled();
    b();
    expect(idle).toHaveBeenCalledTimes(1);
    b(); // already released
    expect(idle).toHaveBeenCalledTimes(1);
    stop();
    busy.holdBusy('c')();
    expect(idle).toHaveBeenCalledTimes(1);
  });
});
