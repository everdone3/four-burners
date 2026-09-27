// Settings > Backup: save a copy of everything to Files and restore from one. The file is built ahead of
// the tap (and rebuilt when data changes), so the share sheet opens inside the tap itself, as iOS requires.
import { useLiveQuery } from 'dexie-react-hooks';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { BackupError, LAST_BACKUP_KEY, buildBackupFile, importBackup, parseBackup, saveBackupFile } from '@/data/backup';
import { db } from '@/data/db';
import { holdBusy, holdBusyUntil } from '../busy';
import { sfx } from '../fx/audio';
import { haptic } from '../fx/haptics';
import { useReducedMotion } from '../motion';
import { GhostButton } from './ui';

const RESTORE_CONFIRM = 'Restore from this backup? Nothing is deleted. Newer items on this device are kept.';

type Note = { tone: 'ok' | 'warn' | 'error'; text: string } | null;
const NOTE_STYLE = {
  ok: { color: '#8ef0c4', glow: '0 0 12px rgba(110,231,183,0.45)' },
  warn: { color: '#ffd27a', glow: '0 0 12px rgba(255,190,90,0.45)' },
  error: { color: '#fda4af', glow: 'none' },
} as const;

export function fmtBackupDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Cool-toned cousin of MoltenButton for backups: fire stays with the goals, Files reads as ice blue. */
export function FrostButton({ children, className = '', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const reduced = useReducedMotion();
  return (
    <motion.button
      whileTap={{ scale: 0.95 }}
      className={`relative isolate overflow-hidden rounded-full font-bold text-black transition-opacity disabled:opacity-50 ${className}`}
      style={{
        backgroundImage: 'linear-gradient(110deg, #e3f8ff, #8ad7ff 35%, #5ab8ff 55%, #a9e7ff 80%, #e3f8ff)',
        backgroundSize: '220% 100%',
        animation: reduced ? undefined : 'lava 4.5s linear infinite, glow-pulse 2.6s ease-in-out infinite',
        boxShadow: '0 0 0 1px rgba(190,235,255,0.55), 0 10px 36px -8px rgba(60,160,255,0.7), 0 0 70px -12px rgba(90,209,255,0.55)',
      }}
      {...(rest as object)}
    >
      <span className="relative flex items-center justify-center gap-2">{children}</span>
    </motion.button>
  );
}

/** Glowing Files tile used by the backup panel and the Home reminder. */
export function BackupIcon({ lit = true }: { lit?: boolean }) {
  const reduced = useReducedMotion();
  return (
    <motion.span
      aria-hidden
      className="grid h-13 w-13 shrink-0 place-items-center rounded-2xl text-[26px]"
      style={{ background: 'radial-gradient(circle at 50% 30%, rgba(138,215,255,0.38), rgba(40,110,255,0.10))' }}
      animate={
        reduced || !lit
          ? { boxShadow: '0 0 0px 0px rgba(90,209,255,0)' }
          : { boxShadow: ['0 0 14px -4px rgba(90,209,255,0.5)', '0 0 26px -2px rgba(90,209,255,0.85)', '0 0 14px -4px rgba(90,209,255,0.5)'] }
      }
      transition={reduced ? undefined : { duration: 2.8, repeat: Infinity, ease: 'easeInOut' }}
    >
      🗂️
    </motion.span>
  );
}

export function BackupPanel() {
  const reduced = useReducedMotion();
  // Rebuilt whenever synced data changes, so the tap can hand it straight to the share sheet.
  const file = useLiveQuery(() => buildBackupFile(), []);
  const last = useLiveQuery(async () => {
    const v = (await db.kv.get(LAST_BACKUP_KEY))?.value;
    return typeof v === 'string' ? v : null;
  }, []);
  const [note, setNote] = useState<Note>(null);
  const [restoring, setRestoring] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // A second tap while the share sheet is opening must not start another save (or a download).
  const saving = useRef(false);
  // The share sheet and the file picker leave no trace in the page, so they hold off app updates (busy.ts).
  const pickerHold = useRef<(() => void) | null>(null);
  const releasePicker = () => {
    pickerHold.current?.();
    pickerHold.current = null;
  };
  useEffect(() => {
    // The picker closed without a file: 'cancel' where supported, else the next touch on the page.
    const el = input.current;
    el?.addEventListener('cancel', releasePicker);
    window.addEventListener('pointerdown', releasePicker, true);
    return () => {
      el?.removeEventListener('cancel', releasePicker);
      window.removeEventListener('pointerdown', releasePicker, true);
      releasePicker();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // releasePicker only touches a ref

  const save = () => {
    if (!file || saving.current) return;
    saving.current = true;
    // First thing in the tap: iOS only opens the share sheet during the gesture.
    const pending = holdBusyUntil('share sheet', saveBackupFile(file));
    sfx.tick();
    haptic();
    setNote(null);
    pending
      .then(
        (outcome) => {
          if (outcome === 'retry') setNote({ tone: 'warn', text: 'Tap again to save' });
          else if (outcome === 'shared' || outcome === 'downloaded') {
            haptic('success');
            setNote({ tone: 'ok', text: 'Backup saved' });
          }
        },
        () => setNote({ tone: 'error', text: 'Could not save the backup. Try again.' }),
      )
      .finally(() => {
        saving.current = false;
      });
  };

  const pick = () => {
    sfx.tick();
    setNote(null);
    pickerHold.current ??= holdBusy('file picker');
    input.current?.click();
  };

  const restore = async (el: HTMLInputElement) => {
    const picked = el.files?.[0];
    if (!picked) {
      releasePicker();
      return;
    }
    // Taken before the picker's hold goes, so there is no gap for a reload mid-restore.
    const release = holdBusy('restore');
    releasePicker();
    setRestoring(true);
    let importing = false;
    try {
      const text = await picked.text();
      parseBackup(text); // a wrong file gets its message right away, without the question first
      if (!confirm(RESTORE_CONFIRM)) return;
      importing = true;
      const r = await importBackup(text);
      setNote({ tone: 'ok', text: `Restored: ${r.added} added, ${r.updated} updated, ${r.skipped} unchanged` });
    } catch (e) {
      // The import is all or nothing, so a failed write leaves this device as it was.
      const text = e instanceof BackupError ? e.message : importing ? 'Could not restore. Nothing was changed.' : 'Could not read that file.';
      setNote({ tone: 'error', text });
    } finally {
      el.value = ''; // so the same file can be picked again
      setRestoring(false);
      release();
    }
  };

  return (
    <div>
      <div className="flex items-center gap-3.5">
        <BackupIcon lit={!!last} />
        <div className="min-w-0">
          <div className="text-[16px] font-semibold">{last ? 'Last backup' : 'No backup yet'}</div>
          <div className="text-[14px] text-dim">{last ? fmtBackupDate(last) : 'Save a copy to Files once a month.'}</div>
        </div>
      </div>

      <FrostButton className="mt-4 h-13 w-full text-[17px]" disabled={!file} onClick={save}>
        {file ? 'Save a backup to Files' : 'Preparing backup...'}
      </FrostButton>
      <GhostButton className="mt-2.5 w-full" disabled={restoring} onClick={pick}>
        {restoring ? 'Restoring...' : 'Restore from a backup'}
      </GhostButton>
      <input
        ref={input}
        type="file"
        accept=".json,application/json,application/octet-stream"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => void restore(e.currentTarget)}
      />

      {/* One live region that stays mounted, so screen readers announce each new note. */}
      <div role="status" aria-live="polite">
      <AnimatePresence mode="wait" initial={false}>
        {note && (
          <motion.p
            key={note.text}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6, filter: 'blur(4px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="mt-3 text-[15px] font-semibold"
            style={{ color: NOTE_STYLE[note.tone].color, textShadow: NOTE_STYLE[note.tone].glow }}
          >
            {note.text}
          </motion.p>
        )}
      </AnimatePresence>
      </div>

      <p className="mt-3 text-[13px] text-dim">A backup is a safety copy you keep in Files. It is separate from sync.</p>
    </div>
  );
}
