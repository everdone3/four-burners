import { describe, expect, it } from 'vitest';
import { awayPeriods, awayReason, crunchSuggestion, isPrivateAddress, isPublicFeedHost, normalizeFeedUrl, parseIcs, type CalEvent } from '../calendar';
import type { CrunchPeriod } from '../types';

const W = { from: '2026-09-01', to: '2026-12-31' };
const cal = (...events: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Me', ...events, 'END:VCALENDAR'].join('\r\n');
const vevent = (...props: string[]) => ['BEGIN:VEVENT', ...props, 'END:VEVENT'].join('\r\n');
const ev = (summary: string, start: string, end = start, over: Partial<CalEvent> = {}): CalEvent => ({ summary, start, end, allDay: true, free: false, ...over });

describe('private addresses', () => {
  it('refuses private, loopback, link-local and similar, allows public', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', 'garbage']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '17.253.144.10', '172.32.0.1', '2607:f8b0:4005::200e']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe('feed address', () => {
  it('accepts https and webcal, refuses anything else', () => {
    expect(normalizeFeedUrl(' webcal://p57-caldav.icloud.com/published/2/abc ')).toBe('https://p57-caldav.icloud.com/published/2/abc');
    expect(normalizeFeedUrl('https://calendar.google.com/calendar/ical/x%40gmail.com/private-abc/basic.ics')).toMatch(/^https:\/\/calendar\.google\.com\//);
    for (const bad of ['http://example.com/cal.ics', 'ftp://x.com/a', 'not a url', '', 42, 'https://user:pw@x.com/a.ics', `https://x.com/${'a'.repeat(2100)}`]) {
      expect(normalizeFeedUrl(bad)).toBeNull();
    }
  });

  it('lets the server reach public names only', () => {
    expect(isPublicFeedHost('outlook.office365.com')).toBe(true);
    expect(isPublicFeedHost('p57-caldav.icloud.com')).toBe(true);
    for (const bad of ['localhost', '127.0.0.1', '10.0.0.5', '169.254.169.254', '[::1]', '::1', 'router.local', 'db.internal', 'intranet', 'kong.supabase.internal', 'x.corp']) {
      expect(isPublicFeedHost(bad), bad).toBe(false);
    }
  });
});

describe('parseIcs', () => {
  it('reads all-day, timed, UTC and zoned events, with all-day ends exclusive', () => {
    const text = cal(
      vevent('UID:1', 'SUMMARY:Trip to Denver', 'DTSTART;VALUE=DATE:20261005', 'DTEND;VALUE=DATE:20261009'),
      vevent('UID:2', 'SUMMARY:Flight UA 1234 ORD → DEN', 'DTSTART:20261005T130000Z', 'DTEND:20261005T160000Z'),
      vevent('UID:3', 'SUMMARY:Dinner', 'DTSTART;TZID=America/Denver:20261006T190000', 'DTEND;TZID=America/Denver:20261006T210000'),
      vevent('UID:4', 'SUMMARY:Late show', 'DTSTART:20261007T220000', 'DTEND:20261008T000000'),
    );
    const p = parseIcs(text, W, -300);
    expect(p.name).toBe('Me');
    expect(p.events).toEqual([
      { summary: 'Trip to Denver', start: '2026-10-05', end: '2026-10-08', allDay: true, free: false },
      { summary: 'Flight UA 1234 ORD → DEN', start: '2026-10-05', end: '2026-10-05', allDay: false, free: false, hours: 3 },
      { summary: 'Dinner', start: '2026-10-06', end: '2026-10-06', allDay: false, free: false, hours: 2 },
      { summary: 'Late show', start: '2026-10-07', end: '2026-10-07', allDay: false, free: false, hours: 2 },
    ]);
  });

  it('shifts UTC times by the device offset and day boundary', () => {
    // 02:00 UTC on Oct 6 is still Oct 5 in Chicago.
    const p = parseIcs(cal(vevent('SUMMARY:Red-eye', 'DTSTART:20261006T020000Z', 'DTEND:20261006T040000Z')), W, -300);
    expect(p.events[0].start).toBe('2026-10-05');
    // 1:30 AM Chicago time on Oct 7 belongs to Oct 6 with a 3 AM day boundary.
    const late = parseIcs(cal(vevent('SUMMARY:Flight home', 'DTSTART:20261007T063000Z', 'DTEND:20261007T090000Z')), W, -300, 3);
    expect(late.events[0].start).toBe('2026-10-06');
  });

  it('reads Outlook all-day events written as midnight-to-midnight times', () => {
    const p = parseIcs(
      cal(
        vevent('SUMMARY:Denver', 'X-MICROSOFT-CDO-ALLDAYEVENT:TRUE', 'DTSTART;TZID=Central Standard Time:20261005T000000', 'DTEND;TZID=Central Standard Time:20261008T000000'),
        vevent('SUMMARY:Blocked', 'DTSTART:20261012T000000', 'DTEND:20261014T000000'),
      ),
      W,
    );
    expect(p.events.map((e) => [e.summary, e.start, e.end, e.allDay])).toEqual([
      ['Denver', '2026-10-05', '2026-10-07', true],
      ['Blocked', '2026-10-12', '2026-10-13', true],
    ]);
  });

  it('unfolds long lines, unescapes text, reads quoted params, ignores alarms', () => {
    const text = cal(
      [
        'BEGIN:VEVENT',
        'SUMMARY:Conference\\, Day 1\\; keynote',
        ' and workshops',
        'LOCATION;ALTREP="https://maps.example.com/x:y":Hotel\\nDowntown',
        'DTSTART;VALUE=DATE:20261010',
        'BEGIN:VALARM',
        'SUMMARY:Alarm text',
        'TRIGGER:-PT15M',
        'END:VALARM',
        'END:VEVENT',
      ].join('\n'),
    );
    expect(parseIcs(text, W).events[0]).toEqual({
      summary: 'Conference, Day 1; keynoteand workshops',
      location: 'Hotel Downtown',
      start: '2026-10-10',
      end: '2026-10-10',
      allDay: true,
      free: false,
    });
  });

  it('skips cancelled and recurring events, and anything outside the window', () => {
    const p = parseIcs(
      cal(
        vevent('SUMMARY:Cancelled trip', 'STATUS:CANCELLED', 'DTSTART;VALUE=DATE:20261005'),
        vevent('SUMMARY:Mom birthday', 'RRULE:FREQ=YEARLY', 'DTSTART;VALUE=DATE:19700310'),
        vevent('SUMMARY:Old trip', 'DTSTART;VALUE=DATE:20250101', 'DTEND;VALUE=DATE:20250105'),
        vevent('SUMMARY:No start'),
        vevent('SUMMARY:Garbage', 'DTSTART:yesterday'),
      ),
      W,
    );
    expect(p.events).toEqual([]);
    expect(p.skippedRecurring).toBe(1);
  });

  it('handles DURATION, transparent events, and a missing end', () => {
    const p = parseIcs(
      cal(
        vevent('SUMMARY:Offsite', 'DTSTART;VALUE=DATE:20261012', 'DURATION:P3D'),
        vevent('SUMMARY:Holiday', 'TRANSP:TRANSPARENT', 'DTSTART;VALUE=DATE:20261013'),
        vevent('SUMMARY:Call', 'DTSTART:20261014T150000', 'DURATION:PT1H30M'),
      ),
      W,
    );
    expect(p.events.map((e) => [e.summary, e.start, e.end, e.free, e.hours])).toEqual([
      ['Offsite', '2026-10-12', '2026-10-14', false, undefined],
      ['Holiday', '2026-10-13', '2026-10-13', true, undefined],
      ['Call', '2026-10-14', '2026-10-14', false, 1.5],
    ]);
  });

  it('copes with LF line endings, lowercase markers and junk', () => {
    expect(parseIcs('garbage\nmore garbage', W)).toEqual({ events: [], skippedRecurring: 0 });
    const lf = 'BEGIN:VCALENDAR\nbegin:vevent\nsummary:PTO\ndtstart;value=date:20261020\nend:vevent\nEND:VCALENDAR';
    expect(parseIcs(lf, W).events).toHaveLength(1);
  });
});

describe('what counts as away', () => {
  it('travel words on all-day, multi-day or long events', () => {
    for (const s of ['Trip to NYC', 'Vacation', 'PTO', 'OOO', 'Out of office', 'Sales offsite', 'Stay at Airbnb', 'On leave', 'Conference']) {
      expect(awayReason(ev(s, '2026-10-01')), s).toBe('keyword');
    }
    expect(awayReason(ev('Conference', '2026-10-01', '2026-10-01', { allDay: false, hours: 8 }))).toBe('keyword');
    expect(awayReason(ev('Offsite', '2026-10-01', '2026-10-01', { allDay: false, hours: 1 }))).toBeNull();
  });

  it('flights count at any length', () => {
    for (const s of ['Flight to Boston', 'Flight UA 1234', 'ORD → DEN', 'SFO->JFK', '✈ Denver']) {
      expect(awayReason(ev(s, '2026-10-01', '2026-10-01', { allDay: false, hours: 2 })), s).toBe('flight');
    }
  });

  it('ordinary work events never count, whatever words they use', () => {
    for (const s of [
      'Conference call with Bob',
      'Leave by 5',
      'Away game vs Lakers',
      'Book flight',
      'Travel expense report',
      'Offsite planning',
      'Team retreat planning',
      'TRIP report',
      'CEO - CFO sync',
      'API-SDK review',
      'Q4 BA 2026 review',
      'Trip debrief',
    ]) {
      expect(awayReason(ev(s, '2026-10-01', '2026-10-01', { allDay: false, hours: 1 })), s).toBeNull();
    }
    expect(awayReason(ev('Book flight', '2026-10-01'))).toBeNull();
  });

  it('several busy all-day days count; birthdays, reminders and free days never do', () => {
    expect(awayReason(ev('Denver', '2026-10-01', '2026-10-03'))).toBe('multi_day');
    expect(awayReason(ev('Denver', '2026-10-01'))).toBeNull();
    expect(awayReason(ev('School break', '2026-10-01', '2026-10-05', { free: true }))).toBeNull();
    expect(awayReason(ev("Sam's birthday trip", '2026-10-01', '2026-10-03'))).toBeNull();
    expect(awayReason(ev('Project deadline', '2026-10-01', '2026-10-03'))).toBeNull();
    expect(awayReason(ev('Team standup', '2026-10-01', '2026-10-01', { allDay: false }))).toBeNull();
  });

  it('merges a trip with its flights and back-to-back days, naming it after the best event', () => {
    const periods = awayPeriods([
      ev('Flight UA 1 ORD → DEN', '2026-10-05', '2026-10-05', { allDay: false }),
      ev('Denver trip', '2026-10-05', '2026-10-08'),
      ev('Flight home', '2026-10-09', '2026-10-09', { allDay: false }),
      ev('Lunch', '2026-10-07', '2026-10-07', { allDay: false }),
      ev('PTO', '2026-10-20'),
    ]);
    expect(periods).toEqual([
      { start: '2026-10-05', end: '2026-10-09', label: 'Denver trip', key: '2026-10-05_2026-10-09' },
      { start: '2026-10-20', end: '2026-10-20', label: 'PTO', key: '2026-10-20_2026-10-20' },
    ]);
  });
});

describe('the suggestion', () => {
  const periods = awayPeriods([ev('Denver trip', '2026-10-05', '2026-10-08')]);
  const crunch = (start: string, end?: string): CrunchPeriod => ({ id: 'c', start, end, createdAt: 'x', updatedAt: 'x' });

  it('appears during a trip, not before or after', () => {
    expect(crunchSuggestion(periods, '2026-10-04', [], [])).toBeNull();
    expect(crunchSuggestion(periods, '2026-10-05', [], [])).toEqual({ period: periods[0], start: '2026-10-05', end: '2026-10-08' });
    expect(crunchSuggestion(periods, '2026-10-08', [], [])?.start).toBe('2026-10-05');
    expect(crunchSuggestion(periods, '2026-10-09', [], [])).toBeNull();
  });

  it('stays quiet when Travel/Crunch is already on, or you said not this time', () => {
    expect(crunchSuggestion(periods, '2026-10-06', [crunch('2026-10-06')], [])).toBeNull();
    expect(crunchSuggestion(periods, '2026-10-06', [crunch('2026-09-01', '2026-09-05')], [])).not.toBeNull();
    expect(crunchSuggestion(periods, '2026-10-06', [], ['2026-10-05_2026-10-08'])).toBeNull();
  });

  it('a dismissed trip stays dismissed when its dates shift a little', () => {
    const shifted = awayPeriods([ev('Denver trip', '2026-10-04', '2026-10-09')]);
    expect(crunchSuggestion(shifted, '2026-10-06', [], ['2026-10-05_2026-10-08'])).toBeNull();
    expect(crunchSuggestion(shifted, '2026-10-06', [], ['2026-09-01_2026-09-03', 'garbage'])).not.toBeNull();
  });

  it('turning Travel/Crunch off mid-trip is a decision too: the card does not come back for that trip', () => {
    // Started the 5th, ended on the 6th: the 7th is still in the trip.
    expect(crunchSuggestion(periods, '2026-10-07', [crunch('2026-10-05', '2026-10-06')], [])).toBeNull();
    // Started and ended the same day (stored as deleted).
    expect(crunchSuggestion(periods, '2026-10-07', [{ ...crunch('2026-10-06'), deleted: true }], [])).toBeNull();
    // A deleted one from long before does not count.
    expect(crunchSuggestion(periods, '2026-10-07', [{ ...crunch('2026-09-01'), deleted: true }], [])).not.toBeNull();
  });

  it('backdates at most a week into a long trip', () => {
    const long = awayPeriods([ev('Sabbatical', '2026-09-01', '2026-10-31')]);
    expect(crunchSuggestion(long, '2026-10-15', [], [])).toMatchObject({ start: '2026-10-08', end: '2026-10-31' });
  });
});
