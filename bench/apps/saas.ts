import http from "http";

// Bench app (a): multi-role "SaaS" archetype (Plan-v6 V9). Zero-dep node http
// server — the fleet tests black-box HTML/HTTP, so a framework adds nothing here.
// Every seeded defect is declared in bench/defects.json (app: "saas").

const USERS: Record<string, { password: string; role: string }> = {
  "admin@bench.local": { password: "admin123", role: "admin" },
  "user@bench.local": { password: "user123", role: "user" },
};

const page = (title: string, body: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><meta name="description" content="BenchSaaS ${title}"></head>
<body><header><h1>${title}</h1><nav><a href="/dashboard">Dashboard</a> <a href="/items">Items</a> <a href="/settings">Settings</a></nav></header>
<main>${body}</main></body></html>`;

function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, v] = part.trim().split("=");
    if (k) out[k] = v ?? "";
  }
  return out;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => resolve(data));
  });
}

export function createSaasApp(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    const sid = parseCookies(req).sid ?? "";
    // SEEDED s11: no security headers are ever sent (no CSP, XFO, nosniff, referrer-policy).

    if (p === "/login") {
      if (req.method === "POST") {
        const body = new URLSearchParams(await readBody(req));
        const u = USERS[String(body.get("email") ?? "").toLowerCase()];
        if (u && u.password === body.get("password")) {
          // SEEDED s1: session cookie set without HttpOnly (and without Secure).
          res.writeHead(302, { "Set-Cookie": `sid=${u.role}; Path=/`, Location: "/dashboard" });
          return res.end();
        }
        res.writeHead(302, { Location: "/login?err=1" });
        return res.end();
      }
      const err = url.searchParams.get("err") ? `<div class="error" role="alert">Invalid email or password</div>` : "";
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(page("Sign in", `${err}
<form method="post" action="/login">
  <label for="email">Email</label><input id="email" name="email" type="email" required>
  <label for="password">Password</label><input id="password" name="password" type="password" required>
  <button type="submit">Sign in</button>
</form>`));
    }

    if (!sid) {
      res.writeHead(302, { Location: "/login" });
      return res.end();
    }

    if (p === "/" || p === "/dashboard") {
      res.writeHead(200, { "Content-Type": "text/html" });
      // SEEDED s2: the dashboard fetches /api/stats which always 500s.
      // SEEDED s3: an inline script throws an uncaught TypeError on load.
      return res.end(page("Dashboard", `<p>Welcome back, ${sid}.</p>
<div id="stats">Loading stats…</div>
<p><a href="/slow">Reports summary</a> · <a href="/reports">Legacy reports</a>${sid === "admin" ? ` · <a href="/admin">Admin panel</a>` : ""}</p>
<script>fetch("/api/stats").then(r=>r.json()).then(d=>{document.getElementById("stats").textContent=d.total});</script>
<script>const cfg = undefined; console.log(cfg.theme);</script>`));
    }

    if (p === "/admin") {
      // SEEDED s5: no role check — any logged-in session (including "user") gets the admin panel.
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(page("Admin panel", `<p>User management</p><table><tr><td>admin@bench.local</td><td>admin</td></tr><tr><td>user@bench.local</td><td>user</td></tr></table>`));
    }

    if (p === "/items") {
      res.writeHead(200, { "Content-Type": "text/html" });
      // SEEDED s6: item thumbnails have no alt text.
      return res.end(page("Items", `<ul>
<li><img src="/img/1.png" width="40" height="40"> <a href="/item/1">Alpha widget</a></li>
<li><img src="/img/2.png" width="40" height="40"> <a href="/item/2">Beta widget</a></li>
<li><img src="/img/3.png" width="40" height="40"> <a href="/item/3">Gamma widget</a></li>
</ul>`));
    }

    const item = p.match(/^\/item\/(\d)$/);
    if (item) {
      res.writeHead(200, { "Content-Type": "text/html" });
      // SEEDED s7: /item/2 renders an empty main.
      const body = item[1] === "2" ? "" : `<p>Details for item ${item[1]}: a fine widget in stock.</p><p>Price: $19.99</p>`;
      return res.end(page(`Item ${item[1]}`, body));
    }

    if (p === "/settings") {
      if (req.method === "POST") {
        // SEEDED s9: server accepts the form with every required field empty.
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end(page("Settings", `<p>Saved!</p>`));
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      // SEEDED s8: inputs have no <label> elements.
      return res.end(page("Settings", `<form method="post" action="/settings">
<input name="display_name" placeholder="Display name" required>
<input name="contact_email" type="email" placeholder="Contact email" required>
<button type="submit">Save</button>
</form>`));
    }

    if (p === "/slow") {
      // SEEDED s10: artificial ~4.6s server delay → slow page load.
      await new Promise((r) => setTimeout(r, 4600));
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(page("Reports summary", `<p>Monthly totals: 42 items sold.</p>`));
    }

    if (p === "/api/stats") {
      // SEEDED s2 (server side): always 500.
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "stats backend unavailable" }));
    }

    if (p.startsWith("/img/")) {
      // 1x1 transparent png so <img> tags resolve.
      res.writeHead(200, { "Content-Type": "image/png" });
      return res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
    }

    // SEEDED s4: /reports (linked from the dashboard) does not exist.
    res.writeHead(404, { "Content-Type": "text/html" });
    return res.end(page("Not found", `<p>404 — nothing here.</p>`));
  });
}
