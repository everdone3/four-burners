// Home screen rituals: quarter close and setup prompts, weekly review card,
// this week's actions (one tap each), and the Travel/Crunch control.
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import {
  addDays,
  dueReviewWeek,
  quarterLabel,
  startOfWeek,
  type CrunchPeriod,
  type Quarter,
  type WeeklyAction,
  type WeeklyReview,
} from '@/domain';
import { endCrunch, startCrunch, toggleAction } from '@/data/repo';
import { celebrate } from '../fx/Celebrations';
import { sfx } from '../fx/audio';
import { haptic } from '../fx/haptics';
import { navigate } from '../router';
import { PALETTES } from '../theme';
import { fmtDay } from '../stateInput';
import { GlowCard, MiniFlame, MoltenButton, ShimmerText } from './sizzle';
import { Field, GhostButton, PrimaryButton, Sheet, inputClass, useToast } from './ui';

// ---------- Quarter close and setup ----------

export function QuarterCloseCard({ quarter }: { quarter: Quarter }) {
  return (
    <motion.section initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mt-6">
      <GlowCard color="#ffb454" intensity={1} className="overflow-hidden bg-black/70 backdrop-blur-xl">
        <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse at 50% 120%, rgba(255,120,40,0.35), transparent 60%)' }} />
        <div className="relative px-5 pt-5 pb-5">
          <div className="text-[12px] font-bold tracking-[0.22em] text-ember uppercase">Quarter complete</div>
          <h2 className="mt-1 font-display text-[32px] leading-tight font-black">
            <ShimmerText>{quarterLabel(quarter.id)} is in the books</ShimmerText>
          </h2>
          <p className="mt-1.5 text-[15px] text-dim">Watch your highlights, grade your goals, and light up the next quarter.</p>
          <MoltenButton className="mt-4 h-14 w-full text-[18px]" onClick={() => navigate(`reel/${quarter.id}/close`)}>
            ▶ Watch your highlights
          </MoltenButton>
        </div>
      </GlowCard>
    </motion.section>
  );
}

export function SetupCard({ quarter }: { quarter: Quarter }) {
  return (
    <motion.section initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mt-6">
      <GlowCard color="#ff9a3c" intensity={0.8} className="bg-black/65 backdrop-blur-xl">
        <div className="px-5 py-5">
          <div className="text-[12px] font-bold tracking-[0.22em] text-ember uppercase">New quarter</div>
          <h2 className="mt-1 font-display text-[28px] leading-tight font-black">Set up {quarterLabel(quarter.id)}</h2>
          <p className="mt-1.5 text-[15px] text-dim">Theme, intents, and three goals a burner. A few focused minutes.</p>
          <MoltenButton className="mt-4 h-13 w-full text-[17px]" onClick={() => navigate(`setup/${quarter.id}`)}>
            Light it up
          </MoltenButton>
        </div>
      </GlowCard>
    </motion.section>
  );
}

// ---------- Weekly review ----------

export function ReviewCard({ today, reviewDay, reviews }: { today: string; reviewDay: number; reviews: WeeklyReview[] }) {
  const due = dueReviewWeek(today, reviewDay);
  if (!due) return null;
  const review = reviews.find((r) => r.weekStart === due);
  if (review?.completedAt) return null;
  const inProgress = !!review && (review.step > 0 || review.wins.length > 0);
  return (
    <motion.section initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="mt-6">
      <GlowCard color="#ffd27a" intensity={0.9} className="bg-black/65 backdrop-blur-xl">
        <button onClick={() => navigate('review')} className="flex w-full items-center gap-4 px-5 py-4 text-left">
          <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl text-[28px]" style={{ background: 'radial-gradient(circle at 50% 30%, rgba(255,200,120,0.35), rgba(255,100,40,0.1))' }}>
            🔥
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[12px] font-bold tracking-[0.2em] text-ember uppercase">Weekly review</span>
            <span className="block font-display text-[21px] font-bold">{inProgress ? `Pick up at step ${review!.step + 1}` : 'Your weekly ritual is ready'}</span>
            <span className="block text-[13px] text-dim">
              Week of {fmtDay(due)} · about 5 minutes
            </span>
          </span>
          <span className="text-[26px] text-ember">›</span>
        </button>
      </GlowCard>
    </motion.section>
  );
}

// ---------- This week's actions ----------

export function ActionsList({ actions, today }: { actions: WeeklyAction[]; today: string }) {
  const toast = useToast();
  const week = startOfWeek(today);
  const mine = actions.filter((a) => a.weekStart === week).sort((a, b) => Number(!!a.done) - Number(!!b.done) || a.order - b.order);
  if (!mine.length) return null;
  const done = mine.filter((a) => a.done).length;
  return (
    <section className="mt-6">
      <div className="mb-2.5 flex items-baseline justify-between">
        <h2 className="font-display text-[20px] font-bold">This week's actions</h2>
        <span className="text-[13px] font-semibold text-ember tabular">
          {done}/{mine.length} done
        </span>
      </div>
      <ul className="space-y-2">
        <AnimatePresence initial={false}>
          {mine.map((a) => {
            const p = a.burner ? PALETTES[a.burner] : PALETTES.family;
            return (
              <motion.li key={a.id} layout transition={{ type: 'spring', stiffness: 400, damping: 34 }}>
                <motion.button
                  whileTap={{ scale: 0.97 }}
                  onClick={async (e) => {
                    const x = e.clientX;
                    const y = e.clientY;
                    const nowDone = await toggleAction(a.id);
                    if (nowDone) {
                      celebrate({ kind: 'log', burner: a.burner ?? 'family', x, y });
                      toast({ message: `Done: ${a.text}`, actions: [{ label: 'Undo', run: () => void toggleAction(a.id) }] });
                    } else {
                      sfx.tick();
                      haptic();
                    }
                  }}
                  className="flex min-h-14 w-full items-center gap-3 rounded-[20px] border px-4 py-3 text-left"
                  style={{
                    borderColor: a.done ? `${p.mid}55` : 'rgba(255,255,255,0.08)',
                    background: a.done ? `linear-gradient(90deg, ${p.mid}18, transparent)` : 'rgba(10,10,12,0.9)',
                  }}
                  aria-pressed={!!a.done}
                  aria-label={`${a.text}${a.done ? ', done' : ''}`}
                >
                  <span
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[15px] font-bold transition"
                    style={a.done ? { background: p.mid, color: '#000', boxShadow: `0 0 14px ${p.mid}` } : { boxShadow: `inset 0 0 0 2px ${p.mid}88` }}
                  >
                    {a.done ? '✓' : ''}
                  </span>
                  <span className={`flex-1 text-[16px] ${a.done ? 'text-dim line-through decoration-white/30' : ''}`}>{a.text}</span>
                  {a.burner && <MiniFlame burner={a.burner} size={18} lit={a.done ? 1 : 0.5} />}
                </motion.button>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </section>
  );
}

// ---------- Travel/Crunch ----------

export function CrunchChip({ crunch, onOpen }: { crunch?: CrunchPeriod; onOpen: () => void }) {
  return (
    <button
      onClick={() => {
        sfx.tick();
        onOpen();
      }}
      className="flex h-10 items-center gap-2 rounded-full border px-3.5 text-[14px] font-semibold"
      style={
        crunch
          ? { borderColor: 'rgba(125,211,252,0.5)', background: 'rgba(56,189,248,0.12)', color: '#bae6fd', boxShadow: '0 0 18px -6px #38bdf8' }
          : { borderColor: 'rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.5)', color: 'rgba(255,255,255,0.7)' }
      }
      aria-label={crunch ? 'Travel/Crunch mode is on. Tap to change.' : 'Turn on Travel/Crunch mode'}
    >
      <span aria-hidden>✈️</span>
      {crunch ? `${crunch.label ?? 'Travel/Crunch'} on` : 'Travel/Crunch'}
    </button>
  );
}

const LABELS = ['Travel', 'Deal crunch', 'Family event', 'Sick'];

export function CrunchSheet({ open, onClose, crunch, today }: { open: boolean; onClose: () => void; crunch?: CrunchPeriod; today: string }) {
  const [label, setLabel] = useState('Travel');
  const [end, setEnd] = useState<string | undefined>(undefined);
  const presets: { label: string; end?: string }[] = [
    { label: 'Through tomorrow', end: addDays(today, 1) },
    { label: '3 days', end: addDays(today, 2) },
    { label: 'Through Sunday', end: addDays(startOfWeek(today), 6) },
    { label: '1 week', end: addDays(today, 6) },
    { label: 'No end date' },
  ];

  return (
    <Sheet open={open} onClose={onClose} title={crunch ? 'Travel/Crunch mode is on' : 'Travel/Crunch mode'}>
      {crunch ? (
        <div className="space-y-4">
          <p className="text-[16px] text-dim">
            {crunch.label ?? 'Travel/Crunch'} since {fmtDay(crunch.start)}
            {crunch.end ? `, ending ${fmtDay(crunch.end)}` : ', no end date'}. Streaks are paused, expectations are softened, and nudges stay quiet.
          </p>
          <PrimaryButton
            className="w-full"
            onClick={async () => {
              await endCrunch();
              onClose();
            }}
          >
            I am back. End it now
          </PrimaryButton>
        </div>
      ) : (
        <div className="space-y-5">
          <p className="text-[16px] text-dim">
            For travel, deal crunches, or life happening. Streaks pause, pace expectations soften, slipping nudges go quiet, and your coach will know to go easy.
          </p>
          <Field label="What is going on">
            <div className="flex flex-wrap gap-2">
              {LABELS.map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => setLabel(l)}
                  className="min-h-11 rounded-full px-4 text-[15px] font-medium"
                  style={label === l ? { background: 'rgba(56,189,248,0.18)', boxShadow: 'inset 0 0 0 1.5px #7dd3fc', color: '#e0f2fe' } : { boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.12)' }}
                >
                  {l}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Until">
            <div className="grid grid-cols-2 gap-2">
              {presets.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setEnd(p.end)}
                  className="min-h-12 rounded-2xl px-3 text-[15px] font-medium"
                  style={end === p.end ? { background: 'rgba(56,189,248,0.18)', boxShadow: 'inset 0 0 0 1.5px #7dd3fc', color: '#e0f2fe' } : { boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.12)' }}
                >
                  {p.label}
                </button>
              ))}
              <input
                type="date"
                className={`${inputClass} col-span-2`}
                min={today}
                value={end ?? ''}
                onChange={(e) => setEnd(e.target.value || undefined)}
                aria-label="Custom end date"
              />
            </div>
          </Field>
          <div className="flex gap-3">
            <GhostButton onClick={onClose}>Cancel</GhostButton>
            <PrimaryButton
              className="flex-1"
              onClick={async () => {
                await startCrunch({ end, label });
                sfx.whoosh();
                onClose();
              }}
            >
              Turn on
            </PrimaryButton>
          </div>
        </div>
      )}
    </Sheet>
  );
}

export function CrunchBanner({ crunch, onOpen }: { crunch: CrunchPeriod; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="mt-4 flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left"
      style={{ borderColor: 'rgba(125,211,252,0.35)', background: 'linear-gradient(90deg, rgba(56,189,248,0.14), rgba(0,0,0,0.5))' }}
    >
      <span className="text-[22px]" aria-hidden>
        ✈️
      </span>
      <span className="flex-1 text-[14px] text-sky-100">
        <span className="font-semibold">{crunch.label ?? 'Travel/Crunch'} mode</span>
        {crunch.end ? ` until ${fmtDay(crunch.end)}` : ''}. Streaks paused, expectations softened.
      </span>
    </button>
  );
}
