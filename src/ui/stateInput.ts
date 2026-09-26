// Build domain inputs from app state for any quarter (reviews and reels can look at past quarters).
import { quarterSpan, type DashboardInput, type HighlightsInput, type QuarterId } from '@/domain';
import type { AppState } from '@/data/hooks';

export function inputFor(state: AppState, quarterId: QuarterId, today = state.today): DashboardInput | null {
  const quarter = state.quarters.find((q) => q.id === quarterId && !q.deleted);
  if (!quarter) return null;
  return {
    quarter,
    quarterStart: quarterSpan(quarterId).start,
    goals: state.data.allGoals.filter((g) => g.quarterId === quarterId),
    logs: state.data.logs,
    energy: state.data.energy,
    people: state.data.people,
    touchpoints: state.data.touchpoints,
    crunch: state.data.crunch,
    actions: state.data.actions,
    settings: state.settings,
    today,
  };
}

export function highlightsInputFor(state: AppState, quarterId: QuarterId): HighlightsInput | null {
  const base = inputFor(state, quarterId);
  if (!base) return null;
  return { ...base, reviews: state.data.reviews };
}

export function fmtDay(d: string, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }) {
  return new Date(d + 'T12:00:00').toLocaleDateString(undefined, opts);
}

export function weekLabel(weekStart: string, weekEnd: string) {
  const a = new Date(weekStart + 'T12:00:00');
  const b = new Date(weekEnd + 'T12:00:00');
  const sameMonth = a.getMonth() === b.getMonth();
  return `${fmtDay(weekStart)} to ${sameMonth ? b.getDate() : fmtDay(weekEnd)}`;
}
