// The app's notion of "now". Normally the real time; the dev menu can shift it
// ("time travel") to preview the weekly review or a quarter close before they happen.
const KEY = 'fb-dev-clock-offset-ms';

let offsetMs = (() => {
  try {
    return Number(globalThis.localStorage?.getItem(KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
})();

export function now(): Date {
  return new Date(Date.now() + offsetMs);
}

export function clockOffsetMs(): number {
  return offsetMs;
}

/** Shift the app clock. 0 returns to real time. Fires a `fb-clock` event so screens refresh. */
export function setClockOffset(ms: number) {
  offsetMs = ms;
  try {
    if (ms) globalThis.localStorage?.setItem(KEY, String(ms));
    else globalThis.localStorage?.removeItem(KEY);
  } catch {
    // storage unavailable; offset still applies for this session
  }
  globalThis.dispatchEvent?.(new Event('fb-clock'));
}

/** Shift the clock so that it is `date` (at the current local time of day). */
export function travelTo(date: string) {
  const real = new Date();
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(real);
  target.setFullYear(y, m - 1, d);
  setClockOffset(target.getTime() - real.getTime());
}
