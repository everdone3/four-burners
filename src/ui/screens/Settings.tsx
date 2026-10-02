import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import type { AppState } from '@/data/hooks';
import { saveSettings, wipeAll } from '@/data/repo';
import { hasSampleData, loadSampleData, wipeSampleData } from '@/data/sample';
import { GhostButton, Row, Toggle, useToast } from '../components/ui';
import { NotificationSettings } from '../components/NotificationSettings';
import { turnOffPush } from '@/notify/push';
import { SensitiveTermsEditor } from '../components/Sensitive';
import { SyncPanel } from '../components/SyncPanel';
import { LockSettings } from '../components/LockSettings';
import { LockDiagnostics } from '../components/LockDiagnostics';
import { BackupPanel } from '../components/BackupPanel';
import { AppVersionRow } from '../components/AppVersionRow';
import { eraseDeviceSync, getSyncStatus, subscribeSyncStatus, syncNow } from '@/sync/manager';
import type { SyncStatus } from '@/sync/types';
import { goBack, navigate } from '../router';
import { clockOffsetMs, setClockOffset, travelTo } from '@/data/clock';
import { addDays, quarterSpan, weekday } from '@/domain';

/** Longest wait for the last push before erasing (a paused or unreachable server can hang much longer). */
export const ERASE_SYNC_WAIT_MS = 4_000;
/** After a push attempt ends, a moment for the pending count to catch up with the records it cleared. */
const SETTLE_MS = 400;

/** Changes made on this device that the account does not have yet (0 when not signed in). */
export function unsyncedCount(s: SyncStatus): number {
  return s.state === 'signedOut' || s.state === 'unconfigured' ? 0 : s.pending;
}

type EraseSyncApi = { getSyncStatus: typeof getSyncStatus; subscribeSyncStatus: typeof subscribeSyncStatus; syncNow: typeof syncNow };

/**
 * Before erasing: one last try to push this device's unsynced changes. Resolves with how many are still
 * unsynced, as soon as none are left, the try has ended (offline, failed), or after waitMs. A sign-out
 * during the try (the session was dead) zeroes the status count, but those changes never reached the
 * account, so the last count seen while signed in stands.
 */
export async function pushBeforeErase(api: EraseSyncApi = { getSyncStatus, subscribeSyncStatus, syncNow }, waitMs = ERASE_SYNC_WAIT_MS): Promise<number> {
  const signedIn = (s: SyncStatus) => s.state !== 'signedOut' && s.state !== 'unconfigured';
  let left = unsyncedCount(api.getSyncStatus());
  if (left === 0) return 0;
  await new Promise<void>((resolve) => {
    let finished = false;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(settle);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(done, waitMs);
    const unsubscribe = api.subscribeSyncStatus(() => {
      const s = api.getSyncStatus();
      if (!signedIn(s)) return done();
      left = s.pending;
      if (left === 0) done();
    });
    void api
      .syncNow()
      .catch(() => undefined)
      .then(() => {
        if (!finished) settle = setTimeout(done, SETTLE_MS);
      });
  });
  const s = api.getSyncStatus();
  return signedIn(s) ? s.pending : left;
}

/** The erase confirmation. Unsynced changes exist only on this device, so it says plainly they will be lost. */
export function eraseConfirmText(unsynced: number): string {
  if (unsynced > 0) {
    const what = unsynced === 1 ? '1 change on this device has' : `${unsynced} changes on this device have`;
    return `${what} not synced yet and will be lost. Erase everything on this device anyway? This cannot be undone.`;
  }
  return 'Erase everything on this device? This cannot be undone. This device also signs out of sync, and your account keeps its copy.';
}

export function SettingsScreen({ state }: { state: AppState }) {
  const toast = useToast();
  const sample = useLiveQuery(hasSampleData, []);
  const [busy, setBusy] = useState(false);
  const [syncingFirst, setSyncingFirst] = useState(false);
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

      <Section title="Notifications">
        <NotificationSettings settings={state.settings} />
      </Section>

      <Section title="Sync across devices">
        <SyncPanel />
      </Section>

      {/* The Face ID lock: an access gate for this device, not encryption (see src/lock/webauthnLocal.ts). */}
      <Section title="App lock">
        <LockSettings />
      </Section>

      <Section title="Backup">
        <BackupPanel />
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

      <Section title="App">
        <AppVersionRow />
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
            onClick={async () => {
              setBusy(true);
              setSyncingFirst(unsyncedCount(getSyncStatus()) > 0);
              let left: number;
              try {
                left = await pushBeforeErase();
              } finally {
                setSyncingFirst(false);
                setBusy(false);
              }
              // The app lock is left as it is. It is a setting of this device, not data: it lives outside
              // the database, and erasing the data is not a request to drop the protection (turning the
              // lock off is one tap in App lock above, and asks for Face ID). This screen is only reachable
              // unlocked anyway. The lock screen's "Reset this device" and the error screen's erase do
              // remove it, because there the lock is what stands between you and a fresh start.
              if (confirm(eraseConfirmText(left)))
                void run(async () => {
                  // Stop this device's notifications while still signed in (the server forgets it).
                  await turnOffPush().catch(() => undefined);
                  await eraseDeviceSync();
                  await wipeAll();
                }, 'All data erased');
            }}
          >
            {syncingFirst ? 'Syncing first...' : 'Erase all data on this device'}
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

        <div className="mt-5 border-t border-white/[0.08] pt-3">
          <LockDiagnostics />
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

/** The next date (after today) falling on the given weekday, 0 = Monday. */
function nextDow(today: string, dow: number): string {
  let d = addDays(today, 1);
  while (weekday(d) !== dow) d = addDays(d, 1);
  return d;
}
