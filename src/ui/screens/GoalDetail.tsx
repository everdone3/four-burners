// Goal details: why, when/where, linked people, and every log (editable, with edit history).
import { useEffect, useState } from 'react';
import { quarterSpan, type Goal, type GoalProgress, type LogEntry, type Person } from '@/domain';
import { deleteLog, editLog, restoreLog } from '@/data/repo';
import { LavaBar } from '../components/sizzle';
import { PrivateToggle } from '../components/NotePrompt';
import { GhostButton, PrimaryButton, Sheet, inputClass, useToast } from '../components/ui';
import { PALETTES } from '../theme';
import { STATUS_COLOR, STATUS_LABEL, goalTypeHint, progressText } from '../labels';

function when(l: LogEntry): string {
  const d = new Date(l.at);
  return `${new Date(l.localDate + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

export function GoalDetail({
  goal,
  progress,
  logs,
  people,
  onClose,
  onEdit,
}: {
  goal: Goal | null;
  progress?: GoalProgress;
  logs: readonly LogEntry[];
  people: readonly Person[];
  onClose: () => void;
  onEdit: (g: Goal) => void;
}) {
  const [editing, setEditing] = useState<LogEntry | null>(null);
  const mine = goal ? logs.filter((l) => l.goalId === goal.id).sort((a, b) => (a.at < b.at ? 1 : -1)) : [];
  const linked = goal?.personIds?.map((id) => people.find((p) => p.id === id)).filter((p): p is Person => !!p) ?? [];
  const p = goal ? PALETTES[goal.burner] : PALETTES.family;
  const toast = useToast();

  return (
    <>
      <Sheet open={!!goal && !editing} onClose={onClose} title={goal?.title}>
        {goal && progress && (
          <div className="space-y-5">
            <div>
              <div className="mb-2 flex items-baseline justify-between text-[14px]">
                <span className="text-dim tabular">{progressText(goal, progress)}</span>
                <span className={`font-semibold ${STATUS_COLOR[progress.status]}`}>{STATUS_LABEL[progress.status]}</span>
              </div>
              <LavaBar fraction={progress.fraction} color={p.accent} hot={p.core} />
              <div className="mt-2 text-[13px] text-faint">
                {goalTypeHint(goal)} · due {new Date(goal.deadline + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                {goal.startDate > quarterSpan(goal.quarterId).start &&
                  ` · added mid-quarter, judged from ${new Date(goal.startDate + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`}
              </div>
            </div>

            <InfoBlock label="Why it matters" value={goal.why} color={p.accent} empty="No why yet. Add one; it is what pulls you back." />
            <InfoBlock label="When and where" value={goal.whenWhere} color={p.accent} empty="No plan yet. When and where will you do this?" />

            {linked.length > 0 && (
              <div>
                <div className="mb-2 text-[12px] font-semibold tracking-[0.14em] text-dim uppercase">People</div>
                <div className="flex flex-wrap gap-2">
                  {linked.map((x) => (
                    <span key={x.id} className="rounded-full px-3 py-1.5 text-[14px]" style={{ background: `${p.mid}1a`, boxShadow: `inset 0 0 0 1px ${p.mid}44` }}>
                      {x.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div>
              <div className="mb-2 text-[12px] font-semibold tracking-[0.14em] text-dim uppercase">
                Log history {mine.length ? `(${mine.length})` : ''}
              </div>
              {mine.length === 0 && <p className="text-[15px] text-faint">Nothing logged yet.</p>}
              <ul className="divide-y divide-white/[0.06] overflow-hidden rounded-2xl border border-white/[0.08]">
                {mine.slice(0, 40).map((l) => (
                  <li key={l.id}>
                    <button onClick={() => setEditing(l)} className="flex w-full items-start gap-3 px-4 py-3 text-left active:bg-white/5">
                      <span className="min-w-12 font-display text-[17px] font-bold tabular" style={{ color: p.accent }}>
                        {goal.type === 'number' ? `+${l.value}` : goal.type === 'milestone' ? '✓' : `×${l.value}`}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] text-dim">{when(l)}</span>
                        {l.milestoneId && <span className="block text-[15px]">{goal.milestones?.find((m) => m.id === l.milestoneId)?.title}</span>}
                        {l.note && (
                          <span className="mt-0.5 block text-[15px]">
                            {l.notePrivate && <span className="mr-1 text-[12px] text-ember">🔒</span>}
                            {l.note}
                          </span>
                        )}
                        {l.edits?.length ? <span className="mt-0.5 block text-[12px] text-faint">Edited {l.edits.length === 1 ? 'once' : `${l.edits.length} times`}</span> : null}
                      </span>
                      <span className="text-[14px] text-faint">Edit</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <GhostButton className="w-full" onClick={() => onEdit(goal)}>
              Edit goal
            </GhostButton>
          </div>
        )}
      </Sheet>

      <LogEditor
        log={editing}
        goal={goal}
        onClose={() => setEditing(null)}
        onDelete={async (l) => {
          await deleteLog(l.id);
          setEditing(null);
          toast({ message: 'Log deleted', actions: [{ label: 'Undo', run: () => void restoreLog(l.id) }] });
        }}
      />
    </>
  );
}

function InfoBlock({ label, value, color, empty }: { label: string; value?: string; color: string; empty: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] px-4 py-3">
      <div className="text-[12px] font-semibold tracking-[0.14em] uppercase" style={{ color }}>
        {label}
      </div>
      <div className={`mt-1 text-[16px] ${value ? '' : 'text-faint'}`}>{value || empty}</div>
    </div>
  );
}

function LogEditor({ log, goal, onClose, onDelete }: { log: LogEntry | null; goal: Goal | null; onClose: () => void; onDelete: (l: LogEntry) => void }) {
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [priv, setPriv] = useState(false);
  useEffect(() => {
    if (!log) return;
    setValue(String(log.value));
    setNote(log.note ?? '');
    setPriv(!!log.notePrivate);
  }, [log]);
  if (!goal) return null;
  const canEditValue = goal.type === 'number' || goal.type === 'habit';

  return (
    <Sheet open={!!log} onClose={onClose} title="Edit log">
      {log && (
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const v = Number(value);
            await editLog(log.id, { value: canEditValue && v > 0 ? v : undefined, note, notePrivate: priv });
            onClose();
          }}
        >
          <p className="text-[14px] text-dim">{when(log)}</p>
          {canEditValue && (
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium tracking-wide text-dim uppercase">{goal.type === 'number' ? goal.unit ?? 'Amount' : 'Times'}</span>
              <input className={inputClass} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
            </label>
          )}
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium tracking-wide text-dim uppercase">Note</span>
            <textarea rows={3} className={`${inputClass} resize-none`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
          </label>
          <PrivateToggle value={priv} onChange={setPriv} />
          {log.edits?.length ? (
            <details className="rounded-2xl border border-white/[0.08] px-4 py-3 text-[14px] text-dim">
              <summary className="cursor-pointer">Edit history ({log.edits.length})</summary>
              <ul className="mt-2 space-y-1">
                {log.edits.map((ed) => (
                  <li key={ed.at}>
                    {new Date(ed.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}: was {ed.prevValue}
                    {ed.prevNote ? `, "${ed.prevNote}"` : ''}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <div className="flex gap-3">
            <GhostButton type="button" className="text-rose-300" onClick={() => onDelete(log)}>
              Delete
            </GhostButton>
            <PrimaryButton type="submit" className="flex-1">
              Save
            </PrimaryButton>
          </div>
        </form>
      )}
    </Sheet>
  );
}
