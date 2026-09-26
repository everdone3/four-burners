// Synthesized sound effects (no audio files). Browsers only allow audio after a tap,
// so the context is created lazily on the first user gesture.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let enabled = true;
let noiseBuf: AudioBuffer | null = null;

export function setSoundEnabled(on: boolean) {
  enabled = on;
}

function ac(): AudioContext | null {
  if (!enabled) return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.55;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp).connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function noise(c: AudioContext): AudioBuffer {
  if (noiseBuf) return noiseBuf;
  const len = c.sampleRate * 2;
  noiseBuf = c.createBuffer(1, len, c.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

function noiseBurst(c: AudioContext, at: number, dur: number, type: BiquadFilterType, f0: number, f1: number, gain: number) {
  const src = c.createBufferSource();
  src.buffer = noise(c);
  const filt = c.createBiquadFilter();
  filt.type = type;
  filt.frequency.setValueAtTime(f0, at);
  filt.frequency.exponentialRampToValueAtTime(f1, at + dur);
  filt.Q.value = 0.8;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + dur * 0.25);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  src.connect(filt).connect(g).connect(master!);
  src.start(at, Math.random());
  src.stop(at + dur + 0.05);
}

function tone(c: AudioContext, at: number, freq: number, dur: number, gain: number, type: OscillatorType = 'sine') {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(master!);
  o.start(at);
  o.stop(at + dur + 0.05);
}

/** Fire crackle: a handful of tiny filtered pops. */
function crackle(c: AudioContext, at: number, count: number, spread: number) {
  for (let i = 0; i < count; i++) {
    const t = at + Math.random() * spread;
    noiseBurst(c, t, 0.02 + Math.random() * 0.03, 'bandpass', 1800 + Math.random() * 3000, 900, 0.35 + Math.random() * 0.3);
  }
}

export const sfx = {
  /** Small log: whoosh up and a crackle. */
  log() {
    const c = ac();
    if (!c) return;
    const t = c.currentTime;
    noiseBurst(c, t, 0.45, 'lowpass', 300, 2600, 0.5);
    crackle(c, t + 0.05, 6, 0.4);
  },
  /** Goal complete: a roar, a rising chord, and a shower of crackles. */
  complete() {
    const c = ac();
    if (!c) return;
    const t = c.currentTime;
    noiseBurst(c, t, 1.2, 'lowpass', 200, 4000, 0.8);
    tone(c, t, 55, 0.9, 0.5, 'sine');
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      tone(c, t + 0.12 + i * 0.09, f, 1.4, 0.16, 'triangle');
      tone(c, t + 0.12 + i * 0.09, f * 2, 0.9, 0.04, 'sine');
    });
    crackle(c, t + 0.1, 22, 1.4);
  },
  /** Tap feedback for buttons. */
  tick() {
    const c = ac();
    if (!c) return;
    noiseBurst(c, c.currentTime, 0.04, 'bandpass', 3000, 1500, 0.25);
  },
  /** Opening a burner: a soft whoosh. */
  whoosh() {
    const c = ac();
    if (!c) return;
    noiseBurst(c, c.currentTime, 0.6, 'bandpass', 400, 3000, 0.35);
  },
  /** Unlock audio on the first gesture so later sounds are instant. */
  unlock() {
    ac();
  },
};
