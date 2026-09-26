import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import type { AppState } from '@/data/hooks';
import { saveSettings, wipeAll } from '@/data/repo';
import { hasSampleData, loadSampleData, wipeSampleData } from '@/data/sample';
import { GhostButton, useToast } from '../components/ui';
import { goBack } from '../router';

export function SettingsScreen({ state }: { state: AppState }) {
  const toast = useToast();
  const sample = useLiveQuery(hasSampleData, []);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>, msg: string) => {
    setBusy(true);
    try {
      await fn();
      toast({ message: msg });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-safe pt-safe pb-24">
      <button onClick={goBack} className="-ml-2 flex h-11 items-center gap-1 rounded-full pr-3 pl-2 text-[17px] text-dim active:bg-white/10">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
        Home
      </button>
      <h1 className="mt-2 font-display text-[34px] font-bold">Settings</h1>

      <Section title="Your day">
        <Row label="Day starts at" hint="Late-night logs before this count toward the day you were living.">
          <select
            className="rounded-xl border border-line bg-raised px-3 py-2"
            value={state.settings.dayBoundaryHour}
            onChange={(e) => saveSettings({ dayBoundaryHour: Number(e.target.value) })}
          >
            {[0, 1, 2, 3, 4, 5, 6].map((h) => (
              <option key={h} value={h}>
                {h === 0 ? 'Midnight' : `${h}:00 AM`}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Grace days per week" hint="Missed days that never break a streak.">
          <select
            className="rounded-xl border border-line bg-raised px-3 py-2"
            value={state.settings.graceDaysPerWeek}
            onChange={(e) => saveSettings({ graceDaysPerWeek: Number(e.target.value) })}
          >
            {[0, 1, 2, 3].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </Row>
      </Section>

      <Section title="Developer">
        <p className="mb-3 text-[14px] text-dim">
          Sample data fills in last quarter and this quarter so far: goals, logs, people, energy, and a travel week.
          Sample records are tagged and can be wiped without touching your own data.
        </p>
        <div className="flex flex-col gap-2.5">
          <GhostButton disabled={busy} onClick={() => run(loadSampleData, 'Sample data loaded')}>
            {sample ? 'Reload sample data' : 'Load sample data'}
          </GhostButton>
          {sample && (
            <GhostButton disabled={busy} onClick={() => run(wipeSampleData, 'Sample data wiped')}>
              Wipe sample data
            </GhostButton>
          )}
          <GhostButton
            disabled={busy}
            className="text-rose-300"
            onClick={() => {
              if (confirm('Erase everything on this device? This cannot be undone.')) void run(wipeAll, 'All data erased');
            }}
          >
            Erase all data on this device
          </GhostButton>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="mb-3 text-[13px] font-medium tracking-wide text-dim uppercase">{title}</h2>
      <div className="rounded-3xl border border-line bg-surface p-4">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div>
        <div className="text-[16px]">{label}</div>
        {hint && <div className="text-[13px] text-faint">{hint}</div>}
      </div>
      {children}
    </div>
  );
}
