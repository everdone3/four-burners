// Full-screen celebration layer: spark bursts, shockwave rings, screen flash, and title slams.
// Trigger from anywhere with celebrate(); the layer is mounted once in App.
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import type { BurnerId } from '@/domain';
import { PALETTES } from '../theme';
import { useReducedMotion } from '../motion';
import { addTick } from './ticker';
import { sfx } from './audio';
import { haptic } from './haptics';

export type CelebrationKind = 'log' | 'complete' | 'reconnect' | 'milestone';

interface CelebrateDetail {
  kind: CelebrationKind;
  burner: BurnerId;
  x?: number;
  y?: number;
  title?: string;
  subtitle?: string;
}

/** Fire a celebration. Call from a tap handler so sound and haptics are allowed. */
export function celebrate(detail: CelebrateDetail) {
  if (detail.kind === 'complete' || detail.kind === 'milestone') {
    sfx.complete();
    haptic('success');
  } else {
    sfx.log();
    haptic('light');
  }
  window.dispatchEvent(new CustomEvent('burner-flare', { detail: { burner: detail.burner, strength: detail.kind === 'log' ? 0.8 : 2 } }));
  window.dispatchEvent(new CustomEvent('fx-celebrate', { detail }));
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  color: string;
  trail: [number, number][];
}

interface Ring {
  x: number;
  y: number;
  age: number;
  life: number;
  maxR: number;
  color: string;
}

export function Celebrations() {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  const [flash, setFlash] = useState<{ id: number; color: string } | null>(null);
  const [slam, setSlam] = useState<{ id: number; title: string; subtitle?: string; color: string } | null>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    const sparks: Spark[] = [];
    const rings: Ring[] = [];
    let w = 0;
    let h = 0;
    const resize = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      w = innerWidth;
      h = innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    addEventListener('resize', resize);

    const burst = (x: number, y: number, colors: string[], power: number) => {
      const n = Math.round((reduced ? 10 : 70) * power);
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * (power > 1.5 ? 2 : 1.3);
        const sp = (180 + Math.random() * 520) * Math.sqrt(power);
        sparks.push({
          x,
          y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          age: 0,
          life: 0.7 + Math.random() * 0.9,
          size: 1.2 + Math.random() * 2.4,
          color: colors[Math.floor(Math.random() * colors.length)],
          trail: [],
        });
      }
      rings.push({ x, y, age: 0, life: 0.7, maxR: 90 + 140 * power, color: colors[1] });
    };

    let stopTick: (() => void) | null = null;
    const ensureTick = () => {
      if (stopTick) return;
      stopTick = addTick((_, dt) => {
        ctx.clearRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'lighter';
        for (let i = rings.length - 1; i >= 0; i--) {
          const r = rings[i];
          r.age += dt;
          const k = r.age / r.life;
          if (k >= 1) {
            rings.splice(i, 1);
            continue;
          }
          const e = 1 - Math.pow(1 - k, 3);
          ctx.strokeStyle = r.color;
          ctx.globalAlpha = (1 - k) * 0.8;
          ctx.lineWidth = 6 * (1 - k) + 1;
          ctx.shadowColor = r.color;
          ctx.shadowBlur = 24;
          ctx.beginPath();
          ctx.arc(r.x, r.y, r.maxR * e, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
        for (let i = sparks.length - 1; i >= 0; i--) {
          const s = sparks[i];
          s.age += dt;
          const k = s.age / s.life;
          if (k >= 1) {
            sparks.splice(i, 1);
            continue;
          }
          s.trail.push([s.x, s.y]);
          if (s.trail.length > 6) s.trail.shift();
          s.vy += 520 * dt; // gravity
          s.vx *= 1 - dt * 1.8;
          s.vy *= 1 - dt * 1.2;
          s.x += s.vx * dt;
          s.y += s.vy * dt;
          const alpha = Math.pow(1 - k, 1.4);
          ctx.globalAlpha = alpha * 0.5;
          ctx.strokeStyle = s.color;
          ctx.lineWidth = s.size;
          ctx.beginPath();
          ctx.moveTo(s.trail[0][0], s.trail[0][1]);
          for (const [tx, ty] of s.trail) ctx.lineTo(tx, ty);
          ctx.lineTo(s.x, s.y);
          ctx.stroke();
          ctx.globalAlpha = alpha;
          ctx.fillStyle = '#fff';
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.size * 0.7, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        if (!sparks.length && !rings.length) {
          ctx.clearRect(0, 0, w, h);
          stopTick?.();
          stopTick = null;
        }
      });
    };

    const on = (e: Event) => {
      const d = (e as CustomEvent<CelebrateDetail>).detail;
      const p = PALETTES[d.burner];
      const colors = [p.core, p.mid, p.outer, p.accent];
      const x = d.x ?? w / 2;
      const y = d.y ?? h * 0.55;
      if (d.kind === 'log' || d.kind === 'reconnect') {
        burst(x, y, colors, 1);
      } else {
        burst(x, y, colors, 2.4);
        if (!reduced) {
          setTimeout(() => burst(w * 0.2, h * 0.35, colors, 1.4), 180);
          setTimeout(() => burst(w * 0.8, h * 0.3, colors, 1.4), 320);
          setTimeout(() => burst(w * 0.5, h * 0.2, colors, 1.8), 480);
        }
        setFlash({ id: Date.now(), color: p.mid });
        setSlam({ id: Date.now(), title: d.title ?? 'Goal complete', subtitle: d.subtitle, color: p.accent });
        setTimeout(() => setSlam(null), 2200);
      }
      ensureTick();
    };
    addEventListener('fx-celebrate', on);
    return () => {
      removeEventListener('fx-celebrate', on);
      removeEventListener('resize', resize);
      stopTick?.();
    };
  }, [reduced]);

  return (
    <>
      <canvas ref={ref} className="pointer-events-none fixed inset-0 z-[60] h-full w-full" aria-hidden />
      <AnimatePresence>
        {flash && (
          <motion.div
            key={flash.id}
            className="pointer-events-none fixed inset-0 z-[59]"
            style={{ background: `radial-gradient(circle at 50% 55%, ${flash.color}88, transparent 70%)` }}
            initial={{ opacity: 0.9 }}
            animate={{ opacity: 0 }}
            transition={{ duration: 0.9, ease: 'easeOut' }}
            onAnimationComplete={() => setFlash(null)}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {slam && (
          <motion.div
            key={slam.id}
            className="pointer-events-none fixed inset-x-0 top-[30%] z-[61] px-8 text-center"
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 2.4, filter: 'blur(12px)' }}
            animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -30, filter: 'blur(8px)' }}
            transition={{ type: 'spring', stiffness: 380, damping: 22 }}
            role="status"
          >
            <div
              className="font-display text-[44px] leading-none font-black tracking-tight"
              style={{ color: '#fff', textShadow: `0 0 18px ${slam.color}, 0 0 48px ${slam.color}, 0 2px 0 #000` }}
            >
              {slam.title}
            </div>
            {slam.subtitle && <div className="mt-3 text-[17px] font-semibold text-white/90" style={{ textShadow: '0 1px 8px #000' }}>{slam.subtitle}</div>}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
