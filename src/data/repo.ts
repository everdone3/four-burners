// All writes go through here so every record gets consistent timestamps for sync.
import {
  DEFAULT_INTENTS,
  DEFAULT_SETTINGS,
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
  type EnergyEntry,
  type Goal,
  type Grade,
  type Intent,
  type LocalDate,
  type LogEntry,
  type LogPatch,
  type Person,
  type Quarter,
  type QuarterId,
  type QuarterSummary,
  type Settings,
  type Touchpoint,
  type TouchpointType,
  type WeeklyAction,
  type WeeklyReview,
} from '@/domain';
import { db, SETTINGS_KEY } from './db';
import { now as clockNow } from './clock';

const nowIso = () => new Date().toISOString();

export async function getSettings(): Promise<Settings> {
  const row = await db.kv.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...((row?.value as Partial<Settings>) ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const current = await getSettings();
  await db.kv.put({ key: SETTINGS_KEY, value: { ...current, ...patch }, updatedAt: nowIso() });
}

export async function currentToday(): Promise<string> {
  return todayFor((await getSettings()).dayBoundaryHour, clockNow());
}

/** Get the quarter containing today, creating it on first use. */
export async function ensureCurrentQuarter(): Promise<Quarter> {
  const id = quarterOf(await currentToday()).id;
  const existing = await db.quarters.get(id);
  if (existing) return existing;
  const t = nowIso();
  const q: Quarter = {
    id,
    createdAt: t,
    updatedAt: t,
    intents: { ...DEFAULT_INTENTS },
    intentHistory: [],
    status: 'active',
  };
  await db.quarters.put(q);
  return q;
}

export async function setTheme(quarterId: QuarterId, theme: string): Promise<void> {
  await db.quarters.update(quarterId, { theme: theme.trim() || undefined, updatedAt: nowIso() });
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
  const q = await db.quarters.get(quarterId);
  if (!q) return { ok: false, error: 'Quarter not found.' };
  const underway = (await db.goals.where('quarterId').equals(quarterId).filter((g) => !g.deleted).count()) > 0;
  if (!underway) {
    const r = canSetIntent(q.intents, burner, intent);
    if (!r.ok) return r;
    await db.quarters.update(quarterId, { intents: r.value, updatedAt: nowIso() });
    return { ok: true };
  }
  const cap = canSetIntent(q.intents, burner, intent);
  if (!cap.ok) return cap;
  if (!reason?.trim()) return { ok: false, error: 'Add a short reason.', needsReason: true };
  const settings = await getSettings();
  const s = stampNow(settings.dayBoundaryHour, clockNow());
  const r = changeIntent(q, burner, intent, reason, s.at, s.localDate);
  if (!r.ok) return r;
  await db.quarters.put(r.value);
  return { ok: true };
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
  const t = nowIso();
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
  await db.goals.update(id, { ...patch, updatedAt: nowIso() });
}

export async function deleteGoal(id: string): Promise<void> {
  await db.goals.update(id, { deleted: true, updatedAt: nowIso() });
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
  const entry: LogEntry = {
    id: newId(),
    goalId: goal.id,
    value,
    ...s,
    createdAt: s.at,
    updatedAt: s.at,
    ...(opts.note?.trim() ? { note: opts.note.trim(), notePrivate: !!opts.notePrivate } : {}),
    ...(opts.milestoneId ? { milestoneId: opts.milestoneId } : {}),
  };
  await db.transaction('rw', db.logs, db.goals, async () => {
    await db.logs.put(entry);
    if (goal.type === 'milestone' && opts.milestoneId) {
      const milestones = (goal.milestones ?? []).map((m) =>
        m.id === opts.milestoneId ? { ...m, doneAt: s.at } : m,
      );
      await db.goals.update(goal.id, { milestones, updatedAt: s.at });
    }
  });
  return entry;
}

/** Soft-delete a log (used by undo). Reopens a milestone step if the log completed one. */
export async function deleteLog(id: string): Promise<void> {
  const t = nowIso();
  await db.transaction('rw', db.logs, db.goals, async () => {
    const log = await db.logs.get(id);
    if (!log) return;
    await db.logs.update(id, { deleted: true, updatedAt: t });
    if (log.milestoneId) {
      const goal = await db.goals.get(log.goalId);
      if (goal?.milestones) {
        const milestones = goal.milestones.map((m) => (m.id === log.milestoneId ? { ...m, doneAt: undefined } : m));
        await db.goals.update(goal.id, { milestones, updatedAt: t });
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
  const log = await db.logs.get(id);
  if (!log) return;
  const next = applyLogEdit(log, patch, nowIso());
  if (next !== log) await db.logs.put(next);
}

// ---------- People ----------

export type NewPerson = Pick<Person, 'name' | 'burner' | 'cadenceDays'>;

export async function addPerson(input: NewPerson, goalIds: string[] = []): Promise<Person> {
  const t = nowIso();
  const order = await db.people.filter((p) => !p.deleted && p.burner === input.burner).count();
  const person: Person = { ...input, name: input.name.trim(), id: newId(), order, createdAt: t, updatedAt: t };
  await db.people.put(person);
  await linkPersonToGoals(person.id, goalIds);
  return person;
}

export async function updatePerson(id: string, patch: Partial<Person>, goalIds?: string[]): Promise<void> {
  await db.people.update(id, { ...patch, updatedAt: nowIso() });
  if (goalIds) await linkPersonToGoals(id, goalIds);
}

export async function deletePerson(id: string): Promise<void> {
  await db.people.update(id, { deleted: true, updatedAt: nowIso() });
  await linkPersonToGoals(id, []);
}

/** Make the person linked to exactly these goals (links live on the goal). */
async function linkPersonToGoals(personId: string, goalIds: string[]): Promise<void> {
  const want = new Set(goalIds);
  const t = nowIso();
  await db.transaction('rw', db.goals, async () => {
    const goals = await db.goals.filter((g) => !g.deleted && (want.has(g.id) || !!g.personIds?.includes(personId))).toArray();
    for (const g of goals) {
      const has = !!g.personIds?.includes(personId);
      if (want.has(g.id) && !has) await db.goals.update(g.id, { personIds: [...(g.personIds ?? []), personId], updatedAt: t });
      if (!want.has(g.id) && has) await db.goals.update(g.id, { personIds: g.personIds!.filter((x) => x !== personId), updatedAt: t });
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
    updatedAt: s.at,
    ...(note?.trim() ? { note: note.trim(), notePrivate: !!notePrivate } : {}),
  };
  await db.touchpoints.put(tp);
  return tp;
}

export async function editTouchpoint(id: string, patch: { note?: string; notePrivate?: boolean; type?: TouchpointType }): Promise<void> {
  const note = patch.note?.trim();
  await db.touchpoints.update(id, {
    ...(patch.type ? { type: patch.type } : {}),
    ...(patch.note !== undefined ? { note: note || undefined, notePrivate: note ? !!patch.notePrivate : undefined } : {}),
    updatedAt: nowIso(),
  });
}

export async function deleteTouchpoint(id: string): Promise<void> {
  await db.touchpoints.update(id, { deleted: true, updatedAt: nowIso() });
}

// ---------- Energy ----------

/** One rating per lived day; tapping again changes it. Pass null to clear. */
export async function setEnergy(rating: EnergyEntry['rating'] | null): Promise<void> {
  const s = stampNow((await getSettings()).dayBoundaryHour, clockNow());
  const existing = energyOn(await db.energy.where('localDate').equals(s.localDate).toArray(), s.localDate);
  if (rating === null) {
    if (existing) await db.energy.update(existing.id, { deleted: true, updatedAt: s.at });
    return;
  }
  if (existing) await db.energy.update(existing.id, { rating, updatedAt: s.at, at: s.at, offsetMin: s.offsetMin });
  else await db.energy.put({ id: newId(), rating, ...s, createdAt: s.at, updatedAt: s.at });
}

/** Undo a log deletion, re-completing its milestone step if it had one. */
export async function restoreLog(id: string): Promise<void> {
  const t = nowIso();
  await db.transaction('rw', db.logs, db.goals, async () => {
    const log = await db.logs.get(id);
    if (!log) return;
    await db.logs.update(id, { deleted: false, updatedAt: t });
    if (log.milestoneId) {
      const goal = await db.goals.get(log.goalId);
      if (goal?.milestones) {
        const milestones = goal.milestones.map((m) => (m.id === log.milestoneId ? { ...m, doneAt: log.at } : m));
        await db.goals.update(goal.id, { milestones, updatedAt: t });
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

export async function getOrCreateReview(weekStart: LocalDate): Promise<WeeklyReview> {
  const id = reviewId(weekStart);
  const existing = await db.reviews.where('weekStart').equals(weekStart).filter((r) => !r.deleted).first();
  if (existing) return existing;
  const t = nowIso();
  const review: WeeklyReview = { id, weekStart, step: 0, wins: [], misses: [], focus: '', focusBurners: [], createdAt: t, updatedAt: t };
  await db.reviews.put(review);
  return review;
}

export async function saveReview(id: string, patch: Partial<WeeklyReview>): Promise<void> {
  await db.reviews.update(id, { ...patch, updatedAt: nowIso() });
}

export async function completeReview(id: string): Promise<void> {
  const s = await stamp();
  await db.reviews.update(id, { completedAt: s.at, updatedAt: nowIso() });
}

// ---------- Weekly actions ----------

export async function addAction(weekStart: LocalDate, text: string, burner?: BurnerId): Promise<WeeklyAction> {
  const t = nowIso();
  const order = await db.actions.where('weekStart').equals(weekStart).filter((a) => !a.deleted).count();
  const action: WeeklyAction = { id: newId(), weekStart, text: text.trim(), burner, order, createdAt: t, updatedAt: t };
  await db.actions.put(action);
  return action;
}

export async function updateAction(id: string, patch: Partial<WeeklyAction>): Promise<void> {
  await db.actions.update(id, { ...patch, updatedAt: nowIso() });
}

export async function removeAction(id: string): Promise<void> {
  await db.actions.update(id, { deleted: true, updatedAt: nowIso() });
}

/** Tap an action done (a check-in), or tap again to undo. Returns whether it is now done. */
export async function toggleAction(id: string): Promise<boolean> {
  const a = await db.actions.get(id);
  if (!a) return false;
  if (a.done) {
    await db.actions.update(id, { done: undefined, updatedAt: nowIso() });
    return false;
  }
  await db.actions.update(id, { done: await stamp(), updatedAt: nowIso() });
  return true;
}

// ---------- Travel/Crunch mode ----------

export async function startCrunch(opts: { end?: LocalDate; label?: string } = {}): Promise<void> {
  const s = await stamp();
  const t = nowIso();
  await endCrunch();
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
  const t = nowIso();
  const open = await db.crunch.filter((p) => !p.deleted && p.start <= today && (!p.end || p.end >= today)).toArray();
  for (const p of open) {
    if (p.start === today) await db.crunch.update(p.id, { deleted: true, updatedAt: t });
    else await db.crunch.update(p.id, { end: today, updatedAt: t });
  }
}

// ---------- Quarter close and setup ----------

export async function gradeGoal(id: string, grade: Grade): Promise<void> {
  await db.goals.update(id, { grade, updatedAt: nowIso() });
}

export async function decideGoal(id: string, closeDecision: CloseDecision): Promise<void> {
  await db.goals.update(id, { closeDecision, updatedAt: nowIso() });
}

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
  const t = nowIso();
  await db.transaction('rw', db.quarters, db.goals, async () => {
    const q = await db.quarters.get(quarterId);
    if (!q) return;
    const next = await db.quarters.get(nextId);
    if (!next) {
      await db.quarters.put({ id: nextId, createdAt: t, updatedAt: t, intents: { ...q.intents }, intentHistory: [], status: 'active' });
    } else if (!next.setupAt) {
      const hasGoals = (await db.goals.where('quarterId').equals(nextId).filter((g) => !g.deleted).count()) > 0;
      if (!hasGoals) await db.quarters.update(nextId, { intents: { ...q.intents }, updatedAt: t });
    }
    const nextGoals = await db.goals.where('quarterId').equals(nextId).filter((g) => !g.deleted).toArray();
    const order: Record<BurnerId, number> = { family: 0, friends: 0, health: 0, work: 0 };
    for (const g of nextGoals) order[g.burner] = Math.max(order[g.burner], g.order + 1);
    const goals = await db.goals.where('quarterId').equals(quarterId).filter((g) => !g.deleted).toArray();
    for (const g of goals.sort((a, b) => a.order - b.order)) {
      if ((g.closeDecision !== 'carry' && g.closeDecision !== 'modify') || g.carriedToId) continue;
      const c = carryForward(g, { quarterId: nextId, startDate, deadline: nextSpan.end }, newId(), t, order[g.burner]++);
      await db.goals.put(c);
      await db.goals.update(g.id, { carriedToId: c.id, updatedAt: t });
    }
    await db.quarters.update(quarterId, { status: 'closed', closedAt: t, summary, updatedAt: t });
  });
  return nextId;
}

/** Intents during guided setup: the High cap applies, but no reason or history is needed yet. */
export async function setSetupIntents(quarterId: QuarterId, intents: Record<BurnerId, Intent>): Promise<IntentResult> {
  const r = validateIntents(intents);
  if (!r.ok) return r;
  await db.quarters.update(quarterId, { intents: { ...intents }, updatedAt: nowIso() });
  return { ok: true };
}

export async function finishSetup(quarterId: QuarterId): Promise<void> {
  await db.quarters.update(quarterId, { setupAt: nowIso(), updatedAt: nowIso() });
}

// ---------- Travel awareness ----------

const OFFSET_KEY = 'lastOffsetMin';

/** Returns the old and new UTC offsets if the device changed time zones since the last check. */
export async function checkTimeZoneChange(): Promise<{ from: number; to: number } | null> {
  const to = -clockNow().getTimezoneOffset();
  const row = await db.kv.get(OFFSET_KEY);
  await db.kv.put({ key: OFFSET_KEY, value: to, updatedAt: nowIso() });
  if (row === undefined || row.value === to) return null;
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
  await db.kv.put({ key: STREAK_KEY, value: hit, updatedAt: nowIso() });
  // The first check just records where you are. Only a milestone crossed in the last couple of days
  // celebrates, so jumps (loading data, syncing another device) stay quiet.
  return last >= 0 && hit > last && streak - hit <= 2 ? hit : null;
}
