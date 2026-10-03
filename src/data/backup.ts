// JSON backups: export everything that syncs to one file, import it back with a last-write-wins merge,
// and a monthly reminder to save a copy to iOS Files through the share sheet.
//
// CONTRACT (implement exactly):
// - The backup covers exactly what sync covers: every record in SYNCED_COLLECTIONS that is not local-only
//   (same rule as isLocalOnly in src/sync/engine.ts: no "sample-" ids, no quarters listed in kv
//   "sampleQuarters", only kv keys in SYNCED_KV_KEYS), including soft-deleted records, with the
//   local-only fields (LOCAL_ONLY_FIELDS) stripped.
// - importBackup never deletes anything. Per record: add it when missing locally; replace the local
//   record only when the imported updatedAt is strictly newer (Date.parse); otherwise skip. Records are
//   written through normal Dexie writes so the change-tracking hooks mark them dirty (they sync up).
//   Local-only records are never touched, and local-only records inside a file are skipped.
//   All writes happen in one rw transaction (all or nothing). Invalid files throw BackupError with a
//   short plain-language message (no em dashes) and write nothing.
// - A file is invalid when any record of a known collection does not have the shape its domain type
//   (src/domain/types.ts) promises: required fields present with the right type, optional fields absent
//   or the right type, ids 1 to 200 characters (the server's limit), UTC offsets (offsetMin) within one
//   day, the synced settings in their ranges, and no "__proto__", "constructor" or
//   "prototype" keys at any depth. Imported records sync to every device, so a record the screens cannot
//   render would break the app everywhere. Unknown extra fields are allowed.
// - Device-local kv keys (never synced, never in backups): LAST_BACKUP_KEY, BACKUP_SNOOZE_KEY,
//   BACKUP_REMINDER_START_KEY.
// - Reminder: due when now >= max(lastBackupAt, reminderStart) + 30 days and now >= snoozedUntil.
//   reminderStart is set to now the first time the reminder is checked on a device (so a brand-new
//   install is not nagged on day one). Snooze pushes it 7 days.
import { BURNERS, HEALTH_METRIC_IDS, INTENTS, parseTime } from '@/domain';
import { isLocalOnly, loadSampleQuarterIds } from '@/sync/localOnly';
import { LOCAL_ONLY_FIELDS, SEED_UPDATED_AT, SYNCED_COLLECTIONS, primaryKeyOf, type Collection } from '@/sync/types';
import { db } from './db';
import { nextUpdatedAt } from './stamp';

export const BACKUP_FORMAT = 'four-burners-backup';
export const BACKUP_VERSION = 1;
export const LAST_BACKUP_KEY = 'lastBackupAt';
export const BACKUP_SNOOZE_KEY = 'backupSnoozedUntil';
export const BACKUP_REMINDER_START_KEY = 'backupReminderStart';
export const BACKUP_INTERVAL_DAYS = 30;
export const BACKUP_SNOOZE_DAYS = 7;

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  /** Dexie schema version (db.verno) of the exporting build. */
  schemaVersion: number;
  exportedAt: string;
  app: { name: 'Four Burners'; build?: string };
  tables: Partial<Record<Collection, Record<string, unknown>[]>>;
}

export interface ImportSummary {
  added: number;
  updated: number;
  skipped: number;
}

export class BackupError extends Error {}

const DAY_MS = 86_400_000;
/** How long a download's blob URL stays alive. Safari can still be reading it right after the click. */
const REVOKE_AFTER_MS = 40_000;

const NOT_A_BACKUP = 'This file is not a Four Burners backup.';
const DAMAGED = 'This backup file is damaged or incomplete.';
const TOO_NEW = 'This backup is from a newer version of Four Burners. Update the app, then try again.';

type Row = Record<string, unknown>;

const isObject = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An ISO 8601 UTC-or-offset timestamp that both Date.parse and Postgres read the same way. */
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const isStamp = (v: unknown): v is string => typeof v === 'string' && ISO_STAMP.test(v) && Number.isFinite(Date.parse(v));
/** A record's updatedAt in ms; missing or malformed counts as the seed (older than any real edit), as in sync. */
const stampMs = (v: unknown) => Date.parse(isStamp(v) ? v : SEED_UPDATED_AT);

// ---------- Record shapes (see CONTRACT) ----------

type Check = (v: unknown) => boolean;

const str: Check = (v) => typeof v === 'string';
const num: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const bool: Check = (v) => typeof v === 'boolean';
const oneOf = (...allowed: readonly unknown[]): Check => (v) => allowed.includes(v);
const listOf = (item: Check): Check => (v) => Array.isArray(v) && v.every(item);
/** Any time Date can read (formatting an unreadable one throws). */
const instant: Check = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const localDate: Check = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v));
const quarterId: Check = (v) => typeof v === 'string' && /^\d{4}-Q[1-4]$/.test(v);
const burner = oneOf(...BURNERS);
const intent = oneOf(...INTENTS);
const inRange = (min: number, max: number): Check => (v) => num(v) && (v as number) >= min && (v as number) <= max;

/** An object with these required fields, and these optional ones only when they have the right type. */
function shape(required: Record<string, Check>, optional: Record<string, Check> = {}): Check {
  return (v) =>
    isObject(v) &&
    Object.entries(required).every(([k, check]) => Object.hasOwn(v, k) && check(v[k])) &&
    Object.entries(optional).every(([k, check]) => !Object.hasOwn(v, k) || check(v[k]));
}

const perBurner = (check: Check) => shape(Object.fromEntries(BURNERS.map((b) => [b, check])));
/** Every record may carry these. id and updatedAt are checked for all records before the shape. */
const BASE: Record<string, Check> = { createdAt: instant, deleted: bool };
/** offsetMin is a UTC offset (real ones are -720 to +840); a huge one breaks the date math behind scores. */
const STAMP: Record<string, Check> = { at: instant, offsetMin: inRange(-1440, 1440), localDate };
const TRAVEL = oneOf('rare', 'monthly', 'weekly', 'mostly_away', null);
const PROFILE_FIELDS: Record<string, Check> = { lifeContext: str, burners: perBurner(shape({ matters: str, winning: str })), crunch: str };
const profileFields = shape(PROFILE_FIELDS, { travel: TRAVEL });
const hhmm: Check = (v) => parseTime(v) !== null;
const reminder = shape({ on: bool, time: hhmm });
const NOTIFY = shape({ daily: reminder, weekly: reminder, nudges: bool, quiet: shape({ on: bool, start: hhmm, end: hhmm }) });
const HEALTH_LINK = shape({ metric: oneOf(...HEALTH_METRIC_IDS) }, { min: inRange(0, 1e6) });
const SOURCE = oneOf('shortcut', 'health');

/** Values of the kv keys that sync. Other kv keys are device-local and skipped on import. */
const KV_VALUES = new Map<string, Check>([
  [
    'settings',
    shape({}, {
      dayBoundaryHour: inRange(0, 23),
      graceDaysPerWeek: inRange(0, 7),
      reviewDay: (v) => Number.isInteger(v) && inRange(0, 6)(v),
      soundEffects: bool,
      haptics: bool,
      sensitiveTerms: listOf(str),
      notify: NOTIFY,
    }),
  ],
  ['onboarding', shape({}, { step: num, draft: profileFields, quarterId, completedAt: instant, dismissedAt: instant, snapshotted: bool, resumeHidden: bool })],
]);

const RECORD_SHAPES: Record<Collection, Check> = {
  quarters: shape(
    { id: quarterId, intents: perBurner(intent), intentHistory: listOf(shape({ burner, from: intent, to: intent, reason: str, at: instant, localDate })), status: oneOf('active', 'closed') },
    { ...BASE, theme: str, setupAt: instant, closedAt: instant, summary: shape({ progressScore: num, consistencyScore: num, longestStreak: num, checkInDays: num }) },
  ),
  goals: shape(
    { quarterId, burner, title: str, type: oneOf('number', 'habit', 'yesno', 'milestone'), startDate: localDate, deadline: localDate, order: num },
    {
      ...BASE,
      why: str,
      whenWhere: str,
      target: num,
      unit: str,
      habitPeriod: oneOf('week', 'month'),
      milestones: listOf(shape({ id: str, title: str }, { doneAt: instant })),
      personIds: listOf(str),
      grade: oneOf('A', 'B', 'C', 'D', 'F'),
      closeDecision: oneOf('carry', 'modify', 'drop'),
      carriedFromId: str,
      carriedToId: str,
      health: HEALTH_LINK,
    },
  ),
  logs: shape(
    { goalId: str, value: num, ...STAMP },
    { ...BASE, milestoneId: str, note: str, notePrivate: bool, edits: listOf(shape({ at: instant, prevValue: num }, { prevNote: str })), source: SOURCE, healthWrittenAt: instant },
  ),
  energy: shape({ rating: oneOf(1, 2, 3, 4, 5), ...STAMP }, BASE),
  people: shape({ name: str, burner: oneOf('family', 'friends'), cadenceDays: num, order: num }, BASE),
  touchpoints: shape({ personId: str, type: oneOf('call', 'text', 'in_person', 'other'), ...STAMP }, { ...BASE, note: str, notePrivate: bool, source: SOURCE }),
  crunch: shape({ start: localDate }, { ...BASE, end: localDate, label: str }),
  reviews: shape(
    { weekStart: localDate, step: num, wins: listOf(str), misses: listOf(str), focus: str, focusBurners: listOf(burner) },
    { ...BASE, drafts: shape({}, { win: str, miss: str, action: str }), coachSkipped: bool, completedAt: instant },
  ),
  actions: shape({ weekStart: localDate, text: str, order: num }, { ...BASE, burner, done: shape(STAMP) }),
  profiles: shape({ ...PROFILE_FIELDS, source: oneOf('interview', 'edited', 'coach') }, { ...BASE, travel: TRAVEL, previous: profileFields, onboardedAt: instant }),
  coachReplies: shape(
    { kind: oneOf('onboarding', 'weekly', 'quarter_setup', 'checkin'), scope: str, text: str, actions: listOf(str) },
    { ...BASE, addedActions: listOf(str), packetChars: num },
  ),
  kv: (r) => {
    const value = KV_VALUES.get((r as Row).key as string);
    return !value || value((r as Row).value);
  },
};

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** No app record nests anywhere near this deep. */
const MAX_DEPTH = 16;

/** No key that could reach an object's prototype, at any depth, and no absurd nesting. */
function safeKeys(v: unknown, depth = 0): boolean {
  if (typeof v !== 'object' || v === null) return true;
  if (depth > MAX_DEPTH) return false;
  if (Array.isArray(v)) return v.every((x) => safeKeys(x, depth + 1));
  return Object.keys(v).every((k) => !UNSAFE_KEYS.has(k) && safeKeys((v as Row)[k], depth + 1));
}

/** True when a record from a file (or any outside source) is safe to write to `collection`. */
export function isValidRecord(collection: Collection, r: unknown): boolean {
  if (!isObject(r)) return false;
  const key = r[primaryKeyOf(collection)];
  return (
    typeof key === 'string' &&
    key.length >= 1 &&
    key.length <= 200 &&
    isStamp(r.updatedAt) &&
    safeKeys(r) &&
    RECORD_SHAPES[collection](r)
  );
}

const syncedTables = () => SYNCED_COLLECTIONS.map((c) => db.table(c));

function stripLocalFields(record: Row): Row {
  const out = { ...record };
  for (const f of LOCAL_ONLY_FIELDS) delete out[f];
  return out;
}

/** Build the backup object from the local database. */
export async function exportBackup(now: Date = new Date()): Promise<BackupFile> {
  const tables: BackupFile['tables'] = {};
  await db.transaction('r', syncedTables(), async () => {
    const sample = await loadSampleQuarterIds(db);
    const all = await Promise.all(SYNCED_COLLECTIONS.map((c) => db.table(c).toArray() as Promise<Row[]>));
    SYNCED_COLLECTIONS.forEach((c, i) => {
      tables[c] = all[i]
        .filter((r) => !isLocalOnly(c, r, sample))
        .map((r) => {
          const out = stripLocalFields(r);
          // Same rule as sync: a record without a readable updatedAt counts as a seed. Keeps every file importable.
          if (!isStamp(out.updatedAt)) out.updatedAt = SEED_UPDATED_AT;
          return out;
        });
    });
  });
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    schemaVersion: db.verno,
    exportedAt: now.toISOString(),
    app: { name: 'Four Burners' },
    tables,
  };
}

/** `four-burners-backup-YYYY-MM-DD.json` (local date of `now`). */
export function backupFileName(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `four-burners-backup-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.json`;
}

/** The backup as a File ready for navigator.share / download (application/json, .json name). */
export async function buildBackupFile(now: Date = new Date()): Promise<File> {
  const backup = await exportBackup(now);
  return new File([JSON.stringify(backup)], backupFileName(now), { type: 'application/json' });
}

/**
 * Parse and validate a backup without writing anything. Throws BackupError with a message for the UI.
 * Collections this build does not know are dropped; everything else must be well formed.
 */
export function parseBackup(text: string): BackupFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new BackupError(NOT_A_BACKUP);
  }
  if (!isObject(data) || data.format !== BACKUP_FORMAT) throw new BackupError(NOT_A_BACKUP);
  const { version } = data;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) throw new BackupError(DAMAGED);
  if (version > BACKUP_VERSION) throw new BackupError(TOO_NEW);
  const source = data.tables;
  if (!isObject(source)) throw new BackupError(DAMAGED);
  const tables: BackupFile['tables'] = {};
  for (const c of SYNCED_COLLECTIONS) {
    if (!Object.hasOwn(source, c)) continue;
    const rows = source[c];
    if (!Array.isArray(rows)) throw new BackupError(DAMAGED);
    for (const r of rows) {
      if (!isValidRecord(c, r)) throw new BackupError(DAMAGED);
    }
    tables[c] = rows as Row[];
  }
  return {
    format: BACKUP_FORMAT,
    version,
    schemaVersion: typeof data.schemaVersion === 'number' ? data.schemaVersion : 0,
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : '',
    app: { name: 'Four Burners', ...(isObject(data.app) && typeof data.app.build === 'string' ? { build: data.app.build } : {}) },
    tables,
  };
}

/** One record per key: the newest wins if a file lists a key twice. */
function newestPerKey(rows: Row[], pk: 'id' | 'key'): Row[] {
  const byKey = new Map<string, Row>();
  for (const r of rows) {
    const key = r[pk] as string;
    const seen = byKey.get(key);
    if (!seen || stampMs(r.updatedAt) > stampMs(seen.updatedAt)) byKey.set(key, r);
  }
  return [...byKey.values()];
}

/** Parse, validate and merge a backup (text of a picked file). */
export async function importBackup(text: string): Promise<ImportSummary> {
  const backup = parseBackup(text);
  const summary: ImportSummary = { added: 0, updated: 0, skipped: 0 };
  await db.transaction('rw', syncedTables(), async () => {
    const sample = await loadSampleQuarterIds(db);
    for (const c of SYNCED_COLLECTIONS) {
      const rows = backup.tables[c];
      if (!rows?.length) continue;
      const pk = primaryKeyOf(c);
      const table = db.table(c);
      const incoming = newestPerKey(rows, pk).map(stripLocalFields);
      const locals = (await table.bulkGet(incoming.map((r) => r[pk] as string))) as (Row | undefined)[];
      const writes: Row[] = [];
      incoming.forEach((r, i) => {
        const local = locals[i];
        if (isLocalOnly(c, r, sample) || (local && isLocalOnly(c, local, sample))) summary.skipped++;
        else if (local && !(stampMs(r.updatedAt) > stampMs(local.updatedAt))) summary.skipped++;
        else {
          // `_dirty: 1` explicitly: the import must sync up, and a put over a clean record would drop the flag.
          writes.push({ ...r, _dirty: 1 });
          if (local) summary.updated++;
          else summary.added++;
        }
      });
      if (writes.length) await table.bulkPut(writes);
    }
  });
  return summary;
}

export type ShareOutcome = 'shared' | 'downloaded' | 'cancelled' | 'retry';

/**
 * Save a prepared file. MUST be called synchronously inside the tap handler (no await before it):
 * iOS requires a fresh user gesture for navigator.share. Pass files only (no title/text).
 * - A Mac with a mouse always downloads (its share menu cannot save to disk).
 * - navigator.canShare({ files }) true -> navigator.share({ files }): resolve 'shared';
 *   AbortError -> 'cancelled'; NotAllowedError -> 'retry' (gesture expired; the UI says "Tap again").
 * - No file sharing, or share rejects for another reason on desktop browsers (Chromium rejects JSON)
 *   -> download through a blob URL on an <a download> attached to the DOM -> 'downloaded'.
 * On 'shared' or 'downloaded' it records LAST_BACKUP_KEY = now.
 */
export function saveBackupFile(file: File): Promise<ShareOutcome> {
  const nav = globalThis.navigator as Partial<Navigator> | undefined;
  const data: ShareData = { files: [file] };
  let canShareFiles = false;
  try {
    canShareFiles = typeof nav?.share === 'function' && typeof nav.canShare === 'function' && nav.canShare(data);
  } catch {
    canShareFiles = false;
  }
  if (!canShareFiles || isDesktopMac(nav)) return downloadFile(file);
  let sharing: Promise<void>;
  try {
    sharing = nav!.share!(data);
  } catch (e) {
    sharing = Promise.reject(e);
  }
  return sharing.then(
    () => recordSaved('shared'),
    (e: unknown) => {
      const name = typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : undefined;
      if (name === 'AbortError') return 'cancelled';
      if (name === 'NotAllowedError') return 'retry';
      // A share sheet is already open (a second tap): the first one is still in charge, so no download.
      if (name === 'InvalidStateError') return 'cancelled';
      return downloadFile(file);
    },
  );
}

/**
 * A Mac with a mouse. Its share menu has no way to save a file to disk, but a download lands in Downloads.
 * iPadOS also says "Macintosh", but it has touch points and keeps the share sheet (Save to Files).
 */
function isDesktopMac(nav: Partial<Navigator> | undefined): boolean {
  return /Macintosh/.test(nav?.userAgent ?? '') && (nav?.maxTouchPoints ?? 0) < 2;
}

function downloadFile(file: File): Promise<ShareOutcome> {
  try {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  } catch (e) {
    return Promise.reject(e);
  }
  return recordSaved('downloaded');
}

async function recordSaved(outcome: 'shared' | 'downloaded'): Promise<ShareOutcome> {
  try {
    await markBackedUp();
  } catch {
    // The file is saved either way; at worst the reminder comes back early.
  }
  return outcome;
}

export interface BackupReminder {
  due: boolean;
  lastBackupAt?: string;
}

const putLocal = (key: string, value: string) => db.kv.put({ key, value, updatedAt: nextUpdatedAt() });
const msOf = (v: unknown) => (isStamp(v) ? Date.parse(v) : undefined);

/**
 * Whether the monthly reminder is due. The first check on a device records reminderStart, so call it
 * from an effect or handler, not inside a live query (live queries cannot write).
 * Backup times are real-world facts (like the file name and exportedAt), so they use the real clock, not
 * the dev pretend day: a backup saved while time traveling must not be dated weeks ahead, which would
 * show a future "Last backup" and silence the reminder long after returning to the real date.
 */
export async function getBackupReminder(now: Date = new Date()): Promise<BackupReminder> {
  return db.transaction('rw', db.kv, async () => {
    const [last, snoozed, start] = await db.kv.bulkGet([LAST_BACKUP_KEY, BACKUP_SNOOZE_KEY, BACKUP_REMINDER_START_KEY]);
    let startMs = msOf(start?.value);
    if (startMs === undefined) {
      startMs = now.getTime();
      await putLocal(BACKUP_REMINDER_START_KEY, now.toISOString());
    }
    const lastMs = msOf(last?.value);
    const dueAt = Math.max(lastMs ?? startMs, startMs) + BACKUP_INTERVAL_DAYS * DAY_MS;
    const due = now.getTime() >= dueAt && now.getTime() >= (msOf(snoozed?.value) ?? -Infinity);
    return lastMs === undefined ? { due } : { due, lastBackupAt: last!.value as string };
  });
}

export async function snoozeBackupReminder(now: Date = new Date()): Promise<void> {
  await putLocal(BACKUP_SNOOZE_KEY, new Date(now.getTime() + BACKUP_SNOOZE_DAYS * DAY_MS).toISOString());
}

export async function markBackedUp(now: Date = new Date()): Promise<void> {
  await putLocal(LAST_BACKUP_KEY, now.toISOString());
}
