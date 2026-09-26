// Dev-only sample data: a realistic previous quarter plus the current quarter to date.
// Every sample record id starts with "sample-" so it can be wiped without touching real data.
import {
  BURNERS,
  addDays,
  computeDashboard,
  dateRange,
  prevQuarterId,
  quarterHighlights,
  startOfWeek,
  suggestedGrade,
  summaryFrom,
  quarterOf,
  quarterSpan,
  weekday,
  type BurnerId,
  type CrunchPeriod,
  type EnergyEntry,
  type Goal,
  type Intent,
  type LocalDate,
  type LogEntry,
  type Person,
  type Quarter,
  type QuarterId,
  type Settings,
  type Touchpoint,
  type TouchpointType,
  type CoachReply,
  type WeeklyAction,
  type WeeklyReview,
} from "@/domain";
import { db } from './db';
import { currentToday, getSettings } from './repo';

const SAMPLE_QUARTERS_KEY = 'sampleQuarters';
const OFFSET = -240; // EDT

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A UTC instant for a local date at a local hour in EDT. */
function at(d: LocalDate, hour: number, minute = 0): string {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day, hour, minute) - OFFSET * 60_000).toISOString();
}

let seq = 0;
const sid = (kind: string) => `sample-${kind}-${(seq++).toString(36)}`;

interface GoalSpec {
  burner: BurnerId;
  title: string;
  type: Goal['type'];
  target?: number;
  unit?: string;
  habitPeriod?: Goal['habitPeriod'];
  milestones?: string[];
  why: string;
  whenWhere: string;
  /** Chance of logging on a normal day, and on a travel day. */
  p: number;
  pTravel: number;
  /** Amount per log for number goals. */
  amount?: () => number;
  /** Days into the quarter the goal was added (proration demo). */
  addedAfter?: number;
}

function specs(r: () => number): GoalSpec[] {
  return [
    { burner: 'family', title: 'Date night', type: 'habit', target: 2, habitPeriod: 'month', why: 'We are a team first. Protect time that is just us.', whenWhere: 'Second and last Friday, somewhere new', p: 0.07, pTravel: 0 },
    { burner: 'family', title: 'Bedtime with the kids', type: 'habit', target: 3, habitPeriod: 'week', why: 'These years go fast and they will not ask forever.', whenWhere: 'Home by 7 on Mon, Wed, Thu', p: 0.45, pTravel: 0 },
    { burner: 'family', title: 'Plan the winter family trip', type: 'milestone', milestones: ['Pick dates', 'Book flights', 'Book the house', 'Share the itinerary'], why: 'Something to look forward to together.', whenWhere: 'Sunday evenings with coffee', p: 0, pTravel: 0 },
    { burner: 'friends', title: 'Call a close friend', type: 'habit', target: 1, habitPeriod: 'week', why: 'Friendships fade quietly if I do not tend them.', whenWhere: 'Drive home on Thursdays', p: 0.16, pTravel: 0.2 },
    { burner: 'friends', title: 'Host a dinner', type: 'yesno', why: 'Our house should be where people gather.', whenWhere: 'A Saturday in September', p: 0, pTravel: 0 },
    { burner: 'health', title: 'Run 150 miles', type: 'number', target: 150, unit: 'miles', why: 'I want to feel strong at 50, not just get there.', whenWhere: 'Tue, Thu, Sat mornings before 7', p: 0.42, pTravel: 0.15, amount: () => Math.round((2.5 + r() * 3.5) * 10) / 10 },
    { burner: 'health', title: 'Strength training', type: 'habit', target: 3, habitPeriod: 'week', why: 'Energy for the people who count on me.', whenWhere: 'Hotel gym or garage, 6 AM', p: 0.38, pTravel: 0.3 },
    { burner: 'health', title: 'Lights out by 10:30', type: 'habit', target: 5, habitPeriod: 'week', why: 'Everything is easier after a real night of sleep.', whenWhere: 'Phone on the charger in the kitchen at 10', p: 0.6, pTravel: 0.25, addedAfter: 30 },
    { burner: 'work', title: 'Deep work blocks', type: 'habit', target: 4, habitPeriod: 'week', why: 'The best deals come from thinking, not reacting.', whenWhere: '8 to 10 AM, calendar blocked, door closed', p: 0.55, pTravel: 0.3 },
    { burner: 'work', title: 'Read 3 industry books', type: 'number', target: 3, unit: 'books', why: 'Stay the sharpest person in the room.', whenWhere: 'Flights and Sunday mornings', p: 0.018, pTravel: 0.08, amount: () => 1 },
  ];
}

const PEOPLE: Array<[string, 'family' | 'friends', number]> = [
  ['Mom', 'family', 7],
  ['Dad', 'family', 14],
  ['Katie (sister)', 'family', 14],
  ['Jake', 'friends', 14],
  ['Priya', 'friends', 30],
  ['Marcus', 'friends', 30],
  ['Elena', 'friends', 60],
];

interface Generated {
  quarter: Quarter;
  goals: Goal[];
  logs: LogEntry[];
  energy: EnergyEntry[];
  touchpoints: Touchpoint[];
  crunch: CrunchPeriod[];
}

function generateQuarter(qid: QuarterId, through: LocalDate, people: Person[], seed: number, status: Quarter['status']): Generated {
  const r = rng(seed);
  const span = quarterSpan(qid);
  const end = through < span.end ? through : span.end;
  const days = dateRange(span.start, end);
  const t0 = at(span.start, 9);

  const intents: Record<BurnerId, Intent> = { family: 'high', friends: 'steady', health: 'high', work: 'steady' };
  const quarter: Quarter = {
    id: qid,
    createdAt: t0,
    updatedAt: t0,
    theme: status === 'closed' ? 'Foundations' : 'Present',
    intents: { ...intents },
    intentHistory: [],
    status,
  };

  // A travel week about 40% into the quarter, Monday to Friday.
  let tStart = addDays(span.start, 38);
  while (weekday(tStart) !== 0) tStart = addDays(tStart, 1);
  const tEnd = addDays(tStart, 4);
  const crunch: CrunchPeriod[] =
    tStart <= end
      ? [{ id: sid('crunch'), start: tStart, end: tEnd, label: 'Travel: West Coast', createdAt: at(tStart, 6), updatedAt: at(tStart, 6) }]
      : [];
  const travel = new Set(tStart <= end ? dateRange(tStart, tEnd) : []);

  // Mid-quarter intent change demo: Work goes High during a busy stretch, Friends drops to Low.
  const changeDay = addDays(span.start, 55);
  if (changeDay <= end) {
    quarter.intents.friends = 'low';
    quarter.intents.work = 'high';
    quarter.intents.family = 'high';
    quarter.intents.health = 'steady';
    quarter.intentHistory = [
      { burner: 'health', from: 'high', to: 'steady', reason: 'Knee is sore, backing off mileage for a few weeks', at: at(changeDay, 8), localDate: changeDay },
      { burner: 'work', from: 'steady', to: 'high', reason: 'Two closings land this month', at: at(changeDay, 8, 5), localDate: changeDay },
      { burner: 'friends', from: 'steady', to: 'low', reason: 'Making room for the closings', at: at(changeDay, 8, 10), localDate: changeDay },
    ];
  }

  const goals: Goal[] = [];
  const logs: LogEntry[] = [];
  const order: Record<BurnerId, number> = { family: 0, friends: 0, health: 0, work: 0 };
  const noteBank: Record<BurnerId, string[]> = {
    family: ['Kids were wired, still great', 'Tacos and a long walk after', 'Read two chapters of the dragon book'],
    friends: ['Caught up for an hour, long overdue', 'He is thinking about moving'],
    health: ['Legs felt heavy', 'Easy pace, great weather', 'New PR on the hill loop', 'Hotel treadmill, not fun but done'],
    work: ['Protected the block, no email', 'Got pulled into a call at 9:15', 'Wrote the memo in one pass'],
  };

  for (const s of specs(r)) {
    const startDate = s.addedAfter ? addDays(span.start, s.addedAfter) : span.start;
    const g: Goal = {
      id: sid('goal'),
      quarterId: qid,
      burner: s.burner,
      title: s.title,
      type: s.type,
      why: s.why,
      whenWhere: s.whenWhere,
      startDate,
      deadline: span.end,
      target: s.target,
      unit: s.unit,
      habitPeriod: s.habitPeriod,
      milestones: s.milestones?.map((title) => ({ id: sid('ms'), title })),
      order: order[s.burner]++,
      createdAt: at(startDate, 9),
      updatedAt: at(startDate, 9),
    };
    goals.push(g);

    const pushLog = (d: LocalDate, value: number, extra: Partial<LogEntry> = {}) => {
      const hour = 7 + Math.floor(r() * 14);
      const note = r() < 0.18 ? noteBank[s.burner][Math.floor(r() * noteBank[s.burner].length)] : undefined;
      logs.push({
        id: sid('log'),
        goalId: g.id,
        value,
        localDate: d,
        at: at(d, hour, Math.floor(r() * 60)),
        offsetMin: OFFSET,
        createdAt: at(d, hour),
        updatedAt: at(d, hour),
        ...(note ? { note, notePrivate: r() < 0.2 } : {}),
        ...extra,
      });
    };

    if (s.type === 'milestone' && g.milestones) {
      const stepDays = [12, 30, 51, 84];
      g.milestones.forEach((m, i) => {
        const d = addDays(span.start, stepDays[i]);
        if (d <= end && (status === 'closed' || i < 3)) {
          m.doneAt = at(d, 20);
          pushLog(d, 1, { milestoneId: m.id });
        }
      });
    } else if (s.type === 'yesno') {
      const d = addDays(span.start, 75);
      if (d <= end) pushLog(d, 1);
    } else {
      for (const d of days) {
        if (d < startDate) continue;
        let p = travel.has(d) ? s.pTravel : s.p;
        // Friends go quiet after the intent change; work ramps up.
        if (d >= changeDay && s.burner === 'friends') p *= 0.5;
        if (d >= changeDay && s.burner === 'work') p *= 1.3;
        // Weekends: more family time, less deep work.
        const wd = weekday(d);
        if (wd >= 5 && s.burner === 'work') p *= 0.2;
        if (wd >= 5 && s.burner === 'family') p *= 1.5;
        if (r() < p) pushLog(d, s.amount ? s.amount() : 1);
      }
    }
  }

  const energy: EnergyEntry[] = [];
  for (const d of days) {
    if (r() > 0.78) continue;
    const base = travel.has(d) ? 2.2 : weekday(d) >= 5 ? 4 : 3.4;
    const rating = Math.max(1, Math.min(5, Math.round(base + (r() - 0.5) * 2))) as EnergyEntry['rating'];
    energy.push({ id: sid('energy'), rating, localDate: d, at: at(d, 21), offsetMin: OFFSET, createdAt: at(d, 21), updatedAt: at(d, 21) });
  }

  const touchpoints: Touchpoint[] = [];
  const types: TouchpointType[] = ['call', 'text', 'in_person', 'other'];
  for (const p of people) {
    let d = addDays(span.start, Math.floor(r() * 5));
    while (d <= end) {
      const type = types[Math.floor(r() * (p.burner === 'family' ? 3 : 4))];
      touchpoints.push({
        id: sid('touch'),
        personId: p.id,
        type,
        localDate: d,
        at: at(d, 18),
        offsetMin: OFFSET,
        createdAt: at(d, 18),
        updatedAt: at(d, 18),
        ...(r() < 0.25 ? { note: 'Good catch up' } : {}),
      });
      // Mostly on cadence, sometimes late. Elena drifts overdue to show the cue.
      const drift = p.name === 'Elena' ? 1.8 : 0.7 + r() * 0.8;
      d = addDays(d, Math.max(2, Math.round(p.cadenceDays * drift)));
    }
  }

  return { quarter, goals, logs, energy, touchpoints, crunch };
}

export async function loadSampleData(): Promise<void> {
  await wipeSampleData();
  seq = 0;
  const today = await currentToday();
  const current = quarterOf(today).id;
  const previous = prevQuarterId(current);
  const t = at(quarterSpan(previous).start, 9);
  const people: Person[] = PEOPLE.map(([name, burner, cadenceDays], i) => ({
    id: sid('person'),
    name,
    burner,
    cadenceDays,
    order: i,
    createdAt: t,
    updatedAt: t,
  }));
  const prev = generateQuarter(previous, quarterSpan(previous).end, people, 7, 'closed');
  const cur = generateQuarter(current, today, people, 42, 'active');

  // Sample goals link people to relevant goals.
  const link = (g: Goal[], title: string, names: string[]) => {
    const goal = g.find((x) => x.title === title);
    if (goal) goal.personIds = people.filter((p) => names.includes(p.name)).map((p) => p.id);
  };
  for (const set of [prev.goals, cur.goals]) link(set, 'Call a close friend', ['Jake', 'Priya', 'Marcus']);

  // Last quarter went through its close: grades, decisions, carry links, and a frozen summary.
  const settings = await getSettings();
  closeSampleQuarter(prev, cur, people, settings);
  // Weekly reviews (wins, misses, focus) and the actions they created, including this week's.
  const { reviews, actions, replies } = sampleRituals(quarterSpan(previous).start, today, [...prev.crunch, ...cur.crunch]);

  // Quarters with real goals are left alone; empty ones (e.g. auto-created) get the sample setup.
  const realGoals = await db.goals.filter((g) => !g.id.startsWith('sample-') && !g.deleted).toArray();
  const existingQuarters = new Set(realGoals.map((g) => g.quarterId));
  const createdQuarters = [previous, current].filter((id) => !existingQuarters.has(id));

  await db.transaction('rw', db.tables, async () => {
    // If a real current quarter exists, keep its intents and theme; add sample records alongside.
    for (const g of [prev, cur]) {
      if (!existingQuarters.has(g.quarter.id)) await db.quarters.put(g.quarter);
      await db.goals.bulkPut(g.goals);
      await db.logs.bulkPut(g.logs);
      await db.energy.bulkPut(g.energy);
      await db.touchpoints.bulkPut(g.touchpoints);
      await db.crunch.bulkPut(g.crunch);
    }
    await db.people.bulkPut(people);
    await db.reviews.bulkPut(reviews);
    await db.actions.bulkPut(actions);
    await db.coachReplies.bulkPut(replies);
    await db.kv.put({ key: SAMPLE_QUARTERS_KEY, value: createdQuarters, updatedAt: new Date().toISOString() });
  });
}

function closeSampleQuarter(prev: Generated, cur: Generated, people: Person[], settings: Settings) {
  const span = quarterSpan(prev.quarter.id);
  const input = {
    quarter: prev.quarter,
    goals: prev.goals,
    logs: prev.logs,
    energy: prev.energy,
    people,
    touchpoints: prev.touchpoints,
    crunch: prev.crunch,
    settings,
    today: span.end,
  };
  const dash = computeDashboard({ ...input, quarterStart: span.start });
  for (const b of BURNERS) {
    for (const { goal, progress } of dash.burners[b].goals) {
      goal.grade = suggestedGrade(progress.fraction, progress.complete);
      goal.closeDecision =
        goal.type === 'yesno' || (goal.type === 'milestone' && progress.complete) ? 'drop' : progress.fraction >= 0.6 ? 'carry' : 'modify';
      const next = cur.goals.find((g) => g.title === goal.title);
      if (next && goal.closeDecision !== 'drop') {
        goal.carriedToId = next.id;
        next.carriedFromId = goal.id;
      }
    }
  }
  prev.quarter.summary = summaryFrom(quarterHighlights(input));
  prev.quarter.closedAt = at(addDays(span.end, 1), 19);
  prev.quarter.setupAt = at(span.start, 8);
  cur.quarter.setupAt = at(quarterSpan(cur.quarter.id).start, 8);
}

const WIN_BANK = [
  'Date night at the new Thai place',
  'Hit every run this week',
  'Protected all four deep work blocks',
  'Bedtime with the kids three nights',
  'Long call with Jake',
  'Lights out by 10:30 five nights',
  'Finished the second book',
  'Said no to a low-value meeting',
  'Sunday pancakes with the kids',
];
const MISS_BANK = [
  'Skipped strength training twice',
  'Worked late Wednesday and Thursday',
  'Never called Priya back',
  'Phone in bed again',
  'Missed the Saturday long run',
  'Too much reactive email',
];
const FOCUS_BANK = ['Protect mornings', 'Home by 7 three nights', 'Move every day', 'Fewer meetings, more thinking', 'Be present at dinner', 'Rest and recover'];
const ACTION_BANK: Array<[string, BurnerId]> = [
  ['Book the sitter for Friday', 'family'],
  ['Plan Saturday morning with the kids', 'family'],
  ['Call Mom on Sunday', 'family'],
  ['Text Jake about golf', 'friends'],
  ['Invite Priya and Sam to dinner', 'friends'],
  ['Three runs: Tue, Thu, Sat', 'health'],
  ['Meal prep Sunday', 'health'],
  ['Phone charges in the kitchen', 'health'],
  ['Block 8 to 10 every morning', 'work'],
  ['Inbox to zero by Friday noon', 'work'],
];

function sampleRituals(from: LocalDate, today: LocalDate, crunch: CrunchPeriod[]) {
  const r = rng(99);
  const pick = <T,>(xs: T[], n: number) => [...xs].sort(() => r() - 0.5).slice(0, n);
  const thisWeek = startOfWeek(today);
  const travel = new Set(crunch.flatMap((c) => dateRange(c.start, c.end ?? c.start)));
  const reviews: WeeklyReview[] = [];
  const actions: WeeklyAction[] = [];
  for (let w = startOfWeek(from); w < thisWeek; w = addDays(w, 7)) {
    // Skipped during the travel week and the odd busy week, like real life.
    if (travel.has(addDays(w, 2)) || r() < 0.12) continue;
    const sunday = addDays(w, 6);
    reviews.push({
      id: `sample-review-${w}`,
      weekStart: w,
      step: 5,
      wins: pick(WIN_BANK, 2 + Math.floor(r() * 2)),
      misses: pick(MISS_BANK, 1 + Math.floor(r() * 2)),
      focus: FOCUS_BANK[Math.floor(r() * FOCUS_BANK.length)],
      focusBurners: [],
      coachSkipped: true,
      completedAt: at(sunday, 19, 30),
      createdAt: at(sunday, 19),
      updatedAt: at(sunday, 19, 30),
    });
    const forWeek = addDays(w, 7);
    pick(ACTION_BANK, 3).forEach(([text, burner], i) => {
      const doneDay = addDays(forWeek, Math.floor(r() * 7));
      const isDone = forWeek < thisWeek ? r() < 0.75 : doneDay <= today && r() < 0.6;
      actions.push({
        id: sid('action'),
        weekStart: forWeek,
        text,
        burner,
        order: i,
        createdAt: at(sunday, 19, 20),
        updatedAt: at(sunday, 19, 20),
        ...(isDone ? { done: { at: at(doneDay, 18), offsetMin: OFFSET, localDate: doneDay } } : {}),
      });
    });
  }
  // Coach replies for the three most recent reviewed weeks, in the tone the packets ask for.
  const replies: CoachReply[] = reviews.slice(-3).map((r, i) => {
    const t = at(addDays(r.weekStart, 6), 20, 10);
    return {
      id: `sample-reply-${r.weekStart}`,
      kind: "weekly",
      scope: r.weekStart,
      text: SAMPLE_REPLIES[i % SAMPLE_REPLIES.length],
      actions: [],
      addedActions: [],
      createdAt: t,
      updatedAt: t,
    };
  });
  return { reviews, actions, replies };
}

export async function wipeSampleData(): Promise<void> {
  const isSample = (x: { id: string }) => x.id.startsWith('sample-');
  const createdQuarters = ((await db.kv.get(SAMPLE_QUARTERS_KEY))?.value as string[] | undefined) ?? [];
  await db.transaction('rw', db.tables, async () => {
    // Anything you logged against a sample goal or person goes with it.
    const sampleGoals = new Set((await db.goals.filter(isSample).primaryKeys()) as string[]);
    const samplePeople = new Set((await db.people.filter(isSample).primaryKeys()) as string[]);
    // Keep any quarter you have since added real goals to.
    const realGoalQuarters = new Set(
      (await db.goals.filter((g) => !isSample(g) && !g.deleted).toArray()).map((g) => g.quarterId),
    );
    await Promise.all([
      db.goals.filter(isSample).delete(),
      db.logs.filter((l) => isSample(l) || sampleGoals.has(l.goalId)).delete(),
      db.energy.filter(isSample).delete(),
      db.people.filter(isSample).delete(),
      db.touchpoints.filter((t) => isSample(t) || samplePeople.has(t.personId)).delete(),
      db.crunch.filter(isSample).delete(),
      db.reviews.filter(isSample).delete(),
      db.actions.filter(isSample).delete(),
      db.coachReplies.filter(isSample).delete(),
      db.quarters.bulkDelete(createdQuarters.filter((q) => !realGoalQuarters.has(q))),
      db.kv.delete(SAMPLE_QUARTERS_KEY),
    ]);
  });
}

export async function hasSampleData(): Promise<boolean> {
  return (await db.goals.filter((g) => g.id.startsWith('sample-')).count()) > 0;
}

const SAMPLE_REPLIES = [
  `Family is carrying the week: bedtime three nights and a date night during a closing week is the real win, not luck. Work held too, four deep work blocks protected.

The pattern that matters: strength training keeps sliding on travel days, and you told me why it exists, energy for the people who count on you. On the road it becomes the first thing cut, then sleep follows.

Let the Friends dinner go until October. Friends is on Low, and a call a week is on track.

Suggested actions:
- Health: Lift at the hotel gym Tuesday at 6 AM, 20 minutes
- Family: Book the sitter for Friday by Wednesday night
- Work: Block 8 to 10 Monday before you open email`,
  `Steady week, and your numbers say so: six check-in days, energy up from last week, and Health back on pace after the knee week. Work is the one burner under its intent. Deep work lost two mornings to early calls.

Your why for deep work was that the best deals come from thinking, not reacting. Two reactive mornings is exactly that slipping.

Dad is 23 days out on a two week cadence. One call closes that gap.

Suggested actions:
- Work: Decline anything before 10 on Tuesday and Thursday
- Family: Call Dad on the Thursday drive home
- Health: Phone on the kitchen charger at 10 every night`,
  `Travel week, so the bar was lower on purpose, and you cleared it: runs on two days, a text to Jake, and you still rated your energy every night. Nothing here needs fixing.

The one thing to watch: lights out slipped four nights, and sleep is what makes the rest easy for you. Protect it first next week.

Suggested actions:
- Health: Lights out by 10:30 Sunday through Wednesday
- Friends: Text Priya about dinner dates this weekend`,
];
