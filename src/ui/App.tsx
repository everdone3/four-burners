import { AnimatePresence, motion } from 'motion/react';
import { Suspense, useEffect, useState } from 'react';
import { BURNERS, type BurnerId } from '@/domain';
import { useAppState } from '@/data/hooks';
import { ToastProvider, useToast } from './components/ui';
import { Celebrations, celebrate } from './fx/Celebrations';
import { checkTimeZoneChange, streakMilestoneReached } from '@/data/repo';
import { lazyScreen, preloadScreens } from './lazyScreen';
import { PendingCoachBanner } from "./components/CoachPanel";
import { navigate } from './router';
import { getOnboarding } from '@/data/repo';
import { MoltenButton } from './components/sizzle';
import { NotePromptProvider } from "./components/NotePrompt";
import { Atmosphere } from './fx/Atmosphere';
import { setSoundEnabled, sfx } from './fx/audio';
import { haptic, setHapticsEnabled } from './fx/haptics';
import { useReducedMotion } from './motion';
import { routeKey, useRoute } from './router';
import { BurnerScreen } from './screens/Burner';
import { Home } from './screens/Home';
import { LogSheet } from './screens/LogSheet';

import { UpdatePill } from './components/UpdatePill';
import { isUpdateSafePoint, useAppUpdate } from './useAppUpdate';

// Loaded on demand (see lazyScreen.ts): everything but Home, a burner and the log sheet.
const ReviewScreen = lazyScreen(() => import('./screens/Review'), (m) => m.ReviewScreen);
const ReelScreen = lazyScreen(() => import('./screens/Reel'), (m) => m.ReelScreen);
const CloseScreen = lazyScreen(() => import('./screens/Close'), (m) => m.CloseScreen);
const SetupScreen = lazyScreen(() => import('./screens/Setup'), (m) => m.SetupScreen);
const ArchiveScreen = lazyScreen(() => import('./screens/Archive'), (m) => m.ArchiveScreen);
const CheckInScreen = lazyScreen(() => import('./screens/CheckIn'), (m) => m.CheckInScreen);
const OnboardingScreen = lazyScreen(() => import('./screens/Onboarding'), (m) => m.OnboardingScreen);
const AboutScreen = lazyScreen(() => import('./screens/About'), (m) => m.AboutScreen);
const CoachHistoryScreen = lazyScreen(() => import('./screens/CoachHistory'), (m) => m.CoachHistoryScreen);
const SettingsScreen = lazyScreen(() => import('./screens/Settings'), (m) => m.SettingsScreen);

// The Log button makes its entrance once per launch, with the ignition sequence.
let logIntro = true;

export function App() {
  // New versions apply silently at a safe moment, otherwise the pill offers a reload.
  useAppUpdate(isUpdateSafePoint);
  return (
    <ToastProvider>
      <NotePromptProvider>
        <Shell />
      </NotePromptProvider>
      <UpdatePill />
    </ToastProvider>
  );
}

function Shell() {
  const state = useAppState();
  const route = useRoute();
  const reduced = useReducedMotion();
  const [logOpen, setLogOpen] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (!state) return;
    setSoundEnabled(state.settings.soundEffects);
    setHapticsEnabled(state.settings.haptics);
  }, [state?.settings.soundEffects, state?.settings.haptics, state]);

  // Browsers only allow audio after a gesture; warm it up on the first touch.
  useEffect(() => {
    const unlock = () => sfx.unlock();
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

  // Traveling: when the device lands in a new time zone, reassure that nothing broke.
  useEffect(() => {
    const check = async () => {
      const change = await checkTimeZoneChange();
      if (change) {
        toast({ message: `New time zone (${fmtOffset(change.to)}). Today and your streak are safe.`, duration: 6000 });
      }
    };
    void check();
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  }, [toast]);

  // Check-in streak milestones (7, 14, 30, ...) get their own celebration, once each.
  const streak = state?.dashboard.streak.current ?? 0;
  useEffect(() => {
    if (!state) return;
    void streakMilestoneReached(streak).then((m) => {
      if (m) celebrate({ kind: 'milestone', burner: 'family', title: `${m}-day streak`, subtitle: 'The fire keeps burning' });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streak, !!state]);

  // First launch on a fresh install (no profile, no goals, no people): start the onboarding interview.
  const fresh = !!state && !state.profile && state.data.allGoals.length === 0 && state.data.people.length === 0;
  useEffect(() => {
    if (!fresh || route.name !== 'home') return;
    void getOnboarding().then((o) => {
      if (!o?.completedAt && !o?.dismissedAt) navigate('onboarding', { replace: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh]);

  // Once the first screen is up, fetch the on-demand screens in the background.
  useEffect(() => {
    if (state) preloadScreens();
  }, [!!state]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!state) return <div className="h-full bg-black" />;

  const isBurner = route.name === 'burner' && (BURNERS as readonly string[]).includes(route.burner);
  let screen: React.ReactNode;
  switch (route.name) {
    case 'burner':
      screen = isBurner ? <BurnerScreen state={state} burner={route.burner as BurnerId} /> : <Home state={state} />;
      break;
    case 'settings':
      screen = <SettingsScreen state={state} />;
      break;
    case 'review':
      screen = <ReviewScreen state={state} />;
      break;
    case 'reel':
      screen = <ReelScreen state={state} quarterId={route.quarterId} closing={route.closing} />;
      break;
    case 'close':
      screen = <CloseScreen state={state} quarterId={route.quarterId} />;
      break;
    case 'setup':
      screen = <SetupScreen state={state} quarterId={route.quarterId} />;
      break;
    case 'archive':
      screen = <ArchiveScreen state={state} quarterId={route.quarterId} />;
      break;
    case 'checkin':
      screen = <CheckInScreen state={state} />;
      break;
    case 'onboarding':
      screen = <OnboardingScreen state={state} />;
      break;
    case 'about':
      screen = <AboutScreen state={state} />;
      break;
    case 'coach':
      screen = <CoachHistoryScreen state={state} />;
      break;
    default:
      screen = <Home state={state} />;
  }

  const heat = Object.fromEntries(BURNERS.map((b) => [b, state.dashboard.burners[b].heat * state.dashboard.burners[b].brightness])) as Record<BurnerId, number>;

  return (
    <>
      <Atmosphere heat={heat} focus={isBurner ? (route as { burner: BurnerId }).burner : undefined} />
      <div className="relative z-10 mx-auto min-h-full max-w-xl">
        <PendingCoachBanner routeName={route.name} />
        <AnimatePresence mode="wait" initial={false}>
          <motion.main
            key={routeKey(route)}
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 1.03, filter: 'blur(6px)' }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
          >
            <Suspense fallback={<div className="min-h-dvh" aria-busy="true" />}>{screen}</Suspense>
          </motion.main>
        </AnimatePresence>

        {route.name === 'home' && (
          <div className="pb-safe pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center bg-gradient-to-t from-black via-black/85 to-transparent pt-12">
            <motion.div
              className="pointer-events-auto"
              initial={reduced || !logIntro ? false : { opacity: 0, y: 40, scale: 0.8 }}
              onAnimationComplete={() => (logIntro = false)}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ delay: 1.4, type: 'spring', stiffness: 260, damping: 18 }}
            >
              <MoltenButton
                className="h-[66px] px-12 text-[20px]"
                onClick={() => {
                  sfx.whoosh();
                  haptic();
                  setLogOpen(true);
                }}
              >
                <span className="text-[26px] leading-none font-light">+</span> Log
              </MoltenButton>
            </motion.div>
          </div>
        )}

        <LogSheet open={logOpen} onClose={() => setLogOpen(false)} state={state} />
      </div>
      <Celebrations />
    </>
  );
}

function fmtOffset(min: number): string {
  const sign = min >= 0 ? '+' : '-';
  const a = Math.abs(min);
  return `UTC${sign}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, '0')}` : ''}`;
}
