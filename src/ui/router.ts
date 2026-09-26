// Tiny hash router. Hash routes keep iOS back-swipe and the installed PWA happy without server config.
import { useEffect, useState } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'burner'; burner: string }
  | { name: 'settings' };

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'burner' && parts[1]) return { name: 'burner', burner: parts[1] };
  if (parts[0] === 'settings') return { name: 'settings' };
  return { name: 'home' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const on = () => setRoute(parse(location.hash));
    window.addEventListener('hashchange', on);
    window.addEventListener('popstate', on);
    return () => {
      window.removeEventListener('hashchange', on);
      window.removeEventListener('popstate', on);
    };
  }, []);
  return route;
}

export function navigate(path: string) {
  location.hash = path.startsWith('#') ? path : `#/${path.replace(/^\//, '')}`;
}

export function goBack() {
  if (history.length > 1) history.back();
  else navigate('');
}

export function routeKey(r: Route): string {
  return r.name === 'burner' ? `burner-${r.burner}` : r.name;
}
