# Four Burners: Build Spec (source of truth)

Save this entire message as SPEC.md in the project root and treat it as the source of truth for this build. Before writing code, give me a short build plan and a checklist of setup steps I need to do myself (accounts, hosting). Then build in the phases listed at the end, confirming each phase works before moving on.

## PRODUCT
"Four Burners" is a personal goal-tracking Progressive Web App for my iPhone 17 Pro Max, based on the Four Burners theory. It must also work on iPad and Mac browsers with synced data. Single user, private, no sharing features. The app makes no paid API calls. AI coaching runs through my personal Claude app via copy and paste (see AI COACH).

## CORE CONCEPT
- Four fixed burners, not renameable: Family, Friends, Health, Work.
- Each quarter I set an intent for every burner: High, Steady, or Low. Maximum of 2 burners on High. The app must enforce this cap.
- I can change a burner's intent mid-quarter. When I do, prompt for a one-line reason and keep a history of changes.
- Progress is always judged against intent. A Low burner with light activity is "on track," not failing.
- Each quarter has an optional theme (one word or short phrase) shown on the dashboard.

## GOALS
- 3 to 4 goals per burner per quarter (suggest 3, allow a 4th, block a 5th).
- When creating a goal, I pick its type:
  - Number: target value and unit (e.g., run 300 miles)
  - Habit: frequency per week or month (e.g., date night 2x/month)
  - Yes/No: done or not done
  - Milestone: a goal with ordered sub-steps
- Every goal has:
  - A "why" (one line on why it matters to me)
  - An implementation intention: when and where I'll do it (e.g., "Tuesday mornings before the office")
  - A deadline: defaults to the end of the calendar quarter, can be set to a custom date
- Use calendar quarters (Jan, Apr, Jul, Oct).
- Proration: goals added mid-quarter are judged only against the time remaining, not the full quarter.
- Built-in goal checks at creation (rule-based): warn if a goal has no why or no when/where, if a Number or Habit goal has no target, or if a Low burner has more goals than a High burner.

## PEOPLE (Family and Friends burners)
- A list of key people, each assigned to Family or Friends, with a desired connection cadence (e.g., every week, every 2 weeks, monthly).
- Log a touchpoint in two taps: person, type (call, text, in person, other), optional note.
- Show "last connected" for each person, with gentle visual cues as someone approaches or passes their cadence.
- People can optionally be linked to goals.
- Overdue people can trigger smart nudges (see NOTIFICATIONS).

## DAILY LOGGING
- Logging must take two taps or fewer: select a goal, tap to log progress, optionally add a short note.
- Show "This week's actions" (created in the weekly review) as quick-tap items.
- Optional daily energy rating (1 to 5), one tap, never required.
- Every log shows a 5-second undo toast. All logs are editable afterward, with an edit history.
- Keep text fields dictation-friendly (standard iOS keyboard, no custom input that blocks dictation).
- Any note can be marked "private," which means it is never included in anything copied for Claude.

## HOME SCREEN: QUARTER DASHBOARD
- Top: quarter theme, days left in the quarter, and two headline scores.
  - Progress: goal progress weighted by intent (High 3x, Steady 2x, Low 1x), measured against intent-adjusted and prorated expectations. Keep the weights in one easy-to-edit config file.
  - Consistency: how reliably I check in, based on streaks and grace days.
- Below: four large animated flames, one per burner. Flame size and intensity reflect intent and recent progress. Tap a flame to open that burner's goals (and people, for Family and Friends).

## WEEKLY REVIEW (guided flow)
1. Auto-summary of my week (rule-based): progress by burner vs. intent, streaks, energy trend, overdue people, Travel/Crunch days
2. Wins
3. Misses
4. Coaching (optional, skippable): see AI COACH
5. Next week's focus
6. Specific actions for next week, which then appear as daily quick-tap items
- Save progress at every step. If I leave the app mid-review (for example, to paste into Claude), resume exactly where I left off.

## STREAKS, GRACE, AND CRUNCH WEEKS
- Streaks for check-ins and habit goals.
- Automatic grace days (default 1 per week, configurable) so one missed day doesn't break a streak.
- Travel/Crunch mode toggle with an optional end date. It pauses streaks, softens expectations, mutes slipping nudges, and is flagged in coaching packets so the coach doesn't pile on.
- Neglected burners dim gently over time. Never make it feel punishing.

## TIME ZONES
- I travel frequently. Always use the device's current local time to decide what "today" is.
- Store timestamps in UTC, plus the local date the entry belongs to.
- Configurable day boundary (default 3:00 AM), so a late-night log counts toward the day I was living.
- Streaks and grace days must never break just because I changed time zones.

## QUARTER CLOSE
- When a quarter ends, play a cinematic highlights reel: top wins, longest streaks, brightest burner, biggest comeback, most-connected people.
- Then a guided close: grade each goal, and choose to carry it forward, modify it, or drop it.
- Then prompt me to set up next quarter (theme, intents, goals), pre-filled with carried-forward goals.
- Keep a browsable archive of past quarters.

## NOTIFICATIONS (Web Push, requires the app installed to Home Screen, iOS 16.4+)
- Daily check-in reminder at a time I choose.
- Weekly review reminder on a day and time I choose.
- Smart nudges (rule-based) when a burner is slipping relative to its intent, or a key person is overdue. Low burners should rarely trigger. Limit to one nudge per day.
- Quiet hours setting, evaluated in my current local time zone. Respect Travel/Crunch mode.
- iOS web apps can't schedule local notifications, so send these from the server on a schedule (Supabase cron + Edge Function using VAPID web push).

## AI COACH (copy and paste through my personal Claude app, no API)
- The app never calls an AI API. Coaching happens by copying a packet into the Claude app on my phone and pasting the reply back.
- Packet types:
  - Onboarding: after the in-app onboarding interview, a packet asking Claude to help me refine my "About me" profile
  - Weekly review: profile, goals with why and when/where, this week's logs and notes, energy ratings, people touchpoints, Travel/Crunch status, my wins and misses from steps 2 and 3, plus a compact trend summary of the previous 4 weeks so Claude can spot patterns
  - Quarter setup: profile, last quarter's results, and my draft intents and goals, asking Claude to flag vague or unmeasurable goals, missing whys or when/wheres, and over-commitment given my travel and crunch history
  - Mid-quarter check-in (on demand): current state of all burners
- Every packet starts with coaching instructions so any Claude chat responds consistently:
  - Tone: grounded in my actual data, candid and direct like a trusted executive coach, warm and clearly in my corner. Brief. No filler, no generic motivation, no em dashes.
  - When a goal is slipping, use my stated "why" to remind me what it's for.
  - Keep Work guidance at the level of habits and priorities. Never ask for client or deal specifics.
  - End with 2 to 3 concrete suggested actions, formatted as a simple list I can copy back.
- Packets must be compact and within free-tier limits. Show the packet length before copying.
- The "Copy for Claude" button copies the packet and then tries to open the Claude iOS app directly. If that isn't possible, show a clear "Now open Claude and paste" prompt.
- When I return to Four Burners, detect that I just copied a packet and open the "Paste coach reply" field automatically.
- Save each pasted reply to the relevant week or quarter, viewable in history.
- If the reply contains a suggested actions list, offer to turn those items into next week's actions with one tap each.
- Keep the coach code structured behind a single interface so a direct API mode could be added later without a rewrite. Do not build API mode now.

## ONBOARDING (first launch)
- A guided in-app interview: my life context, who matters in each burner, my work rhythms (heavy travel, intense deal periods), and what winning looks like for me in each burner.
- Save the answers as an editable "About me" profile.
- Offer the onboarding packet (see AI COACH) as an optional refinement step.
- Then walk me through setting up my first quarter: theme, intents, goals, and key people.

## WORK CONFIDENTIALITY
- In Settings, I can maintain a "sensitive terms" list (e.g., company or client names). These terms are automatically redacted from every packet.
- When I type a sensitive term into a Work note, show a subtle warning.
- Show a preview of the exact packet text before it's copied.

## DATA, SYNC, AND OFFLINE
- Offline-first: every action saves locally to IndexedDB instantly (e.g., Dexie), then syncs when online. It must work fully on airplanes.
- Sync through Supabase (Postgres + Auth) with Row Level Security so only my account can read my data.
- Sign-in with a 6-digit email code (OTP), not magic links, because iOS opens links in Safari instead of the installed app.
- Conflict handling: last write wins per record, using updated_at timestamps.
- Use versioned database migrations.

## BACKUPS
- JSON export and import in Settings.
- Monthly reminder with a one-tap export to the iOS Files app (iCloud Drive) via the share sheet.
- Supabase free projects pause after about a week of inactivity. Make sure the scheduled notification jobs keep it active, and document how to restore a paused project in the README.

## PRIVACY AND SECURITY
- Face ID lock on open, using a WebAuthn passkey (platform authenticator). Re-lock after a configurable idle time.
- Blur the app contents immediately when it goes to the background or app switcher (visibilitychange/pagehide).
- Be upfront in code comments that the Face ID lock is an access gate, not encryption.

## APPLE SHORTCUTS, SIRI, AND HEALTH
- Create a secure Edge Function endpoint for Apple Shortcuts, authenticated with a long random personal token I can generate and revoke in Settings.
- Support:
  - Logging progress on a goal by name ("Hey Siri, log date night")
  - Logging a touchpoint with a person
  - Receiving Apple Health data (steps, workouts, active minutes, sleep duration) from a daily Shortcuts automation and applying it to linked Health goals
- In Settings, I can link a Health goal to a Health metric.
- Provide clear, step-by-step instructions in the app and README for building each Shortcut on my iPhone, since the Shortcuts themselves have to be created on the device.

## CALENDAR-AWARE CRUNCH MODE (optional, build last)
- Let me paste a read-only calendar feed URL (ICS). Detect travel or all-day away events and suggest turning on Travel/Crunch mode. Always suggest; never turn it on automatically.
- Work calendar access may be restricted by my employer's IT policy, so this must be fully optional, and the app must work fine without it.

## VISUAL DESIGN: MAXIMUM SIZZLE, STILL READABLE
- Dark and cinematic: true black background (OLED), glowing flames, premium feel.
- Flames should feel alive: canvas or WebGL particle flames with subtle flicker. Smooth 60fps, with a lightweight fallback if performance drops.
- Celebrations when goals complete, streaks hit milestones, and people get reconnected (embers, flare-ups).
- Smooth transitions throughout (Framer Motion or similar).
- High text contrast. Readability wins over effects.
- Respect "Reduce Motion" accessibility settings with a calmer mode.
- Built for iPhone 17 Pro Max: safe areas, Dynamic Island, home indicator, one-handed reach for primary actions.
- Custom app icon and splash screen that match the aesthetic.
- No em dashes anywhere in UI copy.

## ARCHITECTURE AND QUALITY
- Keep all domain logic (scoring, intents, cap enforcement, streaks, grace days, proration, time zone and day-boundary handling, packet building and redaction) in a pure TypeScript module separate from the UI, so a future native SwiftUI version can mirror it.
- Unit tests (Vitest) for all domain logic, especially scoring, the High cap, streaks, grace days, proration, time zone edge cases, and redaction (private notes and sensitive terms must never appear in a packet).
- End-to-end tests (Playwright) at the iPhone 17 Pro Max viewport for the core flows: log, weekly review with copy and paste coaching, quarter close.
- A "load sample data" option in a dev menu that generates a realistic past quarter (goals, logs, people, energy, a travel week, sample coach replies), so I can see flames, scores, and the highlights reel working immediately. It should be easy to wipe.

## TECH STACK
- Vite + React + TypeScript, Tailwind CSS, Framer Motion, Dexie, Supabase, service worker for offline and push.
- Deploy on Vercel or Netlify with HTTPS.
- README with setup, deployment, Shortcuts instructions, and "Add to Home Screen" instructions.

## BUILD PHASES
1. Foundation: domain logic module with tests, local data, burners, intents, goals, logging, dashboard, flames, dark design, sample data
2. Depth: why, when/where, goal checks, people tracking, energy rating, quarter theme, undo and edit history
3. Rhythm: weekly review, streaks, grace days, Travel/Crunch mode, proration, time zones, quarter close
4. Coach and onboarding: onboarding interview, profile, all packet types, redaction, copy and paste loop, saved replies
5. Sync: Supabase auth (email OTP), sync, offline queue, migrations, backups and export
6. Security: Face ID lock and blur
7. Notifications: daily, weekly, and smart nudges with quiet hours
8. Shortcuts: Siri logging and Apple Health sync endpoint with instructions
9. Calendar-aware crunch mode (optional)
10. Polish: animations, celebrations, performance, accessibility, end-to-end tests
