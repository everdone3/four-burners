// What the service worker shows for a push, and where a tap goes. Pure, shared by src/sw.ts and its tests.
// The server sends {title, body, url, tag} (src/server/notify/handler.ts).

export interface ShownNotification {
  title: string;
  body: string;
  tag?: string;
  /** Hash route inside the app, always '#/...'. */
  hash: string;
}

/** Only in-app hash routes: a push can never send a tap anywhere else. */
export function safeHash(url: unknown): string {
  if (typeof url !== 'string') return '#/';
  const i = url.indexOf('#/');
  if (i < 0 || !/^\/?$/.test(url.slice(0, i))) return '#/';
  const hash = url.slice(i);
  return /^#\/[A-Za-z0-9/_-]*$/.test(hash) ? hash : '#/';
}

/** Read a push payload defensively: bad or missing JSON still shows something (iOS requires a notification). */
export function readPush(text: string | null | undefined): ShownNotification {
  let d: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text ?? '') as unknown;
    if (parsed && typeof parsed === 'object') d = parsed as Record<string, unknown>;
  } catch {
    // not JSON
  }
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  return {
    title: str(d.title, 80) ?? 'Four Burners',
    body: str(d.body, 240) ?? '',
    tag: str(d.tag, 32),
    hash: safeHash(d.url),
  };
}
