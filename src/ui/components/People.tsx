// Key people: two-tap touchpoints (person, then type), cadence cues, and a person editor.
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import {
  CADENCE_OPTIONS,
  cadenceLabel,
  lastConnectedLabel,
  type Goal,
  type Person,
  type PersonStatus,
  type TouchpointType,
} from '@/domain';
import { addPerson, deletePerson, deleteTouchpoint, editTouchpoint, logTouchpoint, updatePerson } from '@/data/repo';
import { celebrate } from '../fx/Celebrations';
import { sfx } from '../fx/audio';
import { PALETTES } from '../theme';
import { useNotePrompt } from './NotePrompt';
import { Field, GhostButton, PrimaryButton, Sheet, inputClass, useToast } from './ui';

export const TOUCH_TYPES: { value: TouchpointType; label: string; icon: string }[] = [
  { value: 'call', label: 'Call', icon: '📞' },
  { value: 'text', label: 'Text', icon: '💬' },
  { value: 'in_person', label: 'In person', icon: '🤝' },
  { value: 'other', label: 'Other', icon: '✨' },
];

const STATE_LABEL: Record<PersonStatus['state'], string> = {
  fresh: 'Warm',
  approaching: 'Coming up',
  due: 'Due',
  overdue: 'Overdue',
  never: 'Reach out',
};

function initials(name: string) {
  return name
    .replace(/\(.*?\)/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

/** 1 = just connected, fading toward 0.25 as they pass their cadence. */
function warmth(s: PersonStatus) {
  if (s.ratio === null) return 0.35;
  return Math.max(0.25, Math.min(1, 1.15 - s.ratio * 0.65));
}

export function useTouchpointLogger() {
  const toast = useToast();
  const promptNote = useNotePrompt();
  return async (s: PersonStatus, type: TouchpointType, at: { x: number; y: number }) => {
    const wasOverdue = s.state === 'overdue' || s.state === 'due' || s.state === 'never';
    celebrate({
      kind: wasOverdue ? 'milestone' : 'reconnect',
      burner: s.person.burner,
      x: at.x,
      y: at.y,
      title: wasOverdue ? 'Reconnected' : undefined,
      subtitle: wasOverdue ? s.person.name : undefined,
    });
    const tp = await logTouchpoint(s.person.id, type);
    toast({
      message: `${TOUCH_TYPES.find((t) => t.value === type)?.label} with ${s.person.name}`,
      actions: [
        {
          label: 'Note',
          run: () =>
            promptNote({
              title: `Note about ${s.person.name}`,
              onSave: (note, isPrivate) => editTouchpoint(tp.id, { note, notePrivate: isPrivate }),
            }),
        },
        { label: 'Undo', run: () => void deleteTouchpoint(tp.id) },
      ],
    });
  };
}

export function PersonCard({ s, compact, onEdit }: { s: PersonStatus; compact?: boolean; onEdit?: () => void }) {
  const [open, setOpen] = useState(false);
  const logTouch = useTouchpointLogger();
  const p = PALETTES[s.person.burner];
  const w = warmth(s);
  const overdue = s.state === 'overdue';

  return (
    <div className="relative overflow-hidden rounded-[20px] border bg-[#0a0a0c]/90 backdrop-blur" style={{ borderColor: overdue ? `${p.outer}66` : 'rgba(255,255,255,0.08)' }}>
      <div className="flex items-center gap-3 px-3.5 py-3">
        <button
          onClick={() => {
            sfx.tick();
            setOpen((o) => !o);
          }}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          aria-expanded={open}
          aria-label={`Log a touchpoint with ${s.person.name}`}
        >
          <span
            className="relative grid h-12 w-12 shrink-0 place-items-center rounded-full font-display text-[16px] font-bold"
            style={{
              color: w > 0.5 ? '#000' : p.core,
              background: `radial-gradient(circle at 50% 35%, ${p.core}, ${p.mid} 55%, ${p.outer})`,
              opacity: 0.35 + 0.65 * w,
              boxShadow: `0 0 ${6 + 22 * w}px ${p.mid}${w > 0.6 ? 'cc' : '55'}`,
            }}
          >
            {initials(s.person.name)}
            {overdue && <span className="absolute -top-0.5 -right-0.5 h-3.5 w-3.5 animate-pulse rounded-full border-2 border-black" style={{ background: p.outer }} />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[16px] font-semibold">{s.person.name}</span>
            <span className="block text-[13px] text-dim">
              {lastConnectedLabel(s)}
              {!compact && <span className="text-faint"> · {cadenceLabel(s.person.cadenceDays).toLowerCase()}</span>}
            </span>
          </span>
          <span
            className="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold tracking-wider uppercase"
            style={{
              color: overdue || s.state === 'due' || s.state === 'never' ? p.core : 'rgba(255,255,255,0.55)',
              background: overdue || s.state === 'due' ? `${p.outer}33` : 'rgba(255,255,255,0.05)',
            }}
          >
            {STATE_LABEL[s.state]}
          </span>
        </button>
        {onEdit && (
          <button onClick={onEdit} className="grid h-11 w-9 shrink-0 place-items-center text-faint" aria-label={`Edit ${s.person.name}`}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
            <div className="grid grid-cols-4 gap-2 border-t border-white/[0.06] p-3">
              {TOUCH_TYPES.map((t, i) => (
                <motion.button
                  key={t.value}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04 }}
                  whileTap={{ scale: 0.9 }}
                  onClick={async (e) => {
                    setOpen(false);
                    await logTouch(s, t.value, { x: e.clientX || innerWidth / 2, y: e.clientY || innerHeight / 2 });
                  }}
                  className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-2xl text-[13px] font-semibold"
                  style={{ background: `${p.mid}14`, boxShadow: `inset 0 0 0 1px ${p.mid}40`, color: p.core }}
                >
                  <span className="text-[20px]" aria-hidden>
                    {t.icon}
                  </span>
                  {t.label}
                </motion.button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function PersonEditor({
  open,
  onClose,
  burner,
  person,
  goals,
}: {
  open: boolean;
  onClose: () => void;
  burner: 'family' | 'friends';
  person?: Person;
  goals: readonly Goal[];
}) {
  const [name, setName] = useState('');
  const [cadence, setCadence] = useState(14);
  const [linked, setLinked] = useState<string[]>([]);
  const burnerGoals = goals.filter((g) => g.burner === burner);

  useEffect(() => {
    if (!open) return;
    setName(person?.name ?? '');
    setCadence(person?.cadenceDays ?? (burner === 'family' ? 7 : 14));
    setLinked(person ? burnerGoals.filter((g) => g.personIds?.includes(person.id)).map((g) => g.id) : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, person, burner]);

  const p = PALETTES[burner];
  return (
    <Sheet open={open} onClose={onClose} title={person ? 'Edit person' : 'Add a key person'}>
      <form
        className="space-y-5"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          if (person) await updatePerson(person.id, { name: name.trim(), cadenceDays: cadence }, linked);
          else await addPerson({ name, burner, cadenceDays: cadence }, linked);
          onClose();
        }}
      >
        <Field label="Name">
          <input autoFocus={!person} className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder={burner === 'family' ? 'Mom' : 'Jake'} autoCapitalize="words" />
        </Field>
        <Field label="Stay in touch">
          <div className="grid grid-cols-2 gap-2">
            {CADENCE_OPTIONS.map((o) => (
              <button
                type="button"
                key={o.days}
                onClick={() => setCadence(o.days)}
                className="min-h-12 rounded-2xl px-3 text-[15px] font-medium transition"
                style={
                  cadence === o.days
                    ? { background: `linear-gradient(135deg, ${p.mid}, ${p.outer})`, color: '#000', boxShadow: `0 0 18px -4px ${p.mid}` }
                    : { background: 'rgba(255,255,255,0.04)', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.09)' }
                }
              >
                {o.label}
              </button>
            ))}
          </div>
        </Field>
        {burnerGoals.length > 0 && (
          <Field label="Linked goals" hint="Optional. Shows this person on those goals.">
            <div className="flex flex-wrap gap-2">
              {burnerGoals.map((g) => {
                const on = linked.includes(g.id);
                return (
                  <button
                    type="button"
                    key={g.id}
                    aria-pressed={on}
                    onClick={() => setLinked((xs) => (on ? xs.filter((x) => x !== g.id) : [...xs, g.id]))}
                    className="min-h-10 rounded-full px-3.5 text-[14px]"
                    style={on ? { background: `${p.mid}33`, boxShadow: `inset 0 0 0 1px ${p.mid}`, color: p.core } : { boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.12)' }}
                  >
                    {on ? '✓ ' : ''}
                    {g.title}
                  </button>
                );
              })}
            </div>
          </Field>
        )}
        <div className="flex gap-3 pt-1">
          {person && (
            <GhostButton
              type="button"
              className="text-rose-300"
              onClick={async () => {
                if (confirm(`Remove ${person.name}? Past touchpoints stay in your history.`)) {
                  await deletePerson(person.id);
                  onClose();
                }
              }}
            >
              Remove
            </GhostButton>
          )}
          <PrimaryButton type="submit" className="flex-1" disabled={!name.trim()}>
            {person ? 'Save' : 'Add person'}
          </PrimaryButton>
        </div>
      </form>
    </Sheet>
  );
}
