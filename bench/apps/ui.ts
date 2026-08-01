import http from "http";

// Bench app (d): SaaS-style dashboard seeded with UI / RESPONSIVE / MOBILE faults —
// the class of defect the other three bench apps don't cover (they carry functional,
// a11y, SEO, security and data defects). Seeded defects are declared in
// bench/defects.json (app: "ui").
//
// Deliberately mixed: some faults the fleet SHOULD catch (overflow, clipped text,
// dead links, contrast, unlabelled inputs, broken image, CLS, dead button, missing
// title, inconsistent design token) and some it currently CANNOT (touch-target size,
// element overlap, content hidden at a breakpoint, un-closable modal). The misses are
// the point: a benchmark that only seeds catchable defects flatters the tool.
//
// Faults marked "mobile-only" are invisible on the default desktop profile — they need
// BENCH_MODE=smart|full, which adds Mobile Chrome. That contrast is itself a result.

const NAV = `
<nav>
  <a href="/">Dashboard</a>
  <a href="/billing">Billing</a>
  <a href="/settings">Settings</a>
  <a href="/reports">Reports</a>
  <!-- SEEDED u3: placeholder links that go nowhere -->
  <a href="#">Docs</a>
  <a href="javascript:void(0)">Support</a>
  <!-- SEEDED u5: icon-only control with no accessible name -->
  <button id="gear">⚙</button>
</nav>`;

const CSS = `
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; background: #ffffff; color: #1a1a1a; }
  nav { display: flex; gap: 12px; align-items: center; margin-bottom: 20px; }
  nav a { color: #2b5fd9; }
  button { background: #2b5fd9; color: #fff; border: 0; border-radius: 6px; padding: 8px 14px; }
  .card { border: 1px solid #e3e3e3; border-radius: 8px; padding: 12px; margin: 12px 0; }
  /* SEEDED u2: fixed-width cell with nowrap + hidden and NO text-overflow: ellipsis,
     so long content is silently cut off instead of truncated visibly. */
  .clip { width: 130px; white-space: nowrap; overflow: hidden; }
  /* SEEDED u9 (expected MISS): two absolutely positioned elements that collide.
     Nothing in the fleet asserts element overlap today. */
  .stack { position: relative; height: 60px; }
  .stack .a { position: absolute; top: 10px; left: 10px; width: 220px; background: #eef; }
  .stack .b { position: absolute; top: 13px; left: 30px; width: 220px; background: #fee; }
  /* SEEDED u7: text on background that fails WCAG contrast. */
  .faint { color: #9a9a9a; background: #ffffff; }
  /* SEEDED u8 (expected MISS): touch target far below the 24-44px guidance. */
  .tiny-tap { display: inline-block; width: 16px; height: 16px; line-height: 16px; text-align: center; background: #2b5fd9; color: #fff; border-radius: 3px; font-size: 10px; }
  @media (max-width: 500px) {
    /* SEEDED u10 (expected MISS): the price table is simply removed on small screens
       with no alternative — content unreachable on mobile, not merely restyled. */
    .prices { display: none; }
  }
</style>`;

function page(title: string, body: string, opts: { noTitle?: boolean; desc?: boolean } = {}): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${opts.noTitle ? "" : `<title>${title} — Acme Console</title>`}
${opts.desc === false ? "" : `<meta name="description" content="${title} in the Acme SaaS console">`}
${CSS}</head><body>${NAV}${body}</body></html>`;
}

// ---- / (dashboard) ---------------------------------------------------------
// u1: a 1600px-wide table in a container that does not scroll → the document is
// wider than the viewport on EVERY profile (desktop included).
// u12: layout shift — a banner is inserted after paint, pushing content down.
const DASHBOARD = page("Dashboard", `
<h1>Dashboard</h1>
<div class="card">
  <p>Monthly recurring revenue and usage.</p>
  <!-- SEEDED u2: this value is clipped with no ellipsis -->
  <div class="clip">USD 128,940.55 recognised this period</div>
</div>
<!-- SEEDED u1: table forces horizontal overflow, no scroll container -->
<table style="min-width:1600px;border-collapse:collapse">
  <thead><tr><th>Account</th><th>Plan</th><th>Seats</th><th>MRR</th><th>Region</th><th>Owner</th><th>Renewal</th><th>Health</th></tr></thead>
  <tbody>
    <tr><td>Northwind</td><td>Enterprise</td><td>412</td><td>$18,400</td><td>eu-west</td><td>a.lang@northwind.example</td><td>2026-11-04</td><td>Good</td></tr>
    <tr><td>Initech</td><td>Growth</td><td>88</td><td>$4,120</td><td>us-east</td><td>p.gibbons@initech.example</td><td>2026-09-19</td><td>At risk</td></tr>
  </tbody>
</table>
<!-- SEEDED u14: this button has no handler at all — it looks live and does nothing -->
<button id="export">Export CSV</button>
<p class="faint">Figures update hourly.</p>`);

// ---- /billing --------------------------------------------------------------
// u6: form inputs with no labels. u11: broken image. u13 (expected MISS): a modal
// that opens but cannot be dismissed by keyboard and traps nothing.
const BILLING = page("Billing", `
<h1>Billing</h1>
<div class="card prices">
  <h2>Plans</h2>
  <p>Growth $49 · Enterprise $199</p>
</div>
<!-- SEEDED u11: this image 404s — it renders as a broken placeholder -->
<img src="/img/card-brands.png" width="120" height="40">
<div class="card">
  <h2>Payment method</h2>
  <!-- SEEDED u6: no <label>, no aria-label — placeholder only -->
  <form id="pay">
    <input name="card" placeholder="Card number">
    <input name="exp" placeholder="MM/YY">
    <input name="cvc" placeholder="CVC">
    <button type="submit">Save card</button>
  </form>
</div>
<!-- SEEDED u8 (expected MISS): 16px tap target -->
<p>Invoices: <span class="tiny-tap" onclick="void 0">↓</span></p>
<button id="open-modal">Cancel subscription</button>
<div id="modal" style="display:none;border:2px solid #c33;padding:12px;margin-top:8px">
  <p>Are you sure? This cannot be undone.</p>
  <!-- SEEDED u13 (expected MISS): no close button, Escape does nothing, focus not trapped -->
</div>
<script>
  document.getElementById("open-modal").addEventListener("click", () => {
    document.getElementById("modal").style.display = "block";
  });
</script>`);

// ---- /settings -------------------------------------------------------------
// u4: this page's primary button colour disagrees with every other page, which is
// the cross-page design-token check (needs ≥3 sampled pages to fire).
// u9 (expected MISS): overlapping absolutely-positioned blocks.
const SETTINGS = page("Settings", `
<h1>Settings</h1>
<!-- SEEDED u4: off-brand primary button colour on this page only -->
<style>button { background: #b23bd6; }</style>
<div id="shift-target"></div>
<div class="card">
  <h2>Workspace</h2>
  <button id="rename">Rename workspace</button>
</div>
<!-- SEEDED u9: these two blocks overlap each other -->
<div class="card stack">
  <div class="a">Notification preferences</div>
  <div class="b">Danger zone</div>
</div>
<script>
  // SEEDED u12: a tall banner injected 400ms after paint pushes everything below it
  // down. Kept on THIS page, not the dashboard: an async DOM mutation like this makes
  // the interaction agent believe a dead button "did something", which masked the
  // seeded dead-button defect when both lived on the same page.
  setTimeout(() => {
    const el = document.getElementById("shift-target");
    if (el) el.innerHTML = '<div style="height:220px;background:#fff8d6;border:1px solid #e8d98a">Trial ends in 3 days — add a payment method.</div>';
  }, 400);
</script>`);

// ---- /reports --------------------------------------------------------------
// u15: no <title>. u16: no meta description. u2 again via a clipped cell.
const REPORTS = page("Reports", `
<h1>Reports</h1>
<div class="card">
  <!-- SEEDED u2: clipped, no ellipsis -->
  <div class="clip">Quarterly retention cohort export (all regions, 2026)</div>
</div>
<!-- SEEDED u17 (mobile-only): fixed 900px block overflows a phone viewport but not desktop -->
<div style="width:900px;background:#f3f3f3;padding:8px">Wide chart canvas placeholder</div>
`, { noTitle: true, desc: false });

export function createUiApp(): http.Server {
  const routes: Record<string, string> = {
    "/": DASHBOARD,
    "/billing": BILLING,
    "/settings": SETTINGS,
    "/reports": REPORTS,
  };
  return http.createServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    // SEEDED u11: the referenced image is deliberately missing.
    if (p.startsWith("/img/")) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("not found");
    }
    const html = routes[p];
    if (!html) {
      res.writeHead(404, { "Content-Type": "text/html" });
      return res.end(page("Not found", "<h1>404</h1>"));
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(html);
  });
}
