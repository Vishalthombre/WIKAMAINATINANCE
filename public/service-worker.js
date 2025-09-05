const CACHE_NAME = "wika-static-v1";
const urlsToCache = [
  "/login",
  "/register",
  "/register/check",
  "/css/auth.css",
  "/css/register-id.css",
  "/images/user_bg.jpg",
  "/images/web-app-manifest-192x192.png",
  "/images/web-app-manifest-512x512.png",
  "/js/register-sw.js",
  "/favicon.ico",
  "/manifest.json",
  "/offline.html"
];

// ----------------------
// INSTALL
// ----------------------
self.addEventListener("install", (event) => {
  console.log("✅ Installing service worker...");
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      for (const url of urlsToCache) {
        try {
          await cache.add(url);
          console.log(`✅ Cached: ${url}`);
        } catch (err) {
          console.warn(`⚠️ Failed to cache: ${url}`, err);
        }
      }
    })
  );
  self.skipWaiting();
});

// ----------------------
// ACTIVATE
// ----------------------
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

// ----------------------
// FETCH
// ----------------------
self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      if (response) return response;
      return fetch(event.request).catch(() => {
        // If navigation request fails, show offline page
        if (event.request.mode === "navigate") {
          return caches.match("/offline.html");
        }
      });
    })
  );
});

// ----------------------
// PUSH NOTIFICATIONS
// ----------------------
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'New notification';
  const options = {
    body: data.body || '',
    icon: '/images/web-app-manifest-192x192.png',
    badge: '/images/web-app-manifest-192x192.png'
  };
  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ----------------------
// NOTIFICATION CLICK
// ----------------------
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window" }).then((clientList) => {
      if (clients.openWindow) {
        return clients.openWindow("/"); // Change to your desired page
      }
    })
  );
});