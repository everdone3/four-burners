// About me: edit the profile your coach sees, refine it with Claude, restore the previous version,
// or redo the interview.
import { useState } from 'react';
import { EMPTY_PROFILE_FIELDS, type ProfileFields } from '@/domain';
import type { AppState } from '@/data/hooks';
import { restorePreviousProfile, saveOnboarding, saveProfile } from '@/data/repo';
import { GhostButton, useToast } from '../components/ui';
import { goBack, navigate } from '../router';
import { Refine, ReviewProfile } from './Onboarding';
import { isPending } from '@/coach/session';

function fieldsOf(p: ProfileFields): ProfileFields {
  return { lifeContext: p.lifeContext, burners: p.burners, travel: p.travel, crunch: p.crunch };
}

export function AboutScreen({ state }: { state: AppState }) {
  const toast = useToast();
  const [draft, setDraft] = useState<ProfileFields>(() => fieldsOf(state.profile ?? EMPTY_PROFILE_FIELDS));
  const resumable = !!state.onboarding && !state.onboarding.completedAt && state.onboarding.step > 0 && !state.onboarding.resumeHidden;
  const [tab, setTab] = useState<'edit' | 'refine'>(() => (isPending('onboarding', 'profile') ? 'refine' : 'edit'));

  return (
    <div className="px-safe pt-safe pb-24">
      <button onClick={goBack} className="-ml-2 flex h-11 items-center gap-1 rounded-full pr-3 pl-2 text-[17px] text-dim active:bg-white/10">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
        Settings
      </button>

      {(!state.profile || resumable) && (
        <div className="mt-4 rounded-3xl border border-ember/40 bg-ember/[0.07] p-5">
          <p className="text-[17px] font-semibold">{resumable ? "Your interview is half done." : "No profile yet."}</p>
          <p className="mt-1 text-[15px] text-dim">{resumable ? "Your answers are saved. Pick up where you left off." : "A 4-minute interview gives your coach real context."}</p>
          <GhostButton className="mt-3 w-full" onClick={() => navigate("onboarding")}>
            {resumable ? "Finish the interview" : "Start the interview"}
          </GhostButton>
        </div>
      )}

      <div className="mt-4 flex rounded-2xl border border-line bg-raised p-1">
        {(['edit', 'refine'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`min-h-11 flex-1 rounded-xl text-[15px] font-semibold ${tab === t ? 'bg-white text-black' : 'text-dim'}`}
          >
            {t === 'edit' ? 'Edit' : 'Refine with Claude'}
          </button>
        ))}
      </div>

      {tab === 'edit' ? (
        <ReviewProfile
          draft={draft}
          onChange={(d) => {
            setDraft(d);
            void saveProfile(d, 'edited');
          }}
        />
      ) : (
        <Refine state={state} draft={draft} onReplaced={setDraft} />
      )}

      <div className="mt-8 flex flex-col gap-2.5">
        {state.profile?.previous && (
          <GhostButton
            onClick={async () => {
              await restorePreviousProfile();
              toast({ message: 'Previous version restored' });
              if (state.profile?.previous) setDraft(fieldsOf(state.profile.previous));
            }}
          >
            Restore previous version
          </GhostButton>
        )}
        <GhostButton
          onClick={async () => {
            // A fresh run: new quarter choice, new one-time snapshot, no lingering dismissal.
            await saveOnboarding({ step: 1, draft, completedAt: undefined, quarterId: undefined, snapshotted: false, dismissedAt: undefined, resumeHidden: false });
            navigate('onboarding');
          }}
        >
          Redo the interview
        </GhostButton>
      </div>
    </div>
  );
}
