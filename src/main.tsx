import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { ErrorBoundary } from './ui/components/ErrorBoundary';
import { LockGate } from './ui/components/LockGate';
import { restoreFlowOnLaunch } from './ui/router';
import { requestPersistentStorage } from './ui/storagePersist';
import { reloadApp } from './ui/useAppUpdate';
import { db } from './data/db';
import { startLock } from './lock/controller';
import { startSync } from './sync/manager';
import './index.css';

// The Face ID lock decides, before anything renders, whether this launch starts locked (index.html has
// already hidden the app if a lock is set up here). It is an access gate, not encryption: the data stays
// unencrypted on this device (see src/lock/webauthnLocal.ts).
// If it throws while index.html has hidden the app for a lock set up here, fail closed: the gate would
// see the lock as off and mount the app under the hiding CSS with no lock screen (a black screen). Show
// the error screen instead (Reload, or Erase), which goes by <html data-lock> and offers no backup.
let lockFailedClosed = false;
try {
  startLock();
} catch (e) {
  console.error('Four Burners could not start the app lock', e);
  lockFailedClosed = document.documentElement.dataset.lock === 'locked';
}

function LockUnavailable(): never {
  throw new Error('The app lock could not start.');
}

// Reopen a guided flow (weekly review, quarter close, setup) if the app was closed mid-way.
restoreFlowOnLaunch();

// Sync across devices (does nothing until Supabase is configured and you sign in in Settings).
// It keeps running while the app is locked.
void startSync();

// Ask the browser not to clear local data when the device is low on space. Settings can read the answer.
void requestPersistentStorage();

// Another tab running a newer version wants to upgrade the local database. Dexie closes this connection
// so the upgrade can go ahead; reload so this tab runs the new code too. At most once every 30 seconds,
// so a mismatch can never become a reload loop. reloadApp() tells the lock this reload is the app's own,
// so it does not lock you out mid-use (a reload from the lock screen still comes back locked).
db.on('versionchange', () => {
  try {
    const key = 'fb-versionchange-reload';
    if (Date.now() - Number(sessionStorage.getItem(key) ?? 0) < 30_000) return;
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    return;
  }
  reloadApp();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      {lockFailedClosed ? (
        <LockUnavailable />
      ) : (
        <LockGate>
          <App />
        </LockGate>
      )}
    </ErrorBoundary>
  </StrictMode>,
);
