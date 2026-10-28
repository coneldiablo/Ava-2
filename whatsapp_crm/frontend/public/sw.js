// Service Worker for Web Push Notifications
// Handles push events and shows browser notifications

self.addEventListener('push', function (event) {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch (e) {
        data = { title: '📬 Уведомление', body: event.data ? event.data.text() : '' };
    }

    const title = data.title || 'WhatsApp CRM';
    const options = {
        body: data.body || '',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: data.type || 'default',
        data: {
            chatId: data.chatId || null,
            instanceId: data.instanceId || null,
            type: data.type || 'info',
        },
        requireInteraction: data.type === 'human_help', // human_help stays until dismissed
        vibrate: [200, 100, 200],
    };

    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

self.addEventListener('notificationclick', function (event) {
    event.notification.close();

    const data = event.notification.data || {};
    let url = '/leads';

    if (data.chatId) {
        url = `/conversations?chat=${encodeURIComponent(data.chatId)}`;
    }

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
            // Focus existing tab if open
            for (const client of clientList) {
                if (client.url.includes(self.location.origin) && 'focus' in client) {
                    client.focus();
                    client.navigate(url);
                    return;
                }
            }
            // Open new tab
            if (clients.openWindow) {
                return clients.openWindow(url);
            }
        })
    );
});

self.addEventListener('install', function (event) {
    self.skipWaiting();
});

self.addEventListener('activate', function (event) {
    event.waitUntil(clients.claim());
});
