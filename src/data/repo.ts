// All writes go through here so every record gets consistent timestamps for sync.
import {
  DEFAULT_INTENTS,
  DEFAULT_SETTINGS,
  EMPTY_PROFILE_FIELDS,
  applyLogEdit,
  canSetIntent,
  carryForward,
  changeIntent,
  energyOn,
  newId,
  nextQuarterId,
  quarterOf,
  quarterSpan,
  stampNow,
  today as todayFor,
  validateIntents,
  type BurnerId,
  type CloseDecision,
  type CoachReply,
  type EnergyEntry,
  type Goal,
  type Grade,
  type Intent,
  type LocalDate,
  type LogEntry,
  type LogPatch,
  type Person,
  type Profile,
  type ProfileFields,
  type Quarter,
  type QuarterId,
  type QuarterSummary,
  type Settings,
  type Touchpoint,
  type TouchpointType,
  type WeeklyAction,
  type WeeklyReview,
} from '@/domain';
import { PREFILLED_UPDATED_AT, SEED_UPDATED_AT, isSeedStamp } from '@/sync/types';
import type { Table } from 'dexie';
import { db, SETTINGS_KEY, type KV } from './db';
import { now as clockNow } from './clock';
import { nextUpdatedAt } from './stamp';

// Sync rules for every write below:
// - updatedAt always comes from nextUpdatedAt() (strictly increasing on this device, real clock), so the
//   later of two quick edits always wins last-write-wins. An edit to an existing record passes the stored
//   updatedAt (or goes through touch()), so it is also newer than that stamp, even one from a device whose
//   clock runs ahead. Domain times (at, localDate, doneAt) still follow the app clock, including the dev
//   pretend day.
// - Records the app creates on its own, without a tap (the current quarter, a review opened for the
//   week), get updatedAt = SEED_UPDATED_AT, so they can never overwrite real data from another device.
//   When the app fills one in on its own (next quarter's intents copied at the quarter close), it gets
//   PREFILLED_UPDATED_AT: that beats an untouched seed from another device, so the content spreads, but
//   still loses to any real edit. "Still a seed" checks use isSeedStamp, which counts both.
// - Read-modify-write of a whole record runs in one transaction, so a sync pull cannot land in between
//   and be overwritten by a stale copy.
// - A put() that replaces a record with a freshly built object sets `_dirty: 1` itself: over a record the
//   sync engine marked clean, the change-tracking hook sees `_dirty` removed, takes that as an explicit
//   write, and the change would never sync.

/** Write a whole kv row (settings, onboarding progress, device-local keys). */
function putKv(key: string, value: unknown) {
  return db.transaction('rw', db.kv, async () => {
    const cur = await db.kv.get(key);
    await db.kv.put({ key, value, updatedAt: nextUpdatedAt(cur?.updatedAt), _dirty: 1 } as KV);
  });
}

/**
 * Patch one record in a single atomic read and write, stamped past its stored updatedAt.
 * `undefined` in the patch removes the field, as in Dexie's update().
 */
function touch<T extends { updatedAt: string }, I>(table: Table<T, string, I>, id: string, patch: Partial<T>) {
  return table.update(id, (r) => {
    const rec = r as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete rec[k];
      else rec[k] = v;
    }
    rec.updatedAt = nextUpdatedAt(rec.updatedAt);
  });
}

export async function getSettings(): Promise<Settings> {
  const row = await db.kv.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...((row?.value as Partial<Settings>) ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await db.transaction('rw', db.kv, async () => {
    const current = await getSettings();
    await putKv(SETTINGS_KEY, { ...current, ...patch });
  });
}

export async function currentToday(): Promise<string> {
  return todayFor((await getSettings()).dayBoundaryHour, clockNow());
}

/** A default quarter, created only if missing. Seeded, so a real copy from another device always wins. */
async function seedQuarter(id: QuarterId): Promise<Quarter> {
  return db.transaction('rw', db.quarters, async () => {
    const existing = await db.quarters.get(id);
    if (existing) return existing;
    const q: Quarter = {
      id,
      createdAt: new Date().toISOString(),
      updatedAt: SEED_UPDATED_AT,
      intents: { ...DEFAULT_INTENTS },
      intentHistory: [],
      status: 'active',
    };
    await db.quarters.add(q);
    return q;
  });
}

/** Get the quarter containing today, creating it on first use. */
export async function ensureCurrentQuarter(): Promise<Quarter> {
  return seedQuarter(quarterOf(await currentToday()).id);
}

/** Create a quarter record (default intents) if it does not exist yet, e.g. setting up next quarter early. */
export async function ensureQuarter(id: QuarterId): Promise<Quarter> {
  return seedQuarter(id);
}

export async function setTheme(quarterId: QuarterId, theme: string): Promise<void> {
  await touch(db.quarters, quarterId, { theme: theme.trim() || undefined });
}

export type IntentResult = { ok: true } | { ok: false; error: string; needsReason?: boolean };

/**
 * Set a burner's intent. While a quarter has no goals yet (setup), changes are free.
 * Once the quarter is underway a one-line reason is required and the change is logged.
 */
export async function setIntent(
  quarterId: QuarterId,
  burner: BurnerId,
  intent: Intent,
  reason?: string,
): Promise<IntentResult> {
  return db.transaction('rw', db.quarters, db.goals, db.kv, async (): Promise<IntentResult> => {
    const q = await db.quarters.get(quarterId);
    if (!q) return { ok: false, error: 'Quarter not found.' };
    const underway = (await db.goals.where('quarterId').equals(quarterId).filter((g) => !g.deleted).count()) > 0;
    if (!underway) {
      const r = canSetIntent(q.intents, burner, intent);
      if (!r.ok) return r;
      await db.quarters.update(quarterId, { intents: r.value, updatedAt: nextUpdatedAt(q.updatedAt) });
      return { ok: true };
    }
    const cap = canSetIntent(q.intents, burner, intent);
    if (!cap.ok) return cap;
    if (!reason?.trim()) return { ok: false, error: 'Add a short reason.', needsReason: true };
    const settings = await getSettings();
    const s = stampNow(settings.dayBoundaryHour, clockNow());
    const r = changeIntent(q, burner, intent, reason, s.at, s.localDate);
    if (!r.ok) return r;
    // The history entry keeps the app-clock time; updatedAt is the sync stamp.
    await db.quarters.put({ ...r.value, updatedAt: nextUpdatedAt(q.updatedAt) });
    return { ok: true };
  });
}

// ---------- Goals ----------

export type NewGoal = Omit<Goal, 'id' | 'createdAt' | 'updatedAt' | 'order' | 'startDate' | 'deadline'> &
  Partial<Pick<Goal, 'startDate' | 'deadline'>>;

export async function addGoal(input: NewGoal): Promise<Goal> {
  const today = await currentToday();
  const span = quarterSpan(input.quarterId);
  const existing = await db.goals
    .where('quarterId')
    .equals(input.quarterId)
    .filter((g) => g.burner === input.burner && !g.deleted)
    .count();
  const t = nextUpdatedAt();
  const startDate = input.startDate ?? (today > span.start ? today : span.start);
  const goal: Goal = {
    ...input,
    id: newId(),
    createdAt: t,
    updatedAt: t,
    order: existing,
    startDate,
    deadline: input.deadline ?? span.end,
  };
  await db.goals.put(goal);
  return goal;
}

export async function updateGoal(id: string, patch: Partial<Goal>): Promise<void> {
  await touch(db.goals, id, patch);
}

export async function deleteGoal(id: string): Promise<void> {
  await touch(db.goals, id, { deleted: true });
}

// ---------- Logging ----------

export interface LogOptions {
  note?: string;
  notePrivate?: boolean;
  milestoneId?: string;
}

export async function logProgress(goal: Goal, value: number, opts: LogOptions = {}): Promise<LogEntry> {
  const settings = await getSettings();
  const s = stampNow(settings.dayBoundaryHour, clockNow());
  const u = nextUpdatedAt();
  const entry: LogEntry = {
    id: newId(),
    goalId: goal.id,
    value,
    ...s,
    createdAt: s.at,
    updatedAt: u,
    ...(opts.note?.trim() ? { note: opts.note.trim(), notePrivate: !!opts.notePrivate } : {}),
    ...(opts.milestoneId ? { milestoneId: opts.milestoneId } : {}),
  };
  await db.transaction('rw', db.logs, db.goals, async () => {
    await db.logs.put(entry);
    if (goal.type === 'milestone' && opts.milestoneId) {
      // Fresh copy, so steps changed since the screen rendered (e.g. by a sync) are kept.
      const current = (await db.goals.get(goal.id)) ?? goal;
      const milestones = (current.milestones ?? []).map((m) =>
        m.id === opts.milestoneId ? { ...m, doneAt: s.at } : m,
      );
      await db.goals.update(goal.id, { milestones, updatedAt: nextUpdatedAt(current.updatedAt) });
    }
  });
  return entry;
}

/** Soft-delete a log (used by undo). Reopens a milestone step if the log completed one. */
export async function deleteLog(id: string): Promise<void> {
  await db.transaction('rw', db.logs, db.goals, async () => {
    const log = await db.logs.get(id);
    if (!log) return;
    await db.logs.update(id, { deleted: true, updatedAt: nextUpdatedAt(log.updatedAt) });
    if (log.milestoneId) {
      const goal = await db.goals.get(log.goalId);
      if (goal?.milestones) {
        const milestones = goal.milestones.map((m) => (m.id === log.milestoneId ? { ...m, doneAt: undefined } : m));
        await db.goals.update(goal.id, { milestones, updatedAt: nextUpdatedAt(goal.updatedAt) });
      }
    }
  });
}

// ---------- Maintenance ----------

export async function wipeAll(): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
  });
}

export async function editLog(id: string, patch: LogPatch): Promise<void> {
  await db.transaction('rw', db.logs, async () => {
    const log = await db.logs.get(id);
    if (!log) return;
    // The edit history keeps the real time of the correction; updatedAt is the sync stamp.
    const next = applyLogEdit(log, patch, nextUpdatedAt());
    if (next !== log) await db.logs.put({ ...next, updatedAt: nextUpdatedAt(log.updatedAt) });
  });
}

// ---------- People ----------

export type NewPerson = Pick<Person, 'name' | 'burner' | 'cadenceDays'>;

export async function addPerson(input: NewPerson, goalIds: string[] = []): Promise<Person> {
  const t = nextUpdatedAt();
  const order = await db.people.filter((p) => !p.deleted && p.burner === input.burner).count();
  const person: Person = { ...input, name: input.name.trim(), id: newId(), order, createdAt: t, updatedAt: t };
  await db.people.put(person);
  await linkPersonToGoals(person.id, goalIds);
  return person;
}

export async function updatePerson(id: string, patch: Partial<Person>, goalIds?: string[]): Promise<void> {
  await touch(db.people, id, patch);
  if (goalIds) await linkPersonToGoals(id, goalIds);
}

export async function deletePerson(id: string): Promise<void> {
  await touch(db.people, id, { deleted: true });
  await linkPersonToGoals(id, []);
}

/** Make the person linked to exactly these goals (links live on the goal). */
async function linkPersonToGoals(personId: string, goalIds: string[]): Promise<void> {
  const want = new Set(goalIds);
  await db.transaction('rw', db.goals, async () => {
    const goals = await db.goals.filter((g) => !g.deleted && (want.has(g.id) || !!g.personIds?.includes(personId))).toArray();
    for (const g of goals) {
      const has = !!g.personIds?.includes(personId);
      const updatedAt = nextUpdatedAt(g.updatedAt);
      if (want.has(g.id) && !has) await db.goals.update(g.id, { personIds: [...(g.personIds ?? []), personId], updatedAt });
      if (!want.has(g.id) && has) await db.goals.update(g.id, { personIds: g.personIds!.filter((x) => x !== personId), updatedAt });
    }
  });
}

export async function logTouchpoint(personId: string, type: TouchpointType, note?: string, notePrivate?: boolean): Promise<Touchpoint> {
  const s = stampNow((await getSettings()).dayBoundaryHour, clockNow());
  const tp: Touchpoint = {
    id: newId(),
    personId,
    type,
    ...s,
    createdAt: s.at,
    updatedAt: nextUpdatedAt(),
    ...(note?.trim() ? { note: note.trim(), notePrivate: !!notePrivate } : {}),
  };
  await db.touchpoints.put(tp);
  return tp;
}

export async function editTouchpoint(id: string, patch: { note?: string; notePrivate?: boolean; type?: TouchpointType }): Promise<void> {
  const note = patch.note?.trim();
  await touch(db.touchpoints, id, {
    ...(patch.type ? { type: patch.type } : {}),
    ...(patch.note !== undefined ? { note: note || undefined, notePrivate: note ? !!patch.notePrivate : undefined } : {}),
  });
}

export async function deleteTouchpoint(id: string): Promise<void> {
  await touch(db.touchpoints, id, { deleted: true });
}

// ---------- Energy ----------

/** One rating per lived day; tapping again changes it. Pass null to clear. */
export async function setEnergy(rating: EnergyEntry['rating'] | null): Promise<void> {
  const s = stampNow((await getSettings()).dayBoundaryHour, clockNow());
  await db.transaction('rw', db.energy, async () => {
    const day = (await db.energy.where('localDate').equals(s.localDate).toArray()).filter((e) => !e.deleted);
    const existing = energyOn(day, s.localDate);
    if (rating === null) {
      // Two devices can each rate the same day before syncing; clearing clears every copy.
      for (const e of day) await db.energy.update(e.id, { deleted: true, updatedAt: nextUpdatedAt(e.updatedAt) });
      return;
    }
    if (existing) await db.energy.update(existing.id, { rating, updatedAt: nextUpdatedAt(existing.updatedAt), at: s.at, offsetMin: s.offsetMin });
    else await db.energy.put({ id: newId(), rating, ...s, createdAt: s.at, updatedAt: nextUpdatedAt() });
  });
}

/** Undo a log deletion, re-completing its milestone step if it had one. */
export async function restoreLog(id: string): Promise<void> {
  await db.transaction('rw', db.logs, db.goals, async () => {
    const log = await db.logs.get(id);
    if (!log) return;
    await db.logs.update(id, { deleted: false, updatedAt: nextUpdatedAt(log.updatedAt) });
    if (log.milestoneId) {
      const goal = await db.goals.get(log.goalId);
      if (goal?.milestones) {
        const milestones = goal.milestones.map((m) => (m.id === log.milestoneId ? { ...m, doneAt: log.at } : m));
        await db.goals.update(goal.id, { milestones, updatedAt: nextUpdatedAt(goal.updatedAt) });
      }
    }
  });
}

async function stamp() {
  return stampNow((await getSettings()).dayBoundaryHour, clockNow());
}

// ---------- Weekly review ----------

/** Deterministic id per week so two devices never create two reviews for the same week. */
export const reviewId = (weekStart: LocalDate) => `review-${weekStart}`;

/** Opening the review creates it, seeded, so progress made on another device for this week always wins. */
export async function getOrCreateReview(weekStart: LocalDate): Promise<WeeklyReview> {
  const id = reviewId(weekStart);
  return db.transaction('rw', db.reviews, async () => {
    const existing = await db.reviews.where('weekStart').equals(weekStart).filter((r) => !r.deleted).first();
    if (existing) return existing;
    const review: WeeklyReview = {
      id,
      weekStart,
      step: 0,
      wins: [],
      misses: [],
      focus: '',
      focusBurners: [],
      createdAt: new Date().toISOString(),
      updatedAt: SEED_UPDATED_AT,
    };
    await db.reviews.put(review);
    return review;
  });
}

export async function saveReview(id: string, patch: Partial<WeeklyReview>): Promise<void> {
  await touch(db.reviews, id, patch);
}

export async function completeReview(id: string): Promise<void> {
  const s = await stamp();
  await touch(db.reviews, id, { completedAt: s.at });
}

// ---------- Weekly actions ----------

export async function addAction(weekStart: LocalDate, text: string, burner?: BurnerId): Promise<WeeklyAction> {
  const t = nextUpdatedAt();
  const order = await db.actions.where('weekStart').equals(weekStart).filter((a) => !a.deleted).count();
  const action: WeeklyAction = { id: newId(), weekStart, text: text.trim(), burner, order, createdAt: t, updatedAt: t };
  await db.actions.put(action);
  return action;
}

export async function updateAction(id: string, patch: Partial<WeeklyAction>): Promise<void> {
  await touch(db.actions, id, patch);
}

export async function removeAction(id: string): Promise<void> {
  await touch(db.actions, id, { deleted: true });
}

/** Tap an action done (a check-in), or tap again to undo. Returns whether it is now done. */
export async function toggleAction(id: string): Promise<boolean> {
  return db.transaction('rw', db.actions, db.kv, async () => {
    const a = await db.actions.get(id);
    if (!a) return false;
    if (a.done) {
      await db.actions.update(id, { done: undefined, updatedAt: nextUpdatedAt(a.updatedAt) });
      return false;
    }
    await db.actions.update(id, { done: await stamp(), updatedAt: nextUpdatedAt(a.updatedAt) });
    return true;
  });
}

// ---------- Travel/Crunch mode ----------

export async function startCrunch(opts: { end?: LocalDate; label?: string } = {}): Promise<void> {
  const s = await stamp();
  await endCrunch();
  const t = nextUpdatedAt();
  await db.crunch.put({
    id: newId(),
    start: s.localDate,
    ...(opts.end && opts.end >= s.localDate ? { end: opts.end } : {}),
    ...(opts.label ? { label: opts.label } : {}),
    createdAt: t,
    updatedAt: t,
  });
}

/** End any crunch covering today. Today still counts as a crunch day, unless it only started today. */
export async function endCrunch(): Promise<void> {
  const today = (await stamp()).localDate;
  const open = await db.crunch.filter((p) => !p.deleted && p.start <= today && (!p.end || p.end >= today)).toArray();
  for (const p of open) {
    if (p.start === today) await touch(db.crunch, p.id, { deleted: true });
    else await touch(db.crunch, p.id, { end: today });
  }
}

// ---------- Quarter close and setup ----------

export async function gradeGoal(id: string, grade: Grade): Promise<void> {
  await touch(db.goals, id, { grade });
}

export async function decideGoal(id: string, closeDecision: CloseDecision): Promise<void> {
  await touch(db.goals, id, { closeDecision });
}

/** The "-YYYY-Qn" endings carried ids add. A root id (a UUID from newId) never ends like this. */
const CARRY_SUFFIXES = /(-\d{4}-Q[1-4])+$/;

/**
 * The id a goal gets when carried into the next quarter: the root goal's id (the goal as first created)
 * plus the quarter. It is the same on every device, and it never grows, however many times a goal is
 * carried (the server refuses ids over 200 characters). Earlier builds chained one ending per carry;
 * carrying one of those ids also drops the old endings. Ids already stored keep working as they are.
 */
export const carriedGoalId = (goalId: string, nextId: QuarterId) => `${goalId.replace(CARRY_SUFFIXES, '')}-${nextId}`;

/**
 * Close a quarter: freeze its summary, carry forward goals marked carry/modify into the next quarter
 * (fresh progress, starting today if the close happens late), and pre-fill next quarter's intents.
 * Safe to run twice: already-carried goals are skipped.
 */
export async function closeQuarter(quarterId: QuarterId, summary: QuarterSummary): Promise<QuarterId> {
  const nextId = nextQuarterId(quarterId);
  const nextSpan = quarterSpan(nextId);
  const today = await currentToday();
  const startDate = today > nextSpan.start && today <= nextSpan.end ? today : nextSpan.start;
  const t = nextUpdatedAt();
  await db.transaction('rw', db.quarters, db.goals, async () => {
    const q = await db.quarters.get(quarterId);
    if (!q) return;
    const next = await db.quarters.get(nextId);
    // Next quarter is a side effect of closing. Creating it, or pre-filling one that is still auto-created,
    // stamps it PREFILLED_UPDATED_AT: the copied intents beat another device's untouched seed of it (so every
    // device gets them), while a next quarter set up or edited on another device still wins.
    if (!next) {
      await db.quarters.add({ id: nextId, createdAt: t, updatedAt: PREFILLED_UPDATED_AT, intents: { ...q.intents }, intentHistory: [], status: 'active' });
    } else if (!next.setupAt) {
      const hasGoals = (await db.goals.where('quarterId').equals(nextId).filter((g) => !g.deleted).count()) > 0;
      if (!hasGoals) {
        await db.quarters.update(nextId, { intents: { ...q.intents }, updatedAt: isSeedStamp(next.updatedAt) ? PREFILLED_UPDATED_AT : nextUpdatedAt(next.updatedAt) });
      }
    }
    const nextGoals = await db.goals.where('quarterId').equals(nextId).filter((g) => !g.deleted).toArray();
    const order: Record<BurnerId, number> = { family: 0, friends: 0, health: 0, work: 0 };
    for (const g of nextGoals) order[g.burner] = Math.max(order[g.burner], g.order + 1);
    const goals = await db.goals.where('quarterId').equals(quarterId).filter((g) => !g.deleted).toArray();
    for (const g of goals.sort((a, b) => a.order - b.order)) {
      if ((g.closeDecision !== 'carry' && g.closeDecision !== 'modify') || g.carriedToId) continue;
      // Deterministic id: if two devices both close this quarter before syncing, their carried copies are
      // one record (last write wins) instead of duplicates. A copy that already arrived is kept as is.
      const id = carriedGoalId(g.id, nextId);
      if (!(await db.goals.get(id))) {
        await db.goals.put(carryForward(g, { quarterId: nextId, startDate, deadline: nextSpan.end }, id, t, order[g.burner]++));
      }
      await db.goals.update(g.id, { carriedToId: id, updatedAt: nextUpdatedAt(g.updatedAt) });
    }
    await db.quarters.update(quarterId, { status: 'closed', closedAt: t, summary, updatedAt: nextUpdatedAt(q.updatedAt) });
  });
  return nextId;
}

/** Intents during guided setup: the High cap applies, but no reason or history is needed yet. */
export async function setSetupIntents(quarterId: QuarterId, intents: Record<BurnerId, Intent>): Promise<IntentResult> {
  const r = validateIntents(intents);
  if (!r.ok) return r;
  await touch(db.quarters, quarterId, { intents: { ...intents } });
  return { ok: true };
}

export async function finishSetup(quarterId: QuarterId): Promise<void> {
  await touch(db.quarters, quarterId, { setupAt: nextUpdatedAt() });
}

// ---------- Travel awareness ----------

const OFFSET_KEY = 'lastOffsetMin';

/**
 * Returns the old and new UTC offsets if the device changed time zones since the last check.
 * Runs on launch and on every return to the app, so it only writes (a device-local kv key) on a change.
 */
export async function checkTimeZoneChange(): Promise<{ from: number; to: number } | null> {
  const to = -clockNow().getTimezoneOffset();
  const row = await db.kv.get(OFFSET_KEY);
  if (row?.value === to) return null;
  await putKv(OFFSET_KEY, to);
  if (row === undefined) return null;
  return { from: row.value as number, to };
}

const STREAK_KEY = 'lastStreakMilestone';
export const STREAK_MILESTONES = [7, 14, 21, 30, 50, 75, 100, 150, 200, 365];

/** The check-in streak milestone just reached (celebrated once each), or null. */
export async function streakMilestoneReached(streak: number): Promise<number | null> {
  const hit = [...STREAK_MILESTONES].reverse().find((m) => streak >= m) ?? 0;
  const row = await db.kv.get(STREAK_KEY);
  const last = (row?.value as number | undefined) ?? -1;
  if (hit === last) return null;
  await putKv(STREAK_KEY, hit);
  // The first check just records where you are. Only a milestone crossed in the last couple of days
  // celebrates, so jumps (loading data, syncing another device) stay quiet.
  return last >= 0 && hit > last && streak - hit <= 2 ? hit : null;
}

// ---------- About me profile ----------

export async function getProfile(): Promise<Profile | undefined> {
  const p = await db.profiles.get('me');
  return p && !p.deleted ? p : undefined;
}

function fieldsOf(p: ProfileFields): ProfileFields {
  return {
    lifeContext: p.lifeContext,
    burners: {
      family: { ...p.burners.family },
      friends: { ...p.burners.friends },
      health: { ...p.burners.health },
      work: { ...p.burners.work },
    },
    travel: p.travel,
    crunch: p.crunch,
  };
}

/**
 * Save the About me profile. `snapshot` keeps a copy of the previous fields (used before a coach
 * replace or an interview re-run) so "Restore previous version" can undo it.
 */
export async function saveProfile(
  fields: ProfileFields,
  source: Profile['source'],
  opts: { snapshot?: boolean; onboarded?: boolean } = {},
): Promise<Profile> {
  return db.transaction('rw', db.profiles, async () => {
    const t = nextUpdatedAt();
    const existing = await db.profiles.get('me');
    const next: Profile = {
      id: 'me',
      createdAt: existing?.createdAt ?? t,
      updatedAt: nextUpdatedAt(existing?.updatedAt),
      ...fieldsOf(fields),
      source,
      previous: opts.snapshot && existing && !existing.deleted ? fieldsOf(existing) : existing?.previous,
      onboardedAt: opts.onboarded ? existing?.onboardedAt ?? t : existing?.onboardedAt,
    };
    await db.profiles.put({ ...next, _dirty: 1 } as Profile);
    return next;
  });
}

export async function restorePreviousProfile(): Promise<boolean> {
  return db.transaction('rw', db.profiles, async () => {
    const existing = await db.profiles.get('me');
    if (!existing?.previous) return false;
    const updatedAt = nextUpdatedAt(existing.updatedAt);
    await db.profiles.put({ ...existing, ...fieldsOf(existing.previous), previous: fieldsOf(existing), source: 'edited', updatedAt });
    return true;
  });
}

// ---------- Onboarding interview progress ----------

const ONBOARDING_KEY = 'onboarding';

export interface OnboardingProgress {
  step: number;
  draft: ProfileFields;
  /** Quarter chosen for the first setup. */
  quarterId?: QuarterId;
  completedAt?: string;
  /** Set when "Later" is tapped, so first launch stops auto-opening the interview. */
  dismissedAt?: string;
  /** Whether this interview run already snapshotted the previous profile. */
  snapshotted?: boolean;
  /** Set when the user hides the "Finish setting up" card for an unfinished run that has a profile. */
  resumeHidden?: boolean;
}

export async function getOnboarding(): Promise<OnboardingProgress | undefined> {
  return (await db.kv.get(ONBOARDING_KEY))?.value as OnboardingProgress | undefined;
}

/** Merge into the saved progress in one transaction, so overlapping autosaves never drop a flag. */
export async function saveOnboarding(patch: Partial<OnboardingProgress>): Promise<void> {
  await db.transaction('rw', db.kv, async () => {
    const cur = ((await db.kv.get(ONBOARDING_KEY))?.value as OnboardingProgress | undefined) ?? { step: 0, draft: EMPTY_PROFILE_FIELDS };
    await putKv(ONBOARDING_KEY, { ...cur, ...patch });
  });
}

// ---------- Coach replies ----------

export async function saveCoachReply(input: Pick<CoachReply, 'kind' | 'scope' | 'text' | 'actions'> & { packetChars?: number }): Promise<CoachReply> {
  const t = nextUpdatedAt();
  const reply: CoachReply = { id: newId(), createdAt: t, updatedAt: t, ...input, addedActions: [] };
  await db.coachReplies.put(reply);
  return reply;
}

export async function deleteCoachReply(id: string): Promise<void> {
  await touch(db.coachReplies, id, { deleted: true });
}

/** Turn one suggested action from a coach reply into a weekly action (one tap each). */
export async function addActionFromReply(replyId: string, text: string, weekStart: LocalDate, burner?: BurnerId): Promise<void> {
  await db.transaction('rw', db.coachReplies, db.actions, async () => {
    const reply = await db.coachReplies.get(replyId);
    if (!reply) return;
    if (reply.addedActions?.includes(text)) return;
    await addAction(weekStart, text, burner);
    await db.coachReplies.update(replyId, { addedActions: [...(reply.addedActions ?? []), text], updatedAt: nextUpdatedAt(reply.updatedAt) });
  });
}
