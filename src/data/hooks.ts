// Reactive reads for the UI. Recompute whenever IndexedDB changes.
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import {
  activeCrunch,
  computeDashboard,
  quarterNeedingClose,
  quarterOf,
  today as todayFor,
  type CrunchPeriod,
  type Dashboard,
  type EnergyEntry,
  type Goal,
  type LogEntry,
  type Person,
  type Quarter,
  type Settings,
  type Touchpoint,
  type WeeklyAction,
  type WeeklyReview,
} from '@/domain';
import { now as clockNow } from './clock';
import { db } from './db';
import { ensureCurrentQuarter, getSettings } from './repo';

/** Today's lived date, refreshed each minute, on return to the foreground, and on dev time travel. */
export function useToday(settings: Settings | undefined): string | undefined {
  const [now, setNow] = useState(() => clockNow());
  useEffect(() => {
    const tick = () => setNow(clockNow());
    const id = setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('fb-clock', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('fb-clock', tick);
    };
  }, []);
  return settings ? todayFor(settings.dayBoundaryHour, now) : undefined;
}

export function useSettings(): Settings | undefined {
  return useLiveQuery(getSettings, []);
}

export interface AppState {
  settings: Settings;
  today: string;
  quarter: Quarter;
  dashboard: Dashboard;
  /** A past quarter still waiting for its close ritual. */
  pendingClose?: Quarter;
  /** True when the current quarter has not been set up (no guided setup and no goals). */
  needsSetup: boolean;
  crunchNow?: CrunchPeriod;
  quarters: Quarter[];
  data: {
    goals: Goal[];
    allGoals: Goal[];
    logs: LogEntry[];
    people: Person[];
    touchpoints: Touchpoint[];
    energy: EnergyEntry[];
    crunch: CrunchPeriod[];
    reviews: WeeklyReview[];
    actions: WeeklyAction[];
  };
}

export function useAppState(): AppState | undefined {
  const settings = useSettings();
  const today = useToday(settings);
  const [quarterReady, setQuarterReady] = useState<string | null>(null);
  useEffect(() => {
    if (!today) return;
    ensureCurrentQuarter().then((q) => setQuarterReady(q.id));
  }, [today]);

  return useLiveQuery(async () => {
    if (!settings || !today || !quarterReady) return undefined;
    const span = quarterOf(today);
    const quarter = await db.quarters.get(span.id);
    if (!quarter) {
      // Live queries are read-only; recreate the quarter outside this context (e.g. after a wipe).
      setTimeout(() => void ensureCurrentQuarter(), 0);
      return undefined;
    }
    const [quarters, allGoals, logs, energy, people, touchpoints, crunch, reviews, actions] = await Promise.all([
      db.quarters.toArray(),
      db.goals.toArray(),
      db.logs.toArray(),
      db.energy.toArray(),
      db.people.toArray(),
      db.touchpoints.toArray(),
      db.crunch.toArray(),
      db.reviews.toArray(),
      db.actions.toArray(),
    ]);
    const goals = allGoals.filter((g) => g.quarterId === span.id);
    const dashboard = computeDashboard({
      quarter,
      quarterStart: span.start,
      goals,
      logs,
      energy,
      people,
      touchpoints,
      crunch,
      actions,
      settings,
      today,
    });
    const liveGoals = allGoals.filter((g) => !g.deleted);
    return {
      settings,
      today,
      quarter,
      dashboard,
      pendingClose: quarterNeedingClose(quarters, liveGoals, span.id),
      needsSetup: !quarter.setupAt && !goals.some((g) => !g.deleted),
      crunchNow: activeCrunch(crunch, today),
      quarters,
      data: {
        goals: goals.filter((g) => !g.deleted),
        allGoals: liveGoals,
        logs: logs.filter((l) => !l.deleted),
        people: people.filter((p) => !p.deleted),
        touchpoints,
        energy: energy.filter((e) => !e.deleted),
        crunch: crunch.filter((c) => !c.deleted),
        reviews: reviews.filter((r) => !r.deleted),
        actions: actions.filter((a) => !a.deleted),
      },
    };
  }, [settings, today, quarterReady]);
}
