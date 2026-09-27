import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { ErrorBoundary } from './ui/components/ErrorBoundary';
import { restoreFlowOnLaunch } from './ui/router';
import { requestPersistentStorage } from './ui/storagePersist';
import { db } from './data/db';
import { startSync } from './sync/manager';
import './index.css';

// Reopen a guided flow (weekly review, quarter close, setup) if the app was closed mid-way.
restoreFlowOnLaunch();

// Sync across devices (does nothing until Supabase is configured and you sign in in Settings).
void startSync();

// Ask the browser not to clear local data when the device is low on space. Settings can read the answer.
void requestPersistentStorage();

// Another tab running a newer version wants to upgrade the local database. Dexie closes this connection
// so the upgrade can go ahead; reload so this tab runs the new code too. At most once every 30 seconds,
// so a mismatch can never become a reload loop.
db.on('versionchange', () => {
  try {
    const key = 'fb-versionchange-reload';
    if (Date.now() - Number(sessionStorage.getItem(key) ?? 0) < 30_000) return;
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    return;
  }
  location.reload();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
