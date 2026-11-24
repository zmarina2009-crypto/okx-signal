/* OKX Signal Pro v3 — Web Push service worker.
 * Scope is limited to /okx-signal/v3/ on GitHub Pages.
 */
self.addEventListener("install", event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "Поступил новый торговый сигнал." };
  }

  const title = String(payload.title || "OKX Signal Pro v3");
  const options = {
    body: String(payload.body || "Поступил новый скальпинг-сигнал."),
    tag: String(payload.tag || "okx-signal-pro-v3"),
    data: payload.data && typeof payload.data === "object" ? payload.data : {},
    badge: undefined,
    renotify: false
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const rawTarget = event.notification.data?.url || self.registration.scope;
    let target;
    try {
      target = new URL(rawTarget, self.registration.scope);
    } catch {
      target = new URL(self.registration.scope);
    }

    // A notification payload must not send the user to another origin.
    if (target.origin !== self.location.origin) target = new URL(self.registration.scope);

    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (client.url.startsWith(self.registration.scope)) {
        if (typeof client.navigate === "function" && client.url !== target.href) {
          await client.navigate(target.href);
        }
        await client.focus();
        return;
      }
    }
    await self.clients.openWindow(target.href);
  })());
});
