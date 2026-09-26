import type { BurnerId, Intent } from '@/domain';

export interface FlamePalette {
  /** Hot core, body, outer edge. */
  core: string;
  mid: string;
  outer: string;
  /** Accent for text and UI on this burner. */
  accent: string;
}

export const PALETTES: Record<BurnerId, FlamePalette> = {
  family: { core: '#fff4d6', mid: '#ffae3b', outer: '#ff4d12', accent: '#ffb44d' },
  friends: { core: '#ffe8ef', mid: '#ff7aa2', outer: '#d0175f', accent: '#ff8cb0' },
  health: { core: '#e8fbff', mid: '#5ad1ff', outer: '#1d4ed8', accent: '#6fd6ff' },
  work: { core: '#f4ecff', mid: '#b58cff', outer: '#6421d6', accent: '#c4a3ff' },
};

/** Flame size multiplier per intent. */
export const INTENT_SCALE: Record<Intent, number> = { high: 1, steady: 0.8, low: 0.6 };
