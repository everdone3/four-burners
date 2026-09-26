# Coach design (Phase 4)

Produced by the phase4-coach-design workflow (3 competing packet designs, judged and synthesized). This is the implementation spec for src/domain/coach/*.

## Shared preamble (ships exactly)

```
FOUR BURNERS COACH v1
Be my executive coach: candid, direct, warm, clearly in my corner. Ground every point in my numbers and words; do not recap. Under 180 words plus actions. Plain text: no markdown, filler, generic motivation, em or en dashes. At most one question.
Judge each burner by its intent: light activity on a Low burner is on track.
Crunch days (travel, deals) have lower expectations built in: do not pile on; suggest the smallest move that keeps a burner lit.
If a goal is behind or slipping, remind me of its why, in my words.
Work: habits and priorities only. Never ask about clients, deals, or firms, or guess what [redacted] hides.
pace = % of where my intent expects me by now. active x/y = active days vs expected.
If END OF PACKET is missing, say the paste was cut off.
End with 2 or 3 actions, each with a day or trigger, nothing after:
Suggested actions:
- Burner: action
```

## Template: weekly

```
{{PREAMBLE}}

TYPE: weekly review, {{weekStart}} to {{weekEndShort}}, {{year}} | {{quarter}}, {{daysLeft}}d left{{#if theme}} | theme: {{theme}}{{/if}}
{{#if trimmed}}TRIMMED for length: {{trimmed}}{{/if}}
ME: {{aboutMe|not written yet}}
{{#if crunch}}CRUNCH: {{crunch}}{{/if}}
DAYS (energy 1 to 5): {{#each day}}{{dow}} {{energy|-}}{{#if crunch}} crunch{{/if}}{{#if noCheckIn}} no check-in{{/if}}{{sep ", "}}{{/each}}
WEEK: check-ins {{checkInDays}}/{{daysElapsed}}, streak {{streak}}d (best {{longestStreak}}), energy {{energyAvg|-}} (prior wk {{energyPrior|-}}), progress {{progressScore}}, consistency {{consistencyScore}}
{{#if actionsTotal}}LAST WK ACTIONS: {{actionsDone}}/{{actionsTotal}} done{{#if openActions}}; open: {{openActions}}{{/if}}{{/if}}
{{#each burner}}
{{BURNER}} ({{Intent}}): {{status}}{{#if pace}}, pace {{pace}}%{{/if}}, active {{activeDays}}/{{expectedActiveDays}}
{{#each goal}}
{{#if done}}{{title}}: DONE {{doneDate}}{{else}}{{title}}{{#if addedMidQ}} (added {{startDate}}){{/if}}: {{progress}}{{#if week}}, {{week}}{{/if}}, {{paceFlag}} | why: {{why|MISSING}} | when: {{whenWhere|MISSING}}{{#if notes}} | notes: {{notes}}{{/if}}{{/if}}
{{else}}
no goals set
{{/each}}
{{#if people}}people: {{people}}{{/if}}
{{/each}}
WINS: {{wins|none written}}
MISSES: {{misses|none written}}
{{#if trend}}
PRIOR 4 WKS, oldest first ({{w1}}, {{w2}}, {{w3}}, {{w4}})
progress {{t.progress}}
check-ins {{t.checkIns}}
energy {{t.energy}}
crunch days {{t.crunch}}
actions done {{t.actions}}
active days: Family {{t.family}}, Friends {{t.friends}}, Health {{t.health}}, Work {{t.work}}
{{#if energyByType}}energy by day type, last 5 wks: {{energyByType}}{{/if}}
{{else}}
PRIOR 4 WKS: not enough history yet
{{/if}}
{{#if chronic}}OFF TRACK 3+ of last 5 wk ends: {{chronic}}{{/if}}
{{#if repeatMisses}}REPEAT misses: {{repeatMisses}}{{/if}}
{{#if intentChanges}}INTENT changes: {{intentChanges}}{{/if}}
ASK: Coach my week against my intents: what held up, the one pattern that matters most, and what to let go.{{#if crunchAhead}} Plan next week around the crunch ahead.{{/if}} Then Suggested actions.
END OF PACKET

RENDER RULES (not part of the packet; the shared rules here apply to all four packet types)
Syntax: {{x}} is a value; {{x|fallback}} prints the fallback when x is empty; {{#if x}}...{{else}}...{{/if}}; {{#each list}}...{{else}}...{{/each}} repeats, and the else part prints once when the list is empty; {{sep ", "}} joins inline items. A line that renders empty is dropped. One blank line after the preamble, none inside the body. LF newlines, ASCII only.
Sources: weekSummary(input, weekStart) and computeDashboard as of the week end (src/domain/reviews.ts, scoring.ts), goalProgress (goals.ts), peopleByUrgency (people.ts), energyTrend (logs.ts), the WeeklyReview being written, Profile.aboutMe.
Formats: dates "Sep 14"; weekEndShort "20" in the same month, else "Oct 4"; dow Mon Tue Wed Thu Fri Sat Sun; numbers max 1 decimal, trailing .0 dropped; pace = round(pace x 100) plus "%"; year only in TYPE.
aboutMe: Profile.aboutMe collapsed to one line, cap 450.
crunch: parts joined ". ". Crunch days this week: Thu ("Closing day") or a range Mon to Wed ("Travel"). Active now: on now until Oct 2, or on now, no end. CrunchPeriods starting in the next 14 days: Ahead: Wed Sep 23 to Fri Sep 25 ("Travel: West Coast"). crunchAhead = crunch still on or any Ahead part.
day: every day of the week that has started. energy "-" when not rated; noCheckIn when WeekSummary.checkedIn is false.
openActions: WeekSummary.actions.undone as "{{text}} ({{Burner}})", joined "; ".
Burners: always all four, fixed order FAMILY, FRIENDS, HEALTH, WORK. Intent = High, Steady, or Low (current). status = on track, behind, slipping, or idle (BurnerStatus). pace omitted when null (no goals). active = activeDays/expectedActiveDays from WeekSummary.burners.
Goals, in goal.order:
  progress: number "{{actual}}/{{target}} {{unit}}"; weekly habit "wk {{n}}/{{target}} ({{dows}})"; monthly habit "mo {{n}}/{{target}}"; yes/no "yes/no, not done"; milestone "steps {{done}}/{{total}}, next: {{nextStep}}".
  week: number "wk +{{sum}} ({{dows}})" or "wk 0"; monthly habit "wk {{n}} ({{dows}})"; milestone "wk: {{step}} done" only when a step was done this week; weekly habit and yes/no add nothing.
  paceFlag: "pace {{pace}}%", plus " BEHIND" or " SLIPPING" when off track; "pace new" inside NEW_GOAL_GRACE_DAYS. Done goals collapse to "{{title}}: DONE Sep 19".
  addedMidQ: startDate after the quarter start (the goal is prorated).
  why and when: always shown; MISSING when empty, because a missing why or plan is itself coaching signal.
  notes: public notes only, {{dow}} "{{text}}" joined "; ", newest first, max 2 per goal and 6 per packet.
people (Family and Friends blocks only), joined "; ": contacted this week "{{name}} {{type}} {{dows}}" (call, text, in person, other) plus a quoted public touchpoint note if any; overdue "{{name}} OVERDUE {{daysSince}}d (every {{cadence}}d)"; due "{{name}} due now {{daysSince}}d (every {{cadence}}d)"; approaching "{{name}} due soon ..."; never "{{name}} none logged (every {{cadence}}d)"; fresh and not contacted "{{name}} ok".
wins, misses: review steps 2 and 3 as typed, joined "; ", max 6 each.
trend: the 4 full weeks before the reviewed week, each from weekSummary as of that Sunday (may reach into last quarter); "-" for a week with no data; actions "done/total" or "-" when none were set. The else branch prints when fewer than 2 prior weeks exist.
energyByType: rated days in the 35 days ending at week end, split into crunch, weekday, and weekend (non-crunch) days, "{{bucket}} {{avg}} ({{n}}d)"; a bucket prints only with n of 2 or more; the Health comparison (days with any Health log vs without) only with 3 or more days on each side; the whole line only with 10 or more rated days.
chronic: current-quarter goals that were behind or slipping by goalProgress at 3 or more of the last 5 Sundays, this one included, using the intent in force that day: "{{title}} {{n}}/5", most first, max 3.
repeatMisses: this week's misses that also appear (lowercased, punctuation stripped) in 2 or more of the prior 4 reviews: "{{text}} {{n}} of 4 wks", max 3.
intentChanges: this quarter's IntentChange records grouped by date: "{{date}}: {{Burner}} {{From}} to {{To}} ({{reason}})" joined "; ".
trimmed: the budget-ladder steps applied, in order, e.g. "notes, energy by day type".
Field caps, applied after sanitize and redact, cut at a word boundary plus "...": aboutMe 450, goal title 60, why 90, when 90, note 90, win and miss 100, action 80, crunch label 30, reason 60, question 200.
Privacy pipeline (all packet types):
1. selectPacketData() is the only input the renderers see. It copies a log or touchpoint note only when notePrivate !== true, never reads LogEntry.edits (applyLogEdit keeps prevNote there), and never passes ids, UTC instants, or offsetMin. Every number comes from structured fields, so no line depends on note text and nothing shows where a private note was.
2. Field prep for every user-written value (titles, whys, whens, steps, notes, wins, misses, focus, actions, crunch labels, reasons, theme, names, aboutMe, question): sanitize (NFKC, straight quotes, digit dash digit to "3 to 4", other em or en dashes to ", ", every whitespace run including newlines to one space, inner double quotes to single), then redact() from src/domain/coach/redact.ts, then cut. Collapsing newlines means user text can never start a line, so it cannot fake a label, "Suggested actions:", or END OF PACKET.
3. finalizePacket(): dash sanitize and redact() over the whole rendered string, preamble included. Idempotent.
4. Copy gate on that exact string: containsSensitive() is false, no U+2013 or U+2014, and no private note of 12+ chars (lowercased alphanumerics) appears as a substring. Any failure disables Copy and says why.
5. The preview shows the exact final string. Chars, about chars/4 tokens, redaction count, and private notes left out (PacketStats) are computed on it and shown in the UI, never in the packet. The Claude deep link carries no text; the "just copied" marker stores only {kind, scope, copiedAt, chars}.
Soft budget 5,000 chars (sample render: 4,707). Trimming ladder: see trimStrategy.
```

## Template: checkin

```
{{PREAMBLE}}

TYPE: mid-quarter check-in, {{dow}} {{date}}, {{year}} | {{quarter}} day {{dayN}}/{{daysTotal}}, {{daysLeft}}d left{{#if theme}} | theme: {{theme}}{{/if}}
{{#if trimmed}}TRIMMED for length: {{trimmed}}{{/if}}
ME: {{aboutMe|not written yet}}
{{#if crunch}}CRUNCH: {{crunch}}{{/if}}
NOW: progress {{progress}}, consistency {{consistency}}, streak {{streak}}d, check-ins 14d {{checkIns14}}/14, crunch days 14d {{crunch14}}, energy 7d {{eRecent|-}} (prior 7d {{ePrior|-}})
{{#each burner}}
{{BURNER}} ({{Intent}}{{#if intentChanged}}, was {{From}} until {{changeDate}}{{/if}}): {{status}}{{#if pace}}, pace {{pace}}%{{/if}}, active 7d {{activeDaysLast7}}/{{expected7}}, last active {{lastActiveAgo}}
{{#each goal}}
{{#if done}}{{title}}: DONE {{doneDate}}{{else}}{{title}}{{#if addedMidQ}} (added {{startDate}}){{/if}}: {{progress}}, {{paceFlag}}{{#if rate}}, {{rate}}{{/if}} | why: {{why|MISSING}} | when: {{whenWhere|MISSING}}{{/if}}
{{else}}
no goals set
{{/each}}
{{#if people}}people: {{people}}{{/if}}
{{/each}}
{{#if energyByType}}energy by day type, quarter so far: {{energyByType}}{{/if}}
{{#if chronic}}OFF TRACK 3+ of last 4 wk ends: {{chronic}}{{/if}}
{{#if lastReview}}LAST REVIEW wk of {{weekStart}}: focus: {{focus|none}}; misses: {{misses|none}}; actions {{done}}/{{total}}{{#if open}}; open: {{open}}{{/if}}{{/if}}
{{#if question}}MY QUESTION: {{question}}{{/if}}
ASK: Where do I stand with {{daysLeft}}d left, judged by intent? Which goals are still realistic, which to shrink or drop, and whether an intent should change (max 2 High). Name the one burner that needs a move now.{{#if question}} Answer my question.{{/if}} Then Suggested actions for the next 7 days.
END OF PACKET

RENDER RULES (not part of the packet)
Shared syntax, formats, paceFlag, field caps, privacy pipeline, and Copy gate from the weekly template. On demand, as of today: computeDashboard(today). No notes in this packet.
crunch: on now ("on now until Oct 2" or "on now, no end") or a period in the last 14 days, "Sep 8 to 9 ("Travel")", plus Ahead parts for periods starting in the next 14 days.
expected7 = RECENT_ACTIVE_DAYS[intent] x non-crunch days in the last 7 / 7 (1 decimal). lastActiveAgo: today, 1d ago, {{n}}d ago, or never. intentChanged: the latest change this quarter for that burner.
progress (quarter to date): number "{{actual}}/{{target}} {{unit}}"; habit "{{actual}}/{{required}} ({{target}}/wk or /mo)"; yes/no "not done"; milestone "steps {{done}}/{{total}}, next: {{nextStep}}".
rate (the check-in's main realism signal): number goals not done "needs {{need}}/wk, last 4 wks {{recent}}/wk" (remaining / weeks to deadline vs amount logged in the last 28 days / 4); weekly habits "last 4 wks {{avg}}/wk" and monthly habits "last 4 wks {{count}}", read against the target rate in progress (a habit's quarter total is never shown as a catch-up number). Omitted for yes/no and milestone.
people: only due soon, due now, OVERDUE, and none logged entries (weekly formats), then "{{n}} ok".
energyByType: same buckets and minimums as the weekly, over the quarter so far. chronic: behind or slipping at 3 or more of the last 4 Sundays, "{{title}} {{n}}/4", max 3.
lastReview: the most recent WeeklyReview: focus, misses joined "; ", and the actions it created, done/total, open texts joined "; ".
question: optional one line the user types before copying ("What should I drop this month?"), cap 200.
Soft budget 4,500 chars (measured sample render with MY QUESTION: 4,166). Trimming ladder: see trimStrategy.
```

## Template: quarterSetup

```
{{PREAMBLE}}

TYPE: quarter setup, {{nextQ}} {{year}}, {{start}} to {{end}} ({{weeks}} wks){{#if theme}} | theme: {{theme}}{{/if}}
{{#if trimmed}}TRIMMED for length: {{trimmed}}{{/if}}
ME: {{aboutMe|not written yet}}
{{#if prev}}
LAST Q {{prevQ}}: progress {{progress}}, consistency {{consistency}}, check-ins {{checkInDays}}/{{daysInQuarter}}d, best streak {{longestStreak}}d, energy {{energyAvg|-}}, goals done {{goalsDone}}/{{goalsTotal}}
{{#each burner}}
LAST {{BURNER}} ({{intentPath}}): {{#each lastGoal}}{{title}} {{pct}}% {{grade|-}} {{decision|undecided}}{{sep "; "}}{{else}}no goals{{/each}}
{{/each}}
{{#if topWins}}LAST Q WINS: {{topWins}}{{/if}}
{{#if repeatMisses}}REPEAT misses last Q: {{repeatMisses}}{{/if}}
{{else}}
LAST Q: first quarter in the app
{{/if}}
CRUNCH history: {{#each pastQuarter}}{{qid}} {{crunchDays}}d{{sep ", "}}{{else}}none logged{{/each}}{{#if ahead}}. Planned: {{ahead}}{{/if}}
{{#if load}}LOAD: draft habits {{draftHabitsPerWeek}}/wk; last Q logged {{normalRate}}/wk in normal wks, {{crunchRate}}/wk in crunch wks{{/if}}
{{#each burner}}
DRAFT {{BURNER}} ({{Intent}}), {{n}} goals:
{{#each draftGoal}}
{{title}}: {{spec}}{{#if rate}} ({{rate}}){{/if}}{{#if carried}}, carried{{#if modified}} and changed{{/if}}, was {{lastPct}}% {{lastGrade}}{{/if}}{{#if customDeadline}}, due {{deadline}}{{/if}} | why: {{why|MISSING}} | when: {{whenWhere|MISSING}}
{{else}}
no goals drafted
{{/each}}
{{/each}}
{{#if checks}}APP CHECKS: {{checks}}{{/if}}
ASK: Stress-test this plan before I commit, up to 250 words, most important first. Flag vague or unmeasurable goals, missing or weak whys and whens, and over-commitment given my crunch history, LOAD, and last Q. Rules: max 2 High, 3 to 4 goals per burner. Say what to cut or shrink. Then Suggested actions as specific edits.
END OF PACKET

RENDER RULES (not part of the packet)
Shared syntax, formats, field caps, privacy pipeline, and Copy gate from the weekly template. Built from the unsaved draft, after quarter close.
prev: quarterHighlights() for the quarter just closed plus each goal's grade and closeDecision. The else branch prints when there is no earlier quarter.
intentPath: "High", or with mid-quarter changes "Steady to High Aug 25" (from intentHistory).
lastGoal: pct = round(fraction x 100); grade A to F or "-"; decision carry, modify, or drop.
topWins: Highlights.topWins, joined "; ", max 5. repeatMisses: miss texts in 3 or more of last quarter's reviews, "{{text}} {{n}} wks", max 3.
pastQuarter: up to 4 most recent quarters with data, newest first, crunch days from CrunchPeriod records ("Q3 8d, Q2 11d").
ahead: CrunchPeriods already starting inside the new quarter, Oct 12 to 16 ("Travel"), joined "; ".
load: shown when any habit goal is drafted. draftHabitsPerWeek = weekly habit targets + monthly targets x 12/52 (1 decimal). normalRate and crunchRate = habit logs per week last quarter in weeks with 0 or 1 crunch days vs 2 or more ("-" if none).
Burners: all four, fixed order, with draft intents (the app already enforces max 2 High).
spec: number "target {{target}} {{unit}}"; habit "{{target}}/wk" or "{{target}}/mo"; yes/no "yes/no"; milestone "steps: {{s1}}, {{s2}}, ..."; a missing target prints "NO TARGET".
rate: goals carried from last quarter put the new ask next to what was delivered: number "needs 13.8/wk, last Q 8.1/wk"; habit "last Q 2.3/wk" (or "/mo"), read against the target already in spec.
why and when: always shown (judging them is the point); MISSING when empty.
checks: checkGoal() warnings in plain words, goal-level "Run 180 miles: no when" and burner-level "Friends (Low) has 4 goals vs Work (High) 3", joined "; ".
Soft budget 5,500 chars (measured sample render with 12 draft goals: 4,495). Trimming ladder: see trimStrategy. Never dropped: any draft goal, why, when, CRUNCH, LOAD, APP CHECKS, ASK.
```

## Template: onboarding

```
{{PREAMBLE}}

TYPE: onboarding, refine my About me profile
LIFE: {{lifeContext|skipped}}
RHYTHM: {{workRhythm|skipped}}
WHO MATTERS: Family: {{whoFamily|skipped}} | Friends: {{whoFriends|skipped}} | Health: {{whoHealth|skipped}} | Work: {{whoWork|skipped}}
WINNING: Family: {{winFamily|skipped}} | Friends: {{winFriends|skipped}} | Health: {{winHealth|skipped}} | Work: {{winWork|skipped}}
ASK: Up to 300 words. First, up to 3 gaps or tensions you see (a burner with no clear win, a rhythm that collides with home). Then a line "About me:" and my profile in first person, at most 450 characters, one short line each for Life, Rhythm, Family, Friends, Health, Work, using only facts I gave and no work specifics. Then Suggested actions for setting up my first quarter.
END OF PACKET

RENDER RULES (not part of the packet)
Shared syntax, field prep, privacy pipeline, and Copy gate from the weekly template.
Each field is one onboarding interview answer (Profile.answers by question id), collapsed to one line, cap 400 chars after field prep. An unanswered field prints "skipped" so the coach can flag the gap.
whoFamily and whoFriends: key people entered in the interview with cadence, "Mom (every week), Dad (every 2 weeks)", plus any free text. whoWork: the interview asks for roles, never names ("my CEO, a team of 4").
Reply handling: the lines after "About me:" up to a blank line or "Suggested actions:" are offered as "Use as my profile", editable before saving to Profile.aboutMe; nothing is saved without a tap. The 450-char limit matches the ME cap in every later packet. Suggested actions become first-quarter setup reminders, not weekly actions.
Soft budget 3,000 chars (measured sample render: 2,130). Field caps bound the maximum near 4,700, so no trimming ladder.
```

## Trimming strategy

- Budgets are in chars of the final redacted string, which is exactly what the preview shows and Copy copies: onboarding 3,000, weekly 5,000, check-in 4,500, quarter setup 5,500. Measured sample renders: 2,130, 4,707, 4,166, 4,495. A packet over budget shows amber with its count. Copy is never blocked for length, since even 10,000 chars is fine for a free-tier Claude message.
- Mechanism: never cut the finished string. Each ladder step is a flag on the render input. Re-render, run finalizePacket (dash sanitize, then redact), re-measure, and stop at the first step that fits. Each step applied is appended to PacketStats.trimmed and printed on the TRIMMED for length line, so Claude knows what is missing.
- Field caps run first, inside field prep, after sanitize and redact, cut at a word boundary plus '...': aboutMe 450, goal title 60, why and when 90, note 90, win and miss 100, action 80, crunch label 30, reason 60, question 200. Because redaction runs before cutting, a cap can never leave half a sensitive term behind.
- Weekly ladder, in order: 1) notes down to 1 per goal, then 3 per packet; 2) drop the energy by day type line; 3) collapse fresh people into a trailing 'N ok'; 4) drop when on on-track goals; 5) drop why on on-track goals; 6) drop REPEAT misses; 7) drop the active days trend row; 8) cut ME to 250; 9) drop the remaining notes.
- Weekly never drops: preamble, TYPE, TRIMMED, CRUNCH, DAYS, WEEK, LAST WK ACTIONS, all four burner lines, every goal's progress and pace, why and when on behind or slipping goals, WINS, MISSES, OFF TRACK, ASK, END OF PACKET.
- Check-in ladder: 1) drop energy by day type; 2) drop when on on-track goals; 3) drop why on on-track goals; 4) drop misses from LAST REVIEW, then the whole line; 5) cut ME to 250. It never drops TYPE, CRUNCH, NOW, burner lines, goal progress, pace, or rate, off-track why and when, OFF TRACK, MY QUESTION, ASK, or END OF PACKET.
- Quarter setup ladder: 1) drop LAST Q WINS; 2) drop REPEAT misses; 3) cut milestone step lists to the first 3 steps plus '+N more'; 4) drop pct from the LAST burner lines, keeping grade and decision; 5) cut ME to 250. It never drops any draft goal, spec, rate, why, when, CRUNCH, LOAD, APP CHECKS, ASK, or END OF PACKET.
- Onboarding has no ladder: 11 answer fields capped at 400 chars keep it under about 4,700.
- If a packet is still over budget after the last step, keep it and show it amber. The ladder only removes detail, never structure, so the packet stays valid and still ends with END OF PACKET.

## Rendered weekly example (4707 chars)

```
FOUR BURNERS COACH v1
Be my executive coach: candid, direct, warm, clearly in my corner. Ground every point in my numbers and words; do not recap. Under 180 words plus actions. Plain text: no markdown, filler, generic motivation, em or en dashes. At most one question.
Judge each burner by its intent: light activity on a Low burner is on track.
Crunch days (travel, deals) have lower expectations built in: do not pile on; suggest the smallest move that keeps a burner lit.
If a goal is behind or slipping, remind me of its why, in my words.
Work: habits and priorities only. Never ask about clients, deals, or firms, or guess what [redacted] hides.
pace = % of where my intent expects me by now. active x/y = active days vs expected.
If END OF PACKET is missing, say the paste was cut off.
End with 2 or 3 actions, each with a day or trigger, nothing after:
Suggested actions:
- Burner: action

TYPE: weekly review, Sep 14 to 20, 2026 | Q3, 10d left | theme: Present
ME: Exec in RIA acquisitions and business development. Married, kids 8 and 11. Travel 1 to 2 wks a month; deal periods eat evenings. Winning: home for bedtime, strong at 50, friendships that last, deals from thinking not reacting.
CRUNCH: Thu ("Closing day"). Ahead: Wed Sep 23 to Fri Sep 25 ("Travel: West Coast")
DAYS (energy 1 to 5): Mon 3, Tue 3, Wed 2, Thu 2 crunch, Fri -, Sat 4, Sun 4
WEEK: check-ins 7/7, streak 19d (best 26), energy 3.0 (prior wk 3.4), progress 85, consistency 86
LAST WK ACTIONS: 2/3 done; open: Invite Priya and Sam to dinner (Friends)
FAMILY (High): on track, pace 94%, active 5/3.4
Date night: mo 1/2, wk 1 (Fri), pace 100% | why: We are a team first. Protect time that is just us. | when: Second and last Friday, somewhere new | notes: Fri "Tacos and a long walk after"
Bedtime with the kids: wk 2/3 (Mon Wed), pace 91% | why: These years go fast and they will not ask forever. | when: Home by 7 on Mon, Wed, Thu
Plan the winter family trip: steps 3/4, next: Share the itinerary, pace 91% | why: Something to look forward to together. | when: Sunday evenings with coffee
people: Mom call Tue, in person Sun; Dad OVERDUE 23d (every 14d); Katie (sister) ok
FRIENDS (Low): slipping, pace 50%, active 1/0.9
Call a close friend: wk 1/1 (Thu), pace 100% | why: Friendships fade quietly if I do not tend them. | when: Drive home on Thursdays
Host a dinner: yes/no, not done, pace 0% SLIPPING | why: Our house should be where people gather. | when: A Saturday in September
people: Jake call Thu "He is thinking about moving"; Priya OVERDUE 44d (every 30d); Elena due soon 50d (every 60d); Marcus ok
HEALTH (Steady): behind, pace 85%, active 3/2.1
Run 150 miles: 101.8/150 miles, wk +11.3 (Tue Sat), pace 97% | why: I want to feel strong at 50, not just get there. | when: Tue, Thu, Sat mornings before 7 | notes: Tue "Legs felt heavy"
Strength training: wk 1/3 (Mon), pace 77% BEHIND | why: Energy for the people who count on me. | when: Hotel gym or garage, 6 AM
Lights out by 10:30 (added Jul 31): wk 3/5 (Mon Tue Sat), pace 80% BEHIND | why: Everything is easier after a real night of sleep. | when: Phone on the charger in the kitchen at 10
WORK (High): behind, pace 88%, active 4/3.4
Deep work blocks: wk 4/4 (Mon Tue Wed Fri), pace 94% | why: The best deals come from thinking, not reacting. | when: 8 to 10 AM, calendar blocked, door closed | notes: Wed "Got pulled into a call at 9:15"; Fri "Wrote the [redacted] memo in one pass"
Read 3 industry books: 2/3 books, wk 0, pace 81% BEHIND | why: Stay the sharpest person in the room. | when: Flights and Sunday mornings
WINS: Protected all four deep work blocks; Date night even in closing week; Long call with Jake
MISSES: Phone in bed again; Skipped strength training twice; Never sent the dinner invite
PRIOR 4 WKS, oldest first (Aug 17, Aug 24, Aug 31, Sep 7)
progress 89 88 86 86
check-ins 7 6 7 6
energy 3.6 3.2 3.5 3.4
crunch days 0 2 0 0
actions done 3/3 2/3 1/3 2/3
active days: Family 5 4 5 4, Friends 2 1 1 1, Health 5 3 4 4, Work 3 5 5 4
energy by day type, last 5 wks: crunch 2.3 (3d), weekday 3.2 (17d), weekend 4.0 (9d); with a Health log 3.7 (15d), without 3.0 (14d)
OFF TRACK 3+ of last 5 wk ends: Host a dinner 5/5, Strength training 4/5, Lights out by 10:30 3/5
REPEAT misses: Phone in bed again 3 of 4 wks; Skipped strength training twice 2 of 4 wks
INTENT changes: Aug 25: Health High to Steady (Knee is sore, backing off mileage for a few weeks); Work Steady to High (Two closings land this month); Friends Steady to Low (Making room for the closings)
ASK: Coach my week against my intents: what held up, the one pattern that matters most, and what to let go. Plan next week around the crunch ahead. Then Suggested actions.
END OF PACKET
```

## Onboarding interview

- **life_context** (text) "Your life right now": The short version: who is at home, where home base is, and what this season of life feels like. Placeholder: "Married to Sarah, two kids, 9 and 12. Home base is Charlotte, but I am on a plane most weeks. Work is the busiest it has been, and I want to be more present at home than I was last year.". Field: lifeContext
  - Notes: A welcome screen comes first: 'A few questions so your coach knows you. About 4 minutes. Talk or type, and skip anything.' It has 'Begin' and a quiet 'Later' link. Every screen has a headline, one prompt, and a large auto-growing textarea. The textarea uses the standard iOS keyboard, autocapitalizes sentences, and has no maxLength, so dictation is never cut off. A soft counter appears after 300 characters. The field is focused when the screen opens, so the keyboard mic is one tap away. Next is pinned within thumb reach, plus Back and Skip. optional=false marks a core question: Skip is still there but quieter, and About me later shows 'Add this' for it. Answers autosave on every change to kv 'onboarding' ({ step, answers, completedAt? }). The route joins the remembered flows, so leaving the app resumes on the same screen. There are 11 screens and one is a single tap, so about 4 minutes when spoken.
- **family_people** (people) "Who matters at home": Name the family you most want to show up for, and roughly how often you want real time with each. Placeholder: "Sarah, every week. Maya and Luke, every week. Mom, every week. Dad and my sister Katie, every two weeks.". Field: burners.family.matters
  - Notes: Live chips under the field show names as they are heard. They are read-only here to keep the interview fast. In the Key people setup step, parsePeople(text, 'family') turns the profile's Family people line into PersonDraft rows { name, burner: 'family', cadenceDays, include: true }. Parsing rules: split into clauses on periods, semicolons, and line breaks. A cadence phrase applies to every name in its clause: daily or every few days = 3 (the shortest CADENCE_OPTIONS value), weekly or every week = 7, every two weeks, every other week, or twice a month = 14, monthly = 30, every couple of months = 60, quarterly or a few times a year = 90. Names split on commas, 'and', '&', and 'plus'. 'my sister Katie' or 'Katie, my sister' becomes 'Katie (sister)', and a bare 'my mom' becomes 'Mom'. With no cadence phrase, Family defaults to weekly (7). Fragments over 4 words go to a 'Did we miss anyone?' line instead of becoming people. Duplicates, and names that match existing people, are merged by name. Nothing becomes a Person until it is confirmed in setup.
- **family_winning** (text) "Winning at home": Picture the last day of the quarter. What happened at home that makes it a win? Placeholder: "Home for dinner most nights I am in town. Two real date nights a month. The kids would say I was around, and the winter trip is booked.". Field: burners.family.winning
  - Notes: Shown as 'Your words' above Family in the Intents and Goals setup steps. It also seeds Family goal suggestions, for example Date nights as a Habit, 2 per month.
- **friends_people** (people) "Your people": Which friends do you want to stay close to? Say their names and roughly how often you want to connect. Placeholder: "Jake, every two weeks. Priya and Marcus, monthly. Elena, every couple of months.". Field: burners.friends.matters
  - Notes: Same parsing as family_people, with burner 'friends' and a default cadence of monthly (30) when no cadence is spoken. A group such as 'the college group chat' stays as one entry, since a Person is only a name. The Key people step lets any row move between Friends and Family.
- **friends_winning** (text) "Winning with friends": What would make you feel like a good friend by the end of the quarter? Placeholder: "I reached out before they had to. We hosted one dinner at our place, and I made the October golf weekend.". Field: burners.friends.winning
  - Notes: Seeds Friends goal suggestions, for example 'Host a dinner' as a Yes/No goal. It also tells the coach what friendship means to this user, so nudges about overdue people land as care rather than guilt.
- **health_focus** (text, optional) "Health, honestly": What does Health cover for you right now? Training, sleep, food, stress, and anything you are working around. Placeholder: "Running and lifting keep me sane. Sleep falls apart on the road. My left knee complains if I add miles too fast.". Field: burners.health.matters
  - Notes: This is framing, not people. A trainer or doctor mentioned here stays as text, because key people are Family or Friends only. Injuries and limits here help the coach avoid pushing volume.
- **health_winning** (text) "Winning at health": What would a winning quarter look like for your body and your energy? Placeholder: "Three workouts a week, even on travel weeks. Lights out by 10:30 most nights. A half marathon on the calendar for spring.". Field: burners.health.winning
  - Notes: Seeds Health goal suggestions. Counts per week map to Habit goals and totals with units map to Number goals.
- **work_focus** (text, optional) "Work at 30,000 feet": Your role in a sentence or two, and what Work should never cost you. Keep it general: no client, firm, or deal names. Placeholder: "I lead acquisitions and business development for a wealth management firm. It is relationships, judgment, and follow-through. Work should never cost me bedtime with the kids or my Saturday long run.". Field: burners.work.matters
  - Notes: Helper line under the field: 'Your coach never needs client or deal specifics. Habits and priorities are enough.' The live sensitive-term warning applies as soon as any terms exist. Capitalized words in this answer are offered as candidate sensitive terms in the setup flow. The 'never cost me' part gives the coach the user's own boundary to hold them to.
- **work_winning** (text) "Winning at work": What does a winning quarter at work look like? Think habits and priorities, not deal specifics. Placeholder: "Deep work four mornings a week. Follow up on everything within a day. Out of the office by 6:30 when I am home. Fewer reactive days, more thinking time.". Field: burners.work.winning
  - Notes: Uses the same helper line and sensitive-term warning as work_focus. Seeds Work goal suggestions, for example Deep work as a Habit, 4 per week.
- **travel_rhythm** (choice) "Time on the road": How much do you travel for work in a typical quarter? Placeholder: "Most weeks". Field: travel. Options: Rarely | A trip or two a month | Most weeks | More away than home
  - Notes: Large tappable rows. One tap saves and advances, and tapping again changes the answer. Stored as the enum rare | monthly | weekly | mostly_away (null if skipped). It drives four things: travel-proof when/where chips in the Goals step, the gentle two-High note in Intents, the over-commitment note when there are more than 10 goals, and the coach's travel context before any crunch history exists.
- **crunch_pattern** (text, optional) "Deal season": When a deal period gets intense, what does it look like, how often does it happen, and what slips first? Placeholder: "A few times a year a closing takes over for two or three weeks: late nights, early flights. Workouts and friend calls slip first. Bedtime with the kids is the one I protect.". Field: crunch
  - Notes: No deal details. This is the last screen, so Next reads 'See my profile'. The 'what slips first' part tells the coach which burner to protect during crunch weeks. If the answer suggests a crunch is happening now ('right now', 'this week', 'this month', 'currently'), the Ignite step offers Travel/Crunch mode. It is always an offer and never automatic.

### Profile fields

- version (1): Schema version for future migrations. The profile is stored in db.kv under key 'aboutMe'. kv rows already carry updatedAt, so Phase 5 last-write-wins sync works with no Dexie version bump. Interview progress is stored separately in kv 'onboarding'. Everything in About me is packet-visible after redaction, and the About me screen says so.
- lifeContext (string): Life right now: household, home base, and the current season. Comes from life_context. Packet label 'Life'. Empty string when skipped.
- burners (Record<BurnerId, BurnerProfile>): One BurnerProfile per burner. All four keys are always present, with empty strings when a question was skipped, so packets and the Swift mirror can iterate BURNERS.
- burners[b].matters (string): Family and Friends: who matters and how often, kept as spoken names with cadence. This is the source text for key-people parsing, while Person records stay the source of truth for people after setup. Health: what Health covers. Work: role at altitude and what Work must never cost. Packet labels are 'Family people', 'Friends people', 'Health focus', and 'Work focus'.
- burners[b].winning (string): What a winning quarter looks like for that burner, in the user's words. Packet labels are 'Family win', 'Friends win', 'Health win', and 'Work win'. Shown as 'Your words' in quarter setup and used to seed goal suggestions.
- travel ('rare' | 'monthly' | 'weekly' | 'mostly_away' | null): Work travel rhythm from the choice question, or null when skipped. Display labels are Rarely, A trip or two a month, Most weeks, and More away than home.
- crunch (string): What intense deal periods look like, how often they happen, and what slips first. No deal details. Packet label 'Crunch'.
- source ('interview' | 'edited' | 'coach'): What last shaped the profile: the interview, a manual edit in About me, or a pasted Claude revision.
- updatedAt (Instant): UTC timestamp of the last change, used for sync.
- previous (Omit<AboutMe, 'previous'> | undefined): A one-level snapshot taken before a one-tap coach replace or a re-run of the interview, so About me can offer 'Restore previous version'.

### ABOUT ME block format and parsing

BLOCK FORMAT
The same block is used in both directions: the app renders it into packets, and Claude returns a revised copy.
ABOUT ME
Life: <text>
Family people: <names with how often>
Family win: <text>
Friends people: <names with how often>
Friends win: <text>
Health focus: <text>
Health win: <text>
Work focus: <text>
Work win: <text>
Travel: <Rarely | A trip or two a month | Most weeks | More away than home>
Crunch: <text>
END ABOUT ME

LABEL TO FIELD MAP
Life = lifeContext
Family people = burners.family.matters
Family win = burners.family.winning
Friends people = burners.friends.matters
Friends win = burners.friends.winning
Health focus = burners.health.matters
Health win = burners.health.winning
Work focus = burners.work.matters
Work win = burners.work.winning
Travel = travel (display label mapped to the enum)
Crunch = crunch

RENDERING INTO PACKETS (placeholders)
1. Values are the redacted profile. Sensitive terms become numbered tokens like [redacted 1]. The token to term mapping is stored on device with the saved packet record and is never put inside the packet.
2. Newlines inside a value collapse to spaces, so each field stays on one line.
3. Each value is capped at 400 characters, cut at a sentence boundary. An empty field renders as the bare label with nothing after the colon. A null travel value renders empty.
4. {{quarterLine}} renders like: 'Today is Sat, Sep 26, 2026. My first quarter in the app is Q4 2026 (Oct 1 to Dec 31).'
5. {{skippedLine}} renders as 'Empty lines are questions I skipped. You may ask about one of them.' It is removed entirely when nothing was skipped.
6. {{travelLabel}} is the display label. Every other placeholder is the matching field value.
7. The same header and profile block are reused as the profile section of the weekly, quarter setup, and mid-quarter packets.
8. The packet length is shown before copying.

PARSING
A pure domain function parseAboutMe(text, current, redactionMap) returns { ok, patch, changedFields, warnings }.
1. Packet guard. If the pasted text contains 'FOUR BURNERS COACHING PACKET', the clipboard still holds the packet itself. Show 'This is the packet, not Claude's reply. Copy the reply in Claude and paste again.' and stop.
2. Normalize. Convert CRLF to LF, strip zero-width characters and non-breaking spaces, drop code fence lines (```), and treat full-width colons as colons.
3. Markers. For each line, strip markdown characters (*, _, #, >) and any trailing parenthetical, then lowercase it and remove non-letters. 'aboutme' is a start line. 'endaboutme' or 'endofaboutme' is an end line. So '**ABOUT ME**', 'ABOUT ME:', and 'About me (revised)' all start a block, but prose like 'Here is your revised About me:' does not.
4. Block choice. A candidate block runs from a start line to the next end line, the next start line, or the end of the text. Use the LAST block with at least 3 recognized labels, so the newest revision in a pasted conversation wins. If there are no markers but 5 or more recognized label lines exist, parse those and warn 'Markers missing, check before replacing.' If no end line was found, warn 'Reply may be cut off.'
5. Lines. Drop leading bullets or numbering (-, *, a bullet dot, '1.', '1)') and bold or italic markers, then split at the first colon. Lowercase the label, remove non-letters, and look it up in this alias map:
   life, lifecontext = Life
   familypeople, familywhomatters, family = Family people
   familywin, familywinning, winningathome = Family win
   friendspeople, friendswhomatter, friends = Friends people
   friendswin, friendswinning = Friends win
   healthfocus, health = Health focus
   healthwin, healthwinning = Health win
   workfocus, work, workbigpicture = Work focus
   workwin, workwinning = Work win
   travel, timeontheroad = Travel
   crunch, crunchperiods, dealseason = Crunch
   A line whose label is not in the map continues the previous field and is appended with a space. That keeps 'Out by 6:30 when home' and values wrapped onto the next line intact. Lines before the first known label are ignored.
6. Values. Trim, strip wrapping quotes, and collapse whitespace. Replace any em dash with a comma. Replace an en dash between numbers with ' to ', and any other en dash with a comma, so the no-dash rule holds even if Claude slips. 'none', 'n/a', 'unknown', 'not provided', 'tbd', and '(blank)' count as empty. Cap each value at 600 characters.
7. Travel. Match keywords, most specific first:
   'more away', 'mostly away', 'constant', 'always' = mostly_away
   'most weeks', 'weekly', 'every week' = weekly
   'month', 'trip or two', 'few trips' = monthly
   'rare', 'seldom', 'hardly' = rare
   With no match, keep the current value and add a warning.
8. Redaction tokens. Restore each [redacted N] to its original term using the mapping saved with the packet that was copied, so the profile on device keeps its real wording. A token with no mapping stays as written and is flagged.
9. Merge. A field that is missing from the block, or empty in it, keeps its current value. Claude can never wipe a field; clearing is a manual edit. changedFields lists every field whose cleaned value differs from the current one.
10. Result. ok is true when at least 3 fields were recognized. If ok is true and nothing changed, show 'No changes to your profile.' If ok is false, still save the reply to coach history and show 'No profile found in this reply.' with a 'Paste again' button.

ONE TAP REPLACE
After a paste, a card reads 'Claude revised your About me: 6 changes'. It has 'Replace my profile' as the primary button and 'Review changes', which expands a before and after view for each changed field, with a checkbox to untick any field. Replace does four things: stores the current profile in previous, sets source to 'coach' and updatedAt to now, shows a 5 second Undo toast, and leaves 'Restore previous version' available in About me. The full reply is always saved to coach history as kind 'onboarding'.

### First quarter flow

- About me review. The interview ends on one scrollable page titled 'Here is you, in your words'. It shows the 11 answers as short editable cards grouped by burner, with autosave and dictation-friendly fields. Skipped core questions show a quiet 'Add this' row. This page saves the AboutMe profile with source 'interview'. Prefill: everything, straight from the answers.
- Private names (optional, about 20 seconds). The screen asks: 'Any names that should never leave this phone? Your firm, clients, targets.' Terms added here go into the Settings sensitive terms list before any packet exists, so the very first packet is already redacted. Prefill: candidate chips only. Candidates are capitalized words from the Work and Crunch answers that are not at the start of a sentence, not days or months, and not names parsed as family or friends. Nothing is added until tapped.
- Refine with Claude (optional, skipped in one tap). This step shows the exact Onboarding packet text and its length, then Copy for Claude. Copy tries to open the Claude app, and otherwise shows 'Now open Claude and paste'. When the user comes back, the Paste coach reply field opens automatically. The reply is saved to coach history, the ABOUT ME block is parsed, and 'Replace my profile' applies it in one tap with Undo. The route is a remembered flow, so leaving for Claude resumes on this step. Prefill: the packet is built entirely from the profile.
- Pick the quarter. The default is the current calendar quarter. If 21 or fewer days remain, the default switches to next quarter. For example, on Sep 26 only 4 days are left in Q3, so the screen asks 'Q3 ends in 4 days. Start clean with Q4 on Oct 1?' with a secondary 'Use the rest of Q3'. Proration already judges late-added goals fairly either way. Implementation note: SetupScreen only auto-creates the current quarter today, so this step must create the next quarter record. Prefill: the choice comes from today's date.
- Theme. This is the existing optional Theme step. Prefill: up to 3 suggested chips, shown ahead of the standard ideas and ranked by keywords in the Life and win answers. The keyword groups are: present, around, home = Present; strong, energy, body = Strong; tired, reset, burned out = Reset; fewer, simplify, focus = Less but better; routine, habits, build = Foundations; big year, push, grow = Momentum. The field stays empty until the user taps a chip or types.
- Intents. This is the existing Intents step, and every burner starts Steady (DEFAULT_INTENTS). Each burner card shows the first sentence of its win answer as 'Your words', so the choice is made against what the user said. canSetIntent enforces the max-2-High cap: a third High is disabled and shows the existing message. If travel is 'weekly' or 'mostly_away' and 2 burners are High, a gentle note appears: 'Two Highs with most weeks on the road is a lot. It can work if the goals are lean.' The note never blocks. Prefill: no intent values by design; the context lines come from the answers.
- Key people. This step comes before Goals so that Family and Friends goals can link people. It shows PersonDraft rows parsed from the profile's Family people and Friends people lines, after any Claude refinement, grouped under Family and Friends. Each row has an editable name, a cadence pill using CADENCE_OPTIONS, an include toggle that is on by default, and a 'Move to Friends' or 'Move to Family' action. There is also '+ Add someone'. Leftover clauses appear under 'Did we miss anyone?', and names that match an existing person are marked 'Already added'. Confirm creates Person records through addPerson in the order they were spoken. Prefill: names, burner, and cadence all come from the answers.
- Goals. This is the existing Goals step and GoalEditor, one section per burner. Each section opens with that burner's win answer as 'Your words' and up to 3 'From your words' suggestion chips parsed from it. Examples: 'Three workouts a week' = Habit, Workouts, 3 per week. 'Two real date nights a month' = Habit, Date nights, 2 per month. 'Most nights' = 5 per week, or 3 when travel is weekly or mostly away. A count with a unit = Number. A short clause with book, plan, host, finish, or sign up = Yes/No or Milestone. Tapping a chip opens GoalEditor prefilled with title, type, target, and period. Why: tap-to-use hints, taken from sentences in the Life, focus, and win answers that contain want, because, never, matters, or protect. When/where: chips tuned to travel and burner, such as 'Hotel gym or garage, 6 AM', '8 to 10 AM, calendar blocked', or 'Home by 7 on non-travel nights'. Family and Friends goals offer the confirmed people to link. goalSlot and checkGoal apply as usual: 3 suggested, 4 max, and a fifth blocked, with warnings for a missing why, when/where, or target, and for a Low burner outweighing a High one. With heavy travel, more than 10 goals in total shows a gentle over-commitment note. Prefill: suggestions and hints only; nothing is saved until the user confirms in GoalEditor.
- Pressure test (optional). Before lighting the quarter, offer the Quarter setup packet: the profile block plus draft intents and goals with their why and when/where. For a first quarter it says 'This is my first quarter in the app, so there are no past results. Use my Travel and Crunch lines to judge over-commitment.' The reply is saved to the quarter, and any changes are made by hand in the Goals step. Prefill: the packet is built from the profile and the drafts.
- Ignite. This is the existing Ignite step and finishSetup. It also sets kv 'onboarding'.completedAt and clears the remembered flow. Two final one-tap offers follow, both skippable. First, the weekly review day, prefilled with Sunday (the current default). Second, if the Crunch answer suggests a crunch is happening now, 'Turn on Travel/Crunch mode?' via startCrunch, which is always an offer and never automatic. The flow then lands on the dashboard with the flames lit.

## Reply parsing

Instruction:

> End your reply with a line that says exactly "Suggested actions:" and then 2 or 3 lines, each starting with "- " plus a burner name (Family, Friends, Health, or Work) and a colon, followed by one concrete action I can do next week in under 12 words, for example "- Health: Run Tuesday and Thursday before the office". Put any closing thought before that line so the list is the very last thing in your reply, and keep the list plain: no bold, no numbering, no sub-bullets, no questions.

Rules:

- R1. Scope and storage. Save the pasted reply raw and unchanged. Run parseSuggestedActions(raw) each time the reply is shown, so later parser fixes also improve old replies. Make it a pure function in src/domain/coachReply.ts (domain layer, easy to mirror in Swift). It returns { actions: { text: string; burner?: BurnerId }[]; source: 'heading' | 'weak-heading' | 'fallback' | 'none' }. It never adds anything by itself. The UI shows each action as a '+ text' chip with its MiniFlame, and one tap adds it through addAction(actionsWeekFor(review.weekStart), text, burner).
- R2. Normalize the text. Turn CRLF and lone CR into LF, and U+2028/U+2029 into LF. Remove U+FEFF, U+200B and U+2060, but keep U+200D because it joins emoji sequences. Turn U+00A0, U+202F, U+2007 and other Unicode spaces into a plain space. Expand tabs to 4 spaces and trim trailing whitespace on every line. A line that is only a code fence (``` or ~~~, with or without a language tag) becomes a blank line, and the content inside the fence is kept. Remove leading blockquote markers ('> '). A horizontal rule (a line made only of 3 or more '-', '*' or '_') becomes a blank line and also ends any list. If the text contains the packet end sentinel line (a fixed constant shared with the packet builder, e.g. '(End of Four Burners packet)'), drop everything up to and including its last occurrence. Parse only the last 400 lines.
- R3. Find list-item lines. After indentation, a line is an item if it starts with any of these: '-', '*' or '+' followed by a space; one of the glyphs '•', '·', '‣', '◦', '▪', '▫', '●', '○', '■', '□', with or without a space after it; U+2013 or U+2014 followed by a space; a number from 1 to 99 followed by '.' or ')' and a space; '(n)' and a space; a keycap emoji (digit, optional U+FE0F, then U+20E3); one of the checkbox glyphs '☐', '☑', '☒', '✓', '✔', '✅'; or a bare checkbox '[ ]', '[]', '[x]' or '[X]' followed by a space. After a bullet or number marker, also remove one optional checkbox '[ ]', '[x]' or '[X]'. Checked or not, the item is still offered. A line that starts with one emoji (Extended_Pictographic, with optional U+FE0F, skin tone or ZWJ sequence) and a space counts as an item only if it sits under a detected heading or belongs to a run of 2 or more emoji-led lines. These are NOT items: '*text*' (italic, no space after the asterisk), '-5 lbs', numbers above 99 ('2026. It was'), and horizontal rules.
- R4. Group items into blocks. Consecutive items form one block. A block continues past blank lines only if the next non-blank line is an item of the same marker family (bullet, number, checkbox, emoji) and the numbering does not restart at 1. An indented non-item line right after an item is a continuation and is ignored as elaboration. The one exception is a hard wrap: if the item line ends without terminal punctuation and the continuation starts with a lowercase letter, join them with a space. An unindented non-item line ends the block at once, even with no blank line before it, so a closing sentence is never glued onto the last action. Do not apply CommonMark lazy continuation.
- R5. Nesting. The base level is the smallest indent in the block. An item indented 2 or more spaces deeper than the previous shallower item is its child. Rendered copies often lose indentation, so a secondary glyph ('◦', '▪', '▫', '○') that follows a primary marker ('•', '-', '*', or a number) is also a child. Children of a normal item are dropped as elaboration. If the parent's cleaned text ends with ':' or is only a burner label ('**Health**', 'Family:'), drop the parent and move its children up to top level. Moved-up children inherit a burner when the parent is a burner label, or when the parent contains exactly one capitalized burner name ('Pick one of these for Health:'). Apply the same rule to grandchildren against their own parent.
- R6. Detect headings. Take each non-item line, plus the text before the first colon on any line, and normalize it: strip leading '#' marks, blockquote marks and a leading emoji; strip wrapping **, __, * or _; strip a trailing ':' and then a trailing parenthetical ('(pick two)'); straighten quotes, collapse spaces, and lowercase. STRONG keywords: action(s), action items, suggested/recommended/concrete actions, next steps, action steps, to-do/todo, try ('try this week', 'things to try'), moves, experiments, 'quick wins'. WEAK keywords: 'this week' (including "this week's"), 'next week', 'the week ahead', 'coming week', 'plan'. NEGATIVE keywords override both tiers: went well, wins (except 'quick wins'), misses/missed, slipped/slipping, noticed, what I see, stood out, working/worked, pattern(s), question(s), recap, summary, numbers, data, observation(s), reflection(s), last week. A heading must stand alone: at most 8 words and 60 characters, and it either ends with ':', is a markdown '#' heading, is fully wrapped in bold or italics, or is followed by a list block (after at most one blank line). A longer line (up to 20 words) that ends with ':' and contains a STRONG keyword ('Here are three things to try next week:') counts as a WEAK heading.
- R7. Which list belongs to a heading. A heading owns the first list block that starts after it, as long as at most one non-blank, non-item line (120 characters or fewer) sits between them and no other heading does. Inline form: a STRONG heading may have text after its colon on the same line ('Suggested actions: call Mom Sunday; run Tuesday'). If that heading owns no list block, split the remainder on ';' and on inline enumerators ('1)', '(2)', '2.') and treat each part as an item. Never split on commas or colons. If a list block does follow, ignore the inline remainder, so 'Suggested actions: here are three' does not produce an action.
- R8. Choose exactly one block. (a) Use the LAST strong-headed block that yields at least one valid action. (b) If there is none, use the LAST weak-headed block that yields at least one valid action. (c) Otherwise fall back to the LAST list block in the reply, skipping blocks where at least half the items end with '?'. Return [] and stop (do not look further back) if either of these is true for that fallback block: the nearest non-blank line above it ends with ':' and matches a NEGATIVE keyword; or at least half its items start with a pronoun or determiner (you, your, you're, i, i'm, my, we, our, it, it's, this, that, these, those, the, there, he, she, they, their). In fallback, emoji-led lines only count as a run of 2 or more.
- R9. Clean each item, in this order. (1) Remove the marker, the checkbox, and any leading emoji or keycap. (2) Bold lead: if the item starts with **X** or __X__ and more text follows, keep 'X: rest' when X ends with ':' (or a ':' comes right after the closing marks). Otherwise keep only X, which drops the rationale. (3) Strip leftover markdown: bold and italic wrappers (but not underscores or asterisks inside words or URLs), `code` ticks, ~~strike~~ marks, and [text](url) links, which become their text. (4) Strip a leading qualifier: 'Bonus:', 'Optional:', 'Stretch:', 'Extra:'. (5) Burner tag: if the text starts with Family, Friends, Health or Work (any case) immediately followed by ':', or by a spaced hyphen, U+2013, U+2014 or '|', set burner and remove the tag. Do this once only, so 'Health: Three runs: Tue, Thu, Sat' keeps its second colon. Otherwise, if the text ends with '(Health)' or '[Work]' style, set burner and remove that suffix. (6) Dashes: U+2014, U+2015 and '--' (spaced or not) become ', '. A spaced U+2013 or spaced ' - ' also becomes ', ', except between digits, where '8 - 10' becomes '8-10'. An unspaced U+2013 becomes '-'. Remove any dash left at the very start or end. Then collapse ', ,', ' ,' and double spaces. (7) Remove quotes that wrap the whole item. Strip trailing '.', ',', ';', ':' and a trailing ellipsis ('...' or U+2026), but keep the period of a trailing 'a.m.', 'p.m.' or 'etc.'. (8) If the first word is all lowercase, uppercase its first letter ('call Mom' becomes 'Call Mom'; 'iPhone' is left alone).
- R10. Length. If the cleaned text is over 90 characters and has a sentence break, keep only the first sentence and re-apply R9 step 7. A sentence break is '. ' or '! ' followed by an uppercase letter or digit, but not after Dr, Mr, Mrs, Ms, St, vs, e.g, i.e, a.m, p.m, or a single letter. If the text is still over 120 characters, cut it at the last word boundary before 117 characters and append '...'.
- R11. Validity. Drop an item if it ends with '?', has fewer than 2 words or fewer than 6 characters, has no letters, is only a burner label, or is itself a heading or meta line ('Suggested actions', 'Pick one', 'Pick two', 'Choose one', 'Any of these').
- R12. Dedupe. The key is: lowercase, curly quotes straightened, burner tag removed, and everything except letters, digits and single spaces removed. Keep the first occurrence. If it has no burner and a later duplicate does, take that burner.
- R13. Cap and UI filtering. Keep the first 5 actions in reply order, counted after dedupe. In the UI, hide chips whose key matches an action already saved for that week, using the same key function (it replaces the plain toLowerCase comparison in ActionsStep). Disable the chips once the week holds MAX_ACTIONS (7). Show the chips only for weekly review and mid-quarter check-in replies.
- R14. Fixture convention. Each fixture name ends with [burners: ...], listing the expected burner for each extracted action in order ('none' means untagged). Fixtures whose expected result is empty have no tag. The expected arrays hold the cleaned text only.

Edge cases:

- Two copy paths on iOS give different text. The Claude app's copy button gives markdown source (**, '- ', '1.'). Selecting text gives rendered text: bullets become '•', often followed by U+00A0; bold markers disappear; nested bullets become '◦' or '▪' with little or no indentation. The fixtures cover both, but check once on a real iPhone.
- Lazy continuation trap: CommonMark would glue an unindented line after a list item onto that item. Doing the same here would turn closing lines like "That's it. Deal weeks end..." into part of the last action. An unindented non-item line must end the block.
- Real actions are full of colons: times (10:30), labels ('Three runs: Tue, Thu, Sat'), rules ('Calendar rule: nothing before 9'). Strip a burner tag only when the text before the first colon is exactly one of the four burner names, and only once. Never split items on colons or commas.
- 'work' is a common word ('pick what will work', 'work out Tuesday'). Item tags need the burner word followed directly by ':' or a spaced dash. Inheriting a burner from a parent line needs the capitalized name.
- Sentence splitting and trailing-period stripping must respect abbreviations and decimals: 'Dr. Patel', '6 a.m. run', '2.5 miles', 'St. Louis', 'etc.'. Otherwise travel and appointment actions get cut in the middle of a name, or 'a.m.' becomes 'a.m'.
- Dash conversion must leave intra-word hyphens alone (check-in, 30-minute, two-line, red-eye), along with negative numbers and '8-10'. Spaced hyphen, '--', U+2014 and U+2015 become ', '. An unspaced U+2013 becomes '-'. Convert even though the text comes from Claude, because UI copy must never show an em dash.
- Items ending in '?' are dropped even under a strong heading, because a chip must be something to do. A tentative suggestion phrased as a question ('Try a walking call instead?') is lost. That is an accepted trade-off.
- Negative words override keywords: 'What worked last week:', 'Questions for next week:', 'Wins this week:' must never be read as action headings. 'Quick wins' is the one allowed exception.
- Checked boxes ('[x]', '☑', '✅') are still offered. Claude sometimes pre-checks an item to show priority, and the user decides what to add.
- Redaction placeholders (whatever token the redactor emits) can come back in Claude's text. Keep them exactly as written and never try to restore the original term. '[...]' in the middle of text must not be read as a checkbox; checkboxes are only recognized right after a marker or at the start of a line. If a parsed action contains one of the user's sensitive terms (Claude typed it), show the same subtle warning used for Work notes before it is added.
- Packet echo: if the user copies the whole chat, the packet appears above the reply. The instruction line contains 'Suggested actions:' in the middle of a sentence, so it is not a standalone heading. The packet's own section for last week's actions must have 'last week' in its label so the negative rule rejects it. The optional end sentinel is an extra safeguard. Define it once as a shared constant used by both the packet builder and the parser.
- Partial pastes are normal: only the list, only the top half, or a paste starting mid-word. Fallback handles list-only pastes. A top-half paste usually returns [], which is correct. Never throw and never show an alarming message. Save the raw reply either way and just skip the chips row when there are no actions.
- Claude may wrap the list in a ``` fence to make it 'easy to copy'. Treat fence lines as blank and keep what is inside.
- Loose lists (blank lines between items) and markdown auto-numbering ('1. 1. 1.') must stay one block. A numbering restart at 1 after a blank line starts a new block. Two separate replies pasted together each have their own heading, and the last one wins.
- Emoji: strip only a leading emoji and keep inline ones. Treat ZWJ sequences, skin-tone modifiers, U+FE0F and keycaps (1️⃣) as a single glyph. A lone emoji-led opening line ('🔥 Big week.') is prose, not a list.
- When a list follows the heading, ignore any inline text after the heading's colon ('**Suggested actions:** here are three'). Otherwise 'Here are three' passes the 2-word minimum and becomes a junk chip.
- Fallback is intentionally conservative. It uses only the last list that is not a question list, and it rejects lead-ins with negative words and pronoun-led observation lists. An observation list that starts with nouns ('Health fell behind') can still slip through. The cost is low because chips are optional taps, and the packet instruction makes headed lists the normal case.
- Offer chips only for weekly review and mid-quarter check-in replies. A quarter setup reply's list is usually goal edits, not next week's actions. Never add actions automatically. Respect MAX_ACTIONS (7), and hide chips already added using the shared dedupe key rather than toLowerCase.
- For performance and safety, parse only the last 400 lines (the actions live at the end), and keep every regex linear with no nested quantifiers over user text. That avoids catastrophic backtracking on a huge paste.
- Keywords are English only. A reply in another language relies on the fallback. Heading keywords are also tuned to this app's packet wording. If the packet instruction changes (for example 'next week' becomes 'this quarter' for another packet type), keep 'suggested actions' as the exact heading so strong detection keeps working.

Fixtures: src/domain/__tests__/replyFixtures.json

## iOS hand-off research

- PRECOMPUTE: when the coach step renders, build the packet string synchronously and keep it in state, so no async work happens at tap time. Start the packet with a marker line such as 'FOUR BURNERS COACH PACKET v1'. Ask Claude, inside the packet, to begin its reply with 'FOUR BURNERS REPLY' so the paste-back box can catch a wrong paste. Keep all packet text free of em dashes and en dashes, and free of client or deal details, as the spec requires.
- TAP 1, button label 'Copy for Claude': make navigator.clipboard.writeText(packet) the very first statement in the click handler, with nothing awaited before it. If navigator.clipboard?.writeText is missing, run the clipboard.js-style execCommand fallback synchronously. If the promise rejects, or execCommand returns false, open the 'Copy manually' sheet: the packet in a read-only textarea, 'Copy again' and 'Select all' buttons, and the text 'Press and hold, then tap Copy.'
- ON COPY SUCCESS: write the pending-handoff record (IndexedDB plus a localStorage flag). Switch the button to a checked 'Copied' state and show the instruction card: 'Copied. Now open Claude, start a new chat, and paste.' Its primary button is 'Open Claude'. Nothing blocks: the user can always switch apps themselves.
- TAP 2, 'Open Claude' (primary route, universal link): render a real anchor, <a href="https://claude.ai/new" target="_blank" rel="noopener noreferrer">Open Claude</a>, with no query string and no fragment. '#no_universal_links' is an exclusion rule in claude.ai's AASA. Do not call preventDefault. Why this is primary: /new is in the AASA, Apple DTS recommends universal links, and forum 779457 shows a webclip tap opening the native app with no prompt. A real anchor also lets the user long-press and choose Open in 'Claude' if iOS has learned to open claude.ai in the browser. Confidence: medium to high, pending a device test.
- SOFT CHECK: in the same anchor handler, record attemptedAt and start a 2000 ms timer. If visibilitychange (hidden), pagehide or blur fires first, mark it 'left app'. If the timer ends while the page is still visible, show this non-blocking line: 'Did Claude open? If you see a claude.ai web page instead, tap Done, then open the Claude app from your Home Screen and paste.' Add a small secondary link 'Try the app link'.
- SECONDARY ROUTE (custom scheme, only on an explicit user tap, never automatic, never chained after the universal link): <a href="claude://claude.ai/new">Try the app link</a>. Expect an iOS confirmation along the lines of 'Open in "Claude"?' that the user must accept. If Claude is missing, iOS may show an 'address is invalid' alert or do nothing. If device testing shows claude://claude.ai/new misbehaving, use bare 'claude://', which should at least open the app's home screen. Do not add ?q=: chat prefill on mobile is undocumented, and the packet should not travel in a URL. Confidence: high that the app opens after the prompt; unverified for which screen.
- REMEMBER WHAT WORKS: add a setting 'Open Claude using' with the options 'App link (recommended)', 'App scheme' and 'Copy only, I will open Claude myself'. When the user comes back and saves a reply, store the method that was used and make it the default next time.
- RETURN: run checkPendingHandoff() at boot and on visibilitychange (visible), pageshow and focus. If a pending record exists, pin a card at the top of the coach screen titled 'Paste Claude's reply', with a large textarea (native long-press Paste works) and a 'Paste' button that calls navigator.clipboard.readText() (iOS shows a Paste bubble the user taps). Autosave the textarea to IndexedDB on input. Use the text 'Copy Claude's reply in the Claude app, then paste it here.'
- VALIDATE THE PASTE: if the pasted text starts with the packet marker, show 'That looks like the packet you sent, not Claude's reply. Copy Claude's answer in the Claude app and paste again.' If the 'FOUR BURNERS REPLY' marker is missing, accept the text anyway after a light confirm; never hard-reject.
- ALWAYS-ON INSTRUCTION: whatever succeeded or failed, show one static line under the buttons: 'Copy, open Claude, paste into a new chat, then copy Claude's reply and come back here.' Every failure mode (copy failed, app did not open, PWA reloaded) then has a manual path, and every attempt is best effort.
- OPTIONAL THIRD ROUTE (low confidence): a 'Share...' button calling navigator.share({ text: packet }) inside the tap, so the user can pick Claude from the iOS share sheet. Anthropic says the Ask Claude intent appears in the Share menu, but it may answer without opening the app, and how it handles long text is unverified. Offer it only as an extra.
- DEVICE TEST MATRIX (iPhone, iOS 17 and 18, installed to the Home Screen): (1) Claude installed and signed in: does the universal link open the app, and on which screen? (2) Claude not installed. (3) After once choosing to open claude.ai in the browser (then recover with a long-press). (4) The claude://claude.ai/new prompt text and the screen it lands on, and bare claude://. (5) Kill the PWA from the app switcher while in Claude, then return: does the pending card appear? (6) Low Power Mode. (7) A work-managed Claude for Intune build installed next to the personal app: both sit in the same AASA entry and may both claim claude://, so the instruction text should say 'your personal Claude app'.

Return detection: SIGNALS: route three events into one idempotent checkPendingHandoff():
- document 'visibilitychange' when document.visibilityState === 'visible';
- window 'pageshow' (event.persisted === true means the page came back from the back-forward cache);
- window 'focus'.
Two recent community sources say visibilitychange alone is unreliable in iOS standalone mode: BT-Rajan/jdk_clean PR #55 (merged Sept 16, 2026) found iOS restores standalone PWAs from the back-forward cache and fires pageshow with persisted true, so it added pageshow and focus. tiann/hapi #1048 (iOS 27 beta) shows stale state after coming back from the background. Page Visibility itself has been supported since iOS 7 (firt.dev).

IOS CAN KILL THE PWA: since iOS 12.2, a standalone PWA's state is usually frozen and restored rather than restarted (firt.dev iOS 12.2 notes). But iOS suspends background apps and can terminate them to reclaim memory. That is likely while the user spends minutes in Claude, which uses a lot of memory. The PWA then does a fresh load. So also run checkPendingHandoff() at boot, and never keep handoff state only in memory.

WHAT TO PERSIST: just before handing off, write a pending record to IndexedDB (a Dexie table or a settings row): { id, kind: 'weekly' | 'quarter' | 'onboarding', createdAt, packetVersion, copyOk, openMethod: 'universal' | 'scheme' | 'none' }. Mirror a tiny flag in localStorage so boot can read it synchronously and render the paste card with no flash. Autosave the reply textarea on input (debounced) so a kill during pasting loses nothing. Clear the record on save or explicit dismiss. After about 24 hours, ask 'Still want to paste Claude's reply?' instead of pinning the card.

STORAGE DURABILITY: Home Screen web apps have their own day counter for WebKit's 7-day storage deletion, and actual use resets it. WebKit says it does not expect their first-party data to be deleted (WebKit, 2020). They get the same quota as Safari. navigator.storage.persist() is granted based on heuristics 'like whether the website is opened as a Home Screen Web App' (WebKit storage policy, Aug 2023). Call navigator.storage.persist() once, for example at the end of onboarding. Ignore third-party claims of a '7-day cache expiry' or '50MB cap' for installed PWAs, and claims that EU standalone PWAs were removed: those contradict WebKit's own posts, and Apple reversed the EU removal on March 1, 2024.

Clipboard: GESTURE AND CONTEXT: WebKit rejects clipboard.writeText/write immediately if called outside a user gesture such as a click or touch handler. It is also only available on https (WebKit Async Clipboard API post). Transient activation lasts 'a few seconds, maybe', is set by the engine and is deliberately not observable (WebKit User Activation post). Any await before writeText (fetch, Dexie read, setTimeout) can invalidate the gesture. So build the packet string before the tap (when the coach screen renders) and make writeText the first call in the handler. Bind it to a button 'click', not to 'change' or 'input' events (Safari 18 rejected writeText from a select's input event, Apple forum 772275). Do not start a second write while one is pending: the earlier one rejects (WebKit). Debounce the button.

IF THE TEXT MUST BE BUILT ASYNC: call navigator.clipboard.write([new ClipboardItem({'text/plain': promiseResolvingToBlob})]) synchronously inside the tap. Safari accepts a pending Promise inside ClipboardItem (Wolfgang Rittner).

COPYING AND NAVIGATING IN THE SAME TAP: I found no documentation for this; it is risky in both directions.
(a) If you do not await, writeText may still be pending when iOS switches apps, and you cannot confirm success before leaving.
(b) If you await the copy and then navigate, the navigation no longer comes straight from the tap. Universal links and custom schemes can then be ignored (forums 772563 and 747921).
Recommendation: use two taps. Tap 1 copies (await it, show 'Copied'). Tap 2 is a real anchor to Claude. If you want an experimental one-tap mode: call writeText() first without awaiting, let the anchor's default navigation run in the same handler, and write the promise result to localStorage for the return screen.

FALLBACK (execCommand, deprecated but works): run it synchronously inside the gesture as well. The proven recipe is clipboard.js:
- create a textarea;
- set style.fontSize = '12pt' (16px is also fine) to stop iOS zooming;
- remove border, padding and margin;
- position: absolute, left: -9999px, top: current window.pageYOffset (avoids the page jumping);
- add the readonly attribute (stops the keyboard popping up);
- append it, then call select() and setSelectionRange(0, value.length) (the 'select' package does both, because select() alone is unreliable on iOS);
- call document.execCommand('copy') and check the boolean result;
- remove the element and restore focus.
Order: use this path when navigator.clipboard?.writeText is missing. If writeText rejects asynchronously, the gesture is gone, so open a 'Copy manually' sheet instead. It shows the packet in a read-only textarea with a 'Copy again' button (a fresh gesture that uses the execCommand path) and a 'Select all' button, plus the text 'Press and hold, then tap Copy.'

PASTING THE REPLY BACK: navigator.clipboard.readText() also needs a user gesture. On iOS it shows a system 'Paste' callout the user must tap. The callout is skipped only when the clipboard was written by the same origin, which will not be true for Claude's reply. Offer both a 'Paste reply' button (readText) and a plain textarea that accepts the normal long-press Paste. Never auto-read the clipboard on focus or visibility: it rejects without a gesture.

Sources:
- https://support.claude.com/en/articles/14898120-open-the-claude-mobile-app-with-a-link
- https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link
- https://support.claude.com/en/articles/10263469-use-claude-app-intents-shortcuts-and-widgets-on-ios
- https://github.com/anthropics/claude-code/issues/95478
- https://github.com/anthropics/claude-code/issues/8827
- https://github.com/anthropics/claude-code/issues/19023
- https://github.com/anthropics/claude-code/issues/67905
- https://claude.ai/.well-known/apple-app-site-association
- https://app-site-association.cdn-apple.com/a/v1/claude.ai
- https://platform.claude.com/_next/static/chunks/0mo34c17d7mt-.js (Open in Claude button template, fetched 2026-09-26)
- https://developer.apple.com/library/archive/documentation/General/Conceptual/AppSearch/UniversalLinks.html
- https://developer.apple.com/forums/thread/779457
- https://developer.apple.com/forums/thread/728141
- https://developer.apple.com/forums/thread/747921
- https://developer.apple.com/forums/thread/772563
- https://developer.apple.com/forums/thread/772275
- https://linkrunner.io/blog/universal-links-app-links-break-in-app-browsers
- https://www.airbridge.io/blog/deeplink-101-ios-safari-alert
- https://firt.dev/notes/pwa-ios/
- https://firt.dev/ios-12.2/
- https://webkit.org/blog/10855/async-clipboard-api/
- https://webkit.org/blog/13862/the-user-activation-api/
- https://wolfgangrittner.dev/how-to-use-clipboard-api-in-safari/
- https://github.com/zenorocha/clipboard.js/blob/master/src/common/create-fake-element.js
- https://github.com/zenorocha/select/blob/master/src/select.js
- https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/
- https://webkit.org/blog/14403/updates-to-storage-policy/
- https://github.com/BT-Rajan/jdk_clean/pull/55
- https://github.com/tiann/hapi/issues/1048
- https://techcrunch.com/2024/03/01/apple-reverses-decision-about-blocking-web-apps-on-iphones-in-the-eu/

## Paste limits research

Target 6000 chars, hard cap 8000.

No published per-message character cap exists in the Claude consumer apps (web, desktop, iOS) as of Sept 2026. The real ceiling is the model context window. Free plan models are Sonnet (Sonnet 5 has been the default since about July 1, 2026) and Haiku. Opus and Fable are not included. claude.com/pricing (fetched Sept 2026) lists Free context as "Up to 1M, varies by model", but several Sept 2026 third-party guides say Free caps Sonnet 5 at 200K tokens. Even at 200K tokens that is roughly 500K+ characters, so a coaching packet under 10K chars uses less than 2% of the window. The only hard character truncation I found (a silent cut at 50,000 chars) is in the Claude Code VS Code extension, a different product from the iOS chat app. An older help center answer said the max prompt length equals the context window, and that on Free the window "can vary depending on current demand". Confidence: high that there is no practical hard limit for packets under 10K chars. Medium on the exact Free context size (official and third-party sources disagree).

Long pastes in claude.ai and the Claude apps are turned into a "pasted text" attachment chip (a pasted text.txt file) automatically, with no prompt and no setting to turn it off. Anthropic does not publish the threshold. Community reports say it happens past "a few thousand characters" on the web. A desktop app bug report (July 2026) says about 100+ lines of plain text triggers it, so line count may matter as well as characters. Claude Code CLI documents more than 800 chars or more than 2 lines, but that is a different product. I found no iOS-specific number, so assume a 5K to 8K packet may become a chip. Does it matter for the model: normally no. The model still gets the full text as a document, and short attachments are read in full. Two real risks: (1) open 2026 Claude Desktop bugs (GitHub anthropics/claude-code #77946 on macOS and #82590 on Windows) where the converted paste reaches the model empty and nothing warns the user. These are not reported for iOS but show the failure mode exists. (2) A community claim (userscript author) that attachments may be read selectively (grep or extraction) instead of in full. This is plausible mainly for very large pastes with code execution on, and unlikely for a few thousand characters. Suggested mitigations for Four Burners: keep packets short and line-efficient (under about 80 lines, one line per goal), put the coaching instructions first, and have the instructions ask Claude to open its reply with a one-line receipt (for example "Got it: week of Sep 21, 11 goals, Crunch on"). Then the user can spot an empty or partial read right away and paste again. Confidence: medium on the behavior, low on any exact threshold number.

Sources:
- https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work (official: usage factors, context window, no fixed counts)
- https://support.claude.com/en/articles/9797557-usage-limit-best-practices (official: message length, attachment size, group related questions)
- https://support.claude.com/en/articles/8606394-how-large-is-the-context-window-on-paid-claude-plans (official: 200K default, 500K and 1M by model on paid plans)
- https://claude.com/pricing (official: Free plan gets Sonnet and Haiku, context 'Up to 1M, varies by model', rolling 5-hour window)
- https://support.claude.com/en/articles/8241126-upload-files-to-claude (official: file limits, no mention of paste threshold)
- https://platform.claude.com/docs/en/build-with-claude/token-counting (official: Claude 4.7+ tokenizer gives about 30% more tokens)
- https://docs.claude.com/en/docs/about-claude/glossary (official: 1 token is about 3.5 English characters)
- https://simonwillison.net/2026/apr/20/claude-token-counts/ (measured 1.46x on a system prompt, 1.08x on a PDF, 30-page PDF about 56K to 61K tokens)
- https://www.edtechinnovationhub.com/news/anthropic-makes-claude-sonnet-5-the-default-for-free-and-pro-users (Sonnet 5 default for Free, July 2026)
- https://www.layer3labs.io/guides/claude-sonnet-5-limits (third-party: Free caps Sonnet 5 at 200K, Free weekly allowance about half of Pro)
- https://www.grandlinux.com/en/blogs/claude-context-window.html (third-party, Sept 2026: pricing table vs help center discrepancy on context)
- https://www.heyuan110.com/posts/ai/2026-07-08-claude-free-tier-limits/ (third-party: about 15 to 40 messages per 5-hour window, token metering)
- https://www.ai-toolbox.co/claude-management-and-productivity/claude-usage-limits-2026 (third-party: each turn processes the chat so far, no Free usage meter)
- https://www.datastudios.org/post/claude-free-limits-updated-usage-restrictions-message-caps-and-file-upload-rules (third-party: Free 5-hour reset, no published character limit)
- https://github.com/anthropics/claude-code/issues/77946 (macOS Desktop, July 2026: converted paste reaches the model empty)
- https://github.com/anthropics/claude-code/issues/82590 (Windows Desktop, July 2026: about 100+ lines triggers conversion, arrives empty)
- https://github.com/anthropics/claude-code/issues/76953 (VS Code extension: 50,000 char silent truncation, not the iOS app)
- https://greasyfork.org/en/scripts/567635-claude-chunked-paste-bypass-attachment-detection (community claim: attachments may be read selectively)
- https://note.com/naito_xyz/n/nf99333fa77ff?hl=en (community: conversion past a few thousand characters)
- https://leadsource.co/blog/claude-pasted-text-empty (community, Sept 2026: empty-paste glitch, check for the file chip before sending)
- https://wmedia.es/en/tips/claude-code-expand-pasted-text (Claude Code CLI: 800 chars or 2+ lines, different product)
