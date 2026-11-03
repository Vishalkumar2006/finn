// FINN service worker: push notifications and notification taps only.
// There is deliberately no fetch handler, so pages, prices and API responses are never cached or served from here.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Only FINN's own screens; anything else opens Alerts. Mirrors safePath() on the server.
function safePath(path) {
  if (path === "/" || path === "/alerts" || path === "/alerts#my-alerts") return path;
  return typeof path === "string" && /^\/research\/[A-Z0-9&-]{1,20}$/.test(path) ? path : "/alerts";
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" ? data.title.slice(0, 80) : "FINN";
  const body = typeof data.body === "string" ? data.body.slice(0, 240) : "Open FINN to see what changed.";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      tag: typeof data.tag === "string" ? data.tag : "finn",
      data: { path: safePath(data.url) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(safePath(event.notification.data && event.notification.data.path), self.location.origin);
  event.waitUntil(
    (async () => {
      const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Reuse an open FINN window rather than stacking new ones.
      for (const tab of tabs) {
        if (new URL(tab.url).origin !== self.location.origin) continue;
        await tab.focus();
        if ("navigate" in tab) return tab.navigate(target.href).catch(() => self.clients.openWindow(target.href));
        return;
      }
      return self.clients.openWindow(target.href);
    })(),
  );
});
