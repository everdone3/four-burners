import type { BurnerStatus, Goal, GoalProgress, GoalStatus } from '@/domain';

export const STATUS_LABEL: Record<BurnerStatus | GoalStatus, string> = {
  done: 'Done',
  on_track: 'On track',
  behind: 'A little behind',
  slipping: 'Needs attention',
  idle: 'Waiting for fuel',
};

export const STATUS_COLOR: Record<BurnerStatus | GoalStatus, string> = {
  done: 'text-emerald-300',
  on_track: 'text-emerald-300',
  behind: 'text-amber-200',
  slipping: 'text-rose-300',
  idle: 'text-dim',
};

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** "42 of 150 miles", "9 of 26 times", "2 of 4 steps", "Not yet" */
export function progressText(goal: Goal, p: GoalProgress): string {
  switch (goal.type) {
    case 'number':
      return `${fmt(p.actual)} of ${fmt(p.required)}${goal.unit ? ` ${goal.unit}` : ''}`;
    case 'habit':
      return `${p.actual} of ${p.required} times`;
    case 'milestone':
      return `${p.actual} of ${p.required} steps`;
    case 'yesno':
      return p.complete ? 'Done' : 'Not yet';
  }
}

export function goalTypeHint(goal: Goal): string {
  switch (goal.type) {
    case 'habit':
      return `${goal.target ?? 0}x per ${goal.habitPeriod ?? 'week'}`;
    case 'number':
      return `Target ${fmt(goal.target ?? 0)}${goal.unit ? ` ${goal.unit}` : ''}`;
    case 'milestone':
      return `${goal.milestones?.length ?? 0} steps`;
    case 'yesno':
      return 'Yes or no';
  }
}
