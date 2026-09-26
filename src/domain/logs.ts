// Editing logs with history, and energy summaries.
import { addDays, dateRange } from './dates';
import type { EnergyEntry, Instant, LocalDate, LogEntry } from './types';

export interface LogPatch {
  value?: number;
  note?: string;
  notePrivate?: boolean;
}

/**
 * Apply an edit to a log, recording the previous value and note in its history.
 * Returns the same object if nothing changed.
 */
export function applyLogEdit(log: LogEntry, patch: LogPatch, at: Instant): LogEntry {
  const value = patch.value ?? log.value;
  const noteIn = patch.note !== undefined ? patch.note.trim() : log.note;
  const note = noteIn ? noteIn : undefined;
  const notePrivate = note ? (patch.notePrivate ?? log.notePrivate ?? false) : undefined;
  if (value === log.value && note === log.note && (notePrivate ?? false) === (log.notePrivate ?? false)) return log;
  // Adding a first note (or flipping privacy) is not a correction, so it leaves no history entry.
  const isCorrection = value !== log.value || (!!log.note && note !== log.note);
  return {
    ...log,
    value,
    note,
    notePrivate,
    edits: isCorrection ? [...(log.edits ?? []), { at, prevValue: log.value, ...(log.note ? { prevNote: log.note } : {}) }] : log.edits,
    updatedAt: at,
  };
}

/** The one energy rating for a date (latest wins if duplicates ever sync in). */
export function energyOn(entries: readonly EnergyEntry[], date: LocalDate): EnergyEntry | undefined {
  let best: EnergyEntry | undefined;
  for (const e of entries) {
    if (e.deleted || e.localDate !== date) continue;
    if (!best || e.updatedAt > best.updatedAt) best = e;
  }
  return best;
}

export interface EnergyTrend {
  /** Average over the last 7 days (null if none rated). */
  recent: number | null;
  /** Average over the 7 days before that. */
  prior: number | null;
  direction: 'up' | 'down' | 'flat' | 'unknown';
  ratedDays: number;
}

export function energyTrend(entries: readonly EnergyEntry[], today: LocalDate): EnergyTrend {
  const avg = (from: LocalDate, to: LocalDate) => {
    const vals = dateRange(from, to)
      .map((d) => energyOn(entries, d)?.rating)
      .filter((v): v is EnergyEntry['rating'] => v !== undefined);
    return { mean: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null, n: vals.length };
  };
  const r = avg(addDays(today, -6), today);
  const p = avg(addDays(today, -13), addDays(today, -7));
  let direction: EnergyTrend['direction'] = 'unknown';
  if (r.mean !== null && p.mean !== null) {
    const d = r.mean - p.mean;
    direction = d > 0.3 ? 'up' : d < -0.3 ? 'down' : 'flat';
  }
  return { recent: r.mean, prior: p.mean, direction, ratedDays: r.n };
}
