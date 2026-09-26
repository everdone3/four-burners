// Burner flames. Three quality tiers, chosen automatically:
//   webgl:  GPU shader fire + a canvas layer of rising sparks (default)
//   canvas: 2D particle fire (if WebGL is missing or frames get slow)
//   static: CSS glow (very slow devices, and always for Reduce Motion)
import { useEffect, useRef } from 'react';
import type { BurnerId, Intent } from '@/domain';
import { INTENT_SCALE, PALETTES, type FlamePalette } from '../theme';
import { useReducedMotion } from '../motion';
import { addTick, setQuality, useQuality, type Tick } from '../fx/ticker';
import { ShaderFlame } from '../fx/webglFlame';

export interface FlameProps {
  burner: BurnerId;
  intent: Intent;
  /** 0..1 */
  heat: number;
  /** 0.4..1 */
  brightness: number;
  /** Seconds to wait before igniting with a flare. Omit for no ignition sequence. */
  ignite?: number;
  className?: string;
}

/** Make a burner's flame flare up (used by celebrations). */
export function flare(burner: BurnerId, strength = 1) {
  window.dispatchEvent(new CustomEvent('burner-flare', { detail: { burner, strength } }));
}

const webglOk = typeof document !== 'undefined' && ShaderFlame.supported();

export function Flame(props: FlameProps) {
  const reduced = useReducedMotion();
  const q = useQuality();
  if (reduced || q === 'static') return <StaticFlame {...props} animate={!reduced} />;
  if (q === 'webgl' && webglOk) {
    return (
      <div className={props.className} style={{ position: 'relative', width: '100%', height: '100%' }}>
        <ShaderLayer {...props} />
        <ParticleLayer {...props} mode="sparks" />
      </div>
    );
  }
  return <ParticleLayer {...props} mode="full" />;
}

// ---------- Shared flame dynamics: eased size, flare boost, ignition ----------

function easeOutBack(x: number) {
  const c1 = 1.7;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

function useFlameDynamics(props: FlameProps) {
  const live = useRef(props);
  live.current = props;
  return () => {
    let scaleNow = props.ignite !== undefined ? 0 : INTENT_SCALE[props.intent] * (0.62 + 0.38 * props.heat);
    let boost = 0;
    let igniteStart: number | null = null;
    let ignited = props.ignite === undefined;
    const onFlare = (e: Event) => {
      const d = (e as CustomEvent).detail as { burner: BurnerId; strength: number };
      if (d.burner === live.current.burner) boost = Math.min(2.5, boost + d.strength);
    };
    window.addEventListener('burner-flare', onFlare);
    return {
      step(t: number, dt: number) {
        const { intent, heat, ignite } = live.current;
        let target = INTENT_SCALE[intent] * (0.62 + 0.38 * heat);
        if (!ignited) {
          if (igniteStart === null) igniteStart = t + (ignite ?? 0);
          const k = (t - igniteStart) / 0.9;
          if (k < 0) target = 0;
          else if (k < 1) {
            if (boost < 0.01 && k < 0.1) boost = 1.6;
            target *= easeOutBack(k);
            scaleNow = target;
          } else ignited = true;
        } else {
          scaleNow += (target - scaleNow) * Math.min(1, dt * 3);
        }
        boost = Math.max(0, boost - dt * 0.8);
        return { scale: scaleNow, boost, igniting: !ignited };
      },
      dispose() {
        window.removeEventListener('burner-flare', onFlare);
      },
    };
  };
}

// ---------- WebGL shader layer ----------

const shaderFor = new WeakMap<HTMLCanvasElement, ShaderFlame>();

function ShaderLayer(props: FlameProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const makeDynamics = useFlameDynamics(props);
  const brightness = useRef(props.brightness);
  brightness.current = props.brightness;

  useEffect(() => {
    const canvas = ref.current!;
    let flame: ShaderFlame;
    try {
      // Reuse the context if this canvas already has one (React may remount effects).
      flame = shaderFor.get(canvas) ?? new ShaderFlame(canvas, PALETTES[props.burner]);
      shaderFor.set(canvas, flame);
    } catch {
      setQuality('canvas');
      return;
    }
    const dyn = makeDynamics();
    const resize = () => flame.resize(canvas.clientWidth, canvas.clientHeight);
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const onLost = (e: Event) => {
      e.preventDefault();
      setQuality('canvas');
    };
    canvas.addEventListener('webglcontextlost', onLost);
    const stop = addTick((t, dt) => {
      const s = dyn.step(t, dt);
      const flicker = 0.94 + 0.06 * Math.sin(t * 9.1) * Math.sin(t * 3.7);
      flame.render(t, { scale: s.scale, brightness: brightness.current * flicker, boost: s.boost });
    });
    return () => {
      stop();
      ro.disconnect();
      dyn.dispose();
      canvas.removeEventListener('webglcontextlost', onLost);
      // Free the GPU context only once the canvas has really left the page. Browsers cap live
      // WebGL contexts (about 16), so leaking them across navigation would kill older flames.
      setTimeout(() => {
        if (!canvas.isConnected) {
          flame.dispose();
          shaderFor.delete(canvas);
        }
      }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.burner]);

  return <canvas ref={ref} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} aria-hidden />;
}

// ---------- 2D particle layer (full fire, or sparks over the shader) ----------

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

function ParticleLayer(props: FlameProps & { mode: 'full' | 'sparks' }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const makeDynamics = useFlameDynamics(props);
  const live = useRef(props);
  live.current = props;

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    const sprites = spritesFor(props.burner);
    const [mr, mg, mb] = hexToRgb(PALETTES[props.burner].mid);
    const sparksOnly = props.mode === 'sparks';
    const particles: Particle[] = [];
    const seed = Math.random() * 100;
    const dyn = makeDynamics();
    let w = 0;
    let h = 0;
    let spawnDebt = 0;

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

    const render: Tick = (t, dt) => {
      if (!w || !h) return;
      const { heat, brightness } = live.current;
      const { scale: s0, boost } = dyn.step(t, dt);
      const s = s0 * (1 + boost * 0.35);
      const flicker = 0.92 + 0.08 * Math.sin(t * 7.3 + seed) * Math.sin(t * 2.9 + seed * 2);
      const unit = Math.min(w, h * 0.8);
      const cx = w / 2;
      const baseY = h * 0.93;

      const rate = sparksOnly
        ? (6 + 14 * heat) * brightness * (s0 > 0.05 ? 1 : 0) + boost * 70
        : 95 * (0.55 + 0.45 * heat) * (0.6 + 0.4 * brightness) * (1 + boost);
      spawnDebt += rate * dt;
      const max = sparksOnly ? 120 : 190;
      while (spawnDebt >= 1 && particles.length < max) {
        spawnDebt -= 1;
        const spread = (Math.random() + Math.random() + Math.random() - 1.5) * unit * (sparksOnly ? 0.1 : 0.13) * s;
        const ember = sparksOnly || Math.random() < 0.035 + boost * 0.12;
        particles.push({
          x: cx + spread,
          y: baseY - (sparksOnly ? unit * 0.15 * s * Math.random() : Math.random() * 4),
          vx: (Math.random() - 0.5) * (sparksOnly ? 60 + boost * 120 : 12),
          vy: -(unit * (1.05 + Math.random() * 0.6) * s) * (ember ? 1.25 : 1) * (1 + boost * 0.4),
          age: 0,
          life: ember ? 0.9 + Math.random() * 1.1 : 0.6 + Math.random() * 0.4,
          r0: ember ? 0.8 + Math.random() * 1.6 : unit * 0.2 * s * (0.75 + Math.random() * 0.5),
          seed: Math.random() * 1000,
          ember,
        });
      }
      if (spawnDebt > 1) spawnDebt = 1;

      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, w, h);

      if (!sparksOnly) {
        const halo = ctx.createRadialGradient(cx, baseY - unit * 0.3 * s, 0, cx, baseY - unit * 0.3 * s, unit * 0.75 * s + 1);
        halo.addColorStop(0, `rgba(${mr},${mg},${mb},${0.22 * brightness * flicker})`);
        halo.addColorStop(1, `rgba(${mr},${mg},${mb},0)`);
        ctx.fillStyle = halo;
        ctx.fillRect(0, 0, w, h);
      }

      ctx.globalCompositeOperation = 'lighter';
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.age += dt;
        const k = p.age / p.life;
        if (k >= 1) {
          particles.splice(i, 1);
          continue;
        }
        const pull = p.ember ? 0.15 : 2 + k * 5;
        p.vx += (cx - p.x) * pull * dt + Math.sin(t * 3 + p.seed) * (p.ember ? 40 : 18) * dt;
        p.vx *= 1 - dt * 1.2;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy *= 1 - dt * (p.ember ? 0.9 : 0.4);
        if (p.ember) {
          const tw = 0.6 + 0.4 * Math.sin(t * 20 + p.seed);
          const alpha = Math.pow(1 - k, 1.2) * brightness * tw;
          const sprite = sprites[Math.min(SPRITE_STEPS - 1, Math.floor(k * 0.55 * SPRITE_STEPS))];
          const r = p.r0 * 4;
          ctx.globalAlpha = alpha * 0.9;
          ctx.drawImage(sprite, p.x - r, p.y - r, r * 2, r * 2);
          ctx.globalAlpha = alpha;
          ctx.fillStyle = '#fff';
          ctx.fillRect(p.x - p.r0 * 0.5, p.y - p.r0 * 0.5, p.r0, p.r0);
        } else {
          const r = p.r0 * Math.pow(1 - k, 0.9) + 1;
          const alpha = Math.min(1, k * 8) * Math.pow(1 - k, 1.1) * brightness * flicker * 0.5;
          ctx.globalAlpha = alpha;
          ctx.drawImage(sprites[Math.min(SPRITE_STEPS - 1, Math.floor(k * SPRITE_STEPS))], p.x - r, p.y - r, r * 2, r * 2);
        }
      }
      ctx.globalAlpha = 1;
    };

    const stop = addTick(render);
    return () => {
      stop();
      ro.disconnect();
      dyn.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.burner, props.mode]);

  return (
    <canvas
      ref={ref}
      className={props.mode === 'full' ? props.className : undefined}
      style={{ position: props.mode === 'sparks' ? 'absolute' : 'relative', inset: 0, width: '100%', height: '100%', display: 'block' }}
      aria-hidden
    />
  );
}

// ---------- Static CSS flame ----------

function StaticFlame({ burner, intent, heat, brightness, className, animate }: FlameProps & { animate: boolean }) {
  const p = PALETTES[burner];
  const s = INTENT_SCALE[intent] * (0.62 + 0.38 * heat);
  return (
    <div className={className} style={{ width: '100%', height: '100%', position: 'relative', opacity: brightness }} aria-hidden>
      <div
        style={{
          position: 'absolute',
          left: '50%',
          bottom: '8%',
          width: `${70 * s}%`,
          height: `${40 * s}%`,
          transform: 'translateX(-50%)',
          background: `radial-gradient(ellipse at 50% 100%, ${p.mid}66, transparent 70%)`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: '50%',
          bottom: '8%',
          width: `${46 * s}%`,
          height: `${80 * s}%`,
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
