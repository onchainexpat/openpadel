// Kumi's service worker: shows the club's push notifications, and opens the app where each one points.
self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(d.title || "Kumi", { body: d.body || "", tag: d.tag, data: { url: d.url || "/" }, icon: "/manifest/icon-192.png", badge: "/manifest/icon-192.png" }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.startsWith(self.location.origin) && "focus" in c) return c.navigate(url).then((w) => (w || c).focus());
    return self.clients.openWindow(url);
  }));
});
