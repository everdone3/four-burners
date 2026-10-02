import { describe, expect, it } from 'vitest';
import {
  clockIn,
  composeDaily,
  composeWeekly,
  dueNow,
  formatTime,
  inQuietHours,
  isValidTimeZone,
  livedMinutes,
  notifyPrefsOf,
  parseTime,
  pickNudge,
  pruneNudged,
  settingsOf,
  zoneOffsetMin,
  type NotifyData,
  type NotifyState,
} from '../notify';
import {
  DEFAULT_NOTIFY_PREFS,
  DEFAULT_SETTINGS,
  type BurnerId,
  type Goal,
  type Intent,
  type LogEntry,
  type NotifyPrefs,
  type Person,
  type Quarter,
  type Settings,
  type Touchpoint,
} from '../types';
import { addDays } from '../dates';

const T = '2026-07-01T12:00:00Z';
const CHI = 'America/Chicago';

/** A UTC instant from a Chicago wall-clock time in daylight time (UTC-5). */
const chicago = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00-05:00`);

function settings(notify: Partial<NotifyPrefs> = {}, over: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...over, notify: { ...DEFAULT_NOTIFY_PREFS, ...notify } };
}

describe('times and settings', () => {
  it('parses and formats HH:MM', () => {
    expect(parseTime('00:00')).toBe(0);
    expect(parseTime('20:30')).toBe(1230);
    expect(parseTime('23:59')).toBe(1439);
    for (const bad of ['24:00', '7:30', '07:60', '', null, 730, '07:30:00']) expect(parseTime(bad)).toBeNull();
    expect(formatTime(1230)).toBe('20:30');
    expect(formatTime(-30)).toBe('23:30');
    expect(formatTime(1440 + 5)).toBe('00:05');
  });

  it('fills missing or malformed prefs with defaults', () => {
    expect(notifyPrefsOf(undefined)).toEqual(DEFAULT_NOTIFY_PREFS);
    expect(notifyPrefsOf({ notify: 'nope' })).toEqual(DEFAULT_NOTIFY_PREFS);
    const p = notifyPrefsOf({ notify: { daily: { on: false, time: '99:99' }, nudges: 'yes', quiet: { start: '23:15' } } });
    expect(p.daily).toEqual({ on: false, time: DEFAULT_NOTIFY_PREFS.daily.time });
    expect(p.nudges).toBe(true);
    expect(p.quiet).toEqual({ ...DEFAULT_NOTIFY_PREFS.quiet, start: '23:15' });
  });

  it('reads stored settings defensively', () => {
    const s = settingsOf({ dayBoundaryHour: 4, reviewDay: 9, sensitiveTerms: ['Acme', 3], graceDaysPerWeek: 'x' });
    expect(s.dayBoundaryHour).toBe(4);
    expect(s.reviewDay).toBe(DEFAULT_SETTINGS.reviewDay);
    expect(s.sensitiveTerms).toEqual(['Acme']);
    expect(s.graceDaysPerWeek).toBe(DEFAULT_SETTINGS.graceDaysPerWeek);
    expect(settingsOf(null)).toEqual(DEFAULT_SETTINGS);
  });
});

describe('time zones', () => {
  it('knows the offset of a named zone at an instant, DST included', () => {
    expect(zoneOffsetMin(new Date('2026-07-01T12:00:00Z'), CHI)).toBe(-300);
    expect(zoneOffsetMin(new Date('2026-12-01T12:00:00Z'), CHI)).toBe(-360);
    expect(zoneOffsetMin(new Date('2026-07-01T12:00:00Z'), 'Asia/Tokyo')).toBe(540);
    expect(zoneOffsetMin(new Date('2026-07-01T12:00:00Z'), 'Asia/Kolkata')).toBe(330);
    expect(zoneOffsetMin(new Date('2026-07-01T12:00:00Z'), 'Not/AZone')).toBe(0);
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });

  it('applies the day boundary: 1:30 AM still belongs to yesterday', () => {
    const c = clockIn(chicago('2026-10-02', '01:30'), CHI, 3);
    expect(c).toEqual({ localDate: '2026-10-01', minutes: 90, offsetMin: -300 });
    expect(clockIn(chicago('2026-10-02', '03:00'), CHI, 3).localDate).toBe('2026-10-02');
  });

  it('the same instant is a different day and time across zones', () => {
    const at = new Date('2026-10-02T23:30:00Z');
    expect(clockIn(at, CHI, 3)).toMatchObject({ localDate: '2026-10-02', minutes: 18 * 60 + 30 });
    expect(clockIn(at, 'Asia/Tokyo', 3)).toMatchObject({ localDate: '2026-10-03', minutes: 8 * 60 + 30 });
  });

  it('orders times within a lived day', () => {
    expect(livedMinutes(60, 3)).toBeGreaterThan(livedMinutes(23 * 60, 3));
    expect(livedMinutes(3 * 60, 3)).toBe(0);
  });
});

describe('quiet hours', () => {
  const q = (start: string, end: string, on = true) => ({ on, start, end });
  it('wraps past midnight', () => {
    expect(inQuietHours(parseTime('22:00')!, q('22:00', '07:00'))).toBe(true);
    expect(inQuietHours(parseTime('03:00')!, q('22:00', '07:00'))).toBe(true);
    expect(inQuietHours(parseTime('07:00')!, q('22:00', '07:00'))).toBe(false);
    expect(inQuietHours(parseTime('21:59')!, q('22:00', '07:00'))).toBe(false);
  });
  it('works within a day, and can be off', () => {
    expect(inQuietHours(parseTime('13:30')!, q('13:00', '14:00'))).toBe(true);
    expect(inQuietHours(parseTime('14:00')!, q('13:00', '14:00'))).toBe(false);
    expect(inQuietHours(parseTime('23:00')!, q('22:00', '07:00', false))).toBe(false);
    expect(inQuietHours(parseTime('23:00')!, q('09:00', '09:00'))).toBe(false);
  });
});

describe('what is due', () => {
  const s = settings({ daily: { on: true, time: '20:00' }, weekly: { on: true, time: '17:00' } });

  it('daily: from its time for a while, once per lived day', () => {
    expect(dueNow(chicago('2026-10-02', '19:59'), CHI, s, {}).daily).toBe(false);
    expect(dueNow(chicago('2026-10-02', '20:00'), CHI, s, {}).daily).toBe(true);
    expect(dueNow(chicago('2026-10-02', '21:55'), CHI, s, {}).daily).toBe(true);
    expect(dueNow(chicago('2026-10-02', '20:05'), CHI, s, { dailyDate: '2026-10-02' }).daily).toBe(false);
    expect(dueNow(chicago('2026-10-02', '20:05'), CHI, settings({ daily: { on: false, time: '20:00' } }), {}).daily).toBe(false);
  });

  it('sends nothing in quiet hours, and a held reminder goes out when they end if still fresh', () => {
    const late = settings({ daily: { on: true, time: '21:30' }, quiet: { on: true, start: '22:00', end: '07:00' } });
    expect(dueNow(chicago('2026-10-02', '22:10'), CHI, late, {})).toMatchObject({ quiet: true, daily: false });
    const early = settings({ daily: { on: true, time: '06:30' }, quiet: { on: true, start: '22:00', end: '07:00' } });
    expect(dueNow(chicago('2026-10-02', '06:45'), CHI, early, {}).daily).toBe(false);
    expect(dueNow(chicago('2026-10-02', '07:00'), CHI, early, {}).daily).toBe(true);
    // A reminder set inside quiet hours that ends too late to be fresh never fires that day.
    const buried = settings({ daily: { on: true, time: '23:00' }, quiet: { on: true, start: '22:00', end: '07:00' } });
    for (const t of ['23:00', '01:00', '07:00', '07:05']) expect(dueNow(chicago('2026-10-02', t), CHI, buried, {}).daily).toBe(false);
  });

  it('drops a reminder that is hours late (server asleep), rather than sending it at a strange time', () => {
    expect(dueNow(chicago('2026-10-02', '23:01'), CHI, settings({ quiet: { on: false, start: '22:00', end: '07:00' } }), {}).daily).toBe(false);
  });

  it('a reminder after midnight counts toward the day you are still living', () => {
    const owl = settings({ daily: { on: true, time: '01:00' }, quiet: { on: false, start: '22:00', end: '07:00' } });
    const d = dueNow(chicago('2026-10-03', '01:30'), CHI, owl, {});
    expect(d.daily).toBe(true);
    expect(d.clock.localDate).toBe('2026-10-02');
    expect(dueNow(chicago('2026-10-03', '01:30'), CHI, owl, { dailyDate: '2026-10-02' }).daily).toBe(false);
  });

  it('follows you across time zones', () => {
    // 20:00 in Tokyo is 06:00 Chicago time: due in Tokyo, not in Chicago.
    const at = new Date('2026-10-02T11:00:00Z');
    expect(dueNow(at, 'Asia/Tokyo', s, {}).daily).toBe(true);
    expect(dueNow(at, CHI, s, {}).daily).toBe(false);
  });

  it('weekly: on the review day at its time, once per review week', () => {
    // 2026-10-04 is a Sunday (reviewDay 6); the week under review starts Monday 2026-09-28.
    expect(dueNow(chicago('2026-10-04', '17:00'), CHI, s, {}).weekly).toBe('2026-09-28');
    expect(dueNow(chicago('2026-10-04', '16:59'), CHI, s, {}).weekly).toBeNull();
    expect(dueNow(chicago('2026-10-03', '17:00'), CHI, s, {}).weekly).toBeNull();
    expect(dueNow(chicago('2026-10-04', '17:30'), CHI, s, { weeklyWeek: '2026-09-28' }).weekly).toBeNull();
    const fri = settings({}, { reviewDay: 4 });
    expect(dueNow(chicago('2026-10-02', '17:10'), CHI, fri, {}).weekly).toBe('2026-09-28');
  });

  it('nudges: considered once a day, inside the nudge window', () => {
    expect(dueNow(chicago('2026-10-02', '10:59'), CHI, s, {}).nudge).toBe(false);
    expect(dueNow(chicago('2026-10-02', '11:00'), CHI, s, {}).nudge).toBe(true);
    expect(dueNow(chicago('2026-10-02', '18:59'), CHI, s, {}).nudge).toBe(true);
    expect(dueNow(chicago('2026-10-02', '19:00'), CHI, s, {}).nudge).toBe(false);
    expect(dueNow(chicago('2026-10-02', '12:00'), CHI, s, { nudgeDate: '2026-10-02' }).nudge).toBe(false);
    expect(dueNow(chicago('2026-10-02', '12:00'), CHI, settings({ nudges: false }), {}).nudge).toBe(false);
  });
});

// ---------- Messages ----------

const TODAY = '2026-08-15';
const quarter = (intents: Partial<Record<BurnerId, Intent>> = {}): Quarter => ({
  id: '2026-Q3',
  createdAt: T,
  updatedAt: T,
  intents: { family: 'steady', friends: 'steady', health: 'steady', work: 'steady', ...intents },
  intentHistory: [],
  status: 'active',
});
const goal = (id: string, burner: BurnerId, over: Partial<Goal> = {}): Goal => ({
  id, burner, title: id, type: 'number', target: 90, startDate: '2026-07-01', deadline: '2026-09-28',
  quarterId: '2026-Q3', order: 0, createdAt: T, updatedAt: T, ...over,
});
/** n logs of 1, one a day from July 1 (so the burner has been quiet since mid-July at most). */
const logs = (goalId: string, n: number, from = '2026-07-01'): LogEntry[] =>
  Array.from({ length: n }, (_, i) => {
    const d = addDays(from, i);
    return { id: `${goalId}-${d}`, goalId, value: 1, localDate: d, at: `${d}T15:00:00Z`, offsetMin: -300, createdAt: T, updatedAt: T };
  });
const person = (id: string, burner: Person['burner'], cadenceDays: number, over: Partial<Person> = {}): Person => ({
  id, name: id, burner, cadenceDays, order: 0, createdAt: T, updatedAt: T, ...over,
});
const touch = (personId: string, d: string): Touchpoint => ({
  id: `t-${personId}-${d}`, personId, type: 'call', localDate: d, at: `${d}T15:00:00Z`, offsetMin: -300, createdAt: T, updatedAt: T,
});

function data(over: Partial<NotifyData> = {}): NotifyData {
  return { quarter: quarter(), goals: [], logs: [], energy: [], people: [], touchpoints: [], crunch: [], actions: [], reviews: [], ...over };
}

const allText = (m: { title: string; body: string } | null) => (m ? `${m.title} ${m.body}` : '');

describe('daily reminder', () => {
  it('skips a day you already checked in, and Travel/Crunch days', () => {
    expect(composeDaily(data(), settings(), TODAY)?.title).toBe('Time to check in');
    expect(composeDaily(data({ goals: [goal('g', 'health')], logs: logs('g', 1, TODAY) }), settings(), TODAY)).toBeNull();
    const crunch = [{ id: 'c', start: '2026-08-10', createdAt: T, updatedAt: T }];
    expect(composeDaily(data({ crunch }), settings(), TODAY)).toBeNull();
  });

  it('mentions a live streak', () => {
    const d = data({ goals: [goal('g', 'health')], logs: logs('g', 5, '2026-08-10') });
    expect(composeDaily(d, settings(), TODAY)?.body).toMatch(/5 day streak/);
  });
});

describe('weekly reminder', () => {
  it('skips a review that is already done', () => {
    const r = { id: 'review-2026-08-10', weekStart: '2026-08-10', step: 6, wins: [], misses: [], focus: '', focusBurners: [], createdAt: T, updatedAt: T };
    expect(composeWeekly({ reviews: [] }, '2026-08-10')?.url).toBe('/#/review');
    expect(composeWeekly({ reviews: [r] }, '2026-08-10')).not.toBeNull();
    expect(composeWeekly({ reviews: [{ ...r, completedAt: T }] }, '2026-08-10')).toBeNull();
  });
});

describe('smart nudges', () => {
  // By Aug 15 a 90-unit goal from Jul 1 is about half way. 22 logged (a High burner) is about half of pace.
  it('nudges a High burner that is behind and quiet, using its why', () => {
    const d = data({
      quarter: quarter({ health: 'high' }),
      goals: [goal('Run 90 miles', 'health', { why: 'Keep up with the kids' })],
      logs: logs('Run 90 miles', 22),
    });
    const m = pickNudge(d, settings(), TODAY);
    expect(m).toMatchObject({ kind: 'nudge', url: '/#/burner/health', subject: 'burner:health' });
    expect(m!.title).toBe('Health could use some heat');
    expect(m!.body).toBe('"Run 90 miles" is behind. Why it matters: Keep up with the kids');
  });

  it('Low burners rarely trigger: the same half pace that nudges Steady leaves Low alone', () => {
    const steady = data({ quarter: quarter({ work: 'steady' }), goals: [goal('w', 'work')], logs: logs('w', 19) });
    expect(pickNudge(steady, settings(), TODAY)?.subject).toBe('burner:work');
    const low = data({ quarter: quarter({ work: 'low' }), goals: [goal('w', 'work')], logs: logs('w', 14) });
    expect(pickNudge(low, settings(), TODAY)).toBeNull();
  });

  it('a burner you touched recently is not nudged, even if behind', () => {
    const d = data({ quarter: quarter({ health: 'high' }), goals: [goal('g', 'health')], logs: [...logs('g', 20), ...logs('g', 1, TODAY)] });
    expect(pickNudge(d, settings(), TODAY)).toBeNull();
  });

  it('an on-pace burner is never nudged', () => {
    const d = data({ quarter: quarter({ health: 'high' }), goals: [goal('g', 'health')], logs: logs('g', 46) });
    expect(pickNudge(d, settings(), TODAY)).toBeNull();
  });

  it('nudges an overdue person; Low-burner people need to be much later', () => {
    const p = person('Sam', 'friends', 7);
    const steady = data({ people: [p], touchpoints: [touch('Sam', '2026-08-04')] }); // 11 days, ratio 1.57
    const m = pickNudge(steady, settings(), TODAY);
    expect(m).toMatchObject({ title: 'Reach out to Sam?', url: '/#/burner/friends', subject: 'person:Sam' });
    expect(m!.body).toBe('11 days since you last connected (your rhythm: every week). A quick text counts.');
    expect(pickNudge({ ...steady, quarter: quarter({ friends: 'low' }) }, settings(), TODAY)).toBeNull();
    expect(pickNudge({ ...steady, quarter: quarter({ friends: 'low' }), touchpoints: [touch('Sam', '2026-08-01')] }, settings(), TODAY)).not.toBeNull();
  });

  it('counts a never-contacted person from when you added them', () => {
    const fresh = person('Ana', 'family', 14, { createdAt: '2026-08-10T12:00:00Z' });
    expect(pickNudge(data({ people: [fresh] }), settings(), TODAY)).toBeNull();
    const old = person('Ana', 'family', 14, { createdAt: '2026-07-01T12:00:00Z' });
    expect(pickNudge(data({ people: [old] }), settings(), TODAY)?.body).toMatch(/^No connection logged yet/);
  });

  it('High burners come first, then people, then Steady burners', () => {
    const base = {
      goals: [goal('h', 'health'), goal('w', 'work')],
      logs: [...logs('h', 22), ...logs('w', 19)],
      people: [person('Sam', 'friends', 7)],
      touchpoints: [touch('Sam', '2026-08-01')],
    };
    expect(pickNudge(data({ ...base, quarter: quarter({ health: 'high' }) }), settings(), TODAY)?.subject).toBe('burner:health');
    expect(pickNudge(data({ ...base, quarter: quarter({ health: 'low' }) }), settings(), TODAY)?.subject).toBe('person:Sam');
  });

  it('a subject rests before nudging again', () => {
    const d = data({ quarter: quarter({ health: 'high' }), goals: [goal('g', 'health')], logs: logs('g', 22) });
    expect(pickNudge(d, settings(), TODAY, { 'burner:health': addDays(TODAY, -2) })).toBeNull();
    expect(pickNudge(d, settings(), TODAY, { 'burner:health': addDays(TODAY, -3) })).not.toBeNull();
  });

  it('Travel/Crunch mutes every nudge', () => {
    const d = data({
      quarter: quarter({ health: 'high' }),
      goals: [goal('g', 'health')],
      logs: logs('g', 22),
      people: [person('Sam', 'friends', 7)],
      touchpoints: [touch('Sam', '2026-07-01')],
      crunch: [{ id: 'c', start: '2026-08-14', end: '2026-08-20', createdAt: T, updatedAt: T }],
    });
    expect(pickNudge(d, settings(), TODAY)).toBeNull();
    expect(pickNudge(d, settings(), '2026-08-21')).not.toBeNull();
  });

  it('redacts sensitive terms and keeps lock-screen text short, with no em dashes', () => {
    const d = data({
      quarter: quarter({ work: 'high' }),
      goals: [goal('Ship the Acme Capital rollout', 'work', { why: `Acme Capital is counting on it ${'and more '.repeat(30)}` })],
      logs: logs('Ship the Acme Capital rollout', 10),
      people: [person('Acme Capital partner', 'friends', 7)],
      touchpoints: [touch('Acme Capital partner', '2026-07-01')],
    });
    const s = settings({}, { sensitiveTerms: ['Acme Capital'] });
    const work = pickNudge(d, s, TODAY);
    expect(work?.subject).toBe('burner:work');
    expect(allText(work)).not.toMatch(/acme/i);
    expect(allText(work)).toContain('[redacted]');
    expect(work!.body.length).toBeLessThan(200);
    const p = pickNudge({ ...d, goals: [], logs: [] }, s, TODAY);
    expect(allText(p)).not.toMatch(/acme/i);
    for (const m of [work, p, composeDaily(data(), s, TODAY), composeWeekly({ reviews: [] }, '2026-08-10')]) {
      expect(allText(m)).not.toMatch(/—/);
    }
  });

  it('nothing to say means no nudge', () => {
    expect(pickNudge(data(), settings(), TODAY)).toBeNull();
    expect(pickNudge(data({ quarter: undefined }), settings(), TODAY)).toBeNull();
  });
});

describe('nudge history', () => {
  it('forgets entries older than any cooldown', () => {
    const state: NotifyState['nudged'] = { a: '2026-01-01', b: '2026-08-01' };
    expect(pruneNudged(state, TODAY)).toEqual({ b: '2026-08-01' });
  });
});
