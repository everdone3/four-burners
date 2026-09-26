// Every coach reply you have saved, by week, check-in, and quarter.
import { addDays, quarterLabel, type CoachReply, type PacketKind } from '@/domain';
import type { AppState } from '@/data/hooks';
import { ShimmerText } from '../components/sizzle';
import { goBack } from '../router';
import { weekLabel } from '../stateInput';

const KIND_LABEL: Record<PacketKind, string> = {
  weekly: 'Weekly review',
  checkin: 'Check-in',
  quarter_setup: 'Quarter setup',
  onboarding: 'About me',
};

function scopeLabel(r: CoachReply): string {
  switch (r.kind) {
    case 'weekly':
      return weekLabel(r.scope, addDays(r.scope, 6));
    case 'checkin':
      return new Date(r.scope + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    case 'quarter_setup':
      return quarterLabel(r.scope);
    default:
      return 'Profile';
  }
}

export function CoachHistoryScreen({ state }: { state: AppState }) {
  const replies = [...state.data.replies].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return (
    <div className="px-safe pt-safe pb-24">
      <button onClick={goBack} className="-ml-2 flex h-11 items-center gap-1 rounded-full pr-3 pl-2 text-[17px] text-dim active:bg-white/10">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
        Back
      </button>
      <h1 className="mt-2 font-display text-[40px] font-black">
        <ShimmerText>Coach history</ShimmerText>
      </h1>
      {replies.length === 0 && <p className="mt-6 text-[16px] text-dim">Replies you paste back from Claude are saved here, with the week or quarter they belong to.</p>}
      <div className="mt-6 space-y-2.5">
        {replies.map((r) => (
          <details key={r.id} className="group rounded-2xl border border-white/[0.08] bg-[#0a0a0c]/90 px-4 py-3">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
              <span>
                <span className="block text-[12px] font-bold tracking-[0.16em] text-ember uppercase">{KIND_LABEL[r.kind]}</span>
                <span className="block text-[16px] font-semibold">{scopeLabel(r)}</span>
              </span>
              <span className="text-[13px] text-faint">
                {new Date(r.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                <span className="ml-2 inline-block transition group-open:rotate-90">›</span>
              </span>
            </summary>
            <p className="mt-3 text-[15px] leading-relaxed whitespace-pre-wrap text-white/85">{r.text}</p>
          </details>
        ))}
      </div>
    </div>
  );
}
