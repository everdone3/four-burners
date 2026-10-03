import { describe, expect, it } from 'vitest';
import { awayPeriods, crunchSuggestion, type CalEvent } from '@/domain';
import { maskFeedUrl, upcomingTrips } from './CalendarSettings';
import { suggestionText } from './CalendarSuggestion';

const ev = (summary: string, start: string, end = start): CalEvent => ({ summary, start, end, allDay: true, free: false });

describe('calendar copy', () => {
  it('lists trips from today on', () => {
    const events = [ev('Old trip', '2026-09-01', '2026-09-03'), ev('Denver trip', '2026-10-05', '2026-10-08'), ev('PTO', '2026-10-20')];
    expect(upcomingTrips(events, '2026-10-06')).toEqual(['Oct 5 to Oct 8: Denver trip', 'Oct 20: PTO']);
  });

  it('never shows the whole secret link', () => {
    const masked = maskFeedUrl('https://calendar.google.com/calendar/ical/me%40gmail.com/private-0123456789abcdef/basic.ics');
    expect(masked).toBe('calendar.google.com/…ic.ics');
    expect(masked).not.toContain('private');
    expect(maskFeedUrl('nonsense')).toBe('saved link');
  });

  it('suggests in plain words, without em dashes', () => {
    const s = crunchSuggestion(awayPeriods([ev('Denver trip', '2026-10-05', '2026-10-08')]), '2026-10-06', [], [])!;
    expect(suggestionText(s, '2026-10-06')).toBe(
      'Your calendar shows "Denver trip" (Oct 5 to Oct 8). Turn on Travel/Crunch through Oct 8? Streaks pause and nudges stay quiet.',
    );
    const one = crunchSuggestion(awayPeriods([ev('PTO', '2026-10-06')]), '2026-10-06', [], [])!;
    expect(suggestionText(one, '2026-10-06')).toBe('Your calendar shows "PTO" (Oct 6). Turn on Travel/Crunch for today? Streaks pause and nudges stay quiet.');
    expect(suggestionText(one, '2026-10-06')).not.toMatch(/—/);
  });
});
