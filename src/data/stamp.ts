// updatedAt for sync. Last-write-wins keeps a change only when its updatedAt is strictly newer than the
// stored one (the server ignores ties), so every value handed out on this device is strictly increasing,
// even for two writes in the same millisecond or after the system clock steps back.
// It follows the real clock, never the dev pretend day (clock.ts): time travel changes what day entries
// belong to, but must not date records into the future, where they would beat every later edit.
let last = 0;

/** The last instant toISOString still writes with a 4-digit year (the format sync accepts). */
const MAX_MS = Date.parse('9999-12-31T23:59:59.999Z');

/**
 * A fresh updatedAt (toISOString format): now, or 1 ms after the last one issued if the clock has not moved on.
 * When changing an existing record, pass its stored updatedAt: the result is then also newer than that, so
 * the edit wins even over a stamp from a device whose clock runs ahead, a clock that stepped back between
 * launches, or an old pretend-day stamp (earlier builds wrote those). The floor applies to that record
 * only; later stamps for other records keep following the real clock.
 */
export function nextUpdatedAt(after?: unknown): string {
  const t = Date.now();
  last = t > last ? t : last + 1;
  const floor = typeof after === 'string' ? Date.parse(after) : NaN;
  return new Date(floor >= last && floor < MAX_MS ? floor + 1 : last).toISOString();
}
