// Update flow state machine (useAppUpdate) against a fake page and a fake vite-plugin-pwa registerSW.
// The real handover (install, skipWaiting, controllerchange) is covered by the headless browser test;
// this pins the decisions: when to reload, when to show the pill, and what a manual check reports.
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Mod = typeof import('./useAppUpdate');
type Options = NonNullable<Parameters<Parameters<Mod['connectUpdates']>[0]>[0]>;

type FakeField = { type: string; value: string; disabled?: boolean; readOnly?: boolean };

class FakeDocument extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';
  activeElement: unknown = null;
  dialogOpen = false;
  /** Every input and textarea on the page. */
  fields: FakeField[] = [];
  querySelector(sel: string) {
    return sel === '[role="dialog"]' && this.dialogOpen ? {} : null;
  }
  querySelectorAll(sel: string) {
    return sel === 'input, textarea' ? this.fields : [];
  }
  setVisibility(v: 'visible' | 'hidden') {
    this.visibilityState = v;
    this.dispatchEvent(new Event('visibilitychange'));
  }
  /** A sheet with something typed into it (GoalEditor, NotePrompt), or the sheet closed again. */
  openSheetWithText(text: string) {
    this.dialogOpen = true;
    this.fields = [{ type: 'text', value: text }];
  }
  closeSheet() {
    this.dialogOpen = false;
    this.fields = [];
  }
}

class FakeElement {
  isContentEditable = false;
}
class FakeInput extends FakeElement {
  constructor(public type: string) {
    super();
  }
}
class FakeTextArea extends FakeElement {}

async function setup({ controller = true, safe = true } = {}) {
  vi.resetModules();
  const doc = new FakeDocument();
  const sw = Object.assign(new EventTarget(), { controller: controller ? ({} as object) : null });
  const nav = { onLine: true, serviceWorker: sw };
  const loc = { hash: '#/', reload: vi.fn() };
  const store = new Map<string, string>();
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('navigator', nav);
  vi.stubGlobal('location', loc);
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  const mod: Mod = await import('./useAppUpdate');
  const busy = await import('./busy'); // the same instance useAppUpdate just loaded
  let opts: Options = {};
  const update = vi.fn(async () => {});
  let isSafe = safe;
  mod.connectUpdates(
    ((o: Options) => {
      opts = o ?? {};
      return update;
    }) as never,
    () => isSafe,
  );
  const status = () => renderToString(createElement(() => mod.useUpdateStatus()));
  // A new worker takes control of the page (skipWaiting + clientsClaim, from this tab or another one).
  const takeOver = () => {
    sw.controller = {};
    sw.dispatchEvent(new Event('controllerchange'));
  };
  return {
    mod,
    busy,
    doc,
    nav,
    loc,
    store,
    update,
    status,
    takeOver,
    opts: () => opts,
    setSafe: (v: boolean) => void (isSafe = v),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('applying updates', () => {
  it('a page that opened without a worker is not reloaded by the first install, but is by a later update', async () => {
    const t = await setup({ controller: false });
    t.takeOver(); // first install claims the fresh page
    expect(t.loc.reload).not.toHaveBeenCalled();
    expect(t.status()).toBe('none');
    // Later in the same session (iOS resumes the app without a navigation) a new version is waiting.
    t.opts().onNeedRefresh!();
    expect(t.update).toHaveBeenCalledTimes(1);
    expect(t.status()).toBe('applying');
    t.takeOver();
    expect(t.loc.reload).toHaveBeenCalledTimes(1);
  });

  it('a page that opened without a worker (hard reload) still reloads into an update it applied', async () => {
    const t = await setup({ controller: false });
    t.opts().onNeedRefresh!();
    t.takeOver();
    expect(t.loc.reload).toHaveBeenCalledTimes(1);
  });

  it('at a safe point: applies right away, silently', async () => {
    const t = await setup();
    t.opts().onNeedRefresh!();
    expect(t.update).toHaveBeenCalledTimes(1);
    t.takeOver();
    expect(t.loc.reload).toHaveBeenCalledTimes(1);
    expect(t.store.size).toBe(0); // no "Updated" pill after a silent update
  });

  it('mid-flow: shows the pill, never reloads while visible, applies on the next hide', async () => {
    const t = await setup({ safe: false });
    t.opts().onNeedRefresh!();
    t.opts().onNeedRefresh!(); // the plugin can report the same worker twice
    expect(t.status()).toBe('ready');
    expect(t.update).not.toHaveBeenCalled();
    t.doc.setVisibility('visible');
    expect(t.update).not.toHaveBeenCalled();
    t.doc.setVisibility('hidden');
    expect(t.update).toHaveBeenCalledTimes(1);
    expect(t.status()).toBe('applying');
    t.takeOver();
    expect(t.loc.reload).toHaveBeenCalledTimes(1);
    expect(t.store.size).toBe(0);
  });

  it('mid-flow: Reload on the pill applies it and asks for the confirmation', async () => {
    const t = await setup({ safe: false });
    t.opts().onNeedRefresh!();
    t.mod.applyUpdate(true);
    expect(t.update).toHaveBeenCalledTimes(1);
    expect(t.store.get('fb-updated-from')).toBe(t.mod.APP_VERSION);
    t.takeOver();
    expect(t.loc.reload).toHaveBeenCalledTimes(1);
  });

  it('found while in the background: applies at once', async () => {
    const t = await setup({ safe: false });
    t.doc.visibilityState = 'hidden';
    t.opts().onNeedRefresh!();
    expect(t.update).toHaveBeenCalledTimes(1);
  });

  it('another tab switches versions while this one is busy: pill instead of a reload, then Reload just reloads', async () => {
    const t = await setup({ safe: false });
    t.opts().onNeedRefresh!(); // this tab saw the waiting worker too
    t.takeOver(); // the other tab applied it
    expect(t.loc.reload).not.toHaveBeenCalled();
    expect(t.status()).toBe('ready');
    t.mod.applyUpdate(true);
    expect(t.loc.reload).toHaveBeenCalledTimes(1);
    expect(t.update).not.toHaveBeenCalled(); // nothing is waiting anymore; messaging it would do nothing
  });

  it('another tab switches versions while this one is busy: reloads when it goes to the background', async () => {
    const t = await setup({ safe: false });
    t.takeOver();
    expect(t.loc.reload).not.toHaveBeenCalled();
    t.doc.setVisibility('hidden');
    expect(t.loc.reload).toHaveBeenCalledTimes(1);
  });

  it('another tab switches versions while this one is idle or hidden: reloads right away', async () => {
    const idle = await setup();
    idle.takeOver();
    expect(idle.loc.reload).toHaveBeenCalledTimes(1);
    const hidden = await setup({ safe: false });
    hidden.doc.visibilityState = 'hidden';
    hidden.takeOver();
    expect(hidden.loc.reload).toHaveBeenCalledTimes(1);
  });

  it('a stalled handover offers Reload again after 15 s and never reloads blindly', async () => {
    const t = await setup({ safe: false });
    t.opts().onNeedRefresh!();
    t.mod.applyUpdate(true);
    t.mod.applyUpdate(true); // double tap
    expect(t.update).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(t.status()).toBe('ready');
    expect(t.loc.reload).not.toHaveBeenCalled();
    t.mod.applyUpdate(true);
    expect(t.update).toHaveBeenCalledTimes(2);
  });

  it('the plugin never gets to reload on its own', async () => {
    const t = await setup({ safe: false });
    expect(typeof t.opts().onNeedReload).toBe('function');
    t.opts().onNeedReload!();
    expect(t.loc.reload).not.toHaveBeenCalled();
  });

  it('applyUpdate before registration is a no-op', async () => {
    vi.resetModules();
    const mod: Mod = await import('./useAppUpdate');
    expect(() => mod.applyUpdate(true)).not.toThrow();
    expect(await mod.checkForUpdates()).toBe('unavailable');
  });
});

describe('never loses typed text or cuts off a share sheet, picker or restore', () => {
  it('a sheet with typed text: no reload on hide; the next hide after it closes applies', async () => {
    const t = await setup({ safe: false });
    t.doc.openSheetWithText('Run a half marathon');
    t.opts().onNeedRefresh!();
    expect(t.status()).toBe('ready');
    t.doc.setVisibility('hidden'); // switch to Messages, or the screen locks
    expect(t.update).not.toHaveBeenCalled();
    expect(t.status()).toBe('ready');
    t.doc.setVisibility('visible');
    t.doc.closeSheet(); // saved or cancelled
    t.doc.setVisibility('hidden');
    expect(t.update).toHaveBeenCalledTimes(1);
    t.takeOver();
    expect(t.loc.reload).toHaveBeenCalledTimes(1);
  });

  it('typed text outside a sheet counts too, but empty, read-only and disabled fields do not', async () => {
    const t = await setup({ safe: false });
    t.opts().onNeedRefresh!();
    t.doc.fields = [{ type: 'text', value: '12' }]; // custom amount on a goal row
    t.doc.setVisibility('hidden');
    expect(t.update).not.toHaveBeenCalled();
    t.doc.setVisibility('visible');
    t.doc.fields = [
      { type: 'text', value: '   ' },
      { type: 'textarea', value: 'the packet', readOnly: true },
      { type: 'email', value: 'me@example.com', disabled: true },
      { type: 'checkbox', value: 'on' },
      { type: 'hidden', value: 'x' },
    ];
    t.doc.setVisibility('hidden');
    expect(t.update).toHaveBeenCalledTimes(1);
  });

  it('found in a hidden tab with typed text (Mac hourly check): waits instead of applying', async () => {
    const t = await setup({ safe: false });
    t.doc.visibilityState = 'hidden';
    t.doc.openSheetWithText('Call Mom on Sundays');
    t.opts().onNeedRefresh!();
    expect(t.update).not.toHaveBeenCalled();
    expect(t.status()).toBe('ready');
  });

  it('another tab switches versions while this hidden one has typed text: no reload until it is safe', async () => {
    const t = await setup({ safe: false });
    t.doc.visibilityState = 'hidden';
    t.doc.openSheetWithText('half written note');
    t.takeOver();
    expect(t.loc.reload).not.toHaveBeenCalled();
    expect(t.status()).toBe('ready');
    t.doc.setVisibility('visible');
    t.doc.closeSheet();
    t.doc.setVisibility('hidden');
    expect(t.loc.reload).toHaveBeenCalledTimes(1);
  });

  it('a tap on Reload still reloads with typed text on the page', async () => {
    const t = await setup({ safe: false });
    t.doc.openSheetWithText('draft');
    t.opts().onNeedRefresh!();
    t.mod.applyUpdate(true);
    t.takeOver();
    expect(t.loc.reload).toHaveBeenCalledTimes(1);
  });

  it('share sheet open at a safe point: waits, and applies once it closes in the background', async () => {
    const t = await setup(); // Home, nothing focused: a safe point by the page alone
    const release = t.busy.holdBusy('share sheet');
    t.opts().onNeedRefresh!();
    expect(t.update).not.toHaveBeenCalled();
    expect(t.status()).toBe('ready');
    t.doc.setVisibility('hidden');
    expect(t.update).not.toHaveBeenCalled();
    release();
    expect(t.update).toHaveBeenCalledTimes(1);
    t.takeOver();
    expect(t.loc.reload).toHaveBeenCalledTimes(1);
  });

  it('restore finishing on screen: applies a moment later, and only if still safe', async () => {
    const t = await setup();
    const picker = t.busy.holdBusy('file picker');
    const restore = t.busy.holdBusy('restore');
    picker(); // hand-off: still held by the restore
    t.opts().onNeedRefresh!();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.update).not.toHaveBeenCalled();
    restore();
    restore(); // releasing twice does nothing
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.update).not.toHaveBeenCalled(); // "Restored: ..." stays up for a moment
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.update).toHaveBeenCalledTimes(1);

    const moved = await setup();
    const hold = moved.busy.holdBusy('restore');
    moved.opts().onNeedRefresh!();
    hold();
    moved.setSafe(false); // opened a sheet in the meantime
    await vi.advanceTimersByTimeAsync(5_000);
    expect(moved.update).not.toHaveBeenCalled();
    expect(moved.status()).toBe('ready');
  });

  it('a restore mid-import when another tab switches versions: no reload until it is done', async () => {
    const t = await setup(); // Settings, nothing focused: a safe point by the page alone
    const release = t.busy.holdBusy('restore'); // confirm() answered, the import transaction is open
    t.takeOver();
    expect(t.loc.reload).not.toHaveBeenCalled();
    expect(t.status()).toBe('ready');
    release();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(t.loc.reload).toHaveBeenCalledTimes(1);
  });

  it('a share sheet opened after an automatic apply began: the handover does not reload until it closes', async () => {
    const t = await setup();
    t.opts().onNeedRefresh!();
    expect(t.status()).toBe('applying');
    const release = t.busy.holdBusy('share sheet');
    t.takeOver();
    expect(t.loc.reload).not.toHaveBeenCalled();
    expect(t.status()).toBe('ready');
    release();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(t.loc.reload).toHaveBeenCalledTimes(1);
    expect(t.update).toHaveBeenCalledTimes(1); // the new version already took over: only a reload was left
  });
});

describe('manual check', () => {
  function fakeRegistration() {
    const reg = {
      installing: null as (EventTarget & { state: string }) | null,
      waiting: null as (EventTarget & { state: string }) | null,
      update: vi.fn(async () => {}),
    };
    return reg;
  }

  it('reports unavailable, offline, failed, current and ready', async () => {
    const t = await setup({ safe: false });
    expect(await t.mod.checkForUpdates()).toBe('unavailable');
    const reg = fakeRegistration();
    t.opts().onRegisteredSW!('/sw.js', reg as never);

    t.nav.onLine = false;
    expect(await t.mod.checkForUpdates()).toBe('offline');
    expect(reg.update).not.toHaveBeenCalled();

    t.nav.onLine = true;
    reg.update.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await t.mod.checkForUpdates()).toBe('failed');

    expect(await t.mod.checkForUpdates()).toBe('current');

    // A new version downloads: resolves only once it has finished installing.
    const worker = Object.assign(new EventTarget(), { state: 'installing' });
    reg.update.mockImplementationOnce(async () => {
      reg.installing = worker;
      setTimeout(() => {
        worker.state = 'installed';
        reg.installing = null;
        reg.waiting = worker;
        worker.dispatchEvent(new Event('statechange'));
      }, 500);
    });
    const pending = t.mod.checkForUpdates();
    let done = false;
    void pending.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toBe('ready');
  });

  it('says ready while an update is waiting or pending a reload', async () => {
    const t = await setup({ safe: false });
    t.opts().onRegisteredSW!('/sw.js', fakeRegistration() as never);
    t.takeOver();
    expect(await t.mod.checkForUpdates()).toBe('ready');
  });
});

describe('announcement after an update you asked for', () => {
  it('is shown once, and only when the version changed', async () => {
    const t = await setup();
    t.store.set('fb-updated-from', 'old1234');
    expect(t.mod.takeUpdateAnnouncement()).toBe('old1234');
    expect(t.mod.takeUpdateAnnouncement()).toBeNull();
    t.store.set('fb-updated-from', t.mod.APP_VERSION); // reloaded, but into the same build
    expect(t.mod.takeUpdateAnnouncement()).toBeNull();
  });

  it('is inert without storage (tests, private modes)', async () => {
    vi.resetModules();
    const mod: Mod = await import('./useAppUpdate');
    expect(mod.takeUpdateAnnouncement()).toBeNull();
    expect(mod.APP_VERSION).toBe('dev');
  });
});

describe('isUpdateSafePoint', () => {
  it('is false in guided flows, the reel, open sheets and while typing', async () => {
    const t = await setup();
    vi.stubGlobal('HTMLElement', FakeElement);
    vi.stubGlobal('HTMLInputElement', FakeInput);
    vi.stubGlobal('HTMLTextAreaElement', FakeTextArea);
    const safeAt = (hash: string) => {
      t.loc.hash = hash;
      return t.mod.isUpdateSafePoint();
    };
    for (const h of ['#/review', '#/close/2026-Q3', '#/setup/2026-Q4', '#/checkin', '#/onboarding', '#/about', '#/reel/2026-Q3/close']) {
      expect(safeAt(h), h).toBe(false);
    }
    for (const h of ['', '#/', '#/settings', '#/burner/work', '#/archive', '#/coach']) {
      expect(safeAt(h), h).toBe(true);
    }
    t.loc.hash = '#/';
    t.doc.dialogOpen = true;
    expect(t.mod.isUpdateSafePoint()).toBe(false);
    t.doc.dialogOpen = false;
    for (const type of ['text', 'email', 'search', 'number', 'tel', 'url', 'password']) {
      t.doc.activeElement = new FakeInput(type);
      expect(t.mod.isUpdateSafePoint(), type).toBe(false);
    }
    for (const type of ['checkbox', 'radio', 'range', 'button', 'file']) {
      t.doc.activeElement = new FakeInput(type);
      expect(t.mod.isUpdateSafePoint(), type).toBe(true);
    }
    t.doc.activeElement = new FakeTextArea();
    expect(t.mod.isUpdateSafePoint()).toBe(false);
    const editable = new FakeElement();
    editable.isContentEditable = true;
    t.doc.activeElement = editable;
    expect(t.mod.isUpdateSafePoint()).toBe(false);
    t.doc.activeElement = new FakeElement();
    expect(t.mod.isUpdateSafePoint()).toBe(true);
  });

  it('is false while something is held or text is typed anywhere, even without focus', async () => {
    const t = await setup();
    vi.stubGlobal('HTMLElement', FakeElement);
    vi.stubGlobal('HTMLInputElement', FakeInput);
    vi.stubGlobal('HTMLTextAreaElement', FakeTextArea);
    expect(t.mod.isUpdateSafePoint()).toBe(true);
    const release = t.busy.holdBusy('share sheet');
    expect(t.mod.isUpdateSafePoint()).toBe(false);
    expect(t.mod.hasUnsavedWork()).toBe(true);
    release();
    expect(t.mod.isUpdateSafePoint()).toBe(true);
    t.doc.fields = [{ type: 'search', value: 'Jake' }]; // typed, then tapped elsewhere
    expect(t.mod.isUpdateSafePoint()).toBe(false);
    t.doc.fields = [{ type: 'textarea', value: 'a note' }];
    expect(t.mod.hasUnsavedWork()).toBe(true);
    t.doc.fields = [{ type: 'text', value: '' }, { type: 'range', value: '5' }];
    expect(t.mod.isUpdateSafePoint()).toBe(true);
    expect(t.mod.hasUnsavedWork()).toBe(false);
  });
});
