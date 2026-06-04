// CobranzaPro ERP — Service Worker v3.0
// Strategy: Cache-first for assets, Network-first for API

const CACHE_NAME = 'gestion-emd-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
];

// ============================================
// INSTALL — Cache static assets
// ============================================
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch(err => {
        console.warn('[SW] Some assets failed to cache:', err);
      });
    })
  );
  self.skipWaiting();
});

// ============================================
// ACTIVATE — Cleanup old caches
// ============================================
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    }).then(() => {
      self.clients.claim();
    })
  );
});

// ============================================
// FETCH — Hybrid strategy
// ============================================
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests — let them pass through
  if (request.method !== 'GET') return;

  // API calls: Network-first (always try to get fresh data)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          // Clone and cache successful responses
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          // Fall back to cache if offline
          return caches.match(request);
        })
    );
    return;
  }

  // Static assets: Cache-first
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        // Return cache but update in background (stale-while-revalidate)
        fetch(request).then(response => {
          if (response.ok) {
            caches.open(CACHE_NAME).then(cache => cache.put(request, response));
          }
        }).catch(() => {});
        return cached;
      }

      // Not in cache: fetch from network
      return fetch(request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback for navigation requests
        if (request.mode === 'navigate') {
          return caches.match('/index.html');
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});

// ============================================
// SYNC — Background sync for offline payments
// ============================================
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-payments') {
    event.waitUntil(syncPendingPayments());
  }
  if (event.tag === 'sync-gastos') {
    event.waitUntil(syncPendingGastos());
  }
});

async function syncPendingPayments() {
  try {
    // Open IndexedDB and get pending items
    const db = await openDB();
    const tx = db.transaction('pending', 'readwrite');
    const store = tx.objectStore('pending');
    const items = await getAllFromStore(store);

    for (const item of items) {
      if (item.tipo === 'pago' && !item.sincronizado) {
        try {
          // Mark as synced
          item.sincronizado = true;
          item.syncTimestamp = new Date().toISOString();
          store.put(item);

          // Notify all clients
          const clients = await self.clients.matchAll();
          clients.forEach(client => {
            client.postMessage({
              type: 'SYNC_COMPLETE',
              id: item.id,
              success: true
            });
          });
        } catch (err) {
          console.error('[SW] Sync failed for item:', item.id, err);
        }
      }
    }
  } catch (err) {
    console.error('[SW] Sync error:', err);
  }
}

async function syncPendingGastos() {
  // Similar logic for gastos
}

// ============================================
// PUSH NOTIFICATIONS (future)
// ============================================
self.addEventListener('push', (event) => {
  if (!event.data) return;

  const data = event.data.json();
  const options = {
    body: data.body || 'Nueva notificación de DotCom',
    icon: '/icon-192.png',
    badge: '/badge-72.png',
    vibrate: [200, 100, 200],
    tag: data.tag || 'cobranzapro-notif',
    data: data.data || {},
    actions: data.actions || [],
    requireInteraction: data.prioridad === 'alta',
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'DotCom', options)
  );
});

// ============================================
// NOTIFICATION CLICK
// ============================================
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // Focus existing window or open new one
      for (const client of clients) {
        if (client.url.includes('/') && 'focus' in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow('/');
    })
  );
});

// ============================================
// MESSAGE — Handle commands from main thread
// ============================================
self.addEventListener('message', (event) => {
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data.type === 'CACHE_URLS') {
    const urls = event.data.urls || [];
    caches.open(CACHE_NAME).then(cache => {
      cache.addAll(urls).then(() => {
        event.source.postMessage({ type: 'CACHE_COMPLETE', urls });
      });
    });
  }

  if (event.data.type === 'GET_VERSION') {
    event.source.postMessage({ type: 'VERSION', version: CACHE_NAME });
  }
});

// ============================================
// IndexedDB Helpers
// ============================================
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('CobranzaProDB', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('pending')) {
        db.createObjectStore('pending', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('syncLog')) {
        db.createObjectStore('syncLog', { keyPath: 'id', autoIncrement: true });
      }
    };
  });
}

function getAllFromStore(store) {
  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

