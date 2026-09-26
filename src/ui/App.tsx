import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { BURNERS, type BurnerId } from '@/domain';
import { useAppState } from '@/data/hooks';
import { ToastProvider } from './components/ui';
import { MoltenButton } from './components/sizzle';
import { Atmosphere } from './fx/Atmosphere';
import { Celebrations } from './fx/Celebrations';
import { setSoundEnabled, sfx } from './fx/audio';
import { haptic, setHapticsEnabled } from './fx/haptics';
import { useReducedMotion } from './motion';
import { routeKey, useRoute } from './router';
import { BurnerScreen } from './screens/Burner';
import { Home } from './screens/Home';
import { LogSheet } from './screens/LogSheet';
import { SettingsScreen } from './screens/Settings';

// The Log button makes its entrance once per launch, with the ignition sequence.
let logIntro = true;

export function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

function Shell() {
  const state = useAppState();
  const route = useRoute();
  const reduced = useReducedMotion();
  const [logOpen, setLogOpen] = useState(false);

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

  if (!state) return <div className="h-full bg-black" />;

  const isBurner = route.name === 'burner' && (BURNERS as readonly string[]).includes(route.burner);
  let screen: React.ReactNode;
  if (isBurner) {
    screen = <BurnerScreen state={state} burner={(route as { burner: BurnerId }).burner} />;
  } else if (route.name === 'settings') {
    screen = <SettingsScreen state={state} />;
  } else {
    screen = <Home state={state} />;
  }

  const heat = Object.fromEntries(BURNERS.map((b) => [b, state.dashboard.burners[b].heat * state.dashboard.burners[b].brightness])) as Record<BurnerId, number>;

  return (
    <>
      <Atmosphere heat={heat} focus={isBurner ? (route as { burner: BurnerId }).burner : undefined} />
      <div className="relative z-10 mx-auto min-h-full max-w-xl">
        <AnimatePresence mode="wait" initial={false}>
          <motion.main
            key={routeKey(route)}
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 1.03, filter: 'blur(6px)' }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
          >
            {screen}
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
