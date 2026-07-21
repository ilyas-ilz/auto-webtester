import http from "http";

// Bench app (c): client-side SPA with button-only navigation (Plan-v6 V9) —
// the thafheem failure mode: zero <a> links, so a link-following crawler sees
// one page unless the interaction agent adopts click-discovered routes.
// Seeded defects declared in bench/defects.json (app: "spa").

const APP_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Photon — a tiny SPA</title><meta name="description" content="Photon demo SPA"></head>
<body>
<header>
  <h1>Photon</h1>
  <nav>
    <button data-nav="/">Home</button>
    <button data-nav="/gallery">Gallery</button>
    <button data-nav="/contact">Contact</button>
    <!-- SEEDED p5: icon-only button with no accessible name -->
    <button id="theme-toggle">☾</button>
  </nav>
</header>
<main id="app"></main>
<script>
const routes = {
  "/": () => \`<h2>Welcome</h2><p>Photon is a demo single-page app with button-driven navigation.</p>
    <button id="load-more">Load more</button>
    <!-- SEEDED p6/p7: contact-style form, no labels, submit accepts empty -->
    <form id="quick-note"><input name="note" placeholder="Quick note"><input name="email" placeholder="Your email"><button type="submit">Send</button></form>\`,
  "/gallery": () => {
    // SEEDED p3: rendering the gallery throws a console TypeError after paint.
    setTimeout(() => { const photos = undefined; console.log(photos.length); }, 50);
    // SEEDED p2: gallery images have no alt text.
    return \`<h2>Gallery</h2><div><img src="/img/a.png" width="60" height="60"><img src="/img/b.png" width="60" height="60"><img src="/img/c.png" width="60" height="60"></div>\`;
  },
  // SEEDED p4: the contact route renders an empty main.
  "/contact": () => \`\`,
};
function render(path) {
  const fn = routes[path] || routes["/"];
  document.getElementById("app").innerHTML = fn();
  const lm = document.getElementById("load-more");
  // SEEDED p1: the "Load more" button throws on every click and nothing changes.
  if (lm) lm.addEventListener("click", () => { const next = undefined; next.fetch(); });
  const form = document.getElementById("quick-note");
  if (form) form.addEventListener("submit", (e) => { e.preventDefault(); }); // accepts empty, no feedback
}
document.querySelectorAll("[data-nav]").forEach((b) =>
  b.addEventListener("click", () => { history.pushState({}, "", b.dataset.nav); render(b.dataset.nav); })
);
window.addEventListener("popstate", () => render(location.pathname));
render(location.pathname);
</script>
</body></html>`;

export function createSpaApp(): http.Server {
  return http.createServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    if (p.startsWith("/img/")) {
      res.writeHead(200, { "Content-Type": "image/png" });
      return res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
    }
    // Every route serves the app shell (history-API deep links must work).
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(APP_HTML);
  });
}
