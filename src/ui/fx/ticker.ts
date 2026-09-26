// One requestAnimationFrame loop for every effect on screen, plus a performance governor
// that steps quality down (webgl -> canvas -> static) if frames get slow.
import { useEffect, useState } from 'react';

export type Tick = (t: number, dt: number) => void;
export type Quality = 'webgl' | 'canvas' | 'static';

const ticks = new Set<Tick>();
let rafId = 0;
let lastT = 0;
let frameSum = 0;
let frameCount = 0;

let quality: Quality = 'webgl';
const qualityListeners = new Set<(q: Quality) => void>();

export function setQuality(q: Quality) {
  quality = q;
  qualityListeners.forEach((l) => l(q));
}

export function getQuality(): Quality {
  return quality;
}

function govern(dt: number) {
  if (dt > 100) return; // tab was hidden; ignore
  frameSum += dt;
  frameCount++;
  if (frameCount < 150) return;
  const avg = frameSum / frameCount;
  frameSum = 0;
  frameCount = 0;
  if (avg > 26) {
    if (quality === 'webgl') setQuality('canvas');
    else if (quality === 'canvas') setQuality('static');
  }
}

function loop(t: number) {
  const dt = lastT ? t - lastT : 16;
  lastT = t;
  govern(dt);
  const step = Math.min(dt, 50) / 1000;
  ticks.forEach((fn) => fn(t / 1000, step));
  rafId = ticks.size ? requestAnimationFrame(loop) : 0;
}

export function addTick(fn: Tick): () => void {
  ticks.add(fn);
  if (!rafId) {
    lastT = 0;
    rafId = requestAnimationFrame(loop);
  }
  return () => {
    ticks.delete(fn);
  };
}

export function useQuality(): Quality {
  const [q, setQ] = useState(quality);
  useEffect(() => {
    qualityListeners.add(setQ);
    return () => {
      qualityListeners.delete(setQ);
    };
  }, []);
  return q;
}

// Dev/test hook: advance every effect by N seconds without waiting on requestAnimationFrame.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  let simT = 1000;
  (window as unknown as Record<string, unknown>).__advanceFlames = (seconds: number) => {
    for (let i = 0; i < seconds * 60; i++) {
      simT += 1 / 60;
      ticks.forEach((fn) => fn(simT, 1 / 60));
    }
  };
}
