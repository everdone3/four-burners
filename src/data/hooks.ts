// Reactive reads for the UI. Recompute whenever IndexedDB changes.
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { computeDashboard, quarterOf, today as todayFor, type Dashboard, type Goal, type LogEntry, type Person, type Quarter, type Settings, type Touchpoint } from '@/domain';
import { db } from './db';
import { ensureCurrentQuarter, getSettings } from './repo';

/** Today's lived date, refreshed each minute and when the app returns to the foreground. */
export function useToday(settings: Settings | undefined): string | undefined {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => setNow(new Date());
    const id = setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
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
  data: {
    goals: Goal[];
    logs: LogEntry[];
    people: Person[];
    touchpoints: Touchpoint[];
  };
}

export function useAppState(): AppState | undefined {
  const settings = useSettings();
  const today = useToday(settings);
  const [quarterReady, setQuarterReady] = useState(false);
  useEffect(() => {
    if (!today) return;
    ensureCurrentQuarter().then(() => setQuarterReady(true));
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
    const [goals, logs, energy, people, touchpoints, crunch] = await Promise.all([
      db.goals.where('quarterId').equals(span.id).toArray(),
      db.logs.toArray(),
      db.energy.toArray(),
      db.people.toArray(),
      db.touchpoints.toArray(),
      db.crunch.toArray(),
    ]);
    const dashboard = computeDashboard({
      quarter,
      quarterStart: span.start,
      goals,
      logs,
      energy,
      people,
      touchpoints,
      crunch,
      settings,
      today,
    });
    return {
      settings,
      today,
      quarter,
      dashboard,
      data: { goals: goals.filter((g) => !g.deleted), logs: logs.filter((l) => !l.deleted), people: people.filter((p) => !p.deleted), touchpoints },
    };
  }, [settings, today, quarterReady]);
}
