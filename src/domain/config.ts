// Tunable scoring knobs. Edit here; everything else reads from this file.
import type { Intent } from './types';

/** How much each burner's goals count toward the Progress score. */
export const INTENT_WEIGHTS: Record<Intent, number> = {
  high: 3,
  steady: 2,
  low: 1,
};

/**
 * Fraction of the straight-line pace expected for a burner at each intent.
 * A Low burner only needs to be at 60% of linear pace to count as on track.
 */
export const INTENT_EXPECTATION: Record<Intent, number> = {
  high: 1.0,
  steady: 0.85,
  low: 0.6,
};

/** Maximum number of burners that can be on High at once. */
export const MAX_HIGH_BURNERS = 2;

/** Goals per burner per quarter. */
export const GOAL_LIMITS = { suggested: 3, max: 4 } as const;

/** Pace thresholds for goal status. Pace = actual / intent-adjusted expected. */
export const PACE_THRESHOLDS = { onTrack: 0.9, behind: 0.6 } as const;

/** A new goal is not judged until it has been live this many days. */
export const NEW_GOAL_GRACE_DAYS = 2;

/** Days with activity expected in a rolling 7 days, per intent, for a full-heat flame. */
export const RECENT_ACTIVE_DAYS: Record<Intent, number> = {
  high: 4,
  steady: 2.5,
  low: 1,
};

/** Days of silence before a burner starts to dim, per intent. */
export const DIM_GRACE_DAYS: Record<Intent, number> = {
  high: 3,
  steady: 5,
  low: 10,
};
/** Days over the grace window it takes to fade to the minimum brightness. */
export const DIM_FADE_DAYS = 21;
/** Burners never dim below this. Neglect is a nudge, not a punishment. */
export const DIM_FLOOR = 0.4;

/** A burner with nothing set up yet shows a steady pilot light at this brightness. */
export const PILOT_BRIGHTNESS = 0.75;
/** Flames never shrink below this heat, so every burner stays visibly lit. */
export const PILOT_HEAT = 0.15;

/** During Travel/Crunch days, expected pace is multiplied by this. */
export const CRUNCH_EXPECTATION = 0.25;

/** Rolling window for the Consistency score. */
export const CONSISTENCY_WINDOW_DAYS = 28;

// ---------- Notifications (src/domain/notify.ts) ----------

/** Smart nudges go out at most once a day, somewhere in this local time window (24h clock). */
export const NUDGE_WINDOW = { start: '11:00', end: '19:00' } as const;

/** A burner only nudges when its pace (already intent-adjusted) is below this. Low barely ever does. */
export const NUDGE_PACE: Record<Intent, number> = {
  high: 0.75,
  steady: 0.6,
  low: 0.35,
};

/** ...and it has also been quiet (no activity) for at least this many days. */
export const NUDGE_QUIET_DAYS: Record<Intent, number> = {
  high: 2,
  steady: 4,
  low: 14,
};

/** Days before the same burner can nudge again. */
export const NUDGE_COOLDOWN_DAYS: Record<Intent, number> = {
  high: 3,
  steady: 5,
  low: 14,
};

/** A person nudges once days since contact reach this multiple of their cadence (by their burner's intent). */
export const PERSON_NUDGE_RATIO: Record<Intent, number> = {
  high: 1.35,
  steady: 1.35,
  low: 2,
};

/** A reminder that could not go out on time (quiet hours, server asleep) is dropped after this many minutes. */
export const REMINDER_LATE_LIMIT_MIN = 180;
