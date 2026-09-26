import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { restoreFlowOnLaunch } from './ui/router';
import './index.css';

// Reopen a guided flow (weekly review, quarter close, setup) if the app was closed mid-way.
restoreFlowOnLaunch();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
