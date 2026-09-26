import { BURNERS, BURNER_LABELS } from '@/domain';
import type { AppState } from '@/data/hooks';
import { GoalRow } from '../components/GoalRow';
import { Sheet } from '../components/ui';
import { PALETTES } from '../theme';

export function LogSheet({ open, onClose, state }: { open: boolean; onClose: () => void; state: AppState }) {
  const { dashboard, data } = state;
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
                  <GoalRow key={goal.id} goal={goal} progress={progress} logs={data.logs} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </Sheet>
  );
}
