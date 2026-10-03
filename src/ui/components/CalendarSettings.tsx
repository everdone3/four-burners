// Settings > Calendar (optional): link a read-only calendar feed so the app can suggest Travel/Crunch mode
// when a trip shows up. The address stays on this device (not synced, not in backups) and is only sent,
// per check, to your own calendar Edge Function, which reads the feed and keeps nothing.
import { useState } from 'react';
import { awayPeriods, type CalEvent, type LocalDate } from '@/domain';
import { refreshCalendar, removeFeed, saveFeed, useCalendar } from '@/calendar/feed';
import { timeAgo, useSyncStatus } from '@/sync/useSync';
import { fmtDay } from '../stateInput';
import { GhostButton, inputClass } from './ui';

/** Trips found from today on, as short lines (pure, tested). */
export function upcomingTrips(events: readonly CalEvent[], today: LocalDate): string[] {
  return awayPeriods(events)
    .filter((p) => p.end >= today)
    .slice(0, 5)
    .map((p) => `${p.start === p.end ? fmtDay(p.start) : `${fmtDay(p.start)} to ${fmtDay(p.end)}`}: ${p.label}`);
}

/** Hide most of a secret address, keeping enough to recognize it. */
export function maskFeedUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}/…${u.pathname.slice(-6)}`;
  } catch {
    return 'saved link';
  }
}

const HOW_TO: { name: string; steps: string }[] = [
  { name: 'Google Calendar', steps: 'On a computer: calendar.google.com > Settings > pick the calendar > Integrate calendar > Secret address in iCal format. Copy it.' },
  {
    name: 'iCloud (Apple Calendar)',
    steps: 'Calendar app > Calendars > (i) next to the calendar > turn on Public Calendar > Share Link > Copy. Anyone with that link can read the calendar, so use one that holds only trips if you can.',
  },
  { name: 'Outlook / Microsoft 365', steps: 'Outlook on the web > Settings > Calendar > Shared calendars > Publish a calendar > Can view all details > ICS link. Work accounts often have this turned off by IT.' },
  { name: 'TripIt', steps: 'TripIt > Settings > Calendar Feeds > copy the feed link. Every trip you forward to TripIt then shows up here.' },
];

export function CalendarSettings({ today }: { today: LocalDate }) {
  const cal = useCalendar();
  const sync = useSyncStatus();
  const signedIn = sync.state !== 'signedOut' && sync.state !== 'unconfigured';
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const check = async () => {
    setChecking(true);
    try {
      await refreshCalendar({ force: true });
    } finally {
      setChecking(false);
    }
  };

  const save = async () => {
    setError(null);
    if (!(await saveFeed(input))) {
      setError('That is not a calendar link. Paste the https:// or webcal:// address from your calendar app.');
      return;
    }
    setInput('');
    await check();
  };

  const feed = cal?.feed;
  const cache = cal?.cache;
  const trips = cache ? upcomingTrips(cache.events, today) : [];

  return (
    <div>
      <p className="text-[14px] leading-relaxed text-dim">
        Optional. Link a read-only calendar and the app suggests Travel/Crunch mode when a trip or a few days away show up. It always asks; it never
        turns it on by itself. Everything works the same without it.
      </p>
      {!signedIn && (
        <div className="mt-3 rounded-2xl border border-amber-300/25 bg-amber-300/[0.07] px-3.5 py-2.5 text-[14px] text-amber-100" role="note">
          The calendar is read through your sync server. Sign in under Sync across devices first.
        </div>
      )}

      {feed ? (
        <div className="mt-4">
          <div className="text-[15px] font-semibold">{cache?.name ?? 'Calendar linked'}</div>
          <div className="text-[13px] text-faint">{maskFeedUrl(feed.url)}</div>
          <div className="mt-1.5 text-[14px] text-dim" role="status">
            {checking
              ? 'Checking...'
              : cache?.error
                ? cache.error.message
                : cache?.fetchedAt
                  ? `Checked ${timeAgo(cache.fetchedAt)}. ${trips.length ? `${trips.length} ${trips.length === 1 ? 'trip' : 'trips'} ahead.` : 'No trips in the next two months.'}`
                  : 'Not checked yet.'}
          </div>
          {trips.length > 0 && (
            <ul className="mt-2 space-y-1 text-[14px]">
              {trips.map((t) => (
                <li key={t} className="flex gap-2">
                  <span aria-hidden>✈️</span>
                  {t}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <GhostButton disabled={checking || !signedIn} onClick={check}>
              Check now
            </GhostButton>
            <GhostButton className="text-rose-300" onClick={() => confirm('Remove the calendar link from this device?') && void removeFeed()}>
              Remove
            </GhostButton>
          </div>
        </div>
      ) : (
        <div className="mt-4">
          <div className="flex gap-2">
            <input
              className={`${inputClass} min-w-0 flex-1 py-2.5`}
              type="url"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="webcal:// or https:// link"
              aria-label="Calendar link"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <GhostButton className="shrink-0" disabled={!input.trim() || checking} onClick={save}>
              {checking ? 'Checking...' : 'Link'}
            </GhostButton>
          </div>
          {error && (
            <p className="mt-2 text-[14px] font-semibold text-rose-300" role="alert">
              {error}
            </p>
          )}
        </div>
      )}

      <details className="mt-4 rounded-2xl border border-line bg-raised px-4 py-3">
        <summary className="cursor-pointer list-none text-[15px] font-semibold">Where to find the link</summary>
        <ul className="mt-2 space-y-2 text-[14px] leading-relaxed">
          {HOW_TO.map((h) => (
            <li key={h.name}>
              <span className="font-semibold">{h.name}:</span> <span className="text-dim">{h.steps}</span>
            </li>
          ))}
        </ul>
      </details>
      <p className="mt-3 text-[13px] leading-relaxed text-faint">
        The link stays on this device only (not synced, not in backups). Each check sends it to your own server function, which reads the calendar
        and keeps nothing. Your employer's IT may block calendar links; that's fine, the app works without one.
      </p>
    </div>
  );
}
