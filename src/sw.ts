// Service worker: the offline app shell. Precaches the built app so it opens on an airplane.
// Data never passes through here; Dexie (IndexedDB) is the offline store, and Supabase calls go straight
// to the network, so there is no runtime caching of *.supabase.co on purpose.
// Served as /sw.js with scope '/'. Never rename or move it: push subscriptions (Phase 7) are tied to it.
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { clientsClaim } from 'workbox-core';

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

// Phase 7 (notifications) goes here, in this same file:
// self.addEventListener('push', (event) => {
//   const data = (event.data?.json() ?? {}) as { title?: string; body?: string; url?: string };
//   event.waitUntil(self.registration.showNotification(data.title ?? 'Four Burners', { body: data.body, icon: '/icon.svg', data }));
// });
// self.addEventListener('notificationclick', (event) => {
//   event.notification.close();
//   const url = (event.notification.data as { url?: string } | undefined)?.url ?? '/#/';
//   event.waitUntil(
//     self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((all) => {
//       const open = all.find((c) => new URL(c.url).origin === self.location.origin);
//       return open ? open.focus().then((c) => c.navigate(url)) : self.clients.openWindow(url);
//     }),
//   );
// });
