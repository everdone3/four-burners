# Four Burners

A private, offline-first goal tracker built on the Four Burners theory. Installable PWA for iPhone, iPad, and Mac.

`SPEC.md` is the source of truth for what this app does. This README grows with each build phase.

## Status

- [x] Phase 1: Foundation (domain logic + tests, local data, burners, intents, goals, logging, dashboard, flames, sample data)
- [x] Phase 2: Depth (why, when/where, goal checks, people, energy, theme, undo, edit history)
- [x] Phase 3: Rhythm (weekly review, actions, habit streaks, Travel/Crunch, time zones, proration notes, quarter close, archive)
- [x] Phase 4: Coach and onboarding (interview + About me, 4 packet types, redaction, copy and paste loop, saved replies)
- [ ] Phase 5: Sync
- [ ] Phase 6: Security
- [ ] Phase 7: Notifications
- [ ] Phase 8: Shortcuts
- [ ] Phase 9: Calendar-aware crunch mode
- [ ] Phase 10: Polish

## Develop

Requires Node 20.19+.

```bash
npm install
npm run dev      # http://localhost:5180
npm test         # domain + data unit tests
npm run build    # typecheck + production build
```

To see everything working right away: Settings (gear icon) > Developer > Load sample data. Wipe it from the same place.

## Layout

```
src/domain/   Pure TypeScript rules: scoring, intents, High cap, goals, proration,
              streaks, grace days, time zones, day boundary. No UI, no storage.
              Mirror this module for a future native SwiftUI version.
src/data/     Dexie (IndexedDB) storage, repository writes, live queries, sample data.
src/ui/       React screens and components. Flames live in ui/components/Flame.tsx.
```

Scoring weights and thresholds are all in `src/domain/config.ts`.

## Deploy (Vercel)

Import the GitHub repo in Vercel. It detects Vite automatically; no settings needed.

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
