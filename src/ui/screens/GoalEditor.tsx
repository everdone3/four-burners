import { useEffect, useState } from 'react';
import {
  BURNER_LABELS,
  goalSlot,
  newId,
  quarterSpan,
  type BurnerId,
  type Goal,
  type GoalType,
  type HabitPeriod,
  type Milestone,
  type QuarterId,
} from '@/domain';
import { addGoal, deleteGoal, updateGoal } from '@/data/repo';
import { Field, GhostButton, PrimaryButton, Segmented, Sheet, inputClass } from '../components/ui';

const TYPES: { value: GoalType; label: string }[] = [
  { value: 'number', label: 'Number' },
  { value: 'habit', label: 'Habit' },
  { value: 'yesno', label: 'Yes/No' },
  { value: 'milestone', label: 'Steps' },
];

export function GoalEditor({
  open,
  onClose,
  burner,
  quarterId,
  existingCount,
  goal,
}: {
  open: boolean;
  onClose: () => void;
  burner: BurnerId;
  quarterId: QuarterId;
  existingCount: number;
  goal?: Goal;
}) {
  const span = quarterSpan(quarterId);
  const [title, setTitle] = useState('');
  const [type, setType] = useState<GoalType>('habit');
  const [target, setTarget] = useState('');
  const [unit, setUnit] = useState('');
  const [period, setPeriod] = useState<HabitPeriod>('week');
  const [steps, setSteps] = useState<Milestone[]>([]);
  const [deadline, setDeadline] = useState(span.end);

  useEffect(() => {
    if (!open) return;
    setTitle(goal?.title ?? '');
    setType(goal?.type ?? 'habit');
    setTarget(goal?.target ? String(goal.target) : '');
    setUnit(goal?.unit ?? '');
    setPeriod(goal?.habitPeriod ?? 'week');
    setSteps(goal?.milestones ?? [{ id: newId(), title: '' }, { id: newId(), title: '' }]);
    setDeadline(goal?.deadline ?? span.end);
  }, [open, goal, span.end]);

  const slot = goalSlot(existingCount);
  const blocked = !goal && !slot.allowed;
  const cleanSteps = steps.filter((s) => s.title.trim());
  const valid =
    title.trim().length > 0 && (type !== 'milestone' || cleanSteps.length > 0) && !blocked;

  const save = async () => {
    const fields = {
      title: title.trim(),
      type,
      target: type === 'number' || type === 'habit' ? Number(target) || undefined : undefined,
      unit: type === 'number' ? unit.trim() || undefined : undefined,
      habitPeriod: type === 'habit' ? period : undefined,
      milestones: type === 'milestone' ? cleanSteps.map((s) => ({ ...s, title: s.title.trim() })) : undefined,
      deadline: deadline > span.end ? span.end : deadline,
    };
    if (goal) await updateGoal(goal.id, fields);
    else await addGoal({ ...fields, burner, quarterId });
    onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} title={goal ? 'Edit goal' : `New ${BURNER_LABELS[burner]} goal`}>
      {blocked ? (
        <p className="py-6 text-[16px] text-dim">{slot.message}</p>
      ) : (
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void save();
          }}
        >
          {!goal && slot.message && <p className="text-[14px] text-amber-200">{slot.message}</p>}
          <Field label="Goal">
            <input
              className={inputClass}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Date night"
              autoCapitalize="sentences"
              enterKeyHint="next"
            />
          </Field>

          <Field label="Type">
            <Segmented value={type} options={TYPES} onChange={setType} disabled={!!goal} />
          </Field>

          {type === 'number' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Target">
                <input className={inputClass} inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="300" />
              </Field>
              <Field label="Unit">
                <input className={inputClass} value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="miles" />
              </Field>
            </div>
          )}

          {type === 'habit' && (
            <div className="grid grid-cols-[1fr_1.4fr] items-end gap-3">
              <Field label="Times">
                <input className={inputClass} inputMode="numeric" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="2" />
              </Field>
              <Segmented
                value={period}
                options={[
                  { value: 'week', label: 'per week' },
                  { value: 'month', label: 'per month' },
                ]}
                onChange={setPeriod}
              />
            </div>
          )}

          {type === 'milestone' && (
            <Field label="Steps, in order">
              <div className="space-y-2">
                {steps.map((s, i) => (
                  <div key={s.id} className="flex items-center gap-2">
                    <span className="w-5 text-right text-[14px] text-faint tabular">{i + 1}</span>
                    <input
                      className={inputClass}
                      value={s.title}
                      disabled={!!s.doneAt}
                      onChange={(e) => setSteps((xs) => xs.map((x) => (x.id === s.id ? { ...x, title: e.target.value } : x)))}
                      placeholder={i === 0 ? 'Pick dates' : 'Next step'}
                    />
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setSteps((xs) => [...xs, { id: newId(), title: '' }])}
                  className="min-h-11 pl-7 text-[15px] font-medium text-ember"
                >
                  + Add step
                </button>
              </div>
            </Field>
          )}

          <Field label="Deadline" hint="Defaults to the end of the quarter.">
            <input
              type="date"
              className={inputClass}
              value={deadline}
              min={span.start}
              max={span.end}
              onChange={(e) => setDeadline(e.target.value || span.end)}
            />
          </Field>

          <div className="flex gap-3 pt-2">
            {goal && (
              <GhostButton
                type="button"
                className="text-rose-300"
                onClick={async () => {
                  if (confirm(`Delete "${goal.title}"? Its logs will no longer count.`)) {
                    await deleteGoal(goal.id);
                    onClose();
                  }
                }}
              >
                Delete
              </GhostButton>
            )}
            <PrimaryButton type="submit" className="flex-1" disabled={!valid}>
              {goal ? 'Save' : 'Add goal'}
            </PrimaryButton>
          </div>
        </form>
      )}
    </Sheet>
  );
}
