// The shortcuts Edge Function: Apple Shortcuts and Siri log to your account with a personal token.
//
// POST, header `Authorization: Bearer fb_...`, JSON body with an action:
//   {action: 'ping'}                                   check the connection
//   {action: 'goals'} / {action: 'people'}             names to pick from (for "Choose from List")
//   {action: 'log', goal, value?, note?, at?}          log progress on a goal by name
//   {action: 'touch', person, type?, note?, at?}       log a touchpoint with a person by name
//   {action: 'health', date?, at?, steps?, workouts?, activeMinutes?, sleepHours? | sleepMinutes?}
//                                                      one day of Apple Health numbers for linked goals
// `at` is the phone's "Current Date" in ISO 8601, so entries land on the day you are living where you are.
// Every answer is JSON {ok, message, items?}; `message` is short enough for Siri to read out.
// Entries are written straight into your synced records and reach your devices on their next sync.
// Deployed with JWT verification off (a Shortcut has a personal token, not a sign-in); this file checks it.
import {
  HEALTH_METRIC_IDS,
  ambiguousReply,
  healthDate,
  healthReply,
  isValidTimeZone,
  logReply,
  matchByName,
  notFoundReply,
  parseTouchType,
  planHealthLogs,
  planLog,
  quarterOf,
  readHealthDay,
  settingsOf,
  stampFor,
  touchReply,
  zoneOffsetMin,
  type Goal,
  type LogEntry,
  type Stamp,
  type Touchpoint,
} from '@/domain';
import { hashToken, isTokenFormat } from '@/shortcuts/token';
import type { ShortcutsStore } from './store';

export interface ShortcutsDeps {
  store: ShortcutsStore;
  now: () => Date;
  newId: () => string;
  log?: (msg: string) => void;
}

interface Reply {
  ok: boolean;
  message: string;
  items?: string[];
}

function reply(status: number, body: Reply): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

const MAX_BODY = 8 * 1024;
const BAD_TOKEN = 'This Shortcut token is wrong or was revoked. Make a new one in Four Burners: Settings > Shortcuts and Siri.';

const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** A sync stamp strictly newer than `prev`, so the write wins last-write-wins even over a fast device clock. */
function nextUpdatedAt(now: Date, prev?: string): string {
  const p = prev ? Date.parse(prev) : NaN;
  return new Date(Number.isFinite(p) && p >= now.getTime() ? p + 1 : now.getTime()).toISOString();
}

interface Ctx {
  deps: ShortcutsDeps;
  userId: string;
  body: Record<string, unknown>;
  now: Date;
}

/** When this entry happened, by the phone's clock, else the server clock in the last zone a device reported. */
async function stamp(ctx: Ctx): Promise<{ stamp: Stamp; settings: ReturnType<typeof settingsOf> }> {
  const [settingsValue, tz] = await Promise.all([ctx.deps.store.settings(ctx.userId), ctx.deps.store.latestTimeZone(ctx.userId)]);
  const settings = settingsOf(settingsValue);
  const fallback = tz && isValidTimeZone(tz) ? zoneOffsetMin(ctx.now, tz) : 0;
  return { stamp: stampFor(ctx.body.at, settings.dayBoundaryHour, fallback, ctx.now), settings };
}

const loggable = (g: Goal) => !g.deleted && g.type !== 'milestone';

async function listGoals(ctx: Ctx): Promise<Reply> {
  const { stamp: s } = await stamp(ctx);
  const goals = (await ctx.deps.store.goals(ctx.userId, quarterOf(s.localDate).id)).filter(loggable);
  const order = ['family', 'friends', 'health', 'work'];
  const items = goals.sort((a, b) => order.indexOf(a.burner) - order.indexOf(b.burner) || a.order - b.order).map((g) => g.title);
  return { ok: true, message: items.length ? `${items.length} goals.` : 'You have no goals this quarter yet.', items };
}

async function listPeople(ctx: Ctx): Promise<Reply> {
  const people = (await ctx.deps.store.people(ctx.userId)).filter((p) => !p.deleted).sort((a, b) => a.order - b.order);
  return { ok: true, message: people.length ? `${people.length} people.` : 'You have no key people yet.', items: people.map((p) => p.name) };
}

async function logGoal(ctx: Ctx): Promise<Reply> {
  const query = text(ctx.body.goal, 120);
  if (!query) return { ok: false, message: 'Which goal? Send its name as "goal".' };
  const { stamp: s } = await stamp(ctx);
  const quarterId = quarterOf(s.localDate).id;
  const [goals, quarter] = await Promise.all([ctx.deps.store.goals(ctx.userId, quarterId), ctx.deps.store.quarter(ctx.userId, quarterId)]);
  const live = goals.filter((g) => !g.deleted);
  const m = matchByName(live, query, (g) => g.title);
  if (m.kind === 'none') return { ok: false, message: notFoundReply('goal', query, live.filter(loggable).map((g) => g.title)) };
  if (m.kind === 'ambiguous') return { ok: false, message: ambiguousReply(query, m.items.map((g) => g.title)) };
  const goal = m.item;
  const plan = planLog(goal, ctx.body.value);
  if (!plan.ok) return { ok: false, message: plan.message };
  const note = text(ctx.body.note, 500);
  const entry: LogEntry = {
    id: ctx.deps.newId(),
    goalId: goal.id,
    value: plan.value,
    ...s,
    createdAt: s.at,
    updatedAt: nextUpdatedAt(ctx.now),
    source: 'shortcut',
    ...(note ? { note, notePrivate: false } : {}),
  };
  await ctx.deps.store.put(ctx.userId, 'logs', entry as unknown as LogEntry & Record<string, unknown>);
  const logs = [...(await ctx.deps.store.logsForGoal(ctx.userId, goal.id)).filter((l) => l.id !== entry.id), entry];
  return { ok: true, message: logReply(goal, plan.value, logs, s.localDate, quarter?.intents?.[goal.burner] ?? 'steady') };
}

async function logTouch(ctx: Ctx): Promise<Reply> {
  const query = text(ctx.body.person, 120);
  if (!query) return { ok: false, message: 'Who? Send their name as "person".' };
  const people = (await ctx.deps.store.people(ctx.userId)).filter((p) => !p.deleted);
  const m = matchByName(people, query, (p) => p.name);
  if (m.kind === 'none') return { ok: false, message: notFoundReply('person', query, people.map((p) => p.name)) };
  if (m.kind === 'ambiguous') return { ok: false, message: ambiguousReply(query, m.items.map((p) => p.name)) };
  const { stamp: s } = await stamp(ctx);
  const type = parseTouchType(ctx.body.type);
  const note = text(ctx.body.note, 500);
  const tp: Touchpoint = {
    id: ctx.deps.newId(),
    personId: m.item.id,
    type,
    ...s,
    createdAt: s.at,
    updatedAt: nextUpdatedAt(ctx.now),
    source: 'shortcut',
    ...(note ? { note, notePrivate: false } : {}),
  };
  await ctx.deps.store.put(ctx.userId, 'touchpoints', tp as unknown as Touchpoint & Record<string, unknown>);
  return { ok: true, message: touchReply(m.item, type) };
}

async function applyHealth(ctx: Ctx): Promise<Reply> {
  const day = readHealthDay(ctx.body);
  const { stamp: s } = await stamp(ctx);
  const date = healthDate(ctx.body.date, s.localDate);
  const goals = await ctx.deps.store.goals(ctx.userId, quarterOf(date).id);
  // Habit and Yes/No goals you already logged by hand that day: Health does not count the day again.
  const byHand = new Set<string>();
  for (const g of goals) {
    if (g.deleted || !g.health || g.type === 'number') continue;
    const logs = await ctx.deps.store.logsForGoal(ctx.userId, g.id);
    if (logs.some((l) => !l.deleted && l.localDate === date && l.source !== 'health')) byHand.add(g.id);
  }
  const plans = planHealthLogs(goals, day, date, byHand);
  const applied = [];
  for (const p of plans) {
    const existing = await ctx.deps.store.get(ctx.userId, 'logs', p.id);
    // You deleted that day's Health log in the app: leave it deleted.
    if (existing?.deleted || existing?.data?.deleted) continue;
    // You edited it in the app (it changed since this function last wrote it): your edit stays.
    if (existing && existing.data.healthWrittenAt !== existing.updated_at) continue;
    applied.push(p);
    if (existing && existing.data.value === p.value) continue;
    const updatedAt = nextUpdatedAt(ctx.now, existing?.updated_at);
    const entry: LogEntry = {
      ...((existing?.data as unknown as LogEntry | undefined) ?? {}),
      id: p.id,
      goalId: p.goal.id,
      value: p.value,
      at: s.at,
      offsetMin: s.offsetMin,
      localDate: date,
      createdAt: (existing?.data?.createdAt as string | undefined) ?? s.at,
      updatedAt,
      source: 'health',
      // Marks the copy this function wrote. A device edit changes updatedAt, so the two then differ.
      healthWrittenAt: updatedAt,
    };
    // A device edit that landed in between wins (the write is newer-wins); the reply then leaves it out.
    if (!(await ctx.deps.store.put(ctx.userId, 'logs', entry as unknown as LogEntry & Record<string, unknown>))) applied.pop();
  }
  return { ok: HEALTH_METRIC_IDS.some((m) => day[m] !== undefined), message: healthReply(applied, day, date) };
}

export function createShortcutsHandler(deps: ShortcutsDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== 'POST') return reply(405, { ok: false, message: 'Use POST.' });
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
    if (!isTokenFormat(token)) return reply(401, { ok: false, message: BAD_TOKEN });
    try {
      const found = await deps.store.tokenByHash(await hashToken(token));
      if (!found) return reply(401, { ok: false, message: BAD_TOKEN });
      const raw = await req.text();
      if (raw.length > MAX_BODY) return reply(413, { ok: false, message: 'That request is too large.' });
      let body: Record<string, unknown> = {};
      try {
        const parsed = raw.trim() ? (JSON.parse(raw) as unknown) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      } catch {
        return reply(400, { ok: false, message: 'The Shortcut must send a JSON body.' });
      }
      const now = deps.now();
      void deps.store.markTokenUsed(found.id, now.toISOString()).catch(() => undefined);
      const ctx: Ctx = { deps, userId: found.userId, body, now };
      const action = typeof body.action === 'string' ? body.action.toLowerCase() : 'ping';
      switch (action) {
        case 'ping':
          return reply(200, { ok: true, message: 'Connected. Four Burners is ready for Siri.' });
        case 'goals':
          return reply(200, await listGoals(ctx));
        case 'people':
          return reply(200, await listPeople(ctx));
        case 'log':
          return reply(200, await logGoal(ctx));
        case 'touch':
          return reply(200, await logTouch(ctx));
        case 'health':
          return reply(200, await applyHealth(ctx));
        default:
          return reply(400, { ok: false, message: `Unknown action "${action.slice(0, 20)}". Use log, touch, health, goals, people or ping.` });
      }
    } catch (e) {
      deps.log?.(`request failed: ${e instanceof Error ? e.message : String(e)}`);
      return reply(500, { ok: false, message: "Four Burners couldn't save that right now. Try again in a minute." });
    }
  };
}
