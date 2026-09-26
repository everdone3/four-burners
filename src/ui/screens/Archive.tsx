// Archive: every closed quarter with its scores, grades, decisions, and weekly reviews.
import { motion } from 'motion/react';
import {
  BURNERS,
  BURNER_LABELS,
  GRADE_LABELS,
  INTENT_LABELS,
  addDays,
  quarterLabel,
  quarterSpan,
  type CloseDecision,
} from '@/domain';
import type { AppState } from '@/data/hooks';
import { GlowCard, MiniFlame, MoltenButton, ShimmerText } from '../components/sizzle';
import { goBack, navigate } from '../router';
import { PALETTES } from '../theme';
import { weekLabel } from '../stateInput';

const DECISION_LABEL: Record<CloseDecision, string> = { carry: 'Carried forward', modify: 'Modified', drop: 'Dropped' };

export function ArchiveScreen({ state, quarterId }: { state: AppState; quarterId?: string }) {
  return quarterId ? <QuarterDetail state={state} quarterId={quarterId} /> : <QuarterList state={state} />;
}

function Back({ label = 'Back' }: { label?: string }) {
  return (
    <button onClick={goBack} className="-ml-2 flex h-11 items-center gap-1 rounded-full pr-3 pl-2 text-[17px] text-dim active:bg-white/10">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
      {label}
    </button>
  );
}

function QuarterList({ state }: { state: AppState }) {
  const closed = state.quarters.filter((q) => q.status === 'closed' && !q.deleted).sort((a, b) => (a.id < b.id ? 1 : -1));
  return (
    <div className="px-safe pt-safe pb-24">
      <Back />
      <h1 className="mt-2 font-display text-[40px] font-black">
        <ShimmerText>Past quarters</ShimmerText>
      </h1>
      {closed.length === 0 && <p className="mt-6 text-[16px] text-dim">Your closed quarters will live here, each with its highlights reel.</p>}
      <div className="mt-6 space-y-3">
        {closed.map((q, i) => (
          <motion.button
            key={q.id}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.06 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => navigate(`archive/${q.id}`)}
            className="block w-full text-left"
          >
            <GlowCard color="#ff9a3c" intensity={(q.summary?.progressScore ?? 50) / 100} className="bg-black/60 backdrop-blur-xl">
              <div className="flex items-center gap-4 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-bold tracking-[0.2em] text-ember uppercase">{quarterLabel(q.id)}</div>
                  <div className="truncate font-display text-[24px] font-black">{q.theme ?? 'Untitled quarter'}</div>
                  <div className="mt-1 flex gap-1.5">
                    {BURNERS.map((b) => (
                      <MiniFlame key={b} burner={b} size={18} lit={q.intents[b] === 'high' ? 1 : q.intents[b] === 'steady' ? 0.65 : 0.35} />
                    ))}
                  </div>
                </div>
                {q.summary && (
                  <div className="text-right">
                    <div className="font-display text-[30px] leading-none font-black tabular">{q.summary.progressScore}</div>
                    <div className="text-[11px] font-semibold tracking-wider text-dim uppercase">Progress</div>
                    <div className="mt-1 text-[12px] text-faint">{q.summary.longestStreak}-day best streak</div>
                  </div>
                )}
              </div>
            </GlowCard>
          </motion.button>
        ))}
      </div>
    </div>
  );
}

function QuarterDetail({ state, quarterId }: { state: AppState; quarterId: string }) {
  const q = state.quarters.find((x) => x.id === quarterId);
  if (!q) return <div className="grid h-dvh place-items-center text-dim">Quarter not found.</div>;
  const span = quarterSpan(quarterId);
  const goals = state.data.allGoals.filter((g) => g.quarterId === quarterId);
  const reviews = state.data.reviews
    .filter((r) => r.completedAt && r.weekStart >= addDays(span.start, -6) && r.weekStart <= span.end)
    .sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1));

  return (
    <div className="px-safe pt-safe pb-24">
      <Back label="Past quarters" />
      <div className="mt-2 text-[12px] font-bold tracking-[0.2em] text-ember uppercase">{quarterLabel(quarterId)}</div>
      <h1 className="font-display text-[40px] leading-tight font-black">
        <ShimmerText>{q.theme ?? 'Untitled quarter'}</ShimmerText>
      </h1>
      {q.summary && (
        <div className="mt-4 grid grid-cols-4 gap-2 text-center">
          {[
            { v: q.summary.progressScore, l: 'Progress' },
            { v: q.summary.consistencyScore, l: 'Consistency' },
            { v: q.summary.longestStreak, l: 'Best streak' },
            { v: q.summary.checkInDays, l: 'Days in' },
          ].map((x) => (
            <div key={x.l} className="rounded-2xl border border-white/[0.08] bg-black/50 px-1 py-3">
              <div className="font-display text-[24px] font-black tabular">{x.v}</div>
              <div className="text-[10px] font-semibold tracking-wider text-dim uppercase">{x.l}</div>
            </div>
          ))}
        </div>
      )}
      <MoltenButton className="mt-5 h-14 w-full text-[17px]" onClick={() => navigate(`reel/${quarterId}`)}>
        ▶ Replay highlights
      </MoltenButton>

      {BURNERS.map((b) => {
        const mine = goals.filter((g) => g.burner === b).sort((x, y) => x.order - y.order);
        const p = PALETTES[b];
        return (
          <section key={b} className="mt-7">
            <div className="mb-2 flex items-center gap-2.5">
              <MiniFlame burner={b} size={22} />
              <h2 className="font-display text-[20px] font-bold" style={{ color: p.accent }}>
                {BURNER_LABELS[b]}
              </h2>
              <span className="text-[12px] font-bold tracking-wider text-faint uppercase">{INTENT_LABELS[q.intents[b]]}</span>
            </div>
            {mine.length === 0 && <p className="text-[14px] text-faint">No goals.</p>}
            <div className="space-y-2">
              {mine.map((g) => (
                <div key={g.id} className="flex items-center gap-3 rounded-2xl border border-white/[0.08] bg-[#0a0a0c]/90 px-4 py-3">
                  {g.grade && (
                    <span
                      className="grid h-11 w-11 shrink-0 place-items-center rounded-xl font-display text-[20px] font-black text-black"
                      style={{ background: `linear-gradient(135deg, ${p.core}, ${p.mid} 55%, ${p.outer})` }}
                      aria-label={`Grade ${g.grade}, ${GRADE_LABELS[g.grade]}`}
                    >
                      {g.grade}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-[16px] font-semibold">{g.title}</span>
                    {g.closeDecision && <span className="block text-[13px] text-dim">{DECISION_LABEL[g.closeDecision]}</span>}
                  </span>
                </div>
              ))}
            </div>
          </section>
        );
      })}

      {reviews.length > 0 && (
        <section className="mt-9">
          <h2 className="mb-3 font-display text-[22px] font-bold">Weekly reviews</h2>
          <div className="space-y-3">
            {reviews.map((r) => (
              <details key={r.id} className="group rounded-2xl border border-white/[0.08] bg-[#0a0a0c]/90 px-4 py-3">
                <summary className="flex cursor-pointer list-none items-center justify-between">
                  <span>
                    <span className="block text-[13px] font-semibold text-ember">{weekLabel(r.weekStart, addDays(r.weekStart, 6))}</span>
                    <span className="block text-[16px] font-semibold">{r.focus || 'No focus set'}</span>
                  </span>
                  <span className="text-faint transition group-open:rotate-90">›</span>
                </summary>
                <div className="mt-3 space-y-2 text-[15px]">
                  {r.wins.map((w) => (
                    <div key={w} className="flex gap-2">
                      <span className="text-emerald-300">+</span>
                      {w}
                    </div>
                  ))}
                  {r.misses.map((m) => (
                    <div key={m} className="flex gap-2 text-dim">
                      <span className="text-rose-300">−</span>
                      {m}
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
