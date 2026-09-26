// First-launch onboarding: a short spoken-or-typed interview that becomes the "About me" profile,
// optional private names (redacted from every packet), an optional Claude refinement, key people,
// then the first quarter setup. Every change autosaves; leaving mid-way resumes on the same screen.
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BURNERS,
  BURNER_LABELS,
  CADENCE_OPTIONS,
  EMPTY_PROFILE_FIELDS,
  daysLeftInQuarter,
  nextQuarterId,
  quarterLabel,
  quarterOf,
  quarterSpan,
  type BurnerId,
  type ProfileFields,
  type TravelRhythm,
} from '@/domain';
import { buildOnboardingPacket } from '@/domain/coach/packets';
import { TRAVEL_LABELS, applyAboutMePatch, parseAboutMe, parsePeople, type PersonDraft } from '@/domain/coach/profile';
import { cleanTerms, termProblem } from '@/domain/coach/redact';
import type { AppState } from '@/data/hooks';
import { addPerson, getOnboarding, restorePreviousProfile, saveOnboarding, saveProfile, saveSettings } from '@/data/repo';
import { db } from '@/data/db';
import { Flame } from '../components/Flame';
import { CoachPanel } from '../components/CoachPanel';
import { SensitiveWarning } from '../components/Sensitive';
import { MiniFlame, MoltenButton, ShimmerText, StepEmbers } from '../components/sizzle';
import { GhostButton, PrimaryButton, inputClass, useToast } from '../components/ui';
import { celebrate } from '../fx/Celebrations';
import { sfx } from '../fx/audio';
import { navigate } from '../router';
import { PALETTES } from '../theme';
import { useReducedMotion } from '../motion';

type Field =
  | 'lifeContext'
  | 'travel'
  | 'crunch'
  | `${BurnerId}.matters`
  | `${BurnerId}.winning`;

interface Question {
  id: string;
  title: string;
  prompt: string;
  placeholder: string;
  field: Field;
  core: boolean;
  kind: 'text' | 'people' | 'choice';
  helper?: string;
  burner?: BurnerId;
}

// From the design workflow (docs/coach-design.md, "Onboarding interview").
const QUESTIONS: Question[] = [
  { id: 'life_context', title: 'Your life right now', prompt: 'The short version: who is at home, where home base is, and what this season of life feels like.', placeholder: 'Married, two kids, 9 and 12. Home base is Charlotte, but I am on a plane most weeks. I want to be more present at home than last year.', field: 'lifeContext', core: true, kind: 'text' },
  { id: 'family_people', title: 'Who matters at home', prompt: 'Name the family you most want to show up for, and roughly how often you want real time with each.', placeholder: 'Sarah, every week. Maya and Luke, every week. Mom, every week. Dad and my sister Katie, every two weeks.', field: 'family.matters', core: true, kind: 'people', burner: 'family' },
  { id: 'family_winning', title: 'Winning at home', prompt: 'Picture the last day of the quarter. What happened at home that makes it a win?', placeholder: 'Home for dinner most nights I am in town. Two real date nights a month. The winter trip is booked.', field: 'family.winning', core: true, kind: 'text', burner: 'family' },
  { id: 'friends_people', title: 'Your people', prompt: 'Which friends do you want to stay close to? Say their names and roughly how often you want to connect.', placeholder: 'Jake, every two weeks. Priya and Marcus, monthly. Elena, every couple of months.', field: 'friends.matters', core: true, kind: 'people', burner: 'friends' },
  { id: 'friends_winning', title: 'Winning with friends', prompt: 'What would make you feel like a good friend by the end of the quarter?', placeholder: 'I reached out before they had to. We hosted one dinner at our place, and I made the golf weekend.', field: 'friends.winning', core: true, kind: 'text', burner: 'friends' },
  { id: 'health_focus', title: 'Health, honestly', prompt: 'What does Health cover for you right now? Training, sleep, food, stress, and anything you are working around.', placeholder: 'Running and lifting keep me sane. Sleep falls apart on the road. My left knee complains if I add miles too fast.', field: 'health.matters', core: false, kind: 'text', burner: 'health' },
  { id: 'health_winning', title: 'Winning at health', prompt: 'What would a winning quarter look like for your body and your energy?', placeholder: 'Three workouts a week, even on travel weeks. Lights out by 10:30 most nights.', field: 'health.winning', core: true, kind: 'text', burner: 'health' },
  { id: 'work_focus', title: 'Work at 30,000 feet', prompt: 'Your role in a sentence or two, and what Work should never cost you. Keep it general: no client, firm, or deal names.', placeholder: 'I lead acquisitions and business development. It is relationships, judgment, and follow-through. Work should never cost me bedtime with the kids.', field: 'work.matters', core: false, kind: 'text', burner: 'work', helper: 'Your coach never needs client or deal specifics. Habits and priorities are enough.' },
  { id: 'work_winning', title: 'Winning at work', prompt: 'What does a winning quarter at work look like? Think habits and priorities, not deal specifics.', placeholder: 'Deep work four mornings a week. Follow up on everything within a day. Out by 6:30 when I am home.', field: 'work.winning', core: true, kind: 'text', burner: 'work', helper: 'Your coach never needs client or deal specifics. Habits and priorities are enough.' },
  { id: 'travel_rhythm', title: 'Time on the road', prompt: 'How much do you travel for work in a typical quarter?', placeholder: '', field: 'travel', core: true, kind: 'choice' },
  { id: 'crunch_pattern', title: 'Deal season', prompt: 'When a deal period gets intense, what does it look like, how often does it happen, and what slips first?', placeholder: 'A few times a year a closing takes over for two or three weeks. Workouts and friend calls slip first. Bedtime is the one I protect.', field: 'crunch', core: false, kind: 'text' },
];

/** Default first quarter: the current one, or the next when 21 or fewer days remain. */
function defaultFirstQuarter(today: string): string {
  const cur = quarterOf(today).id;
  return daysLeftInQuarter(today) <= 21 ? nextQuarterId(cur) : cur;
}

const STAGES = ['welcome', ...QUESTIONS.map((q) => q.id), 'review', 'private', 'refine', 'quarter', 'people'] as const;

function getField(p: ProfileFields, f: Field): string {
  if (f === 'lifeContext') return p.lifeContext;
  if (f === 'crunch') return p.crunch;
  if (f === 'travel') return p.travel ?? '';
  const [b, k] = f.split('.') as [BurnerId, 'matters' | 'winning'];
  return p.burners[b][k];
}

function setField(p: ProfileFields, f: Field, v: string): ProfileFields {
  if (f === 'lifeContext') return { ...p, lifeContext: v };
  if (f === 'crunch') return { ...p, crunch: v };
  if (f === 'travel') return { ...p, travel: (v || null) as TravelRhythm | null };
  const [b, k] = f.split('.') as [BurnerId, 'matters' | 'winning'];
  return { ...p, burners: { ...p.burners, [b]: { ...p.burners[b], [k]: v } } };
}

const MONTHS_DAYS = /^(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun|I|My|The|A|An|Our|We|It|This|That|Q[1-4])$/;

/** Capitalized words mid-sentence in the Work and Crunch answers: likely firm or client names. */
function sensitiveCandidates(p: ProfileFields, peopleNames: string[]): string[] {
  const text = [p.burners.work.matters, p.burners.work.winning, p.crunch].join('. ');
  const names = new Set(peopleNames.map((n) => n.toLowerCase().replace(/\s*\(.*\)$/, '')));
  const out: string[] = [];
  for (const sentence of text.split(/[.!?]\s+/)) {
    const words = sentence.trim().split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const w = words[i].replace(/[^\p{L}\p{N}&'-]/gu, '');
      if (!/^\p{Lu}/u.test(w) || w.length < 3 || MONTHS_DAYS.test(w) || names.has(w.toLowerCase())) continue;
      // Join runs of capitalized words ("Summit Wealth").
      let term = w;
      while (i + 1 < words.length && /^\p{Lu}/u.test(words[i + 1])) {
        term += ' ' + words[++i].replace(/[^\p{L}\p{N}&'-]/gu, '');
      }
      out.push(term);
    }
  }
  return cleanTerms(out).filter((t) => !termProblem(t)).slice(0, 8);
}

export function OnboardingScreen({ state }: { state: AppState }) {
  const [loaded, setLoaded] = useState<{ step: number; draft: ProfileFields; quarterId?: string } | null>(null);
  useEffect(() => {
    getOnboarding().then((o) => {
      const base = state.profile ?? o?.draft ?? EMPTY_PROFILE_FIELDS;
      setLoaded({ step: o?.completedAt ? 0 : o?.step ?? 0, draft: o?.draft ?? pickFields(base), quarterId: o?.quarterId });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!loaded) return <div className="h-dvh" />;
  return <Flow state={state} initial={loaded} />;
}

function pickFields(p: ProfileFields): ProfileFields {
  return { lifeContext: p.lifeContext, burners: p.burners, travel: p.travel, crunch: p.crunch };
}

function Flow({ state, initial }: { state: AppState; initial: { step: number; draft: ProfileFields; quarterId?: string } }) {
  const reduced = useReducedMotion();
  const [step, setStepState] = useState(Math.min(initial.step, STAGES.length - 1));
  const [draft, setDraft] = useState<ProfileFields>(initial.draft);
  const [quarterId, setQuarterId] = useState(initial.quarterId ?? defaultFirstQuarter(state.today));
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const stage = STAGES[step];
  const qIndex = QUESTIONS.findIndex((q) => q.id === stage);
  const q = qIndex >= 0 ? QUESTIONS[qIndex] : null;

  const persist = (next: ProfileFields, nextStep = step) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveOnboarding({ step: nextStep, draft: next }), 250);
  };
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const update = (f: Field, v: string) => {
    const next = setField(draft, f, v);
    setDraft(next);
    persist(next);
  };

  const go = (to: number) => {
    sfx.tick();
    setStepState(to);
    void saveOnboarding({ step: to, draft });
    window.scrollTo({ top: 0 });
  };

  // Leaving the interview for the review page saves the profile (source: interview).
  const toReview = async () => {
    await saveProfile(draft, 'interview', { snapshot: !!state.profile, onboarded: true });
    go(STAGES.indexOf('review'));
  };

  const next = async () => {
    if (q && qIndex === QUESTIONS.length - 1) return toReview();
    go(step + 1);
  };

  return (
    <div className="px-safe pt-safe flex min-h-dvh flex-col pb-40">
      {stage !== 'welcome' && (
        <header className="flex items-center justify-between pt-1">
          <button onClick={() => go(Math.max(0, step - 1))} className="-ml-2 flex h-11 items-center gap-1 rounded-full pr-3 pl-2 text-[17px] text-dim active:bg-white/10">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
            Back
          </button>
          {q ? <StepEmbers count={QUESTIONS.length} current={qIndex} /> : <span />}
          <button onClick={() => { void saveOnboarding({ dismissedAt: new Date().toISOString() }); navigate('', { replace: true }); }} className="h-11 px-2 text-[15px] text-faint">
            Later
          </button>
        </header>
      )}

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={stage}
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 18, filter: 'blur(6px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: -12, filter: 'blur(6px)' }}
          transition={{ duration: 0.3 }}
          className="flex-1"
        >
          {stage === 'welcome' && <Welcome onBegin={() => go(1)} />}
          {q && <QuestionScreen q={q} value={getField(draft, q.field)} onChange={(v) => update(q.field, v)} onChoose={(v) => { update(q.field, v); setTimeout(() => void next(), 250); }} />}
          {stage === 'review' && <ReviewProfile draft={draft} onChange={(d) => { setDraft(d); persist(d); void saveProfile(d, 'edited'); }} />}
          {stage === 'private' && <PrivateNames state={state} draft={draft} />}
          {stage === 'refine' && (
            <Refine
              state={state}
              draft={draft}
              onReplaced={(d) => {
                setDraft(d);
                persist(d);
              }}
            />
          )}
          {stage === "quarter" && <PickQuarter today={state.today} chosen={quarterId} onPick={setQuarterId} />}
          {stage === 'people' && <KeyPeople state={state} draft={draft} />}
        </motion.div>
      </AnimatePresence>

      {stage !== 'welcome' && (
        <div className="pb-safe fixed inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black via-black/95 to-transparent px-5 pt-10">
          <div className="mx-auto flex max-w-xl gap-3">
            {q && (
              <GhostButton className="h-15 px-5" onClick={() => void next()}>
                Skip
              </GhostButton>
            )}
            {stage === 'people' ? (
              <MoltenButton
                className="h-15 flex-1 text-[18px]"
                onClick={async () => {
                  await saveOnboarding({ quarterId });
                  await saveOnboarding({ completedAt: new Date().toISOString(), step: 0 });
                  // Ask the browser to keep this app's data (granted readily to Home Screen apps).
                  void navigator.storage?.persist?.();
                  navigate(`setup/${quarterId}`, { replace: true });
                }}
              >
                Set up {quarterLabel(quarterId)}
              </MoltenButton>
            ) : (
              q?.kind !== 'choice' && (
                <MoltenButton className="h-15 flex-1 text-[18px]" onClick={() => void next()}>
                  {q && qIndex === QUESTIONS.length - 1 ? 'See my profile' : stage === 'refine' ? 'Continue' : 'Next'}
                </MoltenButton>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Welcome({ onBegin }: { onBegin: () => void }) {
  return (
    <div className="flex min-h-[80dvh] flex-col items-center justify-center text-center">
      <div className="relative -mb-4 grid h-[260px] w-full grid-cols-4">
        {BURNERS.map((b, i) => (
          <div key={b} className="relative">
            <Flame burner={b} intent="steady" heat={0.8} brightness={1} ignite={0.4 + i * 0.25} />
          </div>
        ))}
      </div>
      <h1 className="font-display text-[44px] leading-[1.02] font-black">
        <ShimmerText>Light your four burners</ShimmerText>
      </h1>
      <p className="mt-4 max-w-sm text-[17px] text-dim">A few questions so your coach knows you. About 4 minutes. Talk or type, and skip anything.</p>
      <MoltenButton className="mt-8 h-16 w-full max-w-sm text-[19px]" onClick={onBegin}>
        Begin
      </MoltenButton>
      <button onClick={() => { void saveOnboarding({ dismissedAt: new Date().toISOString() }); navigate('', { replace: true }); }} className="mt-4 h-11 text-[15px] text-faint">
        Later
      </button>
    </div>
  );
}

function QuestionScreen({ q, value, onChange, onChoose }: { q: Question; value: string; onChange: (v: string) => void; onChoose: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Auto-grow the field so long dictation stays visible.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(140, el.scrollHeight)}px`;
  }, [value]);
  const p = q.burner ? PALETTES[q.burner] : null;
  const people = q.kind === 'people' && q.burner ? parsePeople(value, q.burner as 'family' | 'friends').people : [];
  return (
    <div className="mt-6">
      {q.burner && (
        <div className="mb-2 flex items-center gap-2">
          <MiniFlame burner={q.burner} size={22} />
          <span className="text-[13px] font-bold tracking-[0.18em] uppercase" style={{ color: p!.accent }}>
            {BURNER_LABELS[q.burner]}
          </span>
        </div>
      )}
      <h1 className="font-display text-[36px] leading-tight font-black">{q.title}</h1>
      <p className="mt-2 text-[17px] text-white/80">{q.prompt}</p>
      {q.kind === 'choice' ? (
        <div className="mt-6 space-y-2.5" role="radiogroup">
          {(Object.keys(TRAVEL_LABELS) as TravelRhythm[]).map((t) => {
            const on = value === t;
            return (
              <motion.button
                key={t}
                role="radio"
                aria-checked={on}
                whileTap={{ scale: 0.97 }}
                onClick={() => onChoose(t)}
                className="flex min-h-15 w-full items-center justify-between rounded-2xl px-5 text-left text-[18px] font-semibold"
                style={on ? { background: 'rgba(255,154,60,0.18)', boxShadow: 'inset 0 0 0 1.5px #ff9a3c', color: '#ffd27a' } : { boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.12)' }}
              >
                {TRAVEL_LABELS[t]}
                {on && <span>✓</span>}
              </motion.button>
            );
          })}
        </div>
      ) : (
        <>
          <textarea
            ref={ref}
            autoFocus
            className={`${inputClass} mt-6 resize-none text-[17px] leading-relaxed`}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={q.placeholder}
            autoCapitalize="sentences"
          />
          {q.helper && <p className="mt-2 text-[13px] text-faint">{q.helper}</p>}
          {q.burner === 'work' || q.id === 'crunch_pattern' ? <div className="mt-1.5"><SensitiveWarning text={value} /></div> : null}
          {value.length > 300 && <p className="mt-1 text-right text-[12px] text-faint tabular">{value.length}</p>}
          {people.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {people.map((pd) => (
                <span key={pd.name} className="rounded-full px-3 py-1.5 text-[14px]" style={{ background: `${p!.mid}1f`, boxShadow: `inset 0 0 0 1px ${p!.mid}55`, color: p!.core }}>
                  {pd.name} · {CADENCE_OPTIONS.find((c) => c.days === pd.cadenceDays)?.label.toLowerCase() ?? `every ${pd.cadenceDays} days`}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function ReviewProfile({ draft, onChange }: { draft: ProfileFields; onChange: (d: ProfileFields) => void }) {
  const rows: { label: string; field: Field; burner?: BurnerId }[] = [
    { label: 'Life', field: 'lifeContext' },
    ...BURNERS.flatMap((b) => [
      { label: b === 'family' || b === 'friends' ? `${BURNER_LABELS[b]} people` : `${BURNER_LABELS[b]} focus`, field: `${b}.matters` as Field, burner: b },
      { label: `${BURNER_LABELS[b]} win`, field: `${b}.winning` as Field, burner: b },
    ]),
    { label: 'Crunch', field: 'crunch' },
  ];
  return (
    <div className="mt-4">
      <div className="text-[12px] font-bold tracking-[0.22em] text-ember uppercase">About me</div>
      <h1 className="mt-1 font-display text-[36px] leading-tight font-black">
        <ShimmerText>Here is you, in your words</ShimmerText>
      </h1>
      <p className="mt-2 text-[15px] text-dim">Edit anything. Your coach sees this (sensitive names redacted). You can change it anytime in Settings.</p>
      <div className="mt-5 space-y-2.5">
        {rows.map((r) => {
          const v = getField(draft, r.field);
          const p = r.burner ? PALETTES[r.burner] : null;
          return (
            <label key={r.field} className="block rounded-2xl border border-white/[0.08] bg-[#0a0a0c]/90 px-4 py-3">
              <span className="mb-1 flex items-center gap-2 text-[12px] font-bold tracking-[0.14em] uppercase" style={{ color: p?.accent ?? '#ffb454' }}>
                {r.burner && <MiniFlame burner={r.burner} size={14} />}
                {r.label}
                {!v && <span className="ml-auto text-[11px] font-semibold text-faint normal-case">Add this</span>}
              </span>
              <textarea
                rows={2}
                className="w-full resize-none bg-transparent text-[16px] leading-relaxed text-white outline-none placeholder:text-faint"
                value={v}
                placeholder="Skipped"
                onChange={(e) => onChange(setField(draft, r.field, e.target.value))}
                autoCapitalize="sentences"
              />
            </label>
          );
        })}
        <div className="rounded-2xl border border-white/[0.08] bg-[#0a0a0c]/90 px-4 py-3">
          <span className="mb-2 block text-[12px] font-bold tracking-[0.14em] text-ember uppercase">Travel</span>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(TRAVEL_LABELS) as TravelRhythm[]).map((t) => (
              <button
                key={t}
                onClick={() => onChange({ ...draft, travel: t })}
                className="min-h-10 rounded-full px-3.5 text-[14px]"
                style={draft.travel === t ? { background: 'rgba(255,154,60,0.2)', boxShadow: 'inset 0 0 0 1.5px #ff9a3c', color: '#ffd27a' } : { boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.12)' }}
              >
                {TRAVEL_LABELS[t]}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function PrivateNames({ state, draft }: { state: AppState; draft: ProfileFields }) {
  const terms = state.settings.sensitiveTerms;
  const [text, setText] = useState('');
  const peopleNames = [...parsePeople(draft.burners.family.matters, 'family').people, ...parsePeople(draft.burners.friends.matters, 'friends').people].map((p) => p.name);
  const candidates = sensitiveCandidates(draft, peopleNames).filter((c) => !terms.some((t) => t.toLowerCase() === c.toLowerCase()));
  const add = (list: string[]) => void saveSettings({ sensitiveTerms: cleanTerms([...terms, ...list.filter((t) => !termProblem(t.trim()))]) });
  return (
    <div className="mt-4">
      <div className="text-[12px] font-bold tracking-[0.22em] text-ember uppercase">Private names</div>
      <h1 className="mt-1 font-display text-[36px] leading-tight font-black">Names that never leave this phone</h1>
      <p className="mt-2 text-[16px] text-dim">
        Your firm, clients, targets. They are replaced with [redacted] in everything you copy for Claude. Optional, and editable later in Settings.
      </p>
      {candidates.length > 0 && (
        <div className="mt-5">
          <div className="mb-2 text-[12px] font-semibold tracking-[0.14em] text-dim uppercase">From your answers, tap to add</div>
          <div className="flex flex-wrap gap-2">
            {candidates.map((c) => (
              <button key={c} onClick={() => add([c])} className="min-h-10 rounded-full px-3.5 text-[14px] text-amber-100" style={{ boxShadow: 'inset 0 0 0 1px rgba(252,211,77,0.4)' }}>
                + {c}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="mt-5 flex flex-wrap gap-2">
        {terms.map((t) => (
          <span key={t} className="flex items-center gap-1 rounded-full bg-white/[0.06] py-1 pr-1 pl-3 text-[14px]">
            🔒 {t}
            <button onClick={() => void saveSettings({ sensitiveTerms: terms.filter((x) => x !== t) })} className="grid h-7 w-7 place-items-center rounded-full text-faint" aria-label={`Remove ${t}`}>
              ×
            </button>
          </span>
        ))}
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          add(text.split(','));
          setText('');
        }}
      >
        <input className={inputClass} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a name (commas for several)" autoCapitalize="words" autoComplete="off" />
        <button type="submit" disabled={!text.trim()} className="shrink-0 rounded-2xl bg-ember/15 px-4 text-[16px] font-bold text-ember disabled:opacity-30">
          Add
        </button>
      </form>
    </div>
  );
}

export function Refine({ state, draft, onReplaced }: { state: AppState; draft: ProfileFields; onReplaced: (d: ProfileFields) => void }) {
  const toast = useToast();
  const packet = useMemo(() => buildOnboardingPacket({ profile: draft, people: state.data.people, settings: state.settings, today: state.today }), [draft, state.data.people, state.settings, state.today]);
  return (
    <div className="mt-4">
      <div className="text-[12px] font-bold tracking-[0.22em] text-ember uppercase">Optional</div>
      <h1 className="mt-1 font-display text-[36px] leading-tight font-black">Refine with Claude</h1>
      <p className="mt-2 mb-5 text-[16px] text-dim">
        Your coach reads your profile, points out gaps, and sends back a tighter version you can use with one tap. Skip it if you like.
      </p>
      <CoachPanel
        kind="onboarding"
        scope="profile"
        packet={packet}
        replies={state.data.replies}
        renderReplyExtras={(reply) => {
          const parsed = parseAboutMe(reply.text, draft);
          if (!parsed.ok) return <p className="mt-2 text-[13px] text-faint">No revised profile found in this reply.</p>;
          if (!parsed.changedFields.length) return <p className="mt-2 text-[13px] text-emerald-200">No changes to your profile.</p>;
          return (
            <div className="mt-3 rounded-2xl border border-emerald-300/25 bg-emerald-300/[0.06] p-3.5">
              <p className="text-[14px] font-semibold text-emerald-100">
                Claude revised your About me: {parsed.changedFields.length} {parsed.changedFields.length === 1 ? 'change' : 'changes'}
              </p>
              {parsed.warnings.map((w) => (
                <p key={w} className="mt-1 text-[12px] text-amber-200">
                  {w}
                </p>
              ))}
              <PrimaryButton
                className="mt-3 w-full"
                onClick={async (e) => {
                  const next = applyAboutMePatch(draft, parsed.patch);
                  await saveProfile(next, 'coach', { snapshot: true, onboarded: true });
                  onReplaced(next);
                  celebrate({ kind: 'log', burner: 'family', x: e.clientX, y: e.clientY });
                  toast({
                    message: 'Profile updated',
                    actions: [
                      {
                        label: 'Undo',
                        run: async () => {
                          await restorePreviousProfile();
                          const p = await db.profiles.get('me');
                          if (p) onReplaced(pickFields(p));
                        },
                      },
                    ],
                  });
                }}
              >
                Replace my profile
              </PrimaryButton>
            </div>
          );
        }}
      />
    </div>
  );
}

function PickQuarter({ today, chosen, onPick }: { today: string; chosen: string; onPick: (q: string) => void }) {
  const current = quarterOf(today).id;
  const next = nextQuarterId(current);
  const left = daysLeftInQuarter(today);
  const suggestNext = left <= 21;
  const pick = chosen;
  const setPick = (q: string) => {
    onPick(q);
    void saveOnboarding({ quarterId: q });
  };
  const options = [
    { id: current, title: `Use the rest of ${quarterLabel(current)}`, sub: `${left} ${left === 1 ? 'day' : 'days'} left. Goals are judged only on the time remaining.` },
    { id: next, title: `Start clean with ${quarterLabel(next)}`, sub: `Begins ${new Date(quarterSpan(next).start + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}.` },
  ];
  if (suggestNext) options.reverse();
  return (
    <div className="mt-4">
      <div className="text-[12px] font-bold tracking-[0.22em] text-ember uppercase">Your first quarter</div>
      <h1 className="mt-1 font-display text-[36px] leading-tight font-black">{suggestNext ? `${quarterLabel(current)} ends in ${left} days` : 'Which quarter?'}</h1>
      <div className="mt-6 space-y-3">
        {options.map((o) => (
          <button
            key={o.id}
            onClick={() => setPick(o.id)}
            className="block w-full rounded-3xl p-5 text-left"
            style={pick === o.id ? { background: 'rgba(255,154,60,0.14)', boxShadow: 'inset 0 0 0 1.5px #ff9a3c, 0 0 30px -10px #ff9a3c' } : { boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.12)' }}
          >
            <div className="font-display text-[22px] font-bold">{o.title}</div>
            <div className="mt-1 text-[14px] text-dim">{o.sub}</div>
          </button>
        ))}
      </div>
      <p className="mt-4 text-[13px] text-faint">Either way, your first weekly review shows up on your review day (Sunday unless you change it).</p>
    </div>
  );
}

function KeyPeople({ state, draft }: { state: AppState; draft: ProfileFields }) {
  const toast = useToast();
  const existing = new Set(state.data.people.map((p) => p.name.toLowerCase()));
  const parsedFamily = useMemo(() => parsePeople(draft.burners.family.matters, 'family'), [draft.burners.family.matters]);
  const parsedFriends = useMemo(() => parsePeople(draft.burners.friends.matters, 'friends'), [draft.burners.friends.matters]);
  const [rows, setRows] = useState<PersonDraft[]>(() => [...parsedFamily.people, ...parsedFriends.people]);
  const leftovers = [...parsedFamily.leftovers, ...parsedFriends.leftovers];
  const [done, setDone] = useState(false);
  const update = (i: number, patch: Partial<PersonDraft>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="mt-4">
      <div className="text-[12px] font-bold tracking-[0.22em] text-ember uppercase">Key people</div>
      <h1 className="mt-1 font-display text-[36px] leading-tight font-black">The people you named</h1>
      <p className="mt-2 text-[16px] text-dim">Confirm who to keep close and how often. You will see gentle cues as someone comes due.</p>
      <div className="mt-5 space-y-2">
        {rows.map((r, i) => {
          const p = PALETTES[r.burner];
          const already = existing.has(r.name.toLowerCase());
          return (
            <div key={i} className="rounded-2xl border bg-[#0a0a0c]/90 p-3.5" style={{ borderColor: r.include && !already ? `${p.mid}55` : 'rgba(255,255,255,0.08)', opacity: r.include ? 1 : 0.55 }}>
              <div className="flex items-center gap-2">
                <MiniFlame burner={r.burner} size={18} />
                <input className="min-w-0 flex-1 bg-transparent text-[17px] font-semibold outline-none" value={r.name} onChange={(e) => update(i, { name: e.target.value })} aria-label="Name" />
                {already ? (
                  <span className="text-[12px] text-faint">Already added</span>
                ) : (
                  <button onClick={() => update(i, { include: !r.include })} className="min-h-9 rounded-full px-3 text-[13px] font-semibold" style={{ color: r.include ? p.core : 'rgba(255,255,255,0.5)' }}>
                    {r.include ? '✓ Keep' : 'Skip'}
                  </button>
                )}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {CADENCE_OPTIONS.filter((c) => c.days >= 7).map((c) => (
                  <button
                    key={c.days}
                    onClick={() => update(i, { cadenceDays: c.days })}
                    className="min-h-8 rounded-full px-2.5 text-[12px]"
                    style={r.cadenceDays === c.days ? { background: `${p.mid}33`, color: p.core, boxShadow: `inset 0 0 0 1px ${p.mid}` } : { boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.6)' }}
                  >
                    {c.label}
                  </button>
                ))}
                <button onClick={() => update(i, { burner: r.burner === 'family' ? 'friends' : 'family' })} className="ml-auto min-h-8 px-2 text-[12px] text-faint">
                  Move to {r.burner === 'family' ? 'Friends' : 'Family'}
                </button>
              </div>
            </div>
          );
        })}
        {rows.length === 0 && <p className="rounded-2xl border border-dashed border-line px-4 py-5 text-center text-[15px] text-dim">No names yet. Add people anytime from the Family and Friends burners.</p>}
      </div>
      {leftovers.length > 0 && <p className="mt-3 text-[13px] text-faint">Did we miss anyone? You also said: {leftovers.join('; ')}</p>}
      <div className="mt-4 flex gap-2">
        <GhostButton className="flex-1" onClick={() => setRows((rs) => [...rs, { name: 'New person', burner: 'friends', cadenceDays: 30, include: true }])}>
          + Add someone
        </GhostButton>
        <PrimaryButton
          className="flex-1"
          disabled={done || !rows.some((r) => r.include && r.name.trim() && !existing.has(r.name.toLowerCase()))}
          onClick={async () => {
            for (const r of rows) {
              if (!r.include || !r.name.trim() || existing.has(r.name.toLowerCase())) continue;
              await addPerson({ name: r.name.trim(), burner: r.burner, cadenceDays: r.cadenceDays });
            }
            setDone(true);
            toast({ message: 'People added' });
          }}
        >
          {done ? '✓ Added' : 'Add these people'}
        </PrimaryButton>
      </div>
    </div>
  );
}
