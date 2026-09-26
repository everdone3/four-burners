// Home screen extras: one-tap energy rating, "Reach out" strip, and the quarter theme editor.
import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { energyOn, type EnergyEntry, type PersonStatus, type QuarterId } from '@/domain';
import { setEnergy, setTheme } from '@/data/repo';
import { sfx } from '../fx/audio';
import { haptic } from '../fx/haptics';
import { PALETTES } from '../theme';
import { useReducedMotion } from '../motion';
import { PersonCard } from './People';
import { GhostButton, PrimaryButton, Sheet, inputClass } from './ui';

const ENERGY_LABELS = ['Drained', 'Low', 'Okay', 'Good', 'On fire'];

/** Five flames; tap one to rate today. Tap it again to clear. Never required. */
export function EnergyRow({ entries, today }: { entries: readonly EnergyEntry[]; today: string }) {
  const current = energyOn(entries, today)?.rating ?? 0;
  const reduced = useReducedMotion();
  return (
    <section className="mt-6 rounded-[24px] border border-white/[0.08] bg-black/55 px-4 py-3.5 backdrop-blur-xl" aria-label="Energy today">
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] font-semibold tracking-[0.16em] text-dim uppercase">Energy today</span>
        <span className="text-[13px] font-medium text-ember">{current ? ENERGY_LABELS[current - 1] : 'Optional'}</span>
      </div>
      <div className="mt-2 flex justify-between gap-1" role="radiogroup">
        {[1, 2, 3, 4, 5].map((n) => {
          const lit = n <= current;
          return (
            <motion.button
              key={n}
              role="radio"
              aria-checked={n === current}
              aria-label={`${n}, ${ENERGY_LABELS[n - 1]}`}
              whileTap={{ scale: 0.8 }}
              onClick={() => {
                sfx.tick();
                haptic();
                void setEnergy(n === current ? null : (n as EnergyEntry['rating']));
              }}
              className="grid h-12 flex-1 place-items-center rounded-2xl"
              style={{ background: lit ? 'rgba(255,140,50,0.10)' : 'rgba(255,255,255,0.03)' }}
            >
              <motion.span
                aria-hidden
                animate={lit && !reduced ? { scale: [1, 1.25, 1] } : { scale: 1 }}
                transition={{ duration: 0.4 }}
                style={{
                  fontSize: 16 + n * 3,
                  filter: lit ? `drop-shadow(0 0 ${4 + n * 2}px #ff8a3d)` : 'grayscale(1) brightness(0.45)',
                  opacity: lit ? 1 : 0.6,
                }}
              >
                🔥
              </motion.span>
            </motion.button>
          );
        })}
      </div>
    </section>
  );
}

/** People who are due or overdue, across Family and Friends. Two taps to log. */
export function ReachOut({ statuses }: { statuses: PersonStatus[] }) {
  const due = statuses.filter((s) => s.state === 'overdue' || s.state === 'due').slice(0, 3);
  if (!due.length) return null;
  return (
    <section className="mt-6">
      <div className="mb-2.5 flex items-baseline justify-between">
        <h2 className="font-display text-[20px] font-bold">Reach out</h2>
        <span className="text-[13px] text-faint">Tap a name, then how</span>
      </div>
      <div className="space-y-2">
        {due.map((s) => (
          <PersonCard key={s.person.id} s={s} compact />
        ))}
      </div>
    </section>
  );
}

export function ThemeSheet({ open, onClose, quarterId, theme }: { open: boolean; onClose: () => void; quarterId: QuarterId; theme?: string }) {
  const [value, setValue] = useState(theme ?? '');
  useEffect(() => {
    if (open) setValue(theme ?? '');
  }, [open, theme]);
  const ideas = ['Present', 'Foundations', 'Less but better', 'Strong', 'All in', 'Reset'];
  return (
    <Sheet open={open} onClose={onClose} title="Quarter theme">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          await setTheme(quarterId, value);
          onClose();
        }}
      >
        <p className="text-[15px] text-dim">One word or a short phrase to carry through the quarter. Optional.</p>
        <input autoFocus className={inputClass} value={value} maxLength={32} onChange={(e) => setValue(e.target.value)} placeholder="Present" autoCapitalize="words" />
        <div className="flex flex-wrap gap-2">
          {ideas.map((i) => (
            <button
              type="button"
              key={i}
              onClick={() => setValue(i)}
              className="min-h-10 rounded-full px-3.5 text-[14px] text-dim"
              style={{ boxShadow: `inset 0 0 0 1px ${PALETTES.family.mid}44` }}
            >
              {i}
            </button>
          ))}
        </div>
        <div className="flex gap-3">
          {theme && (
            <GhostButton
              type="button"
              onClick={async () => {
                await setTheme(quarterId, '');
                onClose();
              }}
            >
              Clear
            </GhostButton>
          )}
          <PrimaryButton type="submit" className="flex-1">
            Save theme
          </PrimaryButton>
        </div>
      </form>
    </Sheet>
  );
}
