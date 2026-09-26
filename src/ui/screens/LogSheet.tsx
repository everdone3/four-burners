import { BURNERS, BURNER_LABELS, crunchDateSet, peopleByUrgency } from "@/domain";
import { PersonCard } from "../components/People";
import type { AppState } from '@/data/hooks';
import { GoalRow } from '../components/GoalRow';
import { Sheet } from '../components/ui';
import { PALETTES } from '../theme';

export function LogSheet({ open, onClose, state }: { open: boolean; onClose: () => void; state: AppState }) {
  const { dashboard, data } = state;
  const people = peopleByUrgency(data.people, data.touchpoints, state.today);
  const crunchSet = crunchDateSet(data.crunch, state.today);
  const any = BURNERS.some((b) => dashboard.burners[b].goals.length > 0);
  return (
    <Sheet open={open} onClose={onClose} title="Log progress">
      {!any && <p className="py-6 text-[16px] text-dim">Add a goal to a burner first. Tap a flame on the home screen.</p>}
      <div className="space-y-6">
        {BURNERS.map((b) => {
          const goals = dashboard.burners[b].goals;
          if (!goals.length) return null;
          return (
            <section key={b}>
              <h3 className="mb-2 text-[13px] font-semibold tracking-[0.12em] uppercase" style={{ color: PALETTES[b].accent }}>
                {BURNER_LABELS[b]}
              </h3>
              <div className="space-y-2">
                {goals.map(({ goal, progress }) => (
                  <GoalRow key={goal.id} goal={goal} progress={progress} logs={data.logs} today={state.today} crunch={crunchSet} />
                ))}
              </div>
            </section>
          );
        })}
        {people.length > 0 && (
          <section>
            <h3 className="mb-2 text-[13px] font-semibold tracking-[0.12em] text-dim uppercase">People</h3>
            <div className="space-y-2">
              {people.map((s) => (
                <PersonCard key={s.person.id} s={s} compact />
              ))}
            </div>
          </section>
        )}
      </div>
    </Sheet>
  );
}
