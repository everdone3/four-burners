// On-demand mid-quarter check-in: the current state of all burners, packaged for your Claude coach.
import { useMemo, useState } from 'react';
import { addDays, quarterLabel, startOfWeek, weekday } from '@/domain';
import { buildCheckinPacket } from '@/domain/coach/packets';
import type { AppState } from '@/data/hooks';
import { CoachPanel } from '../components/CoachPanel';
import { SensitiveWarning } from '../components/Sensitive';
import { ShimmerText } from '../components/sizzle';
import { inputClass } from '../components/ui';
import { goBack } from '../router';
import { inputFor } from '../stateInput';

export function CheckInScreen({ state }: { state: AppState }) {
  const [question, setQuestion] = useState('');
  const input = useMemo(() => inputFor(state, state.quarter.id)!, [state]);
  const packet = useMemo(
    () => buildCheckinPacket({ input, reviews: state.data.reviews, profile: state.profile, question: question.trim() || undefined }),
    [input, state.data.reviews, state.profile, question],
  );
  // "Next 7 days" actions land in this week early on, next week from Friday.
  const actionsWeek = weekday(state.today) <= 3 ? startOfWeek(state.today) : addDays(startOfWeek(state.today), 7);
  const past = state.data.replies.filter((r) => r.kind === 'checkin' && r.scope !== state.today).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  return (
    <div className="px-safe pt-safe pb-24">
      <button onClick={goBack} className="-ml-2 flex h-11 items-center gap-1 rounded-full pr-3 pl-2 text-[17px] text-dim active:bg-white/10">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
        Home
      </button>
      <div className="mt-2 text-[12px] font-bold tracking-[0.22em] text-ember uppercase">{quarterLabel(state.quarter.id)} · coach check-in</div>
      <h1 className="font-display text-[40px] leading-tight font-black">
        <ShimmerText>Where do I stand?</ShimmerText>
      </h1>
      <p className="mt-2 text-[16px] text-dim">
        A snapshot of all four burners for your Claude coach: what is realistic, what to shrink, and the one move to make now.
      </p>

      <label className="mt-6 block">
        <span className="mb-1.5 block text-[13px] font-medium tracking-wide text-dim uppercase">Your question (optional)</span>
        <input
          className={inputClass}
          value={question}
          maxLength={200}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="What should I drop this month?"
          autoCapitalize="sentences"
        />
      </label>
      <div className="mt-1.5">
        <SensitiveWarning text={question} />
      </div>

      <div className="mt-5">
        <CoachPanel
          kind="checkin"
          scope={state.today}
          packet={packet}
          replies={state.data.replies}
          actionsWeek={actionsWeek}
          existingActionTexts={state.data.actions.filter((a) => a.weekStart === actionsWeek).map((a) => a.text)}
        />
      </div>

      {past.length > 0 && (
        <section className="mt-9">
          <h2 className="mb-3 font-display text-[22px] font-bold">Earlier check-ins</h2>
          <div className="space-y-2">
            {past.slice(0, 8).map((r) => (
              <details key={r.id} className="rounded-2xl border border-white/[0.08] bg-[#0a0a0c]/90 px-4 py-3">
                <summary className="cursor-pointer text-[15px] font-semibold">
                  {new Date(r.scope + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                </summary>
                <p className="mt-2 text-[15px] leading-relaxed whitespace-pre-wrap text-white/85">{r.text}</p>
              </details>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
