// Floating pill for app updates (see useAppUpdate): "Update ready" when a new version is waiting but you
// are in the middle of something, and a short "Updated" after a reload you asked for.
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { applyUpdate, takeUpdateAnnouncement, useUpdateStatus } from '../useAppUpdate';
import { useReducedMotion } from '../motion';
import { MoltenButton } from './sizzle';

const GLOW = '0 0 0 1px rgba(255,174,59,0.18), 0 12px 40px -8px rgba(0,0,0,0.95), 0 0 36px -6px rgba(255,140,40,0.6)';

// Read once per page load (reading clears it).
const justUpdated = takeUpdateAnnouncement() !== null;

export function UpdatePill() {
  const status = useUpdateStatus();
  const reduced = useReducedMotion();
  // On while an update waits; stays on through "Updating..." if you were looking at it. Silent updates
  // go from none to applying in one step, so they skip the pill.
  const [pill, setPill] = useState(false);
  const [updated, setUpdated] = useState(justUpdated);
  const banner = useHasBanner();

  useEffect(() => {
    if (status === 'ready') setPill(true);
    else if (status === 'none') setPill(false);
  }, [status]);

  useEffect(() => {
    if (!justUpdated) return;
    const t = setTimeout(() => setUpdated(false), 2800);
    return () => clearTimeout(t);
  }, []);

  const show = (pill && status !== 'none') || updated;
  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-4"
      // Sit below the coach reminder banner when it owns the top of the screen.
      style={{ paddingTop: `calc(max(env(safe-area-inset-top), 12px) + ${banner ? 64 : 6}px)` }}
    >
      <AnimatePresence>
        {show && (
          <motion.div
            key="pill"
            role="status"
            layout
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: -28, scale: 0.9, filter: 'blur(6px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -20, scale: 0.94, filter: 'blur(4px)' }}
            transition={{ type: 'spring', stiffness: 420, damping: 30 }}
            className="pointer-events-auto flex min-h-13 items-center gap-3 rounded-full border border-ember/40 bg-[#141416]/95 py-1.5 pr-1.5 pl-4 backdrop-blur-xl"
            style={{ boxShadow: GLOW }}
          >
            <Ember reduced={reduced} />
            {status === 'ready' ? (
              <>
                <span className="text-[15px] font-semibold">Update ready</span>
                <MoltenButton className="h-10 px-5 text-[15px]" onClick={() => applyUpdate(true)}>
                  Reload
                </MoltenButton>
                <button onClick={() => setPill(false)} className="grid h-10 w-8 place-items-center text-[20px] text-faint" aria-label="Hide until later">
                  ×
                </button>
              </>
            ) : (
              <span className="pr-3 text-[15px] font-semibold">{status === 'applying' ? 'Updating...' : 'Updated to the latest version'}</span>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Ember({ reduced }: { reduced: boolean }) {
  return (
    <motion.span
      aria-hidden
      className="h-2.5 w-2.5 shrink-0 rounded-full"
      style={{ background: 'radial-gradient(circle, #fff 0%, #ffd27a 40%, #ff6a2b 100%)', boxShadow: '0 0 10px #ff8a3d, 0 0 20px rgba(255,120,40,0.6)' }}
      animate={reduced ? undefined : { scale: [1, 1.45, 1], opacity: [1, 0.75, 1] }}
      transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
    />
  );
}

/** The coach reminder banner flags itself with .has-banner on <html> (see CoachPanel). */
function useHasBanner(): boolean {
  const [on, setOn] = useState(() => document.documentElement.classList.contains('has-banner'));
  useEffect(() => {
    const root = document.documentElement;
    const obs = new MutationObserver(() => setOn(root.classList.contains('has-banner')));
    obs.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return on;
}
