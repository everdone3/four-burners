import { motion } from 'motion/react';
import { useState } from 'react';
import {
  BURNERS,
  BURNER_LABELS,
  INTENT_LABELS,
  countHigh,
  MAX_HIGH_BURNERS,
  peopleByUrgency,
  type BurnerId,
  type Person,
  type Goal,
  type Intent,
} from '@/domain';
import type { AppState } from '@/data/hooks';
import { setIntent } from '@/data/repo';
import { Flame } from '../components/Flame';
import { GoalRow } from '../components/GoalRow';
import { GhostButton, PrimaryButton, Segmented, Sheet, inputClass } from '../components/ui';
import { goBack } from '../router';
import { PALETTES } from '../theme';
import { STATUS_COLOR, STATUS_LABEL } from '../labels';
import { GoalEditor } from './GoalEditor';
import { GoalDetail } from "./GoalDetail";
import { PersonCard, PersonEditor } from "../components/People";
import { MoltenButton, getIrisOrigin } from '../components/sizzle';
import { useReducedMotion } from '../motion';
import { sfx } from '../fx/audio';

export function BurnerScreen({ state, burner }: { state: AppState; burner: BurnerId }) {
  const { quarter, dashboard, data } = state;
  const s = dashboard.burners[burner];
  const [detailId, setDetailId] = useState<string | null>(null);
  const [personEditor, setPersonEditor] = useState<{ open: boolean; person?: Person }>({ open: false });
  const isPeopleBurner = burner === "family" || burner === "friends";
  const people = isPeopleBurner ? peopleByUrgency(data.people.filter((p) => p.burner === burner), data.touchpoints, state.today) : [];
  const detail = s.goals.find((g) => g.goal.id === detailId);
  const goalCounts = Object.fromEntries(BURNERS.map((b) => [b, dashboard.burners[b].goals.length])) as Record<BurnerId, number>;
  const [editor, setEditor] = useState<{ open: boolean; goal?: Goal }>({ open: false });
  const [pendingIntent, setPendingIntent] = useState<Intent | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const palette = PALETTES[burner];
  const highs = countHigh(quarter.intents);
  const history = quarter.intentHistory.filter((h) => h.burner === burner);
  const reduced = useReducedMotion();
  const [iris] = useState(getIrisOrigin);

  const requestIntent = async (to: Intent) => {
    setError('');
    const r = await setIntent(quarter.id, burner, to);
    if (r.ok) return;
    if (r.needsReason) {
      setReason('');
      setPendingIntent(to);
    } else setError(r.error);
  };

  const confirmIntent = async () => {
    if (!pendingIntent) return;
    const r = await setIntent(quarter.id, burner, pendingIntent, reason);
    if (r.ok) setPendingIntent(null);
    else setError(r.error);
  };

  // Fixed-position pieces (Add goal bar, sheets) stay outside the iris clip so it never cuts them off.
  return (
    <>
    <motion.div
      className="pb-40"
      initial={reduced ? { opacity: 0 } : { clipPath: `circle(0px at ${iris.x}px ${iris.y}px)` }}
      animate={reduced ? { opacity: 1 } : { clipPath: `circle(300vmax at ${iris.x}px ${iris.y}px)` }}
      transition={{ duration: 0.75, ease: [0.65, 0, 0.35, 1] }}
    >
      <div className="relative h-[380px] overflow-hidden">
        <div className="absolute inset-0" style={{ background: `radial-gradient(ellipse at 50% 90%, ${palette.outer}55, transparent 60%)` }} />
        <div className="absolute inset-x-0 top-6 bottom-0">
          <Flame burner={burner} intent={s.intent} heat={s.heat} brightness={s.brightness} ignite={reduced ? undefined : 0.35} />
        </div>
        <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-black to-transparent" />
        <div className="px-safe pt-safe relative flex items-center justify-between">
          <button onClick={goBack} className="-ml-2 flex h-11 items-center gap-1 rounded-full pr-3 pl-2 text-[17px] text-dim active:bg-white/10">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
            Home
          </button>
          <BurnerSwitcher current={burner} />
        </div>
      </div>

      <div className="px-safe -mt-8 relative">
        <h1 className="font-display text-[48px] leading-none font-black tracking-tight" style={{ color: palette.accent, textShadow: `0 0 24px ${palette.mid}aa, 0 0 60px ${palette.outer}88` }}>
          {BURNER_LABELS[burner]}
        </h1>
        <p className={`text-[15px] ${STATUS_COLOR[s.status]}`}>{STATUS_LABEL[s.status]}</p>

        <div className="mt-5">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[13px] font-medium tracking-wide text-dim uppercase">Intent this quarter</span>
            <span className="text-[13px] text-faint">{highs}/{MAX_HIGH_BURNERS} High</span>
          </div>
          <Segmented
            value={s.intent}
            onChange={requestIntent}
            options={(['high', 'steady', 'low'] as Intent[]).map((i) => ({
              value: i,
              label: INTENT_LABELS[i],
              disabled: i === 'high' && s.intent !== 'high' && highs >= MAX_HIGH_BURNERS,
            }))}
          />
          {s.intent !== 'high' && highs >= MAX_HIGH_BURNERS && (
            <p className="mt-2 text-[13px] text-faint">Two burners are already on High. Lower one to raise this.</p>
          )}
          {error && <p className="mt-2 text-[14px] text-rose-300">{error}</p>}
        </div>

        <div className="mt-8 mb-3 flex items-baseline justify-between">
          <h2 className="font-display text-[24px] font-bold">Goals</h2>
          <span className="text-[13px] text-faint">Tap a goal for details</span>
        </div>
        <div className="space-y-2.5">
          {s.goals.map(({ goal, progress }) => (
            <GoalRow key={goal.id} goal={goal} progress={progress} logs={data.logs} onOpen={() => setDetailId(goal.id)} />
          ))}
          {s.goals.length === 0 && (
            <p className="rounded-2xl border border-dashed border-line px-4 py-6 text-center text-[15px] text-dim">
              No goals yet. Three is the sweet spot.
            </p>
          )}
        </div>

        {isPeopleBurner && (
          <div className="mt-9">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="font-display text-[24px] font-bold">People</h2>
              <button onClick={() => setPersonEditor({ open: true })} className="min-h-11 px-2 text-[16px] font-semibold" style={{ color: palette.accent }}>
                + Add
              </button>
            </div>
            <div className="space-y-2.5">
              {people.map((ps) => (
                <PersonCard key={ps.person.id} s={ps} onEdit={() => setPersonEditor({ open: true, person: ps.person })} />
              ))}
              {people.length === 0 && (
                <p className="rounded-2xl border border-dashed border-line px-4 py-6 text-center text-[15px] text-dim">
                  Who matters most here? Add them and set how often you want to connect.
                </p>
              )}
            </div>
          </div>
        )}

        {history.length > 0 && (
          <div className="mt-8">
            <h3 className="mb-2 text-[13px] font-medium tracking-wide text-dim uppercase">Intent changes</h3>
            <ul className="space-y-2">
              {history.map((h) => (
                <li key={h.at} className="rounded-2xl border border-line bg-surface px-4 py-3 text-[14px]">
                  <span className="font-medium">{INTENT_LABELS[h.from]} to {INTENT_LABELS[h.to]}</span>
                  <span className="text-faint"> · {h.localDate}</span>
                  <div className="mt-0.5 text-dim">{h.reason}</div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </motion.div>

      <div className="pb-safe fixed inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black via-black/90 to-transparent px-5 pt-8">
        <MoltenButton className="h-15 w-full text-[18px]" onClick={() => { sfx.tick(); setEditor({ open: true }); }}>
          Add goal
        </MoltenButton>
      </div>

      <GoalEditor
        open={editor.open}
        goal={editor.goal}
        onClose={() => setEditor({ open: false })}
        burner={burner}
        quarterId={quarter.id}
        existingCount={s.goals.length}
        intents={quarter.intents}
        goalCounts={goalCounts}
      />

      <GoalDetail
        goal={detail?.goal ?? null}
        progress={detail?.progress}
        logs={data.logs}
        people={data.people}
        onClose={() => setDetailId(null)}
        onEdit={(g) => {
          setDetailId(null);
          setEditor({ open: true, goal: g });
        }}
      />

      {isPeopleBurner && (
        <PersonEditor
          open={personEditor.open}
          person={personEditor.person}
          burner={burner as "family" | "friends"}
          goals={data.goals}
          onClose={() => setPersonEditor({ open: false })}
        />
      )}

      <Sheet open={pendingIntent !== null} onClose={() => setPendingIntent(null)} title="Why the change?">
        <p className="mb-4 text-[15px] text-dim">
          {BURNER_LABELS[burner]}: {INTENT_LABELS[s.intent]} to {pendingIntent ? INTENT_LABELS[pendingIntent] : ''}. One line is plenty.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void confirmIntent();
          }}
          className="space-y-4"
        >
          <input
            autoFocus
            className={inputClass}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Two closings land this month"
            autoCapitalize="sentences"
          />
          {error && <p className="text-[14px] text-rose-300">{error}</p>}
          <div className="flex gap-3">
            <GhostButton type="button" onClick={() => setPendingIntent(null)}>Cancel</GhostButton>
            <PrimaryButton type="submit" className="flex-1" disabled={!reason.trim()}>Change intent</PrimaryButton>
          </div>
        </form>
      </Sheet>
    </>
  );
}

function BurnerSwitcher({ current }: { current: BurnerId }) {
  return (
    <div className="flex gap-1.5" role="tablist" aria-label="Burners">
      {BURNERS.map((b) => (
        <a
          key={b}
          href={`#/burner/${b}`}
          role="tab"
          aria-selected={b === current}
          aria-label={BURNER_LABELS[b]}
          className="grid h-11 w-8 place-items-center"
          onClick={(e) => {
            e.preventDefault();
            location.replace(`#/burner/${b}`);
          }}
        >
          <span
            className="block h-2.5 w-2.5 rounded-full transition"
            style={{ background: PALETTES[b].accent, opacity: b === current ? 1 : 0.3, boxShadow: b === current ? `0 0 8px ${PALETTES[b].accent}` : undefined }}
          />
        </a>
      ))}
    </div>
  );
}
