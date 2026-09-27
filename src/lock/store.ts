// Device-local storage for the app lock (Phase 6). Nothing here is synced or backed up: each device
// enrolls its own passkey and keeps its own settings.
//
// THE FACE ID LOCK IS AN ACCESS GATE, NOT ENCRYPTION. Everything below is plain localStorage, readable by
// anything that runs script in this origin. The record holds only public data (a credential id and a
// public key). Full statement: webauthnLocal.ts.
//
// Every read and write is wrapped: storage can throw (private browsing, quota, a locked-down profile).
import { DEFAULT_IDLE_MINUTES, IDLE_CHOICES, type IdleMinutes, type LockLogEntry, type LockRecord } from './types';
import { base64urlDecode, base64urlEncode } from './webauthnLocal';

export const RECORD_KEY = 'fb-lock';
export const USER_ID_KEY = 'fb-lock-user-id';
export const IDLE_KEY = 'fb-lock-idle';
export const ACTIVE_KEY = 'fb-lock-active';
export const LOG_KEY = 'fb-lock-log';
/** sessionStorage: set right before an app-initiated reload. */
export const RELOAD_KEY = 'fb-lock-reload';
export const LOG_LIMIT = 60;

function local(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function session(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function get(s: Storage | null, key: string): string | null {
  try {
    return s?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function set(s: Storage | null, key: string, value: string): boolean {
  if (!s) return false;
  try {
    s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function remove(s: Storage | null, key: string): void {
  try {
    s?.removeItem(key);
  } catch {
    // nothing to do
  }
}

// ---------- The lock record ----------

export interface RecordRead {
  /** The record for this address, or null when this device has no lock here. */
  record: LockRecord | null;
  /** A record exists but belongs to another address (a preview URL or an old domain). */
  otherHost: boolean;
}

/**
 * "Enrolled here" means exactly what the inline script in index.html checks: v === 1 and rpId equals this
 * hostname. Keep the two in step. Other fields are not validated here on purpose: a damaged record still
 * counts as enrolled, so it fails closed (the unlock ceremony fails and recovery takes over) instead of
 * silently opening the app.
 */
export function readRecord(hostname: string): RecordRead {
  const raw = get(local(), RECORD_KEY);
  if (!raw) return { record: null, otherHost: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { record: null, otherHost: false };
  }
  if (!parsed || typeof parsed !== 'object') return { record: null, otherHost: false };
  const r = parsed as Partial<LockRecord>;
  if (r.v !== 1 || typeof r.rpId !== 'string') return { record: null, otherHost: false };
  if (r.rpId !== hostname) return { record: null, otherHost: true };
  return { record: r as LockRecord, otherHost: false };
}

export function writeRecord(record: LockRecord): boolean {
  return set(local(), RECORD_KEY, JSON.stringify(record));
}

export function removeRecord(): void {
  remove(local(), RECORD_KEY);
}

// ---------- This device's WebAuthn user handle ----------

/**
 * 32 random bytes, created once and kept even when the lock is turned off. Reused on every enrollment so
 * a new passkey replaces this device's old one (same rp.id + user.id) and never another device's synced
 * passkey.
 */
export function userId(): Uint8Array<ArrayBuffer> {
  const saved = get(local(), USER_ID_KEY);
  if (saved) {
    try {
      const bytes = base64urlDecode(saved);
      if (bytes.length === 32) return bytes;
    } catch {
      // replaced below
    }
  }
  const fresh = crypto.getRandomValues(new Uint8Array(32));
  set(local(), USER_ID_KEY, base64urlEncode(fresh));
  return fresh;
}

// ---------- Idle setting and last activity ----------

export function readIdle(): IdleMinutes {
  const raw = get(local(), IDLE_KEY);
  if (raw === null) return DEFAULT_IDLE_MINUTES;
  const n = Number(raw);
  return (IDLE_CHOICES as readonly number[]).includes(n) ? (n as IdleMinutes) : DEFAULT_IDLE_MINUTES;
}

export function writeIdle(minutes: IdleMinutes): void {
  set(local(), IDLE_KEY, String(minutes));
}

/** ms timestamp of the last interaction (or of the last hide while unlocked). null = none recorded. */
export function readActive(): number | null {
  const raw = get(local(), ACTIVE_KEY);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function writeActive(ms: number): void {
  set(local(), ACTIVE_KEY, String(ms));
}

export function clearActive(): void {
  remove(local(), ACTIVE_KEY);
}

// ---------- Trusted reloads ----------

export function markReload(ms: number): void {
  set(session(), RELOAD_KEY, String(ms));
}

/** Reads and deletes the reload stamp, so it applies to one launch only. */
export function consumeReload(): number | null {
  const s = session();
  const raw = get(s, RELOAD_KEY);
  remove(s, RELOAD_KEY);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// ---------- Diagnostics ----------

export function readLog(): LockLogEntry[] {
  const raw = get(local(), LOG_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((e): e is LockLogEntry => !!e && typeof e === 'object' && typeof e.at === 'number' && typeof e.event === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Appends to the ring buffer (last LOG_LIMIT entries). Never throws. */
export function appendLog(event: string, detail?: string, at = Date.now()): void {
  const entry: LockLogEntry = detail ? { at, event, detail: detail.slice(0, 200) } : { at, event };
  const next = [...readLog(), entry].slice(-LOG_LIMIT);
  set(local(), LOG_KEY, JSON.stringify(next));
}
