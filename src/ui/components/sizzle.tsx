// Cinematic UI primitives. Each one degrades to a plain, readable version under Reduce Motion.
import { animate, motion, useMotionValue, useTransform } from 'motion/react';
import { useEffect, useId, type ReactNode } from 'react';
import { useReducedMotion } from '../motion';
import { PALETTES as PALETTES_REF } from '../theme';

/** Number that counts up to its value. */
export function CountUp({ value, duration = 1.4, delay = 0, className }: { value: number; duration?: number; delay?: number; className?: string }) {
  const reduced = useReducedMotion();
  const mv = useMotionValue(reduced ? value : 0);
  const rounded = useTransform(mv, (v) => Math.round(v).toString());
  useEffect(() => {
    if (reduced) {
      mv.set(value);
      return;
    }
    const c = animate(mv, value, { duration, delay, ease: [0.16, 1, 0.3, 1] });
    return () => c.stop();
  }, [value, reduced, duration, delay, mv]);
  return <motion.span className={className}>{rounded}</motion.span>;
}

/** Headline text with a molten highlight sweeping across it. Stays solid white underneath. */
export function ShimmerText({ children, className = '', colors = ['#ffffff', '#ffd08a', '#ff8a3d', '#ffffff'] }: { children: ReactNode; className?: string; colors?: string[] }) {
  const reduced = useReducedMotion();
  return (
    <span
      className={`inline-block bg-clip-text text-transparent ${className}`}
      style={{
        backgroundImage: `linear-gradient(100deg, ${colors[0]} 0%, ${colors[0]} 35%, ${colors[1]} 45%, ${colors[2]} 50%, ${colors[1]} 55%, ${colors[3]} 65%, ${colors[3]} 100%)`,
        backgroundSize: '250% 100%',
        animation: reduced ? undefined : 'shimmer 5.5s ease-in-out infinite',
        WebkitBackgroundClip: 'text',
        filter: 'drop-shadow(0 0 18px rgba(255,140,60,0.35))',
      }}
    >
      {children}
    </span>
  );
}

/** Letters that ignite one by one. */
export function IgniteText({ text, delay = 0, className = '' }: { text: string; delay?: number; className?: string }) {
  const reduced = useReducedMotion();
  if (reduced) return <span className={className}>{text}</span>;
  return (
    <span className={className} aria-label={text}>
      {[...text].map((ch, i) => (
        <motion.span
          key={i}
          aria-hidden
          className="inline-block"
          initial={{ opacity: 0, y: 14, filter: 'blur(8px)', textShadow: '0 0 30px rgba(255,160,60,1)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)', textShadow: '0 0 0px rgba(255,160,60,0)' }}
          transition={{ delay: delay + i * 0.035, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        >
          {ch === ' ' ? ' ' : ch}
        </motion.span>
      ))}
    </span>
  );
}

/** Card with a slowly rotating glowing border in the burner's color. */
export function GlowCard({
  color,
  intensity = 1,
  className = '',
  children,
  radius = 26,
}: {
  color: string;
  intensity?: number;
  className?: string;
  children: ReactNode;
  radius?: number;
}) {
  const reduced = useReducedMotion();
  return (
    <div className={`relative ${className}`} style={{ borderRadius: radius }}>
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-px"
        style={{
          borderRadius: radius + 1,
          padding: 1.5,
          background: `conic-gradient(from var(--angle), transparent 0deg, ${color} 50deg, transparent 120deg, transparent 180deg, ${color}aa 230deg, transparent 300deg)`,
          WebkitMask: 'linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0)',
          mask: 'linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0)',
          opacity: 0.35 + 0.65 * intensity,
          animation: reduced ? undefined : `spin-angle ${9 - intensity * 4}s linear infinite`,
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ borderRadius: radius, boxShadow: `0 0 ${24 + 30 * intensity}px -8px ${color}${Math.round(40 + 80 * intensity).toString(16)}, inset 0 1px 0 rgba(255,255,255,0.06)` }}
      />
      {children}
    </div>
  );
}

/** Score ring with a gradient arc, glow, a spark riding the tip, and a count-up number. */
export function ScoreRing({ value, label, from, to, delay = 0 }: { value: number; label: string; from: string; to: string; delay?: number }) {
  const reduced = useReducedMotion();
  const id = useId().replace(/:/g, '');
  const size = 92;
  const r = 38;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, value)) / 100;
  const progress = useMotionValue(reduced ? pct : 0);
  const dash = useTransform(progress, (p) => c * (1 - p));
  const tipX = useTransform(progress, (p) => size / 2 + r * Math.cos(2 * Math.PI * p - Math.PI / 2));
  const tipY = useTransform(progress, (p) => size / 2 + r * Math.sin(2 * Math.PI * p - Math.PI / 2));
  useEffect(() => {
    if (reduced) {
      progress.set(pct);
      return;
    }
    const a = animate(progress, pct, { duration: 1.6, delay, ease: [0.16, 1, 0.3, 1] });
    return () => a.stop();
  }, [pct, reduced, delay, progress]);

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="overflow-visible">
          <defs>
            <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor={from} />
              <stop offset="1" stopColor={to} />
            </linearGradient>
            <filter id={`f${id}`} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="3.5" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(255 255 255 / 0.08)" strokeWidth="7" />
          <motion.circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={`url(#g${id})`}
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={c}
            style={{ strokeDashoffset: dash, rotate: -90, transformOrigin: '50% 50%' }}
            filter={`url(#f${id})`}
          />
          {pct > 0.01 && (
            <>
              <motion.circle cx={tipX} cy={tipY} r="7" fill={to} opacity="0.35" filter={`url(#f${id})`} />
              <motion.circle cx={tipX} cy={tipY} r="3" fill="#fff" />
            </>
          )}
        </svg>
        <div className="absolute inset-0 grid place-items-center">
          <CountUp value={value} delay={delay} className="font-display text-[30px] font-bold tabular" />
        </div>
      </div>
      <div className="text-[12px] font-semibold tracking-[0.16em] text-dim uppercase">{label}</div>
    </div>
  );
}

/** Progress bar that glows and flows like lava, with a bright leading spark. */
export function LavaBar({ fraction, color, hot }: { fraction: number; color: string; hot?: string }) {
  const reduced = useReducedMotion();
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  return (
    <div className="relative h-2 overflow-visible rounded-full bg-white/[0.07]">
      <motion.div
        className="relative h-full rounded-full"
        initial={reduced ? false : { width: 0 }}
        animate={{ width: `${pct}%` }}
        transition={{ duration: 1.1, ease: [0.16, 1, 0.3, 1] }}
        style={{
          backgroundImage: `linear-gradient(90deg, ${color}66, ${color}, ${hot ?? '#fff'}, ${color}, ${color}66)`,
          backgroundSize: '200% 100%',
          animation: reduced ? undefined : 'lava 2.8s linear infinite',
          boxShadow: `0 0 12px ${color}aa, 0 0 2px ${color}`,
        }}
      >
        {pct > 2 && pct < 100 && (
          <span
            className="absolute top-1/2 right-0 h-3.5 w-3.5 translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ background: `radial-gradient(circle, #fff 0%, ${color} 45%, transparent 70%)`, animation: reduced ? undefined : 'pulse-dot 1.4s ease-in-out infinite' }}
          />
        )}
      </motion.div>
    </div>
  );
}

/** Molten call-to-action button. */
export function MoltenButton({ children, onClick, className = '', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const reduced = useReducedMotion();
  return (
    <motion.button
      whileTap={{ scale: 0.94 }}
      onClick={onClick}
      className={`relative isolate overflow-hidden rounded-full font-bold text-black ${className}`}
      style={{
        backgroundImage: 'linear-gradient(110deg, #ffd27a, #ff9a3c 35%, #ff6a2b 55%, #ffb454 80%, #ffd27a)',
        backgroundSize: '220% 100%',
        animation: reduced ? undefined : 'lava 4s linear infinite, glow-pulse 2.4s ease-in-out infinite',
        boxShadow: '0 0 0 1px rgba(255,210,140,0.5), 0 10px 40px -6px rgba(255,120,40,0.75), 0 0 80px -10px rgba(255,140,40,0.6)',
      }}
      {...(rest as object)}
    >
      <span className="relative flex items-center justify-center gap-2">{children}</span>
    </motion.button>
  );
}

/** Streak badge that burns hotter as the streak grows. */
export function StreakBadge({ days, grace }: { days: number; grace: boolean }) {
  const reduced = useReducedMotion();
  const heat = Math.min(1, days / 30);
  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: 1.2, type: 'spring', stiffness: 300, damping: 20 }}
      className="flex h-10 w-fit items-center gap-2 rounded-full border border-white/10 bg-black/60 px-4 backdrop-blur"
      style={{ boxShadow: `0 0 ${16 + heat * 30}px -6px rgba(255,140,40,${0.4 + heat * 0.5})` }}
    >
      <span aria-hidden className="text-[18px]" style={{ filter: `drop-shadow(0 0 ${4 + heat * 8}px #ff8a3d)` }}>🔥</span>
      <span className="text-[15px] font-semibold">
        <CountUp value={days} delay={1.2} className="tabular" /> day streak
      </span>
      {grace && <span className="text-[13px] text-dim">· grace used</span>}
    </motion.div>
  );
}

export function setIrisOrigin(x: number, y: number) {
  (window as unknown as { __iris?: { x: number; y: number } }).__iris = { x, y };
}


/** Where the last burner was tapped, so its page can iris open from that point. */
export function getIrisOrigin(): { x: number; y: number } {
  return (window as unknown as { __iris?: { x: number; y: number } }).__iris ?? { x: innerWidth / 2, y: innerHeight / 3 };
}

/** Small glowing flame icon in a burner's colors (CSS only, cheap enough for lists). */
export function MiniFlame({ burner, size = 22, lit = 1 }: { burner: import('@/domain').BurnerId; size?: number; lit?: number }) {
  const p = PALETTES_REF[burner];
  return (
    <span
      aria-hidden
      className="inline-block shrink-0"
      style={{
        width: size * 0.72,
        height: size,
        borderRadius: '50% 50% 45% 45% / 62% 62% 38% 38%',
        background: `radial-gradient(ellipse at 50% 78%, ${p.core} 0%, ${p.mid} 38%, ${p.outer} 72%, transparent 76%)`,
        filter: `drop-shadow(0 0 ${3 + 6 * lit}px ${p.mid})`,
        opacity: 0.3 + 0.7 * lit,
      }}
    />
  );
}

/** Row of step "embers" for guided flows: done steps glow, the current one pulses. */
export function StepEmbers({ count, current, color = '#ff9a3c' }: { count: number; current: number; color?: string }) {
  return (
    <div className="flex items-center gap-1.5" role="img" aria-label={`Step ${current + 1} of ${count}`}>
      {Array.from({ length: count }, (_, i) => (
        <motion.span
          key={i}
          className="h-1.5 rounded-full"
          animate={{ width: i === current ? 22 : 8, opacity: i <= current ? 1 : 0.25 }}
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          style={{ background: i <= current ? color : '#fff', boxShadow: i <= current ? `0 0 8px ${color}` : undefined }}
        />
      ))}
    </div>
  );
}
