// Last line of defense: if a screen throws while rendering, show a plain recovery screen instead of a blank
// app. Deliberately simple (no live queries, no animation) so it keeps working when something else broke.
import { Component, type ReactNode } from 'react';
import { buildBackupFile, saveBackupFile } from '@/data/backup';
import { wipeAll } from '@/data/repo';
import { eraseDeviceSync } from '@/sync/manager';

interface State {
  failed: boolean;
  file?: File;
  note?: string;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
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
    if (!this.state.file) return;
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
      } finally {
        await wipeAll();
        location.replace('/');
      }
    })();
  };

  render() {
    if (!this.state.failed) return this.props.children;
    const button = 'w-full rounded-2xl border border-white/15 bg-white/[0.06] px-4 py-3.5 text-[17px] font-semibold text-white active:bg-white/15 disabled:opacity-40';
    return (
      <div className="px-safe pt-safe flex min-h-dvh flex-col justify-center gap-3 bg-black pb-10 text-white">
        <h1 className="font-display text-[28px] font-bold">Something went wrong</h1>
        <p className="text-[16px] text-zinc-300">
          Four Burners hit an error while drawing this screen. Your data is still saved on this device.
        </p>
        <button className={`${button} mt-4`} onClick={() => location.replace('/')}>
          Reload the app
        </button>
        <button className={button} disabled={!this.state.file} onClick={this.save}>
          {this.state.file ? 'Save a backup to Files' : 'Preparing a backup...'}
        </button>
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
