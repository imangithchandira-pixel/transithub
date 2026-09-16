// /public/sw.js
// ═══════════════════════════════════════════════════════════════════════════
// The service worker is what lets the browser show a notification even when
// TransitHub isn't open in a tab. This file must live at the SITE ROOT
// (public/sw.js, served at /sw.js) — a service worker can only control pages
// within the scope of the path it's served from.
// ═══════════════════════════════════════════════════════════════════════════

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "TransitHub", body: event.data ? event.data.text() : "You have a reminder." };
  }

  const title = data.title || "TransitHub";
  const options = {
    body: data.body || "",
    data: { url: data.url || "/" },
    tag: "transithub-reminder", // replaces any earlier un-actioned reminder instead of stacking
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping the notification focuses an already-open TransitHub tab if one
// exists, otherwise opens a new one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && "focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(event.notification.data?.url || "/");
    })
  );
});
