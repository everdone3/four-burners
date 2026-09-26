// Canvas particle flames. One shared animation loop drives every flame on screen.
// Quality steps down automatically (full -> lite -> static) if frames get slow,
// and Reduce Motion always gets the calm static flame.
import { useEffect, useRef, useState } from 'react';
import type { BurnerId, Intent } from '@/domain';
import { INTENT_SCALE, PALETTES, type FlamePalette } from '../theme';
import { useReducedMotion } from '../motion';

type Quality = 'full' | 'lite' | 'static';
type Renderer = (t: number, dt: number) => void;

// ---------- Shared loop and performance governor ----------

const renderers = new Set<Renderer>();
let rafId = 0;
let lastT = 0;
let quality: Quality = 'full';
const qualityListeners = new Set<(q: Quality) => void>();
let frameSum = 0;
let frameCount = 0;

function setQuality(q: Quality) {
  quality = q;
  qualityListeners.forEach((l) => l(q));
}

function govern(dt: number) {
  if (dt > 100) return; // tab was hidden or paused; ignore
  frameSum += dt;
  frameCount++;
  if (frameCount < 120) return;
  const avg = frameSum / frameCount;
  frameSum = 0;
  frameCount = 0;
  if (quality === 'full' && avg > 24) setQuality('lite');
  else if (quality === 'lite' && avg > 30) setQuality('static');
}

function loop(t: number) {
  const dt = lastT ? t - lastT : 16;
  lastT = t;
  govern(dt);
  const step = Math.min(dt, 50) / 1000;
  renderers.forEach((r) => r(t / 1000, step));
  rafId = renderers.size ? requestAnimationFrame(loop) : 0;
}

function register(r: Renderer) {
  renderers.add(r);
  if (!rafId) {
    lastT = 0;
    rafId = requestAnimationFrame(loop);
  }
  return () => {
    renderers.delete(r);
  };
}

// Dev/test hook: advance every flame by N seconds without waiting on requestAnimationFrame.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  let simT = 0;
  (window as unknown as Record<string, unknown>).__advanceFlames = (seconds: number) => {
    for (let i = 0; i < seconds * 60; i++) {
      simT += 1 / 60;
      renderers.forEach((r) => r(simT, 1 / 60));
    }
  };
}

function useQuality(): Quality {
  const [q, setQ] = useState(quality);
  useEffect(() => {
    qualityListeners.add(setQ);
    return () => {
      qualityListeners.delete(setQ);
    };
  }, []);
  return q;
}

// ---------- Flare-ups (celebrations) ----------

export function flare(burner: BurnerId, strength = 1) {
  window.dispatchEvent(new CustomEvent('burner-flare', { detail: { burner, strength } }));
}

// ---------- Sprites ----------

const SPRITE_STEPS = 24;
const SPRITE_SIZE = 64;
const spriteCache = new Map<string, HTMLCanvasElement[]>();

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function colorAt(p: FlamePalette, t: number): [number, number, number] {
  const core = hexToRgb(p.core);
  const mid = hexToRgb(p.mid);
  const outer = hexToRgb(p.outer);
  const smoke: [number, number, number] = [outer[0] * 0.35, outer[1] * 0.2, outer[2] * 0.25];
  if (t < 0.12) return mix(core, mid, t / 0.12);
  if (t < 0.6) return mix(mid, outer, (t - 0.12) / 0.48);
  return mix(outer, smoke, (t - 0.6) / 0.4);
}

function spritesFor(burner: BurnerId): HTMLCanvasElement[] {
  const hit = spriteCache.get(burner);
  if (hit) return hit;
  const palette = PALETTES[burner];
  const out: HTMLCanvasElement[] = [];
  for (let i = 0; i < SPRITE_STEPS; i++) {
    const c = document.createElement('canvas');
    c.width = c.height = SPRITE_SIZE;
    const ctx = c.getContext('2d')!;
    const [r, g, b] = colorAt(palette, i / (SPRITE_STEPS - 1)).map(Math.round);
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
    grad.addColorStop(0.35, `rgba(${r},${g},${b},0.5)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
    out.push(c);
  }
  spriteCache.set(burner, out);
  return out;
}

// ---------- Particle flame ----------

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  r0: number;
  seed: number;
  ember: boolean;
}

export interface FlameProps {
  burner: BurnerId;
  intent: Intent;
  /** 0..1 */
  heat: number;
  /** 0.4..1 */
  brightness: number;
  className?: string;
}

export function Flame(props: FlameProps) {
  const reduced = useReducedMotion();
  const q = useQuality();
  if (reduced || q === 'static') return <StaticFlame {...props} animate={!reduced} />;
  return <CanvasFlame {...props} lite={q === 'lite'} />;
}

function CanvasFlame({ burner, intent, heat, brightness, className, lite }: FlameProps & { lite: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef({ intent, heat, brightness, lite });
  live.current = { intent, heat, brightness, lite };

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    const sprites = spritesFor(burner);
    const palette = PALETTES[burner];
    const [mr, mg, mb] = hexToRgb(palette.mid);
    const particles: Particle[] = [];
    const seed = Math.random() * 100;
    let w = 0;
    let h = 0;
    let spawnDebt = 0;
    let boost = 0;
    let scaleNow = 0; // eased flame scale, so intent changes grow/shrink smoothly

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const onFlare = (e: Event) => {
      const d = (e as CustomEvent).detail as { burner: BurnerId; strength: number };
      if (d.burner === burner) boost = Math.min(2, boost + d.strength);
    };
    window.addEventListener('burner-flare', onFlare);

    const render: Renderer = (t, dt) => {
      if (!w || !h) return;
      const { intent, heat, brightness, lite } = live.current;
      const target = INTENT_SCALE[intent] * (0.62 + 0.38 * heat);
      scaleNow += (target - scaleNow) * Math.min(1, dt * 3);
      boost = Math.max(0, boost - dt * 0.9);
      const s = scaleNow * (1 + boost * 0.35);
      const flicker = 0.92 + 0.08 * Math.sin(t * 7.3 + seed) * Math.sin(t * 2.9 + seed * 2);
      const unit = Math.min(w, h * 0.8);
      const cx = w / 2;
      const baseY = h * 0.94;

      // Spawn
      const rate = (lite ? 45 : 95) * (0.55 + 0.45 * heat) * (0.6 + 0.4 * brightness) * (1 + boost);
      spawnDebt += rate * dt;
      const max = lite ? 90 : 190;
      while (spawnDebt >= 1 && particles.length < max) {
        spawnDebt -= 1;
        const spread = (Math.random() + Math.random() + Math.random() - 1.5) * unit * 0.13 * s;
        const ember = Math.random() < 0.035 + boost * 0.12;
        particles.push({
          x: cx + spread,
          y: baseY - Math.random() * 4,
          vx: (Math.random() - 0.5) * 12,
          vy: -(unit * (1.05 + Math.random() * 0.6) * s) * (ember ? 1.2 : 1),
          age: 0,
          life: ember ? 1.3 + Math.random() : 0.6 + Math.random() * 0.4,
          r0: unit * 0.2 * s * (0.75 + Math.random() * 0.5) * (ember ? 0.08 : 1),
          seed: Math.random() * 1000,
          ember,
        });
      }
      if (spawnDebt > 1) spawnDebt = 1;

      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, w, h);

      // Halo and ember bed
      const halo = ctx.createRadialGradient(cx, baseY - unit * 0.3 * s, 0, cx, baseY - unit * 0.3 * s, unit * 0.75 * s);
      halo.addColorStop(0, `rgba(${mr},${mg},${mb},${0.22 * brightness * flicker})`);
      halo.addColorStop(1, `rgba(${mr},${mg},${mb},0)`);
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, w, h);
      const bed = ctx.createRadialGradient(cx, baseY + 2, 0, cx, baseY + 2, unit * 0.3 * s);
      bed.addColorStop(0, `rgba(${mr},${mg},${mb},${0.5 * brightness})`);
      bed.addColorStop(1, `rgba(${mr},${mg},${mb},0)`);
      ctx.fillStyle = bed;
      ctx.beginPath();
      ctx.ellipse(cx, baseY + 2, unit * 0.32 * s, unit * 0.06 * s, 0, 0, Math.PI * 2);
      ctx.fill();

      // Particles
      ctx.globalCompositeOperation = 'lighter';
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.age += dt;
        const k = p.age / p.life;
        if (k >= 1) {
          particles.splice(i, 1);
          continue;
        }
        // Pull toward the center for a tapered tongue, with a gentle sway.
        const pull = p.ember ? 0.2 : 2 + k * 5;
        p.vx += (cx - p.x) * pull * dt + Math.sin(t * 3 + p.seed) * 18 * dt;
        p.vx *= 1 - dt * 1.5;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy *= 1 - dt * 0.4;
        const r = p.ember ? p.r0 * (1 - k * 0.5) + 1 : p.r0 * Math.pow(1 - k, 0.9) + 1;
        const alpha = Math.min(1, k * 8) * Math.pow(1 - k, 1.1) * brightness * flicker * (p.ember ? 1 : 0.5);
        const sprite = sprites[Math.min(SPRITE_STEPS - 1, Math.floor((p.ember ? k * 0.5 : k) * SPRITE_STEPS))];
        ctx.globalAlpha = alpha;
        ctx.drawImage(sprite, p.x - r, p.y - r, r * 2, r * 2);
      }
      ctx.globalAlpha = 1;
    };

    const unregister = register(render);
    return () => {
      unregister();
      ro.disconnect();
      window.removeEventListener('burner-flare', onFlare);
    };
  }, [burner]);

  return <canvas ref={ref} className={className} style={{ width: '100%', height: '100%', display: 'block' }} aria-hidden />;
}

/** Lightweight CSS flame for slow devices and Reduce Motion. */
function StaticFlame({ burner, intent, heat, brightness, className, animate }: FlameProps & { animate: boolean }) {
  const p = PALETTES[burner];
  const s = INTENT_SCALE[intent] * (0.62 + 0.38 * heat);
  return (
    <div className={className} style={{ width: '100%', height: '100%', position: 'relative', opacity: brightness }} aria-hidden>
      <div
        style={{
          position: 'absolute',
          left: '50%',
          bottom: '10%',
          width: `${46 * s}%`,
          height: `${78 * s}%`,
          transform: 'translateX(-50%)',
          transformOrigin: '50% 100%',
        }}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            borderRadius: '50% 50% 45% 45% / 65% 65% 35% 35%',
            background: `radial-gradient(ellipse at 50% 80%, ${p.core} 0%, ${p.mid} 30%, ${p.outer}cc 60%, transparent 75%)`,
            filter: 'blur(6px)',
            animation: animate ? 'flicker 1.6s ease-in-out infinite' : undefined,
            transformOrigin: '50% 100%',
          }}
        />
      </div>
    </div>
  );
}
