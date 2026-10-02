// Service worker: the offline app shell. Precaches the built app so it opens on an airplane.
// Data never passes through here; Dexie (IndexedDB) is the offline store, and Supabase calls go straight
// to the network, so there is no runtime caching of *.supabase.co on purpose.
// Served as /sw.js with scope '/'. Never rename or move it: push subscriptions are tied to it.
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { clientsClaim } from 'workbox-core';
import { readPush, safeHash } from './notify/payload';

declare let self: ServiceWorkerGlobalScope;

// A new version waits until the page says it is a good moment (src/ui/useAppUpdate.ts), then takes over.
self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') void self.skipWaiting();
});
clientsClaim();

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// Every page load (including /?source=pwa from the Home Screen) gets the cached index.html.
// Routes live in the hash, so one shell serves them all. Files with an extension still hit the network.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/^\/api\//, /\/[^/?]+\.[a-z0-9]+$/i],
  }),
);

// Notifications (Phase 7). The notify Edge Function sends {title, body, url, tag} by Web Push.
// iOS requires every push to show a notification (or it revokes the subscription), so one is always shown,
// even for a payload that can't be read.
self.addEventListener('push', (event) => {
  let text: string | null = null;
  try {
    text = event.data?.text() ?? null;
  } catch {
    // unreadable payload: show the default
  }
  const n = readPush(text);
  event.waitUntil(
    self.registration.showNotification(n.title, {
      body: n.body,
      tag: n.tag,
      icon: '/apple-touch-icon.png',
      badge: '/apple-touch-icon.png',
      data: { hash: n.hash },
    }),
  );
});

// A tap opens the screen the notification is about: in the open app if there is one (the app switches its
// hash route, see startPush in src/notify/push.ts, so nothing reloads and nothing typed is lost), otherwise
// in a fresh launch. Either way the app lock, if on, asks for Face ID first.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const hash = safeHash((event.notification.data as { hash?: unknown } | null)?.hash);
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = all.find((c) => new URL(c.url).origin === self.location.origin);
      if (open) {
        await open.focus().catch(() => undefined);
        open.postMessage({ type: 'fb-open', hash });
        return;
      }
      await self.clients.openWindow(`/${hash}`);
    })(),
  );
});
