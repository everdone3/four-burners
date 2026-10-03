# Four Burners

A private, offline-first goal tracker built on the Four Burners theory. Installable PWA for iPhone, iPad, and Mac.

`SPEC.md` is the source of truth for what this app does. This README grows with each build phase.

## Status

- [x] Phase 1: Foundation (domain logic + tests, local data, burners, intents, goals, logging, dashboard, flames, sample data)
- [x] Phase 2: Depth (why, when/where, goal checks, people, energy, theme, undo, edit history)
- [x] Phase 3: Rhythm (weekly review, actions, habit streaks, Travel/Crunch, time zones, proration notes, quarter close, archive)
- [x] Phase 4: Coach and onboarding (interview + About me, 4 packet types, redaction, copy and paste loop, saved replies)
- [x] Phase 5: Sync (email-code sign-in, offline-first sync, JSON backups, offline app shell)
- [x] Phase 6: Security (Face ID lock with a passkey, idle re-lock, blur when leaving the app)
- [x] Phase 7: Notifications (daily and weekly reminders, smart nudges, quiet hours, Web Push from a Supabase schedule)
- [x] Phase 8: Shortcuts (Siri logging, touchpoints, Apple Health sync, personal tokens)
- [x] Phase 9: Calendar-aware crunch mode (optional calendar link, travel suggestions, never automatic)
- [x] Phase 10: Polish (end-to-end tests, accessibility audit, faster startup, app icon and launch screens)

## Develop

Requires Node 20.19+.

```bash
npm install
npm run dev      # http://localhost:5180
npm test         # domain + data unit tests
npm run build    # typecheck + production build
npm run build:functions  # rebundle supabase/functions/* after changing src/server or src/domain
npm run e2e      # end-to-end tests (Playwright, iPhone 17 Pro Max screen, WebKit)
npm run icons    # redraw the app icon and launch screens (public/) from scripts/make-icons.mjs
```

First time running the end-to-end tests: `npx playwright install webkit chromium` (downloads the test browsers).

## Tests

- **Unit and integration** (`npm test`, Vitest): the domain rules, the data layer and sync, the SQL migrations
  (real Postgres via PGlite), the Edge Functions and their bundles, and UI copy.
- **End to end** (`npm run e2e`, Playwright in WebKit, Safari's engine, at the iPhone 17 Pro Max screen size,
  440 x 956 points at 3x, with Reduce Motion on):
  - **Log**: two taps from Home, the 5-second undo, a private note, logging from a burner screen.
  - **Weekly review**: all six steps, resuming on the same step after the app reloads, Copy for Claude (the
    packet has the week's wins and misses and never a private note), the paste box opening on return, saving
    the reply, adding a suggested action, sealing the week, and the action showing on Home.
  - **Quarter close**: the highlights reel, grading, carry forward and drop, the close, next quarter's setup
    pre-filled with what carried, and the archive.
  - **Accessibility**: axe (WCAG 2.1 A and AA) on every main screen and the log sheet; any serious or critical
    problem fails.
  The test app runs on its own port with no Supabase settings, in a fresh browser profile per test, so it
  never touches your account or your own data.

To see everything working right away: Settings (gear icon) > Developer > Load sample data. Wipe it from the same place.

## Layout

```
src/domain/   Pure TypeScript rules: scoring, intents, High cap, goals, proration,
              streaks, grace days, time zones, day boundary. No UI, no storage.
              Mirror this module for a future native SwiftUI version.
src/data/     Dexie (IndexedDB) storage, repository writes, live queries, sample data, backups.
src/sync/     Sync engine (last write wins), Supabase client, email-code auth, sync scheduler.
src/notify/   This device's push subscription (turn on/off, time zone refresh, test) and push payloads.
src/shortcuts/ Personal tokens (made on the device, only the hash is stored), recipes for the Shortcuts.
src/calendar/ The optional calendar link on this device and its Travel/Crunch suggestions.
src/server/   Server code: the notify (Web Push), shortcuts (Siri, Health) and calendar Edge Functions, each bundled
              with src/domain into supabase/functions/<name> by `npm run build:functions`.
src/sw.ts     Service worker: the app shell works offline, and it shows notifications.
e2e/          End-to-end tests (Playwright). scripts/: function bundler, VAPID keys, icon and launch screens.
src/ui/       React screens and components. Flames live in ui/components/Flame.tsx.
supabase/migrations/  Versioned SQL for the Supabase database (one new file per change).
```

Scoring weights and thresholds are all in `src/domain/config.ts`.

## Deploy (Vercel)

Import the GitHub repo in Vercel. It detects Vite automatically; no settings needed. The Supabase URL and
publishable key are built in from `.env.production` (both are public by design). `vercel.json` keeps
`/sw.js` uncached so app updates arrive promptly.

## Sync across devices

Everything is saved on the device first and works fully offline (airplanes included). When you are signed
in, changes upload in the background and other devices pull them in: on launch, when the app comes back to
the front, when the network returns, every minute while open, and a couple of seconds after each change.
If the same item was edited on two devices, the newer edit wins. A device signing in for the first time
takes your account's copy of anything that exists on both sides, then uploads what is new.

Sign in: Settings > Sync across devices > your email > Send code > type the 6-digit code from the email.
Sign in from inside the installed Home Screen app (Safari and the installed app keep separate storage).

### One-time Supabase setup

1. **Email sender.** New free Supabase projects can only edit email templates with a custom sender:
   Authentication > Emails > SMTP Settings > Enable custom SMTP (for example your own Gmail with an app
   password, or your Xfinity address: host `smtp.comcast.net`, port 587, username and sender both your full
   address).
2. **Code email.** Authentication > Emails > Templates > "Magic link or OTP": put `{{ .Token }}` in the subject
   and body and remove any link. Codes of 6 to 10 digits work; a pasted sign-in link also works as a fallback.
3. **Code settings.** Authentication > Sign In / Providers > Email: OTP length 6, expiration 900 seconds.
4. **Your account.** Authentication > Users > Add user > Create new user (auto confirm). The app never
   creates accounts. Then turn off "Allow new users to sign up" on the Sign In / Providers page.
5. **Database.** SQL Editor > New query > paste `supabase/migrations/20260926120000_sync_records.sql` > Run.
   Safe to run again; confirm the "destructive operation" prompt (it comes from `drop policy if exists`).
   It creates one `records` table with Row Level Security, so each account can only ever read its own rows.
6. **Keys.** Put the Project URL and publishable key (`sb_publishable_...`) in `.env.production`
   (and `.env.local` for development, see `.env.example`). Never use the secret key in the app.

Database changes are versioned: add a new timestamped file under `supabase/migrations/` and run it the same
way. Never edit a migration that has already been run.

### If Supabase paused the project

Free Supabase projects pause after about a week with no activity. Once notifications are set up, the
schedule calls the notify function through the project's API every 5 minutes, which counts as activity and
keeps it awake. The app keeps working offline while paused, and the status in Settings says the sync server can't
be reached. Your data is safe on every device and in the paused project. To restore:

1. Sign in at supabase.com/dashboard and open the project. It shows as paused.
2. Click **Resume project** (or "Restore project") and confirm. It can take a few minutes.
3. Open the app. Sync picks up on its own; queued changes upload. Nothing needs to be redone.

Supabase keeps a paused free project restorable for a long time (currently up to a year); past that, download
its backup from the dashboard and restore it into a new project, then update `.env.production`.

## Notifications

Daily check-in and weekly review reminders at times you choose, and smart nudges when a burner slips against
its intent or a key person is overdue. iOS web apps can't schedule notifications themselves, so a Supabase
schedule (pg_cron, every 5 minutes) runs the `notify` Edge Function, which sends Web Push to every device that
turned notifications on. The rules live in `src/domain/notify.ts`:

- **Daily check-in** at your time. Skipped on days you already checked in, and during Travel/Crunch.
- **Weekly review** at your time on your review day. Skipped once that review is done.
- **Smart nudges**, at most one a day, sent between 11:00 and 19:00. A burner nudges when its pace (already
  adjusted for its intent) is well behind and it has been quiet for a few days; High burners first, then
  overdue people, then Steady burners. Low burners barely ever nudge. Each subject rests a few days before it
  can nudge again. Never during Travel/Crunch. Thresholds are in `src/domain/config.ts`.
- **Quiet hours**: nothing arrives in them. A reminder that falls inside waits until they end if that is
  within 3 hours, otherwise it is skipped that day.
- **Time zones**: times are wall-clock times wherever you are. The server uses the time zone of the device you
  opened most recently (each open refreshes it), and "today" follows your day boundary.
- **Lock screen**: nudges can show a goal or a person's name. Work names on your confidentiality list are
  always replaced with [redacted], and private notes never appear. To hide previews entirely: iOS Settings >
  Notifications > Four Burners > Show Previews.

The schedule (Settings > Notifications) syncs and is shared by all devices. Each device turns notifications on
for itself: Settings > Notifications > **Turn on notifications** > Allow, then **Send a test notification**.
Requires being signed in to sync, and on iPhone and iPad the app installed to the Home Screen and opened from
there (iOS 16.4 or later).

### One-time setup

The VAPID key pair that signs notifications is already made (`npm run vapid`): the public key is built into the
app from `.env.production`, and the private key is in `supabase/functions/.env`, which is git-ignored. Keep that
file; making new keys means every device has to turn notifications on again.

1. **Tables.** SQL Editor > New query > paste `supabase/migrations/20261002120000_push.sql` > Run.
2. **The function.** Edge Functions > Deploy a new function > Via Editor. Name it exactly `notify`, replace the
   sample code with the whole of `supabase/functions/notify/index.ts` (one self-contained file), and Deploy.
   Then in the function's settings turn **off** JWT verification ("Verify JWT" or "Enforce JWT verification"; the schedule calls it without
   a user token; the function checks its own secret) and save.
3. **Secrets.** Edge Functions > Secrets > add the three lines from `supabase/functions/.env`:
   `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`. The project URL and service key are provided
   to the function automatically.
4. **Schedule.** SQL Editor > New query > paste `supabase/migrations/20261002120100_notify_schedule.sql` > Run.
   It turns on pg_cron and pg_net, stores the function URL and a random secret in Vault, and schedules the run
   every 5 minutes.
5. **Your devices.** Open the Home Screen app > Settings > Notifications > Turn on notifications.

With the Supabase CLI instead of steps 2 and 3: `npx supabase login`, `npx supabase link --project-ref
zkgdagxnrkqshulwnmya`, `npx supabase functions deploy notify` (`supabase/config.toml` turns JWT verification
off), `npx supabase secrets set --env-file supabase/functions/.env`.

After changing `src/server` or `src/domain`, run `npm run build:functions` and deploy the function again (a
test fails while the bundle is out of date).

### If notifications don't arrive

- **Send a test notification** in Settings says what went wrong (function not deployed, missing secrets, key
  rejected).
- Is the schedule running? SQL Editor: `select status, return_message, start_time from cron.job_run_details
  order by start_time desc limit 5;` and the function's answers: `select status_code, content from
  net._http_response order by created desc limit 5;` (`401` means the schedule secret did not match; run the
  schedule migration again).
- Edge Functions > notify > Logs shows errors from each run.
- iPhone: Settings > Notifications > Four Burners must allow notifications, and Focus modes can hold them.
- If iOS drops a device's subscription, the app renews it on the next open, or Settings asks you to turn it on
  again.
- Pause all notifications: `select cron.unschedule('four-burners-notify');` (run the schedule migration again
  to resume).

## Shortcuts and Siri

Log by voice ("Hey Siri, log date night"), log a call or a coffee with someone, and send Apple Health numbers
(steps, workouts, exercise minutes, sleep) every evening to linked Health goals. A web app can't install
Shortcuts, so you build them once on your iPhone; Settings > Shortcuts and Siri has step-by-step recipes.

How it works: each Shortcut calls the `shortcuts` Edge Function with a personal token. The function finds the
goal or person by name (any part of the name works; it says so when a name could mean two things), writes the
log or touchpoint straight into your synced records, and answers with a short sentence Siri reads out ("Logged
"Date night". 3 of 6 so far."). Your devices pull the entry on their next sync, tagged "via Siri" or "from Apple
Health". Each Shortcut sends the phone's own time, so an entry lands on the day you are living wherever you are.

- **Tokens**: Settings > Shortcuts and Siri > Make a token. It is shown once: copy it into your Shortcuts. Only
  its SHA-256 hash is stored on the server, so a lost token is replaced, not recovered. Revoke stops every
  Shortcut using it at once. Up to 10 tokens.
- **Health goals**: in the same section, link a Health goal (Number, Habit or Yes/No) to Steps, Workouts,
  Exercise minutes or Sleep. Number goals add each day's amount; Habit and Yes/No goals count a day that
  reaches the minimum you set. Each goal gets one Health log per day, so sending again the same day replaces
  that day's number instead of adding a second. Edit or delete a Health log in the app and your change stays
  (once it has synced; a change made offline can be replaced by that evening's send). A Habit day you already
  logged by hand is not counted twice. A carried-forward goal keeps its link.
- Milestone goals can't be logged by voice (check off the next step in the app).

The request every Shortcut makes: **Get Contents of URL**, Method POST, header `Authorization: Bearer <token>`,
Request Body JSON. On current iOS each header and body row has the key box on the left (grey "Key") and an
unlabeled value box on the right. End with "Get Dictionary Value" (key `message`) and "Show Content" (older iOS:
"Show Result"). There is no Done button; Shortcuts saves as you go.

| action | fields | does |
| --- | --- | --- |
| `log` | `goal`, `value` (Number goals), `note`, `at` | logs progress on a goal |
| `touch` | `person`, `type` (call, text, in person, other), `note`, `at` | logs a touchpoint |
| `health` | `date` (yyyy-MM-dd), `at`, `steps`, `workouts`, `activeMinutes`, `sleepHours` (or `sleepMinutes`, `sleepSeconds`) | one day of Health numbers |
| `goals`, `people` | | names for "Choose from List" (in `items`) |
| `ping` | | checks the connection |

`at` is Current Date with Date Format ISO 8601 (include time). Every answer is JSON with `message` (what Siri
says) and `ok`.

### One-time setup

1. **Table.** SQL Editor > New query > paste `supabase/migrations/20261003120000_shortcuts.sql` > Run.
2. **The function.** Edge Functions > Deploy a new function > Via Editor. Name it exactly `shortcuts`, replace
   the sample code with the whole of `supabase/functions/shortcuts/index.ts`, Deploy. Then turn **off** JWT
   verification in its settings (Shortcuts send a personal token, not a sign-in). No secrets to add.
3. **Your iPhone.** Settings > Shortcuts and Siri > Make a token, then follow the recipes. Start with a "ping"
   Shortcut (fields: action = ping) to check the address and token.

With the CLI: `npx supabase functions deploy shortcuts` (`supabase/config.toml` turns JWT verification off).

## Calendar (optional)

Link a read-only calendar and the app suggests Travel/Crunch mode when your calendar shows you away. It always
asks first ("Your calendar shows "Denver trip" (Oct 5 to Oct 8). Turn on Travel/Crunch through Oct 8?") and never
turns it on by itself. The app works exactly the same with no calendar linked, which matters if your employer
blocks calendar sharing.

- **What counts as away**: flights at any length ("Flight to Boston", "ORD → DEN"); travel words (trip, travel,
  vacation, PTO, OOO, out of office, on leave, offsite, conference, hotel...) on all-day, multi-day or 4+ hour
  events; and any all-day event of two or more days marked busy. Ordinary work items never count, whatever
  words they use ("Conference call", "Offsite planning", "Travel expense report", "Book flight"), and neither
  do birthdays, reminders, recurring events or events marked free. Outlook's midnight-to-midnight all-day events
  are read as all-day. Overlapping and back-to-back days merge into one trip.
- **When it asks**: on Home, on any day a trip covers, if Travel/Crunch is off. Not for a trip you said "Not this
  time" to (even if its dates shift a little), nor one you already turned Travel/Crunch on and off for. "Turn it on" starts Travel/Crunch on the trip's first day (up to a week back, so missed days
  are paused too) and ends it on the last.
- **Privacy**: the link is a secret (anyone with it can read the calendar). It stays on the device where you
  pasted it: not synced, not in backups. Browsers can't read most calendar feeds directly, so each check (at
  most every 6 hours, or Check now) sends it to your own `calendar` Edge Function, which fetches the feed, sends
  back only the next two months of events, and stores and logs nothing. It only fetches https addresses on
  public host names that resolve to public addresses (re-checked on every redirect). A failed check retries
  after 30 minutes.

Getting the link (Settings > Calendar > Where to find the link has the same steps):
- **Google Calendar**: calendar.google.com > Settings > the calendar > Integrate calendar > Secret address in iCal format.
- **iCloud**: Calendar app > Calendars > (i) > Public Calendar > Share Link. This makes that calendar readable by
  anyone with the link, so prefer a calendar that only holds trips.
- **Outlook / Microsoft 365**: Outlook on the web > Settings > Calendar > Shared calendars > Publish a calendar > ICS.
- **TripIt**: Settings > Calendar Feeds.

### One-time setup

1. **The function.** Edge Functions > Deploy a new function > Via Editor. Name it exactly `calendar`, replace
   the sample code with the whole of `supabase/functions/calendar/index.ts`, Deploy, then turn **off** JWT
   verification in its settings (it checks your sign-in itself). No secrets, no SQL.
2. **Your iPhone.** Settings > Calendar (optional) > paste the link > Link. It shows the trips it found.

With the CLI: `npx supabase functions deploy calendar`.

## Backups

Settings > Backup > **Save a backup to Files** makes one JSON file with everything that syncs. On iPhone and
iPad it opens the share sheet: choose **Save to Files**. On a Mac it downloads. A card on Home reminds you
once a month. **Restore from a backup** merges a file back in: nothing is deleted, and anything newer on the
device is kept.

## App lock (Face ID)

Settings > App lock > **Lock with Face ID** (Touch ID on a Mac). iOS asks for Face ID twice the first time:
once to create a passkey named "Four Burners lock · iPhone" in your Passwords, once to test it. Each device
sets up its own lock. After that:

- Opening the app asks for Face ID (the prompt usually appears on its own; otherwise tap **Unlock**).
- It locks again after the time you choose (Immediately, 1, 5, 15 or 60 minutes away or without a tap).
  **Lock now** locks right away. App updates never lock you out mid-use.
- The app blurs the moment you leave it.

What it is and is not: the lock is an **access gate, not encryption**. It keeps someone holding your unlocked
phone from casually opening the app. Your data is stored unencrypted on the device, as before. iOS takes the
app switcher preview before any web app can react, so that preview can still show your screen; coming back
to the app never shows your content before the blur or the lock screen.

If Face ID keeps failing, tap **Can't unlock?** on the lock screen:
1. **Restore the passkey** if it was deleted: Passwords app > Recently Deleted > "Four Burners lock".
2. **Sign in with an email code** (when this device is signed in to sync). This turns the lock off; turn it on
   again in Settings to make a new passkey.
3. **Reset this device**: erases the data on this device (your synced account keeps its copy).

Turning the lock off asks for Face ID first. To remove the passkey afterwards: Passwords app > search
"Four Burners" > Delete. Settings > Developer > Lock diagnostics shows a log of lock events for troubleshooting.

## Offline and updates

A service worker caches the app itself, so it opens with no connection. New versions install in the
background and switch over on their own when nothing is in progress; otherwise an "Update ready" pill
appears and the update applies the next time the app goes to the background. Settings > App shows the
version and a Check for updates button.

## Rituals

- **Weekly review**: appears on your review day (default Sunday, change it in Settings) and stays for 3 more days. Six steps; everything saves as you go, including half-typed text. If the app closes mid-review, reopening it within an hour lands you back on the same step.
- **Quarter close**: on the first open of a new quarter, a card offers the highlights reel, then grading (A to F) and carry forward, modify, or drop for each goal, then the next quarter's setup.
- **Archive**: Settings > Past quarters and highlights. Replay any quarter's reel.

## Dev tools

Settings > Developer:
- **Load / wipe sample data**: a closed previous quarter (grades, reviews) plus the current quarter so far.
- **Time travel**: pretend it is next Sunday or the first day of next quarter to preview the review and the quarter close. New logs are dated to the pretend day, so reload sample data afterward.

## Coaching with your Claude app (no API)

The app never calls an AI service. It builds a compact text "packet", you paste it into your own Claude app, and you paste Claude's reply back.

1. Tap **Copy for Claude** (weekly review step 4, Coach check-in on home, the Pressure test step in quarter setup, or Refine with Claude in About me). **Preview** shows the exact text and its length first.
2. Tap **Open Claude**. It is a link to `https://claude.ai/new`, which iOS opens in the Claude app. If a web page opens instead, tap Done and open the Claude app yourself; **Try the app link** uses `claude://` as a backup.
3. Paste into a new chat and send. Copy Claude's reply.
4. Come back. The paste box opens on its own (even if iOS reloaded the app). Paste and save. Suggested actions appear with a one-tap **+ Add** to your weekly actions.

Privacy: private notes are never included, and names on your **Settings > Work confidentiality** list are replaced with `[redacted]` everywhere in a packet. A final check blocks Copy if anything sensitive survived. Design details and research: `docs/coach-design.md`.
