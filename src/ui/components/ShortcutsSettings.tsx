// Settings > Shortcuts and Siri: the address and personal tokens your iPhone Shortcuts use, recipes for
// building them, and which Health goals Apple Health fills in. The token is shown once and never stored on
// the server (only its hash), so a lost token is replaced, not recovered.
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useState } from 'react';
import { HEALTH_METRICS, HEALTH_METRIC_IDS, canLinkHealth, type Goal, type HealthLink, type HealthMetric } from '@/domain';
import { updateGoal } from '@/data/repo';
import { detectDevice } from '@/notify/push';
import { createToken, listTokens, revokeToken, shortcutsEndpoint, tokenError, type TokenInfo } from '@/shortcuts/client';
import { RECIPES } from '@/shortcuts/recipes';
import { timeAgo, useSyncStatus } from '@/sync/useSync';
import { useReducedMotion } from '../motion';
import { MoltenButton } from './sizzle';
import { GhostButton, inputClass } from './ui';

// ---------- Copy (pure, tested) ----------

export function tokenLine(t: TokenInfo, now = Date.now()): string {
  const made = new Date(t.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return `Made ${made}. ${t.lastUsedAt ? `Last used ${timeAgo(t.lastUsedAt, now)}.` : 'Not used yet.'}`;
}

/** What a linked goal will do with the metric. */
export function linkHint(goal: Pick<Goal, 'type'>, link: HealthLink): string {
  const m = HEALTH_METRICS[link.metric];
  if (goal.type === 'number') return `Adds each day's ${m.unit} to this goal.`;
  return `Counts a day with at least ${link.min ?? m.defaultMin} ${m.unit}.`;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ---------- Panel ----------

export function ShortcutsSettings({ goals }: { goals: Goal[] }) {
  const endpoint = shortcutsEndpoint();
  const sync = useSyncStatus();
  const signedIn = sync.state !== 'signedOut' && sync.state !== 'unconfigured';
  const reduced = useReducedMotion();
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState(() => `${detectDevice()} Shortcuts`);
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState<'token' | 'url' | null>(null);

  const load = useCallback(() => {
    if (!signedIn) return;
    listTokens()
      .then((t) => {
        setTokens(t);
        setError(null);
      })
      .catch((e: unknown) => setError(tokenError(e)));
  }, [signedIn]);
  useEffect(load, [load]);

  const make = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { token } = await createToken(label || 'Shortcuts');
      setFresh(token);
      load();
    } catch (e) {
      setError(tokenError(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (t: TokenInfo) => {
    if (!confirm(`Revoke "${t.label || 'token'}"? Shortcuts using it stop working right away.`)) return;
    try {
      await revokeToken(t.id);
      load();
    } catch (e) {
      setError(tokenError(e));
    }
  };

  const copyThat = async (what: 'token' | 'url', text: string) => {
    if (await copy(text)) {
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    }
  };

  return (
    <div>
      <p className="text-[14px] leading-relaxed text-dim">
        Log by voice ("Hey Siri, log date night"), log a call with someone, and send Apple Health numbers every evening. The Shortcuts are built
        once on your iPhone with the recipes below.
      </p>

      {!endpoint && <Callout text="Shortcuts aren't set up in this build. See README > Shortcuts and Siri." />}
      {endpoint && !signedIn && <Callout text="Shortcuts log to your synced account. Sign in under Sync across devices first." />}

      {endpoint && signedIn && (
        <>
          <div className="mt-4">
            <div className="text-[13px] font-medium tracking-wide text-dim uppercase">Shortcuts address</div>
            <div className="mt-1.5 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-xl border border-line bg-raised px-3 py-2.5 text-[13px]">{endpoint}</code>
              <GhostButton className="shrink-0" onClick={() => copyThat('url', endpoint)}>
                {copied === 'url' ? 'Copied' : 'Copy'}
              </GhostButton>
            </div>
          </div>

          <AnimatePresence initial={false}>
            {fresh && (
              <motion.div
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0 }}
                className="mt-4 rounded-2xl border border-amber-300/40 bg-amber-300/[0.08] p-3.5"
                style={{ boxShadow: '0 0 30px -10px rgba(255,170,60,0.6)' }}
              >
                <div className="text-[15px] font-semibold text-amber-100">Your new token</div>
                <code className="mt-2 block rounded-xl bg-black/50 px-3 py-2.5 text-[13px] break-all select-all">{fresh}</code>
                <p className="mt-2 text-[13px] leading-relaxed text-amber-100/90">
                  Shown once. Paste it into your Shortcuts now (after "Bearer "). Keep it like a password: anyone with it can log to your account.
                </p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <MoltenButton className="h-12 text-[16px]" onClick={() => copyThat('token', fresh)}>
                    {copied === 'token' ? 'Copied' : 'Copy token'}
                  </MoltenButton>
                  <GhostButton onClick={() => setFresh(null)}>Done</GhostButton>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="mt-5">
            <div className="text-[13px] font-medium tracking-wide text-dim uppercase">Tokens</div>
            {tokens === null && !error && <p className="mt-2 text-[14px] text-faint">Loading...</p>}
            {tokens?.length === 0 && <p className="mt-2 text-[14px] text-faint">None yet.</p>}
            <ul className="mt-1">
              {tokens?.map((t) => (
                <li key={t.id} className="flex items-center gap-3 border-b border-white/[0.06] py-2.5 last:border-0">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px]">{t.label || 'Token'}</div>
                    <div className="text-[13px] text-faint">{tokenLine(t)}</div>
                  </div>
                  <button className="shrink-0 rounded-full px-3 py-1.5 text-[14px] text-rose-300 active:bg-white/10" onClick={() => revoke(t)}>
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex gap-2">
              <input className={`${inputClass} min-w-0 flex-1 py-2.5`} aria-label="Token name" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
              <GhostButton className="shrink-0" disabled={busy} onClick={make}>
                {busy ? 'Making...' : 'Make a token'}
              </GhostButton>
            </div>
            {error && (
              <p className="mt-2 text-[14px] font-semibold text-rose-300" role="alert">
                {error}
              </p>
            )}
          </div>
        </>
      )}

      <div className="mt-6">
        <div className="text-[13px] font-medium tracking-wide text-dim uppercase">Recipes</div>
        <div className="mt-2 flex flex-col gap-2">
          {RECIPES.map((r) => (
            <details key={r.id} className="group rounded-2xl border border-line bg-raised px-4 py-3">
              <summary className="cursor-pointer list-none text-[15px] font-semibold">
                {r.title}
                {r.siri && <span className="mt-0.5 block text-[13px] font-normal text-dim">"{r.siri}"</span>}
              </summary>
              <p className="mt-2 text-[14px] text-dim">{r.summary}</p>
              <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[14px] leading-relaxed">
                {r.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </details>
          ))}
        </div>
      </div>

      <HealthLinks goals={goals} />
    </div>
  );
}

function HealthLinks({ goals }: { goals: Goal[] }) {
  const linkable = goals.filter((g) => !g.deleted && canLinkHealth(g)).sort((a, b) => a.order - b.order);
  return (
    <div className="mt-6">
      <div className="text-[13px] font-medium tracking-wide text-dim uppercase">Apple Health goals</div>
      <p className="mt-1 text-[13px] leading-relaxed text-faint">Link a Health goal to a number the evening automation sends.</p>
      {!linkable.length && <p className="mt-2 text-[14px] text-faint">No Number, Habit or Yes/No goals in Health this quarter.</p>}
      {linkable.map((g) => (
        <HealthLinkRow key={g.id} goal={g} />
      ))}
    </div>
  );
}

function HealthLinkRow({ goal }: { goal: Goal }) {
  const link = goal.health;
  const setMetric = (v: string) => void updateGoal(goal.id, { health: v ? { metric: v as HealthMetric, ...(link?.min !== undefined && link.metric === v ? { min: link.min } : {}) } : undefined });
  const setMin = (v: string) => {
    const n = Number(v);
    if (link && Number.isFinite(n) && n > 0) void updateGoal(goal.id, { health: { ...link, min: n } });
  };
  return (
    <div className="border-b border-white/[0.06] py-3 last:border-0">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 truncate text-[15px]">{goal.title}</div>
        <select aria-label={`Health metric for ${goal.title}`} className="shrink-0 rounded-xl border border-line bg-raised px-3 py-2" value={link?.metric ?? ''} onChange={(e) => setMetric(e.target.value)}>
          <option value="">Not linked</option>
          {HEALTH_METRIC_IDS.map((m) => (
            <option key={m} value={m}>
              {HEALTH_METRICS[m].label}
            </option>
          ))}
        </select>
      </div>
      {link && (
        <div className="mt-1.5 flex items-center justify-between gap-3 text-[13px] text-faint">
          <span>{linkHint(goal, link)}</span>
          {goal.type !== 'number' && (
            <input
              type="number"
              inputMode="decimal"
              aria-label={`Minimum ${HEALTH_METRICS[link.metric].unit} for ${goal.title}`}
              className="w-24 shrink-0 rounded-xl border border-line bg-raised px-3 py-1.5 text-[15px] text-white"
              key={link.metric}
              defaultValue={link.min ?? HEALTH_METRICS[link.metric].defaultMin}
              onBlur={(e) => setMin(e.target.value)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Callout({ text }: { text: string }) {
  return (
    <div className="mt-3.5 rounded-2xl border border-amber-300/25 bg-amber-300/[0.07] px-3.5 py-2.5 text-[14px] text-amber-100" role="note">
      {text}
    </div>
  );
}
