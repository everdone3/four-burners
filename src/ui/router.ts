// Tiny hash router. Hash routes keep iOS back-swipe and the installed PWA happy without server config.
import { useEffect, useState } from 'react';
import { readPending } from '@/coach/session';

export type Route =
  | { name: 'home' }
  | { name: 'burner'; burner: string }
  | { name: 'settings' }
  | { name: 'review' }
  | { name: 'reel'; quarterId: string; closing: boolean }
  | { name: 'close'; quarterId: string }
  | { name: 'setup'; quarterId: string }
  | { name: 'archive'; quarterId?: string }
  | { name: 'checkin' }
  | { name: 'onboarding' }
  | { name: 'about' }
  | { name: 'coach' };

function parse(hash: string): Route {
  const [a, b, c] = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  switch (a) {
    case 'burner':
      return b ? { name: 'burner', burner: b } : { name: 'home' };
    case 'settings':
      return { name: 'settings' };
    case 'review':
      return { name: 'review' };
    case 'reel':
      return b ? { name: 'reel', quarterId: b, closing: c === 'close' } : { name: 'home' };
    case 'close':
    case 'setup':
      return b ? { name: a, quarterId: b } : { name: 'home' };
    case 'archive':
      return { name: 'archive', quarterId: b };
    case 'checkin':
    case 'onboarding':
    case 'about':
    case 'coach':
      return { name: a };
    default:
      return { name: 'home' };
  }
}

// Guided flows survive the app being closed (e.g. switching to Claude to paste a packet):
// on a cold start within an hour, reopen the flow you were in.
const FLOW_KEY = 'fb-last-flow';
const FLOWS = new Set(['review', 'close', 'setup', 'checkin', 'onboarding', 'about']);
// Screens that only matter on relaunch while a copied coach packet is waiting for its reply.
const COACH_ONLY = new Set(['checkin', 'about']);

function rememberFlow(hash: string) {
  try {
    const name = hash.replace(/^#\/?/, '').split('/')[0];
    if (FLOWS.has(name)) localStorage.setItem(FLOW_KEY, JSON.stringify({ hash, at: Date.now() }));
    else if (name === '' || name === 'home') localStorage.removeItem(FLOW_KEY);
  } catch {
    // storage unavailable
  }
}

export function restoreFlowOnLaunch() {
  try {
    if (location.hash && location.hash !== '#/') return;
    const saved = JSON.parse(localStorage.getItem(FLOW_KEY) ?? 'null') as { hash: string; at: number } | null;
    if (!saved) return;
    const age = Date.now() - saved.at;
    const name = saved.hash.replace(/^#\/?/, '').split('/')[0];
    // A packet copied for Claude keeps its screen restorable as long as the paste box waits (2 hours).
    const waiting = readPending() !== null;
    if (COACH_ONLY.has(name) ? waiting : age < 60 * 60_000 || waiting) location.replace(saved.hash);
  } catch {
    // ignore
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const on = () => {
      rememberFlow(location.hash);
      setRoute(parse(location.hash));
    };
    window.addEventListener('hashchange', on);
    window.addEventListener('popstate', on);
    return () => {
      window.removeEventListener('hashchange', on);
      window.removeEventListener('popstate', on);
    };
  }, []);
  return route;
}

export function navigate(path: string, opts: { replace?: boolean } = {}) {
  const hash = path.startsWith('#') ? path : `#/${path.replace(/^\//, '')}`;
  if (opts.replace) {
    location.replace(hash);
  } else {
    location.hash = hash;
  }
}

export function goBack() {
  if (history.length > 1) history.back();
  else navigate('');
}

export function routeKey(r: Route): string {
  switch (r.name) {
    case 'burner':
      return `burner-${r.burner}`;
    case 'reel':
    case 'close':
    case 'setup':
      return `${r.name}-${r.quarterId}`;
    case 'archive':
      return `archive-${r.quarterId ?? ''}`;
    default:
      return r.name;
  }
}
