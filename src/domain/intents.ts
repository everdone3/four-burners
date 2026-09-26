// Burner intents and the High cap.
import { MAX_HIGH_BURNERS } from './config';
import { BURNERS, type BurnerId, type Instant, type Intent, type LocalDate, type Quarter } from './types';

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export function countHigh(intents: Record<BurnerId, Intent>): number {
  return BURNERS.filter((b) => intents[b] === 'high').length;
}

/** Whether a burner may be set to the given intent without breaking the High cap. */
export function canSetIntent(
  intents: Record<BurnerId, Intent>,
  burner: BurnerId,
  next: Intent,
): Result<Record<BurnerId, Intent>> {
  const updated = { ...intents, [burner]: next };
  if (next === 'high' && intents[burner] !== 'high' && countHigh(updated) > MAX_HIGH_BURNERS) {
    return {
      ok: false,
      error: `Only ${MAX_HIGH_BURNERS} burners can run High. Lower another burner first.`,
    };
  }
  return { ok: true, value: updated };
}

export function validateIntents(intents: Record<BurnerId, Intent>): Result<Record<BurnerId, Intent>> {
  if (countHigh(intents) > MAX_HIGH_BURNERS) {
    return { ok: false, error: `Only ${MAX_HIGH_BURNERS} burners can run High.` };
  }
  return { ok: true, value: intents };
}

export const DEFAULT_INTENTS: Record<BurnerId, Intent> = {
  family: 'steady',
  friends: 'steady',
  health: 'steady',
  work: 'steady',
};

/**
 * Change a burner's intent mid-quarter. A one-line reason is required and recorded.
 */
export function changeIntent(
  quarter: Quarter,
  burner: BurnerId,
  to: Intent,
  reason: string,
  at: Instant,
  localDate: LocalDate,
): Result<Quarter> {
  const from = quarter.intents[burner];
  if (from === to) return { ok: false, error: 'Intent is already set to that.' };
  const trimmed = reason.trim();
  if (!trimmed) return { ok: false, error: 'Add a short reason for the change.' };
  const check = canSetIntent(quarter.intents, burner, to);
  if (!check.ok) return check;
  return {
    ok: true,
    value: {
      ...quarter,
      intents: check.value,
      intentHistory: [...quarter.intentHistory, { burner, from, to, reason: trimmed, at, localDate }],
      updatedAt: at,
    },
  };
}

/** The intent that was in effect for a burner on a given day, reconstructed from history. */
export function intentOn(quarter: Quarter, burner: BurnerId, date: LocalDate): Intent {
  const changes = quarter.intentHistory.filter((c) => c.burner === burner);
  // Walk back from current intent, undoing changes made after `date`.
  let intent = quarter.intents[burner];
  for (let i = changes.length - 1; i >= 0; i--) {
    if (changes[i].localDate > date) intent = changes[i].from;
    else break;
  }
  return intent;
}
