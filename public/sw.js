// Deliberately minimal service worker: its presence makes the app
// installable (home-screen icon, standalone window, more reliable
// screen-off playback on Android), while every request still goes
// straight to the network. Offline download support will grow here.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* network passthrough */ });
