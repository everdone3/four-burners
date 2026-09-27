// Home card: the monthly nudge to save a backup to Files. Shown only while the reminder is due.
import { useLiveQuery } from 'dexie-react-hooks';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { buildBackupFile, getBackupReminder, saveBackupFile, snoozeBackupReminder } from '@/data/backup';
import { holdBusyUntil } from '../busy';
import { sfx } from '../fx/audio';
import { haptic } from '../fx/haptics';
import { useReducedMotion } from '../motion';
import { BackupIcon, FrostButton } from './BackupPanel';
import { GlowCard } from './sizzle';
import { useToast } from './ui';

export function BackupReminderCard() {
  const reduced = useReducedMotion();
  const toast = useToast();
  const [due, setDue] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const saving = useRef(false);
  useEffect(() => {
    // Not a live query: the first check on a device records when the reminder clock starts.
    // Checked again on every return to the app, since Home can stay open in the background for weeks.
    let live = true;
    const check = () => {
      if (document.visibilityState === 'hidden' || saving.current) return;
      getBackupReminder().then(
        (r) => live && setDue(r.due),
        () => {},
      );
    };
    check();
    document.addEventListener('visibilitychange', check);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', check);
    };
  }, []);
  // Built while the card shows (and rebuilt on changes), so "Save to Files" opens the share sheet inside the tap.
  const file = useLiveQuery(() => (due ? buildBackupFile() : undefined), [due]);

  const save = () => {
    if (!file || saving.current) return;
    saving.current = true;
    // The share sheet leaves no trace in the page: hold off app updates until it closes (busy.ts).
    const pending = holdBusyUntil('share sheet', saveBackupFile(file));
    haptic();
    setNote(null);
    pending
      .then(
        (outcome) => {
          if (outcome === 'retry') setNote('Tap again to save');
          else if (outcome === 'shared' || outcome === 'downloaded') {
            haptic('success');
            setDue(false);
            toast({ message: 'Backup saved' });
          }
        },
        () => setNote('Could not save the backup. Try again.'),
      )
      .finally(() => {
        saving.current = false;
      });
  };

  const later = () => {
    sfx.tick();
    setDue(false);
    void snoozeBackupReminder();
  };

  return (
    <AnimatePresence initial={false}>
      {due && (
        <motion.section
          key="backup-reminder"
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, filter: 'blur(6px)' }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
          className="mt-6"
        >
          <GlowCard color="#5ad1ff" intensity={0.8} className="overflow-hidden bg-black/65 backdrop-blur-xl">
            <div aria-hidden className="absolute inset-0" style={{ background: 'radial-gradient(ellipse at 50% 125%, rgba(90,209,255,0.26), transparent 62%)' }} />
            <div className="relative px-5 py-5">
              <div className="flex items-center gap-4">
                <BackupIcon />
                <div className="min-w-0 flex-1">
                  <h2 className="font-display text-[21px] font-bold" style={{ textShadow: '0 0 18px rgba(90,209,255,0.45)' }}>
                    Monthly backup
                  </h2>
                  <p className="text-[15px] text-dim">Save a copy of your data to Files.</p>
                </div>
              </div>
              <div className="mt-4 flex gap-2.5">
                <FrostButton className="h-13 flex-1 text-[17px]" disabled={!file} onClick={save}>
                  Save to Files
                </FrostButton>
                <button
                  onClick={later}
                  className="h-13 rounded-full border border-white/10 bg-white/[0.05] px-5 text-[16px] font-semibold text-white/80 transition active:scale-[0.97] active:bg-white/10"
                >
                  Later
                </button>
              </div>
              {note && <p role="status" className="mt-2.5 text-[14px] font-semibold text-amber-200">{note}</p>}
            </div>
          </GlowCard>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
