// The notify Edge Function. Two ways in:
//   pg_cron, every 5 minutes, with the schedule's secret (x-notify-secret): send whatever is due, for every
//     account with a subscribed device.
//   The app, with a signed-in user's token and {action: 'test', endpoint}: send a test notification to that
//     one device of that user.
// Deployed with JWT verification off (the cron call carries no user token); this file does its own checks.
// The rules themselves are in src/domain/notify.ts.
import {
  TEST_MESSAGE,
  addDays,
  composeDaily,
  composeWeekly,
  dueNow,
  isValidTimeZone,
  pickNudge,
  pruneNudged,
  quarterOf,
  settingsOf,
  type PushMessage,
} from '@/domain';
import type { NotifyStore, SubscriptionRow } from './store';
import { importVapidKey, sendWebPush, type VapidKeys } from './webpush';
import { serviceKeyFrom } from '../env';

export interface HandlerDeps {
  store: NotifyStore;
  vapid: VapidKeys;
  fetch: typeof fetch;
  now: () => Date;
  log?: (msg: string) => void;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

/** History: logs and check-ins this far back feed streaks and pace (a quarter, with room to spare). */
const HISTORY_DAYS = 400;
/** Subscriptions the push service dropped are kept this long (so the device can learn why), then deleted. */
const GONE_KEEP_DAYS = 30;

export interface SendResult {
  endpoint: string;
  ok: boolean;
  status: number;
}

/** Deliver one message to a set of devices, recording each outcome on its subscription. */
async function deliver(deps: HandlerDeps, signingKey: CryptoKey, subs: SubscriptionRow[], msg: PushMessage): Promise<SendResult[]> {
  const at = deps.now().toISOString();
  const payload = JSON.stringify({ title: msg.title, body: msg.body, url: msg.url, tag: msg.tag });
  const urgency = msg.kind === 'nudge' ? 'low' : 'normal';
  return Promise.all(
    subs.map(async (s) => {
      const out = await sendWebPush(s, payload, deps.vapid, signingKey, deps.fetch, deps.now().getTime(), { topic: msg.tag, urgency });
      try {
        if (out.ok) await deps.store.markSent(s.endpoint, at);
        else if (out.gone) await deps.store.markGone(s.endpoint, at);
        else await deps.store.markError(s.endpoint, `${out.status}: ${out.reason}`, at);
      } catch (e) {
        deps.log?.(`record outcome failed: ${String(e)}`);
      }
      return { endpoint: s.endpoint, ok: out.ok, status: out.status };
    }),
  );
}

export interface TickSummary {
  accounts: number;
  sent: { kind: PushMessage['kind']; devices: number; delivered: number }[];
  errors: number;
}

/** One scheduled run: for each account, send what is due right now. */
export async function runTick(deps: HandlerDeps): Promise<TickSummary> {
  const { store } = deps;
  const now = deps.now();
  const signingKey = await importVapidKey(deps.vapid);
  const subs = await store.subscriptions();
  const byUser = new Map<string, SubscriptionRow[]>();
  for (const s of subs) byUser.set(s.user_id, [...(byUser.get(s.user_id) ?? []), s]);

  const summary: TickSummary = { accounts: byUser.size, sent: [], errors: 0 };
  for (const [userId, devices] of byUser) {
    try {
      // "Now" is wherever you opened the app most recently.
      const latest = [...devices].sort((a, b) => (a.last_seen_at < b.last_seen_at ? 1 : -1))[0];
      const tz = isValidTimeZone(latest.time_zone) ? latest.time_zone : 'UTC';
      const [settingsValue, state] = await Promise.all([store.settings(userId), store.state(userId)]);
      const settings = settingsOf(settingsValue);
      const due = dueNow(now, tz, settings, state);
      if (!due.daily && !due.weekly && !due.nudge) continue;

      const today = due.clock.localDate;
      const data = await store.data(userId, {
        quarterId: quarterOf(today).id,
        since: addDays(today, -HISTORY_DAYS),
        reviewWeek: due.weekly ?? undefined,
      });
      const send = async (msg: PushMessage | null) => {
        if (!msg) return;
        const results = await deliver(deps, signingKey, devices, msg);
        summary.sent.push({ kind: msg.kind, devices: results.length, delivered: results.filter((r) => r.ok).length });
      };

      // Claim first, then send: a run that overlaps another can never send the same reminder twice.
      if (due.weekly && (await store.claim(userId, 'weekly_week', due.weekly))) await send(composeWeekly(data, due.weekly));
      if (due.daily && (await store.claim(userId, 'daily_date', today))) await send(composeDaily(data, settings, today));
      if (due.nudge && (await store.claim(userId, 'nudge_date', today))) {
        const nudge = pickNudge(data, settings, today, state.nudged);
        if (nudge?.subject) await store.saveNudged(userId, { ...pruneNudged(state.nudged, today), [nudge.subject]: today });
        await send(nudge);
      }
    } catch (e) {
      summary.errors++;
      deps.log?.(`account run failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  try {
    await store.pruneGone(new Date(now.getTime() - GONE_KEEP_DAYS * 86_400_000).toISOString());
  } catch (e) {
    deps.log?.(`prune failed: ${String(e)}`);
  }
  return summary;
}

async function sendTest(deps: HandlerDeps, userId: string, endpoint: unknown): Promise<Response> {
  if (typeof endpoint !== 'string' || !endpoint) return reply(400, { error: 'endpoint required' });
  const sub = (await deps.store.subscriptions()).find((s) => s.endpoint === endpoint && s.user_id === userId);
  if (!sub) return reply(404, { error: 'This device is not subscribed.' });
  const [result] = await deliver(deps, await importVapidKey(deps.vapid), [sub], TEST_MESSAGE);
  return reply(200, result);
}

/** The function's request handler. A missing VAPID key pair or service key is reported by the entry point. */
export function createHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return reply(405, { error: 'POST only' });
    try {
      const secret = req.headers.get('x-notify-secret');
      if (secret !== null) {
        if (!(await deps.store.cronSecretOk(secret))) return reply(401, { error: 'Bad schedule secret' });
        return reply(200, await runTick(deps));
      }
      const token = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
      const userId = token ? await deps.store.userFromToken(token) : null;
      if (!userId) return reply(401, { error: 'Sign in required' });
      const body = (await req.json().catch(() => ({}))) as { action?: unknown; endpoint?: unknown };
      if (body.action === 'test') return await sendTest(deps, userId, body.endpoint);
      return reply(400, { error: 'Unknown action' });
    } catch (e) {
      deps.log?.(`request failed: ${e instanceof Error ? e.message : String(e)}`);
      return reply(500, { error: 'Server error' });
    }
  };
}

/** Read the function's configuration from its environment. Returns the names of anything missing. */
export function readConfig(env: (name: string) => string | undefined):
  | { ok: true; supabaseUrl: string; serviceKey: string; vapid: VapidKeys }
  | { ok: false; missing: string[] } {
  const supabaseUrl = env('SUPABASE_URL');
  const serviceKey = serviceKeyFrom(env, 'NOTIFY_SERVICE_KEY');
  const publicKey = env('VAPID_PUBLIC_KEY');
  const privateKey = env('VAPID_PRIVATE_KEY');
  const subject = env('VAPID_SUBJECT');
  const missing = [
    !supabaseUrl && 'SUPABASE_URL',
    !serviceKey && 'SUPABASE_SERVICE_ROLE_KEY',
    !publicKey && 'VAPID_PUBLIC_KEY',
    !privateKey && 'VAPID_PRIVATE_KEY',
    !subject && 'VAPID_SUBJECT',
  ].filter((x): x is string => !!x);
  if (missing.length) return { ok: false, missing };
  return { ok: true, supabaseUrl: supabaseUrl!, serviceKey: serviceKey!, vapid: { publicKey: publicKey!, privateKey: privateKey!, subject: subject! } };
}
