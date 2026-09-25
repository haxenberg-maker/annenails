// sw.js — pune acest fișier chiar lângă index.html, la rădăcina site-ului
// (pe Netlify: în folderul care se publică, ex. /public sau rădăcina repo-ului).
// Trebuie servit ca /sw.js, altfel scope-ul din pagină nu se potrivește.

const CACHE_NAME = 'unghii-app-shell-v2';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.add(self.registration.scope).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  // Extensiile de Chrome (traducere, password manager etc.) pot declanșa
  // cereri cu scheme necache-uibile (chrome-extension://) — le ignorăm.
  if (!event.request.url.startsWith('http')) return;
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      fetch(event.request)
        .then((networkResp) => {
          cache.put(event.request, networkResp.clone()).catch(() => {});
          return networkResp;
        })
        .catch(() => cache.match(event.request))
    )
  );
});

// ====================== WEB PUSH ======================

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }

  const title = data.title || 'Programare în curând!';
  const options = {
    body: data.body || '',
    tag: data.tag || 'appt-reminder',
    data: { appointmentId: data.appointmentId || null },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const appointmentId = event.notification.data && event.notification.data.appointmentId;
  event.waitUntil(
    (async () => {
      const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of allClients) {
        // Pagina e deja deschisă — îi trimitem id-ul ca să navigheze direct la programare.
        if (appointmentId && 'postMessage' in client) {
          client.postMessage({ type: 'open-appointment', appointmentId });
        }
        if ('focus' in client) return client.focus();
      }
      const url = appointmentId ? `/?appt=${encodeURIComponent(appointmentId)}` : '/';
      if (clients.openWindow) return clients.openWindow(url);
    })()
  );
});
