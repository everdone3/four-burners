import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { BURNERS, type BurnerId } from '@/domain';
import { useAppState } from '@/data/hooks';
import { ToastProvider } from './components/ui';
import { useReducedMotion } from './motion';
import { routeKey, useRoute } from './router';
import { BurnerScreen } from './screens/Burner';
import { Home } from './screens/Home';
import { LogSheet } from './screens/LogSheet';
import { SettingsScreen } from './screens/Settings';

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

  if (!state) return <div className="h-full bg-black" />;

  let screen: React.ReactNode;
  if (route.name === 'burner' && (BURNERS as readonly string[]).includes(route.burner)) {
    screen = <BurnerScreen state={state} burner={route.burner as BurnerId} />;
  } else if (route.name === 'settings') {
    screen = <SettingsScreen state={state} />;
  } else {
    screen = <Home state={state} />;
  }

  return (
    <div className="mx-auto min-h-full max-w-xl">
      <AnimatePresence mode="wait" initial={false}>
        <motion.main
          key={routeKey(route)}
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: -8 }}
          transition={{ duration: 0.22, ease: 'easeOut' }}
        >
          {screen}
        </motion.main>
      </AnimatePresence>

      {route.name === 'home' && (
        <div className="pb-safe pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center bg-gradient-to-t from-black via-black/85 to-transparent pt-10">
          <motion.button
            whileTap={{ scale: 0.95 }}
            onClick={() => setLogOpen(true)}
            className="pointer-events-auto flex h-16 items-center gap-2 rounded-full bg-white px-10 text-[18px] font-semibold text-black shadow-[0_0_40px_rgba(255,174,59,0.35)]"
          >
            <span className="text-2xl leading-none font-light">+</span> Log
          </motion.button>
        </div>
      )}

      <LogSheet open={logOpen} onClose={() => setLogOpen(false)} state={state} />
    </div>
  );
}
