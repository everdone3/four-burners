import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import type { AppState } from '@/data/hooks';
import { saveSettings, wipeAll } from '@/data/repo';
import { hasSampleData, loadSampleData, wipeSampleData } from '@/data/sample';
import { GhostButton, useToast } from '../components/ui';
import { SensitiveTermsEditor } from '../components/Sensitive';
import { goBack, navigate } from '../router';
import { clockOffsetMs, setClockOffset, travelTo } from '@/data/clock';
import { addDays, quarterSpan, weekday } from '@/domain';

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

      <Section title="Rituals">
        <div className="flex flex-col gap-2.5">
          <GhostButton onClick={() => navigate('about')}>About me (what your coach knows)</GhostButton>
          <GhostButton onClick={() => navigate('checkin')}>Coach check-in</GhostButton>
          <GhostButton onClick={() => navigate('coach')}>Coach history</GhostButton>
          <GhostButton onClick={() => navigate('review')}>Open weekly review</GhostButton>
          <GhostButton onClick={() => navigate('archive')}>Past quarters and highlights</GhostButton>
          {state.quarter.status === 'active' && !state.pendingClose && (
            <GhostButton onClick={() => navigate(`setup/${state.quarter.id}`)}>Quarter setup: theme, intents, goals</GhostButton>
          )}
        </div>
        <div className="mt-3">
          <Row label="Weekly review day" hint="The review card appears on this day and stays for 3 more.">
            <select
              className="rounded-xl border border-line bg-raised px-3 py-2"
              value={state.settings.reviewDay}
              onChange={(e) => saveSettings({ reviewDay: Number(e.target.value) })}
            >
              {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </Row>
        </div>
      </Section>

      <Section title="Work confidentiality">
        <SensitiveTermsEditor terms={state.settings.sensitiveTerms} />
      </Section>

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

      <Section title="Effects">
        <Row label="Sound effects" hint="Crackles, whooshes, and celebration sounds.">
          <Toggle checked={state.settings.soundEffects} onChange={(v) => saveSettings({ soundEffects: v })} label="Sound effects" />
        </Row>
        <Row label="Haptics" hint="A tap you can feel when you log.">
          <Toggle checked={state.settings.haptics} onChange={(v) => saveSettings({ haptics: v })} label="Haptics" />
        </Row>
        <p className="pt-2 text-[13px] text-faint">Turn on Reduce Motion in iOS Settings for a calmer, still version of the app.</p>
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

        <div className="mt-5 border-t border-white/[0.08] pt-4">
          <div className="text-[15px] font-semibold">Time travel</div>
          <p className="mt-1 mb-3 text-[13px] text-faint">
            Pretend it is another day to preview rituals. New logs are dated to the pretend day, so reload sample data afterward.
            {clockOffsetMs() !== 0 && <span className="mt-1 block font-semibold text-amber-200">Active: today is {state.today}.</span>}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <GhostButton onClick={() => travelTo(nextDow(state.today, 6))}>Next Sunday</GhostButton>
            <GhostButton onClick={() => travelTo(addDays(quarterSpan(state.quarter.id).end, 1))}>First day of next quarter</GhostButton>
            <GhostButton className="col-span-2" disabled={clockOffsetMs() === 0} onClick={() => setClockOffset(0)}>
              Back to the real date
            </GhostButton>
          </div>
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

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="relative h-8 w-13 shrink-0 rounded-full transition"
      style={{ background: checked ? 'linear-gradient(90deg, #ffb454, #ff6a2b)' : 'rgba(255,255,255,0.15)', boxShadow: checked ? '0 0 16px -2px #ff8a3d' : undefined }}
    >
      <span className="absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-all" style={{ left: checked ? 24 : 4 }} />
    </button>
  );
}

/** The next date (after today) falling on the given weekday, 0 = Monday. */
function nextDow(today: string, dow: number): string {
  let d = addDays(today, 1);
  while (weekday(d) !== dow) d = addDays(d, 1);
  return d;
}
