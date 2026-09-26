# Four Burners

A private, offline-first goal tracker built on the Four Burners theory. Installable PWA for iPhone, iPad, and Mac.

`SPEC.md` is the source of truth for what this app does. This README grows with each build phase.

## Status

- [x] Phase 1: Foundation (domain logic + tests, local data, burners, intents, goals, logging, dashboard, flames, sample data)
- [x] Phase 2: Depth (why, when/where, goal checks, people, energy, theme, undo, edit history)
- [ ] Phase 3: Rhythm
- [ ] Phase 4: Coach and onboarding
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
