const cacheName = "gj-shell-4";
const assets = ["./", "./index.html", "./style.css", "./app.mjs", "./vault.mjs", "./model.mjs",
    "./manifest.json", "./icon-192.png", "./icon-512.png", "./evidence.bundle.json"];
self.addEventListener("install", event => event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(assets))));
self.addEventListener("activate", event => event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith("gj-shell-") && name !== cacheName) await caches.delete(name);
    await self.clients.claim();
})()));
self.addEventListener("fetch", event => {
    const request = event.request;
    const url = new URL(request.url);
    if (request.method !== "GET" || url.origin !== self.location.origin) return;
    const key = request.mode === "navigate" ? "./" : assets.find(path => new URL(path, self.location).href === url.href);
    if (!key) return;
    event.respondWith(caches.open(cacheName).then(async cache => await cache.match(key) || fetch(request)));
});
