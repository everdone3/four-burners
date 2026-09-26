// Quarter highlights reel: full-screen, story-style slides that auto-advance.
// Tap right for next, left for back, press and hold to pause.
import { AnimatePresence, motion, useMotionValue, useTransform, type MotionValue } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BURNER_LABELS, quarterHighlights, quarterLabel, type BurnerId, type Highlights } from '@/domain';
import type { AppState } from '@/data/hooks';
import { Flame } from '../components/Flame';
import { CountUp, MoltenButton, ScoreRing, ShimmerText } from '../components/sizzle';
import { celebrate } from '../fx/Celebrations';
import { sfx } from '../fx/audio';
import { addTick } from '../fx/ticker';
import { navigate } from '../router';
import { PALETTES } from '../theme';
import { highlightsInputFor } from '../stateInput';
import { useReducedMotion } from '../motion';

const SLIDE_SECONDS = 5.5;

type Slide = { key: string; render: () => React.ReactNode; burner?: BurnerId; auto?: boolean };

export function ReelScreen({ state, quarterId, closing }: { state: AppState; quarterId: string; closing: boolean }) {
  const h = useMemo(() => {
    const input = highlightsInputFor(state, quarterId);
    return input ? quarterHighlights(input) : null;
    // Freeze the reel's numbers for the session; live updates mid-reel would jitter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quarterId]);
  if (!h) return <div className="grid h-dvh place-items-center text-dim">Quarter not found.</div>;
  return <Reel h={h} closing={closing} />;
}

function Reel({ h, closing }: { h: Highlights; closing: boolean }) {
  const reduced = useReducedMotion();
  const slides = useMemo(() => buildSlides(h, closing), [h, closing]);
  const [i, setI] = useState(0);
  const paused = useRef(false);
  const elapsed = useMotionValue(0);
  const slide = slides[i];

  const go = (to: number) => {
    if (to < 0 || to >= slides.length) return;
    elapsed.set(0);
    setI(to);
  };

  // Advance on the shared animation loop so progress bars and timing stay in sync.
  useEffect(() => {
    if (slide.auto === false) return;
    return addTick((_, dt) => {
      if (paused.current) return;
      const next = elapsed.get() + dt;
      elapsed.set(next);
      if (next >= SLIDE_SECONDS) go(i + 1);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  // Each slide lands with a whoosh; the big ones get a burst.
  useEffect(() => {
    sfx.whoosh();
    if (!reduced && (slide.key === 'wins' || slide.key === 'brightest' || slide.key === 'finale')) {
      const t = setTimeout(() => celebrate({ kind: 'log', burner: slide.burner ?? h.brightest?.burner ?? 'family', x: innerWidth / 2, y: innerHeight * 0.45 }), 450);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  return (
    <div
      className="fixed inset-0 z-40 overflow-hidden bg-black select-none"
      onPointerDown={() => (paused.current = true)}
      onPointerUp={() => (paused.current = false)}
      onPointerCancel={() => (paused.current = false)}
    >
      {/* Ambient burner glow for the slide */}
      <div
        aria-hidden
        className="absolute inset-0 transition-[background] duration-1000"
        style={{ background: `radial-gradient(ellipse at 50% 75%, ${PALETTES[slide.burner ?? h.brightest?.burner ?? 'family'].outer}40, transparent 65%)` }}
      />

      <div className="pt-safe absolute inset-x-0 top-0 z-20 px-4">
        <div className="flex gap-1.5 pt-2">
          {slides.map((s, n) => (
            <ProgressBar key={s.key} state={n < i ? 'done' : n > i ? 'todo' : 'now'} elapsed={elapsed} auto={s.auto !== false} />
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between">
          <span className="text-[12px] font-bold tracking-[0.2em] text-white/70 uppercase">{quarterLabel(h.quarterId)} highlights</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              navigate('', { replace: true });
            }}
            className="-mr-2 grid h-11 w-11 place-items-center rounded-full text-white/80 active:bg-white/10"
            aria-label="Close highlights"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
      </div>

      {/* Tap zones */}
      <button className="absolute inset-y-0 left-0 z-10 w-1/3" aria-label="Previous" onClick={() => go(i - 1)} />
      <button className="absolute inset-y-0 right-0 z-10 w-2/3" aria-label="Next" onClick={() => go(i + 1)} />

      <AnimatePresence mode="wait">
        <motion.div
          key={slide.key}
          className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-center px-7"
          initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 1.08, filter: 'blur(10px)' }}
          animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.94, filter: 'blur(8px)' }}
          transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        >
          {slide.render()}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function ProgressBar({ state, elapsed, auto }: { state: 'done' | 'now' | 'todo'; elapsed: MotionValue<number>; auto: boolean }) {
  const width = useTransform(elapsed, (e) => `${Math.min(100, (e / SLIDE_SECONDS) * 100)}%`);
  return (
    <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/20">
      {state === 'done' && <div className="h-full w-full bg-white" />}
      {state === 'now' && <motion.div className="h-full bg-white" style={{ width: auto ? width : '100%', boxShadow: '0 0 8px #fff' }} />}
    </div>
  );
}

// ---------- Slides ----------

const pct = (x: number) => `${Math.round(x * 100)}%`;

function Kicker({ children, color = '#ffb454' }: { children: React.ReactNode; color?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.15 }}
      className="text-[13px] font-bold tracking-[0.24em] uppercase"
      style={{ color }}
    >
      {children}
    </motion.div>
  );
}

function Big({ children, delay = 0.25, className = '' }: { children: React.ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ delay, type: 'spring', stiffness: 220, damping: 20 }}
      className={`font-display leading-[0.95] font-black tracking-tight ${className}`}
    >
      {children}
    </motion.div>
  );
}

function Stagger({ items, render, start = 0.45 }: { items: unknown[]; render: (x: never, i: number) => React.ReactNode; start?: number }) {
  return (
    <>
      {items.map((x, n) => (
        <motion.div key={n} initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: start + n * 0.18, type: 'spring', stiffness: 260, damping: 24 }}>
          {render(x as never, n)}
        </motion.div>
      ))}
    </>
  );
}

function buildSlides(h: Highlights, closing: boolean): Slide[] {
  const slides: Slide[] = [];
  const bright = h.brightest?.burner ?? 'family';

  slides.push({
    key: 'intro',
    burner: bright,
    render: () => (
      <div className="text-center">
        <div className="pointer-events-none mx-auto -mb-10 h-[300px] w-[260px] opacity-90">
          <Flame burner={bright} intent="high" heat={1} brightness={1} ignite={0.2} />
        </div>
        <Kicker>Your quarter in fire</Kicker>
        <Big className="mt-3 text-[64px]">
          <ShimmerText>{quarterLabel(h.quarterId)}</ShimmerText>
        </Big>
        {h.theme && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.8 }} className="mt-3 font-display text-[26px] font-bold text-white/85">
            "{h.theme}"
          </motion.div>
        )}
      </div>
    ),
  });

  slides.push({
    key: 'numbers',
    burner: 'family',
    render: () => (
      <div>
        <Kicker>You showed up</Kicker>
        <Big className="mt-3 text-[96px] text-white">
          <CountUp value={h.checkInDays} delay={0.3} duration={1.6} />
        </Big>
        <div className="mt-1 text-[22px] font-semibold text-white/80">of {h.daysInQuarter} days</div>
        <div className="mt-8 grid grid-cols-3 gap-3">
          {[
            { v: h.totalLogs, l: 'logs' },
            { v: h.touchpointCount, l: 'connections' },
            { v: h.actionsDone, l: 'actions done' },
          ].map((x, n) => (
            <motion.div key={x.l} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.7 + n * 0.15 }} className="rounded-2xl border border-white/10 bg-white/[0.04] p-3">
              <div className="font-display text-[30px] font-black tabular">
                <CountUp value={x.v} delay={0.8 + n * 0.15} />
              </div>
              <div className="text-[13px] text-white/60">{x.l}</div>
            </motion.div>
          ))}
        </div>
      </div>
    ),
  });

  if (h.brightest) {
    const p = PALETTES[h.brightest.burner];
    slides.push({
      key: 'brightest',
      burner: h.brightest.burner,
      render: () => (
        <div className="text-center">
          <Kicker color={p.accent}>Brightest burner</Kicker>
          <div className="pointer-events-none mx-auto mt-2 -mb-6 h-[340px] w-[300px]">
            <Flame burner={h.brightest!.burner} intent="high" heat={1} brightness={1} ignite={0.1} />
          </div>
          <Big className="text-[68px]" delay={0.5}>
            <span style={{ color: p.accent, textShadow: `0 0 30px ${p.mid}, 0 0 80px ${p.outer}` }}>{BURNER_LABELS[h.brightest!.burner]}</span>
          </Big>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.9 }} className="mt-3 text-[18px] text-white/80">
            {pct(h.brightest!.pace)} of pace · {h.brightest!.activeDays} active days
          </motion.div>
        </div>
      ),
    });
  }

  if (h.longestStreak > 1 || h.habitStreaks.length) {
    slides.push({
      key: 'streaks',
      burner: 'health',
      render: () => (
        <div>
          <Kicker>Longest streak</Kicker>
          <Big className="mt-3 text-[110px]">
            <span style={{ textShadow: '0 0 40px rgba(255,140,60,0.8)' }}>
              <CountUp value={h.longestStreak} delay={0.3} duration={1.6} />
            </span>
          </Big>
          <div className="text-[22px] font-semibold text-white/80">days in a row 🔥</div>
          {h.habitStreaks.length > 0 && (
            <div className="mt-8 space-y-2.5">
              <Stagger
                items={h.habitStreaks}
                start={0.8}
                render={(s: Highlights['habitStreaks'][number]) => (
                  <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
                    <span className="text-[17px] font-semibold" style={{ color: PALETTES[s.burner].accent }}>
                      {s.title}
                    </span>
                    <span className="font-display text-[20px] font-black">
                      {s.periods} {s.unit}s
                    </span>
                  </div>
                )}
              />
            </div>
          )}
        </div>
      ),
    });
  }

  if (h.topWins.length) {
    slides.push({
      key: 'wins',
      burner: bright,
      render: () => (
        <div>
          <Kicker color="#6ee7b7">Top wins</Kicker>
          <div className="mt-5 space-y-3">
            <Stagger
              items={h.topWins}
              start={0.3}
              render={(w: Highlights['topWins'][number], n) => (
                <div className="flex items-center gap-4">
                  <span className="font-display text-[34px] font-black text-white/25 tabular">{n + 1}</span>
                  <span className="font-display text-[26px] leading-tight font-bold" style={{ color: w.burner ? PALETTES[w.burner].accent : '#fff' }}>
                    {w.text}
                  </span>
                </div>
              )}
            />
          </div>
        </div>
      ),
    });
  }

  if (h.comeback) {
    const c = h.comeback;
    const p = PALETTES[c.burner];
    slides.push({
      key: 'comeback',
      burner: c.burner,
      render: () => (
        <div>
          <Kicker color={p.accent}>Biggest comeback</Kicker>
          <Big className="mt-3 text-[48px]">{c.title}</Big>
          <div className="mt-8">
            <div className="flex justify-between text-[15px] font-semibold text-white/70">
              <span>Low point {pct(c.from)}</span>
              <span style={{ color: p.accent }}>Finished {pct(c.to)}</span>
            </div>
            <div className="mt-2 h-4 overflow-hidden rounded-full bg-white/10">
              <motion.div
                className="h-full rounded-full"
                initial={{ width: pct(c.from) }}
                animate={{ width: pct(c.to) }}
                transition={{ delay: 0.8, duration: 1.6, ease: [0.16, 1, 0.3, 1] }}
                style={{ background: `linear-gradient(90deg, ${p.outer}, ${p.mid}, ${p.core})`, boxShadow: `0 0 20px ${p.mid}` }}
              />
            </div>
          </div>
        </div>
      ),
    });
  }

  if (h.mostConnected.length) {
    slides.push({
      key: 'people',
      burner: 'friends',
      render: () => (
        <div>
          <Kicker color="#ff8cb0">Most connected</Kicker>
          <div className="mt-6 space-y-4">
            <Stagger
              items={h.mostConnected}
              start={0.3}
              render={(m: Highlights['mostConnected'][number]) => {
                const p = PALETTES[m.burner];
                return (
                  <div className="flex items-center gap-4">
                    <span
                      className="grid h-16 w-16 place-items-center rounded-full font-display text-[22px] font-black text-black"
                      style={{ background: `radial-gradient(circle at 50% 35%, ${p.core}, ${p.mid} 55%, ${p.outer})`, boxShadow: `0 0 30px ${p.mid}` }}
                    >
                      {m.name.replace(/\(.*?\)/g, '').trim()[0]}
                    </span>
                    <span className="flex-1">
                      <span className="block font-display text-[26px] font-bold">{m.name}</span>
                      <span className="block text-[15px] text-white/65">
                        {m.count} {m.count === 1 ? 'connection' : 'connections'}
                      </span>
                    </span>
                  </div>
                );
              }}
            />
          </div>
        </div>
      ),
    });
  }

  slides.push({
    key: 'finale',
    burner: bright,
    auto: false,
    render: () => (
      <div className="pointer-events-auto relative z-20 text-center">
        <Kicker>{quarterLabel(h.quarterId)} final</Kicker>
        <div className="mt-6 flex justify-around">
          <ScoreRing value={h.progressScore} label="Progress" from="#ffd27a" to="#ff5a1f" delay={0.3} />
          <ScoreRing value={h.consistencyScore} label="Consistency" from="#9ae8ff" to="#3b82f6" delay={0.5} />
        </div>
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1 }} className="mt-6 text-[18px] text-white/80">
          {h.goalsDone} of {h.goalsTotal} goals complete
          {h.crunchDays > 0 ? ` · ${h.crunchDays} travel/crunch days` : ''}
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 1.2 }} className="mt-10">
          {closing ? (
            <MoltenButton className="h-16 w-full text-[19px]" onClick={() => navigate(`close/${h.quarterId}`, { replace: true })}>
              Grade your goals
            </MoltenButton>
          ) : (
            <MoltenButton className="h-16 w-full text-[19px]" onClick={() => history.back()}>
              Done
            </MoltenButton>
          )}
        </motion.div>
      </div>
    ),
  });

  return slides;
}
