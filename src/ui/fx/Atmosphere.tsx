// Background atmosphere: burner-tinted glows that breathe, drifting embers, grain, and vignette.
// Sits behind all content and never competes with text.
import { useEffect, useRef } from 'react';
import { BURNERS, type BurnerId } from '@/domain';
import { PALETTES } from '../theme';
import { useReducedMotion } from '../motion';
import { addTick } from './ticker';

const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

const BLOB_POS: Record<BurnerId, [string, string]> = {
  family: ['12%', '38%'],
  friends: ['88%', '42%'],
  health: ['15%', '78%'],
  work: ['85%', '82%'],
};

export function Atmosphere({ heat, focus }: { heat: Record<BurnerId, number>; focus?: BurnerId }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) return;
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
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
    const colors = focus ? [PALETTES[focus].mid, PALETTES[focus].core, PALETTES[focus].accent] : BURNERS.map((b) => PALETTES[b].mid);
    const motes = Array.from({ length: 46 }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      vy: -(8 + Math.random() * 26),
      r: 0.6 + Math.random() * 1.8,
      phase: Math.random() * 10,
      color: colors[Math.floor(Math.random() * colors.length)],
    }));
    const stop = addTick((t, dt) => {
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      for (const m of motes) {
        m.y += m.vy * dt;
        m.x += Math.sin(t * 0.7 + m.phase) * 10 * dt;
        if (m.y < -10) {
          m.y = h + 10;
          m.x = Math.random() * w;
        }
        const tw = 0.35 + 0.65 * Math.abs(Math.sin(t * 1.7 + m.phase));
        ctx.globalAlpha = tw * 0.7;
        ctx.fillStyle = m.color;
        ctx.shadowColor = m.color;
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    });
    return () => {
      stop();
      removeEventListener('resize', resize);
    };
  }, [reduced, focus]);

  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden>
      {(focus ? [focus] : BURNERS).map((b) => {
        const [x, y] = focus ? ['50%', '18%'] : BLOB_POS[b];
        const size = focus ? 130 : 80;
        return (
          <div
            key={b}
            className="absolute rounded-full"
            style={{
              left: x,
              top: y,
              width: `${size}vmax`,
              height: `${size}vmax`,
              transform: 'translate(-50%, -50%)',
              background: `radial-gradient(circle, ${PALETTES[b].outer}${focus ? '55' : '30'} 0%, transparent 60%)`,
              opacity: 0.35 + 0.65 * (heat[b] ?? 0.5),
              animation: reduced ? undefined : `breathe ${7 + BURNERS.indexOf(b) * 1.3}s ease-in-out infinite`,
              transition: 'opacity 1.2s',
            }}
          />
        );
      })}
      <canvas ref={ref} className="absolute inset-0 h-full w-full" />
      <div className="absolute inset-0 opacity-[0.07] mix-blend-overlay" style={{ backgroundImage: GRAIN }} />
      <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse at 50% 40%, transparent 45%, rgba(0,0,0,0.85) 100%)' }} />
    </div>
  );
}
