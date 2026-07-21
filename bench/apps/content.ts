import http from "http";

// Bench app (b): static content-site archetype (Plan-v6 V9). Public, no auth.
// Seeded defects declared in bench/defects.json (app: "content").

const shell = (head: string, body: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${head}</head>
<body><nav><a href="/">Home</a> <a href="/articles">Articles</a> <a href="/about">About</a></nav>
<main>${body}</main></body></html>`;

// SEEDED c8: no page carries a meta description.
const ARTICLES: Record<string, { title: string; body: string }> = {
  "1": { title: "Understanding tides", body: `<img src="/img/tides.png" width="80" height="60"><p>Tides rise and fall twice daily, driven by the moon's gravity acting on the oceans over the course of each day.</p>` },
  "2": { title: "Empty draft", body: "" }, // SEEDED c6: published article with an empty main
  "3": { title: "A field guide to mosses", body: `<img src="/img/moss.png" width="80" height="60"><p>Mosses are non-vascular plants that thrive in damp, shaded environments and reproduce via spores rather than seeds.</p>` },
  "4": { title: "Bread at home", body: `<img src="/img/bread.png" width="80" height="60"><p>Good bread needs four things: flour, water, salt, and time. Everything else is refinement layered on patience.</p>` },
};

export function createContentApp(): http.Server {
  return http.createServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://localhost").pathname;

    if (p === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      // SEEDED c1: the landing page has no <h1>.
      return res.end(shell(`<title>Field Notes — a small journal</title>`, `<p>A small journal of practical curiosities.</p>
<p>Start with the <a href="/articles">article index</a> or read <a href="/about">about the site</a>.</p>`));
    }

    if (p === "/articles") {
      res.writeHead(200, { "Content-Type": "text/html" });
      // SEEDED c2: mixed date formats on one page. SEEDED c3: console TypeError.
      // SEEDED c4: the index links /article/9 which does not exist.
      return res.end(shell(`<title>Articles — Field Notes</title>`, `<h1>Articles</h1><ul>
<li><a href="/article/1">Understanding tides</a> — published 2026-07-01</li>
<li><a href="/article/2">Empty draft</a> — published 07/03/2026</li>
<li><a href="/article/3">A field guide to mosses</a> — published 2026-07-10</li>
<li><a href="/article/4">Bread at home</a> — published 2026-07-14</li>
<li><a href="/article/9">The lost article</a> — published 2026-07-18</li>
</ul>
<script>const meta = null; console.log(meta.updatedAt);</script>`));
    }

    const art = p.match(/^\/article\/(\d+)$/);
    if (art) {
      const a = ARTICLES[art[1]];
      if (!a) {
        res.writeHead(404, { "Content-Type": "text/html" });
        return res.end(shell(`<title>Not found</title>`, `<h1>404</h1><p>No such article.</p>`));
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      // SEEDED c5: article hero images carry no alt text.
      return res.end(shell(`<title>${a.title} — Field Notes</title>`, `<article><h1>${a.title}</h1>${a.body}</article>`));
    }

    if (p === "/about") {
      res.writeHead(200, { "Content-Type": "text/html" });
      // SEEDED c7: the about page has no <title>.
      return res.end(shell(``, `<h1>About</h1><p>Field Notes is written by one person with too many hobbies and a scanner.</p>`));
    }

    if (p.startsWith("/img/")) {
      res.writeHead(200, { "Content-Type": "image/png" });
      return res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
    }

    res.writeHead(404, { "Content-Type": "text/html" });
    return res.end(shell(`<title>Not found</title>`, `<h1>404</h1><p>Nothing here.</p>`));
  });
}
