import assert from "node:assert";
import { UNSAFE, urlTemplate } from "./agents/crawler";
import { shouldAdoptRoute } from "./agents/interaction";
import { inferPageType } from "./agents/expectations";
import { encrypt, decrypt, fingerprint } from "../crypto";
import { riskScore } from "./graph";
import { diffByFingerprint } from "./agents/regression";
import { withRecovery } from "./recovery";
import { profilesForMode, PRIMARY_PROFILE } from "./devices";
import { reorderByChangeStatus } from "./graph";
import { classifyCurrencyFormat, classifyDateFormat } from "./agents/dataIntegrity";
import { diffBaseline } from "./agents/visual";
import { AI_BUDGET_BY_MODE } from "./planner";
import { genTestEmail, extractOtp, extractVerifyLink } from "./agents/register";
import { crudTag } from "./agents/crud";
import { findOutliers } from "./agents/uiAudit";
import { pickLoginError } from "./agents/login";
import { parseZapAlerts } from "./agents/security";
import { buildRunReport, computeCoverageTotals, buildCoverageMatrix } from "./orchestrate";
import { rankPages } from "./graph";
import { clusterFailures } from "./agents/rootCause";
import { FUZZ_CATALOGUE, genFuzzInput, looksReflectedXss, expandEdgeTokens, type FuzzKind } from "./fuzz";
import { stripTarget, buildDigest, isDestructiveStep, expandTokens, RESOLVE_ORDER } from "./agents/journey";
import { classifyReaction } from "./agents/resilience";
import { isSafeChaosControl, CHAOS_CONDITIONS } from "./agents/chaos";
import { auditSeoTags, type SeoSignals } from "./agents/seo";
import { parseRequirements } from "./agents/requirements";
import { analyzeApiResponses } from "./agents/apiValidation";
import { assessAnalytics } from "./agents/analytics";
import { analyticsProvider } from "./agents/crawler";
import { classifyLeak } from "./agents/memory";
import { fileToRoute, routesMatch, matchRouteToFiles, mapChangedFilesToPaths } from "./repo";
import { scoreBench, type SeededDefect, type BenchFinding } from "./benchScore";
import type { CrawledPage, ApiSample } from "./context";

// Security-critical: the read-only crawler must NEVER follow links that end the
// session or mutate data. If this regex regresses, the crawler could log itself
// out mid-run or trigger a destructive action. Run: npm run agents:test
for (const bad of [
  "https://x.com/logout",
  "https://x.com/account/sign-out",
  "https://x.com/users/5/delete",
  "https://x.com/items/9/remove",
  "https://x.com/api/orders",
  "javascript:void(0)",
]) {
  assert.ok(UNSAFE.test(bad), `crawler should BLOCK unsafe link: ${bad}`);
}
for (const ok of [
  "https://x.com/dashboard",
  "https://x.com/invoices/5",
  "https://x.com/settings",
  "https://x.com/reports?range=30d",
]) {
  assert.ok(!UNSAFE.test(ok), `crawler should ALLOW safe link: ${ok}`);
}

console.log("selftest OK: crawler URL-safety filter blocks destructive/session-ending links");

// Template sampling: sibling pages of one type must collapse to one template
// (so a 114-surah site doesn't consume the whole crawl budget), while distinct
// sections stay distinct.
assert.strictEqual(urlTemplate("https://x.com/surah/2"), urlTemplate("https://x.com/surah/113"), "numeric siblings must share a template");
assert.strictEqual(urlTemplate("https://x.com/item/2?page=3"), urlTemplate("https://x.com/item/9"), "query strings must not split templates");
assert.notStrictEqual(urlTemplate("https://x.com/surah/2"), urlTemplate("https://x.com/juz/2"), "different sections must not collapse");
assert.strictEqual(
  urlTemplate("https://x.com/order/123e4567-e89b-12d3-a456-426614174000"),
  urlTemplate("https://x.com/order/00000000-0000-4000-8000-000000000000"),
  "uuid siblings must share a template"
);
console.log("selftest OK: crawler URL templates collapse sibling pages");

// Route adoption: click-discovered SPA routes join the tested page set only
// when same-origin, new, safe, and ≤2 per URL template — otherwise a
// button-nav site (thafheem surah menu) gets zero coverage or floods it.
{
  const known = new Set(["https://x.com/"]);
  const perTpl = new Map<string, number>();
  assert.ok(shouldAdoptRoute("https://x.com/surah/67", "https://x.com", known, perTpl), "new same-origin route must be adopted");
  assert.ok(shouldAdoptRoute("https://x.com/surah/1", "https://x.com", known, perTpl), "second representative of a template is allowed");
  assert.ok(!shouldAdoptRoute("https://x.com/surah/36", "https://x.com", known, perTpl), "third sibling of one template must be rejected");
  assert.ok(!shouldAdoptRoute("https://x.com/", "https://x.com", known, perTpl), "already-known URL must be rejected");
  assert.ok(!shouldAdoptRoute("https://evil.com/surah/2", "https://x.com", known, perTpl), "cross-origin must be rejected");
  assert.ok(!shouldAdoptRoute("https://x.com/logout", "https://x.com", known, perTpl), "session-ending route must be rejected");
  console.log("selftest OK: interaction adopts click-discovered routes with template sampling");
}

// Page-type inference: structural rules must classify the common shapes.
{
  const base = { path: "/x", templated: false, mainTextLen: 500, repeatedGroups: 0, hasArticle: false, hasSearchInput: false, hasPrevNext: false, formCount: 0, looksError: false };
  assert.strictEqual(inferPageType({ ...base, looksError: true }), "error");
  assert.strictEqual(inferPageType({ ...base, path: "/search", hasSearchInput: true }), "search");
  assert.strictEqual(inferPageType({ ...base, templated: true }), "detail");
  assert.strictEqual(inferPageType({ ...base, templated: true, hasArticle: true }), "article");
  assert.strictEqual(inferPageType({ ...base, repeatedGroups: 12 }), "list");
  assert.strictEqual(inferPageType({ ...base, formCount: 1, mainTextLen: 200 }), "form");
  assert.strictEqual(inferPageType({ ...base, path: "/" }), "landing");
  console.log("selftest OK: page-type inference classifies error/search/detail/article/list/form/landing");
}

// Credential vault: password must round-trip and must not be stored as plaintext.
const secret = "correct horse battery staple";
const enc = encrypt(secret);
assert.notStrictEqual(enc, secret, "encrypted blob must not equal the plaintext");
assert.strictEqual(decrypt(enc), secret, "decrypt(encrypt(x)) must equal x");
console.log("selftest OK: credential encryption round-trips and does not store plaintext");

// Fingerprints must be stable (dedup across runs depends on this) and distinguish different findings.
assert.strictEqual(fingerprint("a", "b"), fingerprint("a", "b"), "fingerprint must be deterministic");
assert.notStrictEqual(fingerprint("a", "b"), fingerprint("a", "c"), "fingerprint must vary with input");
console.log("selftest OK: finding fingerprints are deterministic");

// Risk scoring must rank auth/payment routes above generic pages so the planner prioritizes them.
assert.ok(riskScore("/login") > riskScore("/faq"), "auth routes must outrank generic pages");
assert.ok(riskScore("/billing/invoice") > riskScore("/profile"), "payment routes must outrank profile pages");
console.log("selftest OK: risk scoring prioritizes auth/payment routes");

// Regression diff (V13): "what broke since last run" is a fingerprint set-diff.
{
  const prev = [{ fingerprint: "a" }, { fingerprint: "b" }];
  const curr = [{ fingerprint: "b" }, { fingerprint: "c" }];
  const { isNew, resolved } = diffByFingerprint(prev, curr);
  assert.deepStrictEqual(isNew.map((f) => f.fingerprint), ["c"], "new = in current, not in prev");
  assert.deepStrictEqual(resolved.map((f) => f.fingerprint), ["a"], "resolved = in prev, not in current");
  console.log("selftest OK: regression diff detects new and resolved findings");
}

// Recovery middleware (§3.5): retry once, then report-and-continue (never throw).
(async () => {
  const noop = { log: () => {}, agentsRan: new Set<string>(), findingCounts: new Map<string, number>() };
  let calls = 0;
  const recovered = await withRecovery(noop, "t", async () => { calls++; if (calls < 2) throw new Error("flake"); return "done"; });
  assert.strictEqual(recovered, "done", "recovery must return the value produced on retry");
  assert.strictEqual(calls, 2, "recovery must retry exactly once");
  const gaveUp = await withRecovery(noop, "t", async () => { throw new Error("always fails"); });
  assert.strictEqual(gaveUp, null, "recovery must return null once retries are exhausted, not throw");
  console.log("selftest OK: recovery retries once then reports-and-continues");
})();

// Device/browser matrix (Plan-v2 §4 execution dimension): Quick must stay fast
// (1 profile) so "2-5 min" holds; coverage must widen monotonically; the
// primary profile must always be Desktop Chrome so the orchestrator's
// "primary gets the full pipeline" assumption is never silently wrong.
{
  const quick = profilesForMode("quick");
  const smart = profilesForMode("smart");
  const full = profilesForMode("full");
  assert.strictEqual(quick.length, 1, "quick mode must run a single device profile");
  assert.ok(quick.length < smart.length && smart.length < full.length, "coverage must widen quick < smart < full");
  for (const set of [quick, smart, full]) assert.strictEqual(set[0].name, PRIMARY_PROFILE.name, "profile [0] must always be the primary");
  assert.ok(full.some((p) => p.contextOptions.isMobile), "full mode must include a mobile-web profile");
  console.log("selftest OK: device/browser matrix widens quick < smart < full with a stable primary");
}

// Change detection (§3.3, "the cost-killer"): new/changed pages must sort
// ahead of unchanged ones so size-limited samples spend their budget on what
// actually changed since last run, not whatever the crawler visited first.
{
  const priorLabels = new Map([["/a", "Dashboard"], ["/b", "Old Title"]]);
  const page = (url: string, title: string): CrawledPage => ({ url, title, role: "U", status: 200, consoleErrors: [], failedRequests: [], screenshot: null });
  const pages: CrawledPage[] = [
    page("https://x.com/a", "Dashboard"),
    page("https://x.com/b", "New Title"),
    page("https://x.com/c", "Brand New Page"),
  ];
  const { newCount, changedCount } = reorderByChangeStatus(pages, priorLabels);
  assert.strictEqual(newCount, 1, "exactly one page (/c) is unseen before");
  assert.strictEqual(changedCount, 1, "exactly one page (/b) has a different title than before");
  assert.deepStrictEqual(pages.map((p) => p.url), ["https://x.com/c", "https://x.com/b", "https://x.com/a"], "new, then changed, then unchanged");
  console.log("selftest OK: change detection sorts new/changed pages ahead of unchanged ones");
}

// Data integrity (V8, formatting-consistency slice): mixed conventions on one page is the signal.
assert.notStrictEqual(classifyCurrencyFormat("$1,200.00"), classifyCurrencyFormat("$45.5"), "different decimal precision must classify differently");
assert.strictEqual(classifyCurrencyFormat("$1,200.00"), classifyCurrencyFormat("$3,400.99"), "same convention must classify the same");
assert.strictEqual(classifyDateFormat("2026-07-08"), "ISO (YYYY-MM-DD)");
assert.notStrictEqual(classifyDateFormat("2026-07-08"), classifyDateFormat("07/08/2026"), "ISO vs slash dates must classify differently");
console.log("selftest OK: data-integrity format classifiers distinguish conventions");

// Visual regression (V11): first sighting baselines, identical bytes are a
// no-op, and a differing screenshot must be flagged as changed.
{
  const a = Buffer.from([1, 2, 3]);
  const b = Buffer.from([1, 2, 3]);
  const c = Buffer.from([9, 9, 9]);
  assert.strictEqual(diffBaseline(null, a), "baselined", "no prior baseline must record one, not compare");
  assert.strictEqual(diffBaseline(a, b), "unchanged", "identical bytes must not be flagged");
  assert.strictEqual(diffBaseline(a, c), "changed", "differing bytes must be flagged as changed");
  console.log("selftest OK: visual regression baseline diff distinguishes new/unchanged/changed");
}

// AI cost guardrail (§5.1 budget.aiTokens): quick must be a provable 0, and
// the ceiling must widen with mode so a Full Audit isn't throttled to Quick's budget.
assert.strictEqual(AI_BUDGET_BY_MODE.quick, 0, "quick mode's AI budget must be exactly 0");
assert.ok(AI_BUDGET_BY_MODE.smart > 0 && AI_BUDGET_BY_MODE.smart < AI_BUDGET_BY_MODE.full, "budget must widen quick < smart < full");
console.log("selftest OK: AI token budget is 0 in quick mode and widens smart < full");

// Self-registration (V1): generated emails must be unique-per-run, obviously
// synthetic (greppable for cleanup), and valid; OTP/verify-link extraction must
// pull the right token from a realistic email body.
{
  const e1 = genTestEmail("app.example.com", "RUNiddddd1");
  const e2 = genTestEmail("app.example.com", "RUNiddddd2");
  assert.ok(/^qa-bot-[a-z0-9]+@app\.example\.com$/.test(e1), `generated email must be synthetic + valid: ${e1}`);
  assert.notStrictEqual(e1, e2, "different run seeds must yield different emails");
  assert.strictEqual(extractOtp("Your code is 483920. Expires soon."), "483920", "must extract the numeric OTP");
  assert.strictEqual(extractOtp("no digits here"), null, "no OTP present must return null");
  const body = "Welcome! Confirm here: https://app.example.com/verify?token=abc and ignore https://other.com/x";
  assert.strictEqual(extractVerifyLink(body, "https://app.example.com"), "https://app.example.com/verify?token=abc", "must pick the same-origin verify link");
  assert.strictEqual(extractVerifyLink(body, "https://nope.com"), null, "no same-origin verify link must return null");
  console.log("selftest OK: self-registration email gen + OTP/verify-link extraction");
}

// CRUD (V5): the data tag must be deterministic per run (so created rows are
// findable) and vary across runs (so two runs' junk don't collide).
assert.strictEqual(crudTag("abcdefgh12345"), crudTag("abcdefgh12345"), "crud tag must be stable within a run");
assert.notStrictEqual(crudTag("run-aaaa"), crudTag("run-bbbb"), "crud tag must vary across runs");
console.log("selftest OK: CRUD data tag is stable within a run and unique across runs");

// UI uniformity (V11): the odd-one-out page must be flagged, but only with a
// clear majority over enough samples — never on 1-2 pages or a tie (noise).
{
  const same = ["/a", "/b", "/c"].map((url) => ({ url, value: "Inter" }));
  assert.deepStrictEqual(findOutliers(same), [], "no outlier when every page agrees");
  const odd = [{ url: "/a", value: "Inter" }, { url: "/b", value: "Inter" }, { url: "/c", value: "Comic Sans" }];
  assert.deepStrictEqual(findOutliers(odd), [{ url: "/c", value: "Comic Sans", majority: "Inter" }], "the minority page is the outlier");
  assert.deepStrictEqual(findOutliers([{ url: "/a", value: "X" }, { url: "/b", value: "Y" }]), [], "under 3 samples is never an outlier");
  const tie = [{ url: "/a", value: "X" }, { url: "/b", value: "X" }, { url: "/c", value: "Y" }, { url: "/d", value: "Y" }];
  assert.deepStrictEqual(findOutliers(tie), [], "a 50/50 tie has no majority, so no outlier");
  assert.deepStrictEqual(findOutliers([{ url: "/a", value: null }, { url: "/b", value: "X" }, { url: "/c", value: "X" }]), [], "nulls are ignored, dropping below 3 valid samples");
  console.log("selftest OK: UI uniformity flags the odd-one-out page only with a clear majority");
}

// Login error scraping (Plan-v3 Fix A): the failure finding must quote the
// page's own auth error, not a cookie banner that also matched [class*=alert].
{
  assert.strictEqual(
    pickLoginError(["We use cookies to improve your experience", "Invalid email or password"]),
    "Invalid email or password",
    "auth-looking text must win over generic banners"
  );
  assert.strictEqual(pickLoginError(["  Something   went\nwrong  "]), "Something went wrong", "whitespace must be normalized");
  assert.strictEqual(pickLoginError([]), null, "no candidates must return null");
  assert.strictEqual(pickLoginError(["ab", "x".repeat(301)]), null, "too-short/too-long candidates are dropped");
  console.log("selftest OK: login error scraper prefers the site's own auth error");
}

// Run report (Plan-v3 Fix C): failed sessions quote the login finding, the
// anonymous fallback still counts as coverage, and skipped agents carry a reason.
{
  const report = buildRunReport({
    attempted: [{ role: "Admin" }, { role: "Jobseeker" }],
    established: ["Anonymous"],
    pages: [{ role: "Anonymous" }, { role: "Anonymous" }],
    findings: [
      { agent: "login", role: "Admin", detail: 'The site rejected the sign-in and displayed: "Invalid email or password". Verify by hand.' },
      { agent: "crawler", role: "Anonymous", detail: "broken link" },
    ],
    missionAgents: ["login", "crawler", "permissions"],
    agentsRan: ["login", "crawler"],
  });
  assert.strictEqual(report.sessions.length, 3, "2 attempted roles + 1 fallback session row");
  const admin = report.sessions.find((s) => s.role === "Admin");
  assert.ok(admin && !admin.ok && admin.detail.includes("Invalid email or password"), "failed session must quote the login finding");
  const anon = report.sessions.find((s) => s.role === "Anonymous");
  assert.ok(anon?.ok && anon.detail.includes("2 page(s)"), "fallback session must count its pages");
  assert.deepStrictEqual(report.coverage, [{ role: "Anonymous", pagesTested: 2, findings: 1 }], "coverage counts pages + findings per established role");
  assert.deepStrictEqual(report.agentsSkipped, [{ name: "permissions", reason: "needs 2+ logged-in roles" }], "skipped agents must carry a reason");
  console.log("selftest OK: run report quotes login errors, counts fallback coverage, explains skips");
}

// Risk-weighted sampling (Plan-v4 P1): high-risk and new pages must win the
// limited sample, and the type-coverage guarantee must prevent a sample of N
// from being N pages of one type.
{
  const mk = (url: string, changeRank?: number): CrawledPage => ({ url, title: url, role: "U", status: 200, consoleErrors: [], failedRequests: [], screenshot: null, changeRank });
  // Risk: /admin (90) and /checkout (90) must outrank /faq (20) when the sample is small.
  const risky = rankPages([mk("https://x.com/faq"), mk("https://x.com/admin"), mk("https://x.com/checkout"), mk("https://x.com/blog")], 2);
  assert.deepStrictEqual(risky.map((p) => p.url).sort(), ["https://x.com/admin", "https://x.com/checkout"], "small sample must be the two high-risk pages");
  // Recency: a NEW low-risk page (20+40=60) must outrank an UNCHANGED med-risk page (50).
  const recency = rankPages([mk("https://x.com/settings", 2), mk("https://x.com/about", 0)], 1);
  assert.strictEqual(recency[0].url, "https://x.com/about", "a new page must beat an unchanged higher-base-risk page");
  // Type coverage: 2 list pages + 1 detail, sample 2 → must include the detail, not two lists.
  const types = new Map([["https://x.com/list1", "list"], ["https://x.com/list2", "list"], ["https://x.com/item/9", "detail"]]);
  const covered = rankPages([mk("https://x.com/list1"), mk("https://x.com/list2"), mk("https://x.com/item/9")], 2, types);
  assert.ok(covered.some((p) => types.get(p.url) === "detail"), "type-coverage guarantee must include the detail page");
  // Adaptive sampling (Plan-v5 R3): a historically-broken low-risk page (20+30=50)
  // must beat an unchanged higher-base page it would otherwise lose to.
  const hot = rankPages([mk("https://x.com/about"), mk("https://x.com/settings")], 1, undefined, new Set(["/about"]));
  assert.strictEqual(hot[0].url, "https://x.com/about", "a page with a finding history must win the sample via the hot-path bonus");
  const noHot = rankPages([mk("https://x.com/about"), mk("https://x.com/settings")], 1);
  assert.strictEqual(noHot[0].url, "https://x.com/settings", "without history, the higher-base-risk page wins (bonus is the only difference)");
  console.log("selftest OK: risk sampling prioritizes risk + recency + finding-history and guarantees page-type diversity");
}

// Coverage totals (Plan-v4 P4): honest discovered-vs-tested ratios; sibling
// URLs collapse to one template so the template ratio isn't inflated.
{
  const pages = [{ url: "https://x.com/a" }, { url: "https://x.com/item/1" }, { url: "https://x.com/item/2" }];
  const tested = new Set(["https://x.com/a", "https://x.com/item/1"]);
  const totals = computeCoverageTotals(pages, tested, { controlsSeen: 10, controlsClicked: 4, journeysDefined: 2, journeysPassed: 1 });
  assert.strictEqual(totals.pagesDiscovered, 3, "3 distinct pages discovered");
  assert.strictEqual(totals.pagesTested, 2, "2 pages tested");
  assert.strictEqual(totals.templatesDiscovered, 2, "/a and /item/:n are the two templates");
  assert.strictEqual(totals.templatesTested, 2, "both templates were sampled");
  assert.strictEqual(totals.controlsClicked, 4, "control counters pass through");
  assert.strictEqual(totals.journeysDefined, 2, "journey counters pass through");
  assert.strictEqual(totals.journeysPassed, 1, "journeys passed pass through");
  console.log("selftest OK: coverage totals report honest discovered-vs-tested ratios");
}

// Coverage matrix (Plan-v6 V4): sibling URLs collapse to one template row; a
// dimension is "tested" only if an agent mapped to that dimension touched a
// page matching the template; untested dimensions are named, not hidden.
{
  const pages = [{ url: "https://x.com/item/1" }, { url: "https://x.com/item/2" }, { url: "https://x.com/about" }];
  const tested = new Map<string, Set<string>>([
    ["https://x.com/item/1", new Set(["route-health", "a11y"])],
    ["https://x.com/about", new Set(["route-health"])],
  ]);
  const matrix = buildCoverageMatrix(pages, tested, new Map());
  const itemRow = matrix.rows.find((r) => r.template.includes("item"))!;
  const aboutRow = matrix.rows.find((r) => r.template === "https://x.com/about")!;
  assert.strictEqual(matrix.rows.length, 2, "/item/:n and /about collapse to two template rows");
  assert.strictEqual(itemRow.tested.functional, true, "item template tested for functional (route-health touched item/1)");
  assert.strictEqual(itemRow.tested.a11y, true, "item template tested for a11y");
  assert.strictEqual(itemRow.tested.security, false, "item template never touched by a security-mapped agent");
  assert.ok(itemRow.notTestedBy.includes("security"), "notTestedBy names the untested dimension");
  assert.strictEqual(aboutRow.tested.a11y, false, "about template was only route-health-touched, not a11y");
  assert.strictEqual(matrix.templatesFullyCovered, 0, "no template covers every dimension in this fixture");
  console.log("selftest OK: coverage matrix collapses templates and names exactly which dimensions weren't tested");
}

// ZAP baseline parsing (Plan-v6 V6): alerts that duplicate our own header
// checks (CSP, X-Content-Type-Options, anti-clickjacking, HSTS, Referrer-Policy)
// are dropped; genuinely new alerts survive with a mapped severity.
{
  const report = {
    site: [{
      alerts: [
        { name: "Content Security Policy (CSP) Header Not Set", riskcode: "2", desc: "no CSP", solution: "add one", instances: [{ uri: "https://x.com" }] },
        { name: "Server Leaks Version Information", riskcode: "1", desc: "X-Powered-By header present", solution: "remove it", instances: [{ uri: "https://x.com" }, { uri: "https://x.com/about" }] },
        { name: "Cross-Domain Misconfiguration", riskcode: "3", desc: "permissive CORS", solution: "restrict origins", instances: [{ uri: "https://x.com/api" }] },
      ],
    }],
  };
  const findings = parseZapAlerts(report);
  assert.strictEqual(findings.length, 2, "the CSP alert (duplicate of our own header check) is dropped, two genuine alerts survive");
  assert.ok(!findings.some((f) => f.title.includes("Content Security Policy")), "CSP duplicate must not appear");
  const cors = findings.find((f) => f.title.includes("Cross-Domain"))!;
  assert.strictEqual(cors.severity, "high", "riskcode 3 maps to high severity");
  assert.ok(cors.detail.includes("restrict origins"), "solution text is included in the detail");
  const leak = findings.find((f) => f.title.includes("Server Leaks"))!;
  assert.strictEqual(leak.severity, "low", "riskcode 1 maps to low severity");
  assert.ok(leak.detail.includes("2 instance(s)"), "multi-instance alerts note the instance count");
  console.log("selftest OK: ZAP alert parsing dedupes against our own header checks and maps severities");
}

// Root-cause correlation (Plan-v4 P7): failures sharing a signature cluster into
// one finding; a shared API endpoint needs ≥2 pages, a console error needs ≥3.
{
  const page = (url: string, failedRequests: { url: string; status: number; method: string }[] = [], consoleErrors: string[] = []) => ({ url, consoleErrors, failedRequests });
  const apiPages = [
    page("https://x.com/a", [{ url: "https://x.com/api/user/1", status: 500, method: "GET" }]),
    page("https://x.com/b", [{ url: "https://x.com/api/user/2", status: 500, method: "GET" }]),
    page("https://x.com/c", [{ url: "https://x.com/api/other", status: 404, method: "GET" }]),
  ];
  const clusters = clusterFailures(apiPages, urlTemplate);
  assert.strictEqual(clusters.length, 1, "the shared endpoint (2 pages, one template) clusters; the lone 404 does not");
  assert.strictEqual(clusters[0].kind, "api");
  assert.strictEqual(clusters[0].pages.length, 2, "cluster names both affected pages");
  const twoConsole = [page("https://x.com/a", [], ["TypeError: x is undefined"]), page("https://x.com/b", [], ["TypeError: x is undefined"])];
  assert.strictEqual(clusterFailures(twoConsole, urlTemplate).length, 0, "2 pages with the same console error is below the ≥3 threshold");
  const threeConsole = ["a", "b", "c"].map((s) => page(`https://x.com/${s}`, [], ["TypeError: cannot read foo of undefined at line 42"]));
  const conClusters = clusterFailures(threeConsole, urlTemplate);
  assert.strictEqual(conClusters.length, 1, "3 pages sharing a console error cluster");
  assert.strictEqual(conClusters[0].kind, "console");
  console.log("selftest OK: root-cause clusters shared API/console failures above threshold, not unrelated ones");
}

// Fuzz catalogue (Plan-v4 P9): every kind resolves, and the reflected-XSS
// detector fires only on a live (unescaped) payload — not on an escaped one or a
// plain echoed value.
{
  const kinds: FuzzKind[] = ["long", "unicode", "emoji", "xss", "sqli", "empty", "whitespace", "bignum", "negative", "future", "leap"];
  for (const k of kinds) assert.ok(FUZZ_CATALOGUE.some((e) => e.kind === k), `catalogue must include ${k}`);
  assert.ok(genFuzzInput("long").length > 1000, "long fuzz value must be long");
  assert.strictEqual(genFuzzInput("empty"), "", "empty fuzz value is the empty string");
  const payload = genFuzzInput("xss");
  assert.ok(looksReflectedXss(`<div>${payload}</div>`, payload), "unescaped payload in served HTML is reflected XSS");
  assert.ok(!looksReflectedXss("<div>&lt;img src=x onerror&gt;</div>", payload), "escaped payload must NOT be flagged");
  assert.ok(!looksReflectedXss("hello plainvalue world", "plainvalue"), "a non-bracket value echoed back is not XSS");
  assert.ok(expandEdgeTokens("name {edge:emoji} end").includes("🧪"), "edge tokens expand to fuzz values");
  console.log("selftest OK: fuzz catalogue is complete and reflected-XSS detector distinguishes escaped vs live");
}

// Journey engine pure parts (Plan-v4 P5.6): target normalization, digest cap +
// labels, destructive-verb guard, {tag}/{edge:} expansion, resolution order.
{
  assert.strictEqual(stripTarget("the Publish button"), "Publish", "strip 'the' prefix and 'button' suffix");
  assert.strictEqual(stripTarget("Title field"), "Title", "strip 'field' suffix");
  assert.strictEqual(stripTarget("Save"), "Save", "plain target unchanged");
  const raw = Array.from({ length: 100 }, (_, i) => ({ role: "button", name: `  b${i}  ` }));
  const digest = buildDigest(raw, 60);
  assert.strictEqual(digest.length, 60, "digest is capped at the requested size");
  assert.strictEqual(digest[0], 'button: "b0"', "labels are trimmed and quoted");
  assert.ok(isDestructiveStep("Delete the account"), "delete is destructive");
  assert.ok(isDestructiveStep("Pay the invoice"), "pay is destructive");
  assert.ok(!isDestructiveStep("Create a job posting"), "create is not destructive");
  assert.strictEqual(expandTokens("job {tag}", "qabot-12345678"), "job qabot-12345678", "{tag} expands to the run tag");
  assert.ok(expandTokens("x {edge:long}", "t").length > 1000, "{edge:} expands to a fuzz value");
  assert.deepStrictEqual([...RESOLVE_ORDER], ["role-button", "role-link", "label", "placeholder", "text-exact", "text-loose"], "resolution fallback order is stable");
  console.log("selftest OK: journey target-strip, digest cap/labels, destructive guard, token expansion, resolve order");
}

// Fault-injection classifier (Plan-v4 P8.3): a resilient app degrades to a real
// state; blank/exception/stuck-spinner/stack-trace are ungraceful.
{
  assert.ok(classifyReaction({ bodyText: "", hadPageError: false, spinnerVisible: false }).ungraceful, "blank page is ungraceful");
  assert.ok(classifyReaction({ bodyText: "x", hadPageError: true, spinnerVisible: false }).ungraceful, "an uncaught error is ungraceful");
  assert.ok(classifyReaction({ bodyText: "Loading", hadPageError: false, spinnerVisible: true }).ungraceful, "a spinner stuck with no content is ungraceful");
  assert.ok(classifyReaction({ bodyText: "TypeError: cannot read properties of undefined", hadPageError: false, spinnerVisible: false }).ungraceful, "a rendered stack trace is ungraceful");
  assert.ok(!classifyReaction({ bodyText: "You appear to be offline. Check your connection and try again.", hadPageError: false, spinnerVisible: false }).ungraceful, "a real offline message is graceful");
  console.log("selftest OK: resilience classifier flags blank/exception/spinner/stack-trace, passes a real error state");
}

// Browser chaos (Plan-v4 P10.3): spam-clicking respects the UNSAFE filter and
// the emulation-condition list is complete.
{
  assert.ok(isSafeChaosControl("Show more"), "a benign control is safe to spam");
  assert.ok(!isSafeChaosControl("Delete account"), "a destructive-labelled control must not be spammed");
  assert.ok(!isSafeChaosControl("Remove item"), "remove label must not be spammed");
  assert.deepStrictEqual([...CHAOS_CONDITIONS], ["mobile-320", "wide-1920", "dark-mode", "reduced-motion", "forced-colors"], "chaos emulation condition list is complete");
  console.log("selftest OK: chaos control selection respects the UNSAFE filter; condition list complete");
}

// SEO audit (Plan-v5 R2): a well-formed page yields no issues; missing/oversized
// tags are flagged; noindex is a bug only on production.
{
  const good: SeoSignals = { title: "A clear page title", metaDescription: "A concise description of the page under 160 chars.", canonical: "https://x.com/a", hasViewport: true, htmlLang: "en", h1Count: 1, robotsNoindex: false, ogTitle: true, ogImage: true, jsonLdCount: 1 };
  assert.deepStrictEqual(auditSeoTags(good, true), [], "a well-formed page has no SEO issues");
  const bad: SeoSignals = { title: "", metaDescription: "", canonical: "", hasViewport: false, htmlLang: "", h1Count: 0, robotsNoindex: false, ogTitle: false, ogImage: false, jsonLdCount: 0 };
  const badTitles = auditSeoTags(bad, false).map((i) => i.title);
  for (const expected of ["Missing <title>", "No responsive viewport meta", "No <h1> heading", "Missing meta description"]) {
    assert.ok(badTitles.includes(expected), `bare page must flag "${expected}"`);
  }
  const prodNoindex = auditSeoTags({ ...good, robotsNoindex: true }, true);
  assert.ok(prodNoindex.some((i) => i.kind === "bug" && /noindex/.test(i.title)), "noindex on production is a bug");
  assert.deepStrictEqual(auditSeoTags({ ...good, robotsNoindex: true }, false), [], "noindex off-production is fine (staging expects it)");
  console.log("selftest OK: SEO audit passes a good page, flags a bare page, treats production noindex as a bug");
}

// Requirement parsing (Plan-v5 R1): one criterion per line, bullets/numbering
// stripped, blanks + dupes dropped, capped.
{
  const parsed = parseRequirements("- Users can reset their password\n1. Prices show two decimals\n\n  • Users can reset their password\nx");
  assert.deepStrictEqual(parsed, ["Users can reset their password", "Prices show two decimals"], "bullets/numbering stripped, dupes + too-short lines dropped");
  assert.strictEqual(parseRequirements("").length, 0, "empty requirements is an empty list");
  const many = parseRequirements(Array.from({ length: 40 }, (_, i) => `Requirement number ${i}`).join("\n"));
  assert.ok(many.length <= 20, "requirement list is capped so a pasted PRD can't blow the budget");
  console.log("selftest OK: requirement parsing strips bullets/numbering, dedupes, and caps the list");
}

// API response validation (Plan-v5 R4): a 200-but-all-null body and shape drift
// across one template are flagged; a healthy consistent endpoint is not.
{
  const s = (template: string, body: unknown, status = 200): ApiSample => ({ method: "GET", url: template, template, status, body });
  assert.deepStrictEqual(analyzeApiResponses([s("/api/user/:n", { id: 1, name: "A" }), s("/api/user/:n", { id: 2, name: "B" })]), [], "consistent non-null responses = no issue");
  const nullIssues = analyzeApiResponses([s("/api/profile", { name: null, email: null })]);
  assert.ok(nullIssues.some((i) => /all-empty/.test(i.title)), "a 200 with every field null is flagged");
  const driftIssues = analyzeApiResponses([s("/api/x", { a: 1, b: 2 }), s("/api/x", { a: 1, c: 3 })]);
  assert.ok(driftIssues.some((i) => /shape is inconsistent/.test(i.title)), "differing top-level shapes on one template are flagged");
  assert.deepStrictEqual(analyzeApiResponses([s("/api/list", [], 200)]), [], "an empty array is a valid 'no results', not an issue");
  assert.deepStrictEqual(analyzeApiResponses([s("/api/e", { name: null }, 500)]), [], "non-2xx responses are out of scope here (route-health owns them)");
  console.log("selftest OK: API validation flags empty-200 + shape drift, ignores empty arrays and non-2xx");
}

// Memory-leak classifier (Plan-v5 R18): sustained heap/node growth is a leak;
// a plateau (settled after warm-up) is not.
{
  const r = (heap: number, nodes: number) => ({ heap, nodes });
  const leak = classifyLeak([r(10e6, 500), r(11e6, 520), r(16e6, 800), r(22e6, 1100)]);
  assert.ok(leak.leaking, "monotonic heap+node growth past the factor is a leak");
  const stable = classifyLeak([r(10e6, 500), r(12e6, 540), r(12.5e6, 545), r(12e6, 542)]);
  assert.ok(!stable.leaking, "a settled plateau is not a leak");
  assert.ok(!classifyLeak([r(10e6, 500), r(20e6, 900)]).leaking, "too few samples never reports a leak");
  console.log("selftest OK: memory-leak classifier flags sustained growth, passes a settled plateau");
}

// Analytics detection (Plan-v5 R7): provider host matching + the "revenue site
// with zero analytics" heuristic (and content sites don't get flagged).
{
  assert.strictEqual(analyticsProvider("https://www.google-analytics.com/g/collect?v=2"), "Google Analytics / GTM", "GA collect endpoint matches");
  assert.strictEqual(analyticsProvider("https://connect.facebook.net/en_US/fbevents.js"), "Meta Pixel", "Meta Pixel matches");
  assert.strictEqual(analyticsProvider("https://example.com/app.js"), null, "a normal asset is not analytics");
  assert.deepStrictEqual(assessAnalytics(["Google Analytics / GTM"], "ecommerce"), [], "a site with analytics is not flagged");
  assert.ok(assessAnalytics([], "ecommerce").length > 0, "an ecommerce site with no analytics is flagged");
  assert.deepStrictEqual(assessAnalytics([], "content"), [], "a content site legitimately has no analytics");
  console.log("selftest OK: analytics provider matching + zero-analytics-on-revenue-site heuristic");
}

// Route↔file matching (Plan-v6 V7): repo files map to the URL routes they
// serve via Next.js conventions; templated URL paths match dynamic segments;
// the grep fallback catches non-conventional layouts.
{
  assert.strictEqual(fileToRoute("app/api/user/[id]/route.ts"), "/api/user/[id]", "app-router API route file maps to its path");
  assert.strictEqual(fileToRoute("src/app/(marketing)/about/page.tsx"), "/about", "route groups are dropped, src/ prefix stripped");
  assert.strictEqual(fileToRoute("app/page.tsx"), "/", "root page maps to /");
  assert.strictEqual(fileToRoute("pages/item/[id].tsx"), "/item/[id]", "pages-router dynamic file maps to its path");
  assert.strictEqual(fileToRoute("pages/blog/index.tsx"), "/blog", "index collapses to the directory route");
  assert.strictEqual(fileToRoute("pages/_app.tsx"), null, "_app is not a route");
  assert.strictEqual(fileToRoute("src/components/Button.tsx"), null, "a component is not a route file");

  assert.ok(routesMatch("/api/user/[id]", "/api/user/:n"), "dynamic segment serves a templated position");
  assert.ok(routesMatch("/item/[id]", "/item/5"), "dynamic segment serves a concrete value");
  assert.ok(routesMatch("/[locale]/admin", "/en/admin"), "leading dynamic segment (locale) matches a literal");
  assert.ok(routesMatch("/docs/[...slug]", "/docs/a/b/c"), "catch-all absorbs the rest of the path");
  assert.ok(!routesMatch("/[...slug]", "/"), "a required catch-all does not serve the bare root");
  assert.ok(routesMatch("/[[...slug]]", "/"), "an optional catch-all does serve the bare root");
  assert.ok(!routesMatch("/item/[id]", "/order/:n"), "different literal sections never match");
  assert.ok(!routesMatch("/item/detail", "/item/:n"), "a literal file segment cannot serve a templated position");
  assert.ok(!routesMatch("/item", "/item/5"), "shorter file route does not swallow deeper paths");

  const files = ["src/app/api/user/[id]/route.ts", "src/app/items/page.tsx", "src/components/Button.tsx", "src/lib/pricing.ts"];
  assert.deepStrictEqual(matchRouteToFiles("/api/user/:n", files), ["src/app/api/user/[id]/route.ts"], "conventional match wins");
  assert.deepStrictEqual(matchRouteToFiles("/pricing", files), ["src/lib/pricing.ts"], "grep fallback finds the path-segment name");
  assert.deepStrictEqual(matchRouteToFiles("/nowhere", files), [], "no match returns empty, never a guess");
  console.log("selftest OK: route↔file matcher handles app/pages conventions, dynamic segments, and the grep fallback");
}

// Git-diff → route mapping (Plan-v6 V8): changed route files map to the known
// pathnames they serve; changed components map by basename-as-segment; files
// matching nothing are dropped (a global boost would boost nothing).
{
  const changed = ["src/app/item/[id]/page.tsx", "src/components/Cart.tsx", "README.md"];
  const known = ["/item/5", "/cart", "/about"];
  const mapped = mapChangedFilesToPaths(changed, known);
  assert.deepStrictEqual(mapped.get("/item/5"), ["src/app/item/[id]/page.tsx"], "changed route file maps to its live pathname");
  assert.deepStrictEqual(mapped.get("/cart"), ["src/components/Cart.tsx"], "changed component maps via basename-as-segment");
  assert.ok(!mapped.has("/about"), "unrelated pathname gets no boost");
  assert.strictEqual(mapNothing(), 0, "a docs-only diff boosts nothing");
  function mapNothing(): number { return mapChangedFilesToPaths(["README.md", "docs/x.md"], known).size; }
  console.log("selftest OK: git-diff file mapping boosts exactly the routes the changed files serve");
}

// Bench scorer (Plan-v6 V9): a defect is detected only by a finding on the
// right page, from the right dimension's agents, with the keyword; unmatched
// findings count as unseeded; repeated (title,page) pairs count as duplicates.
{
  const defects: SeededDefect[] = [
    { id: "d1", app: "x", path: "/items", dimension: "a11y", keyword: "alt", severity: "medium" },
    { id: "d2", app: "x", path: "/admin", dimension: "permissions", keyword: "", severity: "critical" },
    { id: "d3", app: "x", path: "/slow", dimension: "perf", keyword: "slow", severity: "medium" },
  ];
  const f = (agent: string, title: string, pageUrl: string): BenchFinding => ({ agent, severity: "medium", title, detail: "", pageUrl });
  const findings = [
    f("a11y", "Images missing alt text", "http://x/items"),
    f("permissions", "User role can open admin-only page", "http://x/admin"),
    f("seo", "Missing meta description", "http://x/"),
    f("a11y", "Images missing alt text", "http://x/items"), // duplicate
  ];
  const s = scoreBench(defects, findings);
  assert.deepStrictEqual(s.detected.map((d) => d.id), ["d1", "d2"], "the a11y and permissions defects are detected");
  assert.deepStrictEqual(s.missed.map((d) => d.id), ["d3"], "the perf defect (no perf finding) is missed");
  assert.strictEqual(s.criticalRecall, 1, "the one critical seeded defect was caught");
  assert.strictEqual(s.unseededFindings, 1, "the SEO finding matches no seeded defect");
  assert.ok(s.duplicateRate > 0, "the repeated (title,page) finding counts as a duplicate");
  const wrongAgent = scoreBench([defects[0]], [f("seo", "alt text mentioned here", "http://x/items")]);
  assert.strictEqual(wrongAgent.detected.length, 0, "a keyword hit from the wrong dimension's agent does not count");
  console.log("selftest OK: bench scorer credits the right agent+page+keyword and reports unseeded/duplicate rates");
}
