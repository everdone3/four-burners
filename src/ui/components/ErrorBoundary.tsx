// Last line of defense: if a screen throws while rendering, show a plain recovery screen instead of a blank
// app. Deliberately simple (no live queries, no animation) so it keeps working when something else broke.
//
// Used twice: around the whole tree (main.tsx) and around the app inside the lock gate (LockGate.tsx), so
// an app crash never removes the lock screen. While the Face ID lock is engaged the screen offers no
// backup (that would hand the data past the lock); reload and erase stay. The lock is an access gate, not
// encryption (see src/lock/webauthnLocal.ts). Erasing also removes this device's lock, like "Reset this
// device" on the lock screen: once the data is gone there is nothing left for it to guard.
import { Component, type ReactNode } from 'react';
import { buildBackupFile, saveBackupFile } from '@/data/backup';
import { wipeAll } from '@/data/repo';
import { getLockState, resetLock, subscribeLock } from '@/lock/controller';
import { eraseDeviceSync } from '@/sync/manager';

interface State {
  failed: boolean;
  file?: File;
  note?: string;
}

/**
 * True while the lock screen should be up: the controller says locked, OR <html data-lock> is set (by
 * index.html before the bundle ran, or by the controller). Either one is enough, so a lock controller that
 * failed to start (state still 'off' while index.html hid the app) fails closed.
 */
export function lockEngaged(): boolean {
  let phase: string | undefined;
  try {
    phase = getLockState().phase;
  } catch {
    phase = undefined;
  }
  if (phase === 'locked' || phase === 'unlocking') return true;
  try {
    return document.documentElement.getAttribute('data-lock') === 'locked';
  } catch {
    return false;
  }
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };
  private unsubscribeLock?: () => void;

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  componentDidMount() {
    // Redraw the recovery screen when the lock engages or opens (the backup button follows it).
    try {
      this.unsubscribeLock = subscribeLock(() => {
        if (this.state.failed) this.forceUpdate();
      });
    } catch {
      // No lock to follow.
    }
  }

  componentWillUnmount() {
    this.unsubscribeLock?.();
  }

  componentDidCatch(error: unknown) {
    console.error('Four Burners hit an error while drawing a screen', error);
    // Build the backup ahead of the tap: iOS only opens the share sheet straight from a tap.
    buildBackupFile().then(
      (file) => this.setState({ file }),
      () => this.setState({ note: "A backup couldn't be prepared." }),
    );
  }

  private save = () => {
    if (!this.state.file || lockEngaged()) return;
    saveBackupFile(this.state.file).then(
      (outcome) => {
        if (outcome === 'retry') this.setState({ note: 'Tap again to save.' });
        else if (outcome !== 'cancelled') this.setState({ note: 'Backup saved.' });
      },
      () => this.setState({ note: "The backup couldn't be saved." }),
    );
  };

  private erase = () => {
    if (!confirm('Erase everything on this device? This cannot be undone. If you use sync, your account keeps its copy.')) return;
    void (async () => {
      try {
        await eraseDeviceSync();
      } catch {
        // The wipe below also clears this device's sync position.
      }
      try {
        await wipeAll();
      } catch {
        // Nothing was erased, so the lock stays: the data that is still here stays behind it.
        this.setState({ note: "Couldn't erase this device. Try again." });
        return;
      }
      // Only after the wipe worked.
      try {
        resetLock();
      } catch {
        // The data is gone either way.
      }
      location.replace('/');
    })();
  };

  render() {
    if (!this.state.failed) return this.props.children;
    const locked = lockEngaged();
    const button = 'w-full rounded-2xl border border-white/15 bg-white/[0.06] px-4 py-3.5 text-[17px] font-semibold text-white active:bg-white/15 disabled:opacity-40';
    return (
      <div className="px-safe pt-safe flex min-h-dvh flex-col justify-center gap-3 bg-black pb-10 text-white">
        <h1 className="font-display text-[28px] font-bold">Something went wrong</h1>
        <p className="text-[16px] text-zinc-300">
          {locked
            ? 'Four Burners hit an error while it was locked. Your data is still saved on this device. Reload to unlock again.'
            : 'Four Burners hit an error while drawing this screen. Your data is still saved on this device.'}
        </p>
        <button className={`${button} mt-4`} onClick={() => location.replace('/')}>
          Reload the app
        </button>
        {!locked && (
          <button className={button} disabled={!this.state.file} onClick={this.save}>
            {this.state.file ? 'Save a backup to Files' : 'Preparing a backup...'}
          </button>
        )}
        <button className={`${button} text-rose-300`} onClick={this.erase}>
          Erase this device
        </button>
        {this.state.note && (
          <p role="status" className="text-[15px] font-semibold text-amber-200">
            {this.state.note}
          </p>
        )}
      </div>
    );
  }
}
