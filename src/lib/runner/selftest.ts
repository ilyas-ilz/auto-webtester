import assert from "node:assert";
import { isRunAbandoned } from "../db";
import { absorbRootCauseMembers, buildReportMarkdown } from "./report-doc";
import { UNSAFE, urlTemplate } from "./agents/crawler";
import { shouldAdoptRoute, isJsError, clickDidNothing, searchVerdict, type SearchProbeSample } from "./agents/interaction";
import { tidyWhy } from "./agents/a11y";
import { inferPageType } from "./agents/expectations";
import { plainImpact } from "../plain";
import { encrypt, decrypt, fingerprint } from "../crypto";
import { riskScore } from "./graph";
import { diffByFingerprint } from "./agents/regression";
import { withRecovery, classifyObservation, isTrustworthy, observe, type ObservationQuality } from "./recovery";
import { decideRunStatus } from "./verdict";
import { deriveAgentView } from "../report-view";
import { RunCancelledError, modifierMask, keyInfo, isNavigable, grabControl, releaseControl, humanHasControl, claimLiveOwner, setLiveSession, liveOwnerKey } from "./control";
import { controlAllowed } from "../originGuard";
import { learnLifecycle, lifecycleViolations, type Transition } from "./lifecycle";
import { FactStore, type Fact } from "./facts";
import { shouldProbe, resolveStrategy, factFromProbe, learnFromProbe, classifyControl, planProbes, runProbePlan, type ProbeOutcome, type ProbeTarget, type ProbeIO, type ProbePlanItem } from "./probe";
import { freezeContract, checkContract, type Observation } from "./contracts";
import { profilesForMode, PRIMARY_PROFILE } from "./devices";
import { reorderByChangeStatus } from "./graph";
import { classifyCurrencyFormat, classifyDateFormat } from "./agents/dataIntegrity";
import { diffBaseline, baselineKey } from "./agents/visual";
import { AI_BUDGET_BY_MODE } from "./planner";
import { genTestEmail, extractOtp, extractVerifyLink } from "./agents/register";
import { crudTag, isWriteMethod, isReplayableWrite, classifyWriteIdor } from "./agents/crud";
import { findOutliers, tooSmallTaps, overlapRatio, OVERLAP_THRESHOLD } from "./agents/uiAudit";
import { pickLoginError, parseCredentialAnswer } from "./agents/login";
import { orderForReplay, relationshipOf, classifyRelAuthz, replayIsolation } from "./agents/permissions";
import { parseZapAlerts } from "./agents/security";
import { buildRunReport, computeCoverageTotals, buildCoverageMatrix } from "./orchestrate";
import { rankPages } from "./graph";
import { clusterFailures } from "./agents/rootCause";
import { FUZZ_CATALOGUE, genFuzzInput, looksReflectedXss, expandEdgeTokens, type FuzzKind } from "./fuzz";
import { stripTarget, buildDigest, isDestructiveStep, expandTokens, matchGoal, RESOLVE_ORDER } from "./agents/journey";
import { classifyReaction } from "./agents/resilience";
import { isSafeChaosControl, CHAOS_CONDITIONS } from "./agents/chaos";
import { auditSeoTags, type SeoSignals } from "./agents/seo";
import { parseRequirements } from "./agents/requirements";
import { analyzeApiResponses } from "./agents/apiValidation";
import { assessAnalytics } from "./agents/analytics";
import { analyticsProvider } from "./agents/crawler";
import { classifyLeak } from "./agents/memory";
import { fileToRoute, routesMatch, matchRouteToFiles, mapChangedFilesToPaths } from "./repo";
import { scoreBench, formatArr, type SeededDefect, type BenchFinding } from "./benchScore";
import { accountArr, statusTransition, transitionKey } from "./agents/learning";
import { implicitRole, chooseName, computeRef, isInteresting, enrich, normName, canonicalStateKey, interactiveShape, isStateCollision, type SemanticNode, type SemanticSnapshot } from "./snapshot";
import { RunContext, type CrawledPage, type ApiSample } from "./context";
import { generalizeSubject, mergeExperience, contradictRows, computeGlobalPromotions, recallFacts, summarizeForPrompt, recallRecoveryStrategy, type ExperienceInput } from "./experience";
import type { ExperienceRow } from "../db";
import { normalizeForFingerprint, partitionByFeedback, type FeedbackEntry } from "./feedback";
import { OWASP_CATEGORIES, CWE_TO_OWASP, owaspForCwe, buildOwaspCoverage, parseNpmAudit } from "./owasp";
import { isSafeProbeUsername } from "./agents/login";
import { parseAiRoute, resolveRoutedModel, validateToolOutput } from "./ai";
import { classifyVerifyResult, crossModelVerify } from "./agents/aiReviewer";
import { judgeShotFractions, pickJudgeTargets } from "./agents/pageJudge";
import type { Finding, Run, RunReport } from "../types";
import { targetOriginAllowed } from "../originGuard";

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

// A click is only "broken" when it threw JS. Browser-logged network failures (the 401
// analytics beacon that made us file `Clicking "ഹോം" throws a JS error`) are not that.
{
  assert.ok(isJsError("TypeError: Cannot read properties of undefined (reading 'id')"), "a thrown exception is a JS error");
  assert.ok(isJsError("Uncaught (in promise) Error: boom"), "an unhandled rejection is a JS error");
  assert.ok(!isJsError("Failed to load resource: the server responded with a status of 401 ()"), "a failed request is not a JS error");
  assert.ok(!isJsError("net::ERR_CONNECTION_REFUSED"), "a network stack error is not a JS error");
  assert.ok(!isJsError("Access to fetch at 'https://a.b' from origin 'https://c.d' has been blocked by CORS policy"), "a CORS block is not a JS error");
  assert.ok(!isJsError("Refused to connect to 'https://x' because it violates the Content Security Policy directive"), "a CSP refusal is not a JS error");
  console.log("selftest OK: click-error classifier separates thrown JS from browser-logged network failures");
}

// a11y findings must name the offending elements, and the axe boilerplate must go.
{
  assert.strictEqual(tidyWhy("Fix any of the following:\n  Element has insufficient color contrast of 2.5 (foreground #fff, background #eee)"),
    "Element has insufficient color contrast of 2.5 (foreground #fff, background #eee)", "the ceremony line is dropped, the measurement kept");
  assert.strictEqual(tidyWhy("Fix all of the following:\n  aria-label attribute is empty\n  Element has no title attribute"),
    "aria-label attribute is empty; Element has no title attribute", "multiple causes join on one line");
  assert.ok(tidyWhy("x".repeat(500)).length <= 240, "a runaway summary is capped");
  console.log("selftest OK: a11y failure summaries keep the measurement and drop the boilerplate");
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

// Search probe: reacting is not searching. A matching term and a nonsense term
// must produce different results before the box counts as working.
{
  const s = (over: Partial<SearchProbeSample> = {}): SearchProbeSample => ({ url: "https://x/list", itemCount: 20, textLen: 1000, sawQueryRequest: false, ...over });
  assert.strictEqual(searchVerdict(s(), s(), s()), "dead", "no change from either query is a dead box");
  assert.strictEqual(searchVerdict(s(), s({ sawQueryRequest: true }), s({ sawQueryRequest: true })), "ignores-query",
    "firing a request but returning identical rows for a real and a nonsense term is not searching");
  assert.strictEqual(searchVerdict(s(), s({ itemCount: 6, textLen: 300 }), s({ itemCount: 0, textLen: 40 })), "works",
    "different result sizes for the two terms means the query is filtering");
  assert.strictEqual(searchVerdict(s({ itemCount: 0, textLen: 200 }), s({ itemCount: 0, textLen: 200, sawQueryRequest: true }), s({ itemCount: 0, textLen: 200, sawQueryRequest: true })), "inconclusive",
    "nothing countable on the page means no verdict, not a finding");
  console.log("selftest OK: search probe separates dead boxes, query-ignoring boxes, and real filtering");
}

// Plain-language layer: findings must read as consequences, not as evidence.
{
  const p = (agent: string, title: string, detail = ""): string => plainImpact({ agent, title, detail });
  assert.match(p("route-health", "Server error 504 on /en/admin/users", "Route returned HTTP 504."), /page is down/i, "a 5xx reads as 'the page is down'");
  assert.match(p("perf", "Very slow page load (16.1s)", "loadEventEnd at 16073ms."), /9 seconds|give up/i, "a slow load reads as users leaving");
  assert.match(p("a11y", "a11y: Buttons must have discernible text (button-name)", "7 element(s) affected."), /blind|screen reader/i, "button-name reads as unusable for blind users");
  assert.match(p("interaction", 'Search/filter box "x" ignores the query', ""), /does not actually search/i, "a query-ignoring box reads as a broken search");
  assert.strictEqual(p("orchestrator", "Run finished", "12 pages"), "", "no pattern match yields no plain line, not a wrong one");
  console.log("selftest OK: plain-language layer turns finding evidence into user-facing consequences");
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
  const noop = { runId: "selftest", log: () => {}, agentsRan: new Set<string>(), agentsFailed: new Map<string, string>(), findingCounts: new Map<string, number>(), checkCancelled: () => {}, skipCompleted: () => false };
  let calls = 0;
  const recovered = await withRecovery(noop, "t", async () => { calls++; if (calls < 2) throw new Error("flake"); return "done"; });
  assert.strictEqual(recovered, "done", "recovery must return the value produced on retry");
  assert.strictEqual(calls, 2, "recovery must retry exactly once");
  const gaveUp = await withRecovery(noop, "t", async () => { throw new Error("always fails"); });
  assert.strictEqual(gaveUp, null, "recovery must return null once retries are exhausted, not throw");
  assert.ok(noop.agentsFailed.has("t"), "an exhausted agent must be recorded in agentsFailed (P0-2), not forgotten");
  assert.ok((noop.agentsFailed.get("t") ?? "").includes("always fails"), "the failure reason must be preserved");
  console.log("selftest OK: recovery retries once then reports-and-continues");

  // Stop button: a cancel unwinds the run instead of being retried like a flake.
  let cancelCalls = 0;
  const cancelling = { ...noop, checkCancelled: () => {} };
  await assert.rejects(
    withRecovery(cancelling, "t", async () => { cancelCalls++; throw new RunCancelledError(); }),
    (e: unknown) => e instanceof RunCancelledError,
    "cancel must propagate out of withRecovery",
  );
  assert.strictEqual(cancelCalls, 1, "cancel must not be retried");
  const gate = { ...noop, checkCancelled: () => { throw new RunCancelledError(); } };
  await assert.rejects(withRecovery(gate, "t", async () => "never runs"), (e: unknown) => e instanceof RunCancelledError, "cancel gate must stop the next agent from starting");
  console.log("selftest OK: stop request unwinds the run and is never retried");

  // Interactive live view: the human hand-off gate. withRecovery must hold the
  // next agent while a human drives, and let go the moment they release.
  grabControl("selftest");
  assert.ok(humanHasControl("selftest"), "a hold must give the human the wheel");
  let ran = false;
  const held = withRecovery(noop, "t", async () => { ran = true; return "ok"; });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!ran, "no agent may start while a human holds the wheel");
  releaseControl("selftest");
  assert.strictEqual(await held, "ok", "the agent must run once the human releases");
  assert.ok(!humanHasControl("selftest"), "release must drop the lease");
  console.log("selftest OK: human control gate holds agents, then hands back");
})();

// Verdict policy (WEBTESTER-AUDIT P0-2 + P1-12): what may fail a run, and when a
// PASS is honest.
{
  const bug = (severity: "critical" | "high" | "medium", fingerprint: string) => ({ severity, kind: "bug" as const, fingerprint });
  const none = new Set<string>();
  assert.strictEqual(decideRunStatus([bug("critical", "a")], none, none, 0).status, "failed", "an unsuppressed critical bug fails the run");
  assert.strictEqual(decideRunStatus([bug("medium", "a")], none, none, 0).status, "passed", "medium findings are advisory, not failures");
  assert.strictEqual(decideRunStatus([bug("critical", "a")], new Set(["a"]), none, 0).status, "passed", "a human-suppressed false positive must not keep failing every run (P1-12)");
  assert.strictEqual(decideRunStatus([bug("high", "a")], none, new Set(["a"]), 0).status, "passed", "a cross-model-refuted finding must not affect status (P1-12)");
  assert.strictEqual(decideRunStatus([{ severity: "high", kind: "improvement", fingerprint: "a" }], none, none, 0).status, "passed", "a high-severity improvement is not a product failure (P1-12)");
  assert.strictEqual(decideRunStatus([], none, none, 2).status, "inconclusive", "failed agents make the verdict inconclusive, never a silent PASS (P0-2)");
  assert.strictEqual(decideRunStatus([bug("critical", "a")], none, none, 2).status, "failed", "a real critical bug outranks infrastructure failure — FAIL wins over inconclusive");
  assert.strictEqual(decideRunStatus([bug("critical", "a")], new Set(["a"]), none, 1).status, "inconclusive", "suppressed finding + failed agent = inconclusive, not passed");
  console.log("selftest OK: verdict policy — suppression/refutation respected, failed agents block silent PASS");
}

// Journey goal oracle (WEBTESTER-AUDIT P0-3): Unicode-aware, no silent auto-pass.
{
  assert.strictEqual(matchGoal("Your order was placed successfully", "order placed"), "confirmed", "goal words on the page confirm");
  assert.strictEqual(matchGoal("Page not found", "order placed successfully"), "absent", "missing goal words are absent, not a pass");
  assert.strictEqual(matchGoal("تم إنشاء الطلب بنجاح", "إنشاء الطلب"), "confirmed", "Arabic goals are actually checked (old [a-z]{4,} auto-passed them)");
  assert.strictEqual(matchGoal("something else entirely", "تأكيد الحجز"), "absent", "Arabic goal absent from an English page must NOT auto-pass");
  assert.strictEqual(matchGoal("whatever", "OK #1!"), "unverifiable", "a goal with no matchable words is unverifiable — never silently confirmed");
  console.log("selftest OK: journey goal oracle — locale-aware matching, no auto-pass on unmatchable goals");
}

// AI tool-output runtime validation (WEBTESTER-AUDIT P1-10): a cast is not a check.
{
  const schema = { type: "object", required: ["severity", "items"], properties: { severity: { type: "string" }, items: { type: "array" }, note: { type: "string" } } };
  assert.ok(validateToolOutput({ severity: "high", items: [] }, schema), "a conforming payload validates");
  assert.ok(!validateToolOutput({ severity: "high" }, schema), "a missing required key fails validation");
  assert.ok(!validateToolOutput({ severity: 5, items: [] }, schema), "a wrong-typed required key fails validation");
  assert.ok(!validateToolOutput(null, schema), "null is not a tool payload");
  assert.ok(!validateToolOutput([1, 2], schema), "an array is not a tool payload object");
  assert.ok(validateToolOutput({ severity: "high", items: [], extra: true }, schema), "unknown extra keys are tolerated");
  console.log("selftest OK: AI tool outputs are runtime-validated against their own schema");
}

// Shared report view (WEBTESTER-AUDIT P1-17): dashboard and Markdown derive
// ran/skipped from ONE function — the stale senior-review case can't recur.
{
  const report = { agentsRan: ["crawler"], agentsSkipped: [{ name: "senior-review", reason: "AI off" }, { name: "visual", reason: "quick mode" }] };
  const view = deriveAgentView(report, ["senior-review"]);
  assert.ok(!view.skipped.some((s) => s.name === "senior-review"), "an agent with findings is never shown as skipped, whatever the stored JSON says");
  assert.ok(view.ran.includes("senior-review"), "an agent with findings appears in the ran list");
  assert.ok(view.skipped.some((s) => s.name === "visual"), "a genuinely skipped agent stays skipped");
  const viaEvents = deriveAgentView(report, [], ["perf"]);
  assert.ok(viaEvents.ran.includes("perf"), "an agent seen in agent events counts as ran");
  console.log("selftest OK: shared report view — findings/events evidence beats stale stored skip lists");
}

// Visual baseline identity (WEBTESTER-AUDIT P1-7): role and viewport are part of
// what a screenshot IS — two roles must not overwrite one baseline.
{
  const vp = { width: 1280, height: 800 };
  assert.notStrictEqual(baselineKey("Admin", "", vp, "/dashboard"), baselineKey("Viewer", "", vp, "/dashboard"), "different roles get different baselines");
  assert.notStrictEqual(baselineKey("Admin", "", vp, "/dashboard"), baselineKey("Admin", "", { width: 390, height: 844 }, "/dashboard"), "different viewports get different baselines");
  assert.notStrictEqual(baselineKey("Admin", "mobile", vp, "/x"), baselineKey("Admin", "desktop", vp, "/x"), "different profiles get different baselines");
  assert.strictEqual(baselineKey("Admin", "", vp, "/dashboard"), baselineKey("Admin", "", vp, "/dashboard"), "the same identity is stable across runs");
  console.log("selftest OK: visual baselines keyed by role+profile+viewport+route, so roles cannot collide");
}

// Responsive/layout checks added for the seeded UI bench app (bench/apps/ui.ts).
{
  const taps = [
    { sel: "a#ok", w: 44, h: 44 },
    { sel: "span.tiny", w: 16, h: 16 },
    { sel: "button#thin", w: 80, h: 18 },
    { sel: "i.decorative", w: 2, h: 2 },
  ];
  const small = tooSmallTaps(taps).map((t) => t.sel);
  assert.deepStrictEqual(small, ["span.tiny", "button#thin"], "under-sized targets flagged; a 44px target passes and a 2px decorative element is ignored");

  const a = { x: 0, y: 0, w: 100, h: 100 };
  assert.strictEqual(overlapRatio(a, { x: 200, y: 200, w: 100, h: 100 }), 0, "disjoint rects do not overlap");
  assert.strictEqual(overlapRatio(a, { x: 0, y: 0, w: 100, h: 100 }), 1, "identical rects overlap fully");
  assert.strictEqual(overlapRatio(a, { x: 50, y: 50, w: 100, h: 100 }), 0.25, "a half-offset square covers exactly a quarter — the threshold itself is not a hit");
  assert.ok(overlapRatio(a, { x: 40, y: 40, w: 100, h: 100 }) > OVERLAP_THRESHOLD, "a 36% collision is over the threshold");
  assert.ok(overlapRatio(a, { x: 98, y: 0, w: 100, h: 100 }) < OVERLAP_THRESHOLD, "a 2px touching edge is not an overlap");
  console.log("selftest OK: responsive checks — tap-target sizing and element-overlap ratio");
}

// Resume safety (WEBTESTER-AUDIT A-3): positional step matching is only sound while
// each agent name is unique — "login" is registered three times, so an ambiguous name
// must stop the skipping rather than risk skipping the wrong slot.
{
  const ctx = new RunContext("selftest-resume", "p1");
  ctx.resumeSteps = ["crawler", "a11y", "seo"];
  assert.strictEqual(ctx.skipCompleted("crawler"), false, "the crawl always re-runs — it lives only in the browser");
  assert.strictEqual(ctx.skipCompleted("a11y"), true, "a unique, already-completed agent is skipped on resume");
  assert.strictEqual(ctx.skipCompleted("perf"), false, "a divergent plan stops skipping");

  const dup = new RunContext("selftest-resume-dup", "p1");
  dup.resumeSteps = ["login", "a11y", "login"];
  assert.strictEqual(dup.skipCompleted("login"), false, "a repeated agent name must never be skipped positionally (A-3)");
  assert.strictEqual(dup.skipCompleted("a11y"), false, "after an ambiguous name, skipping stops entirely — re-running is safe, skipping the wrong step is not");
  console.log("selftest OK: resume skips only unambiguous completed steps, never a repeated agent name");
}

// Live-view ownership (WEBTESTER-AUDIT P1-4): sticky owner, not "last frame wins".
{
  const runId = "selftest-live";
  const fakeCdp = {} as unknown as Parameters<typeof setLiveSession>[2];
  assert.ok(claimLiveOwner(runId, "pageA"), "with no owner, any page may claim");
  setLiveSession(runId, "pageA", fakeCdp, 1280, 800);
  assert.strictEqual(liveOwnerKey(runId), "pageA", "the first claimant owns the stream");
  assert.ok(!claimLiveOwner(runId, "pageB"), "a second page cannot steal a live owner mid-stream (no flicker)");
  assert.ok(claimLiveOwner(runId, "pageA"), "the owner keeps renewing its own claim");
  assert.ok(claimLiveOwner(runId, "pageB", Date.now() + 10_000), "once the owner goes quiet, handover is allowed");
  grabControl(runId);
  assert.ok(!claimLiveOwner(runId, "pageB", Date.now() + 10_000), "a tab a human is driving is never stolen, even if quiet");
  releaseControl(runId);
  console.log("selftest OK: live-view ownership is explicit and sticky, and human-held tabs are never stolen");
}

// Resume (retry of an interrupted run): completed steps replay in lockstep and
// skipping stops for good at the first divergence; sign-in and crawl always re-run.
{
  const ctx = new RunContext("selftest-resume", "selftest");
  ctx.resumeSteps = ["crawler", "a11y", "perf"];
  assert.ok(!ctx.skipCompleted("crawler"), "the crawl must re-run — it lives only in the browser");
  assert.ok(ctx.skipCompleted("a11y"), "a step the interrupted run completed must be skipped");
  assert.ok(!ctx.skipCompleted("seo"), "a different agent at this position means the plan diverged");
  assert.ok(!ctx.skipCompleted("perf"), "after a divergence nothing else may be skipped");
  console.log("selftest OK: resume skips completed steps until the plan diverges");
}

// Live-view input translation (pure): CDP modifier bitmask, key mapping, and the
// navigation allow-list that keeps file:/chrome: out of the automation browser.
assert.strictEqual(modifierMask({}), 0, "no modifiers is an empty mask");
assert.strictEqual(modifierMask({ ctrl: true }), 2, "ctrl is bit 2");
assert.strictEqual(modifierMask({ alt: true, ctrl: true, meta: true, shift: true }), 15, "all four modifiers set every bit");
assert.deepStrictEqual(keyInfo("Enter"), { key: "Enter", code: "Enter", vk: 13 }, "named keys come from the table");
assert.deepStrictEqual(keyInfo("a"), { key: "a", code: "KeyA", vk: 65 }, "a letter maps to its uppercase virtual key code, so ctrl+a works");
assert.deepStrictEqual(keyInfo("7"), { key: "7", code: "Digit7", vk: 55 }, "a digit maps to Digit<n>");
assert.strictEqual(keyInfo("F13"), null, "an unmapped key is rejected, not guessed");
assert.ok(isNavigable("https://example.com") && isNavigable("back") && isNavigable("reload"), "http(s) urls and history moves are navigable");
assert.ok(!isNavigable("file:///etc/passwd") && !isNavigable("javascript:alert(1)"), "non-web schemes must never reach Page.navigate");
console.log("selftest OK: live-view input translation (modifiers, keys, nav allow-list)");

// Who may drive the live browser. This endpoint is remote control of sessions
// logged in as every role, and the app has no login of its own.
{
  const same = { origin: "http://localhost:3000", host: "localhost:3000", token: null };
  assert.ok(controlAllowed(same, undefined), "the app's own UI may drive the browser");
  assert.ok(controlAllowed({ ...same, origin: null }, undefined), "a request with no Origin on loopback is same-origin");
  assert.ok(!controlAllowed({ origin: null, host: "10.0.0.5:3400", token: null }, undefined), "off-box, a missing Origin is not a free pass");
  assert.ok(controlAllowed({ origin: null, host: "10.0.0.5:3400", token: "s3cret" }, "s3cret"), "off-box without an Origin, the token is what vouches");
  assert.ok(!controlAllowed({ ...same, origin: "https://evil.example" }, undefined), "another site must never drive the test browser");
  assert.ok(!controlAllowed({ ...same, origin: "not a url" }, undefined), "an unparseable Origin is rejected, not ignored");
  assert.ok(!controlAllowed(same, "s3cret"), "a configured token is required once set");
  assert.ok(controlAllowed({ ...same, token: "s3cret" }, "s3cret"), "the right token passes");
  assert.ok(!controlAllowed({ ...same, origin: "https://evil.example", token: "s3cret" }, "s3cret"), "a stolen token still can't come from another origin");
  // DNS rebinding: the attacker's page satisfies Origin===Host (both are its own
  // hostname) while the request lands here, so agreement alone can't be the test.
  const rebound = { origin: "http://attacker.example:3400", host: "attacker.example:3400", token: null };
  assert.ok(!controlAllowed(rebound, undefined), "a rebound host whose Origin matches it is still not us");
  assert.ok(controlAllowed(rebound, undefined, "attacker.example:3400"), "an explicitly configured host is admitted");
  assert.ok(controlAllowed({ ...rebound, token: "s3cret" }, "s3cret"), "a configured token vouches for a hosted setup without listing its host");
  assert.ok(!controlAllowed({ origin: null, host: "attacker.example:3400", token: null }, undefined), "rebinding plus a missing Origin is still rejected");
  console.log("selftest OK: live-view control guard (host pinning + same-origin + optional token)");
}

// "Control does nothing" is an inference, not an observation, so it must survive
// every cheap counter-signal first. A false accusation here teaches readers to
// distrust the report — the mployedin run flagged a language switcher this way.
{
  const quiet = { nodeDelta: 0, textChanged: false, requestsFired: 0, urlChanged: false };
  assert.ok(clickDidNothing(quiet), "nothing moved at all — the control really does look dead");
  assert.ok(!clickDidNothing({ ...quiet, textChanged: true }), "a content swap with an identical node count (language toggle, tab, sort) is the control WORKING");
  assert.ok(!clickDidNothing({ ...quiet, requestsFired: 1 }), "a click that fired a request did something, even if the DOM never re-rendered");
  assert.ok(!clickDidNothing({ ...quiet, nodeDelta: 5 }), "a re-render is a reaction");
  assert.ok(!clickDidNothing({ ...quiet, urlChanged: true }), "navigation is a reaction");
  console.log("selftest OK: a dead-control claim must survive DOM, text, network and navigation counter-signals");
}

// Root-cause member absorption (P7 completion). The report used to list the
// symptoms AND the cause that explains them, so one bug was counted many times.
// The risk of the fix is the opposite failure — absorbing something unrelated
// HIDES a real bug — so the guards matter more than the collapsing.
{
  const mk = (over: Partial<Finding>): Finding => ({
    id: 0, runId: "r", agent: "route-health", severity: "medium", kind: "bug", source: "deterministic",
    confidence: 1, title: "t", detail: "d", pageUrl: "https://x/en/jobs", role: null, evidence: null,
    fingerprint: `fp${Math.round(over.confidence ?? 0)}`, fingerprintV: 1, afterHuman: false, ...over,
  });
  const cluster = { kind: "api" as const, signature: "GET /api/jobs/:n", pages: ["https://x/en/jobs", "https://x/en/home"], detail: "" };
  const symptom = mk({ title: "1 failed request on /en/jobs", detail: "GET /api/jobs/42 → 500" });
  const otherPage = mk({ title: "1 failed request", detail: "GET /api/jobs/7 → 500", pageUrl: "https://x/en/other" });
  const unrelatedAgent = mk({ agent: "a11y", title: "Buttons must have discernible text", detail: "on /api/jobs page" });
  const unrelatedText = mk({ title: "1 console error", detail: "TypeError: undefined is not a function" });
  const out = absorbRootCauseMembers([symptom, otherPage, unrelatedAgent, unrelatedText], [cluster]);
  assert.deepStrictEqual(out.membersBySignature.get("GET /api/jobs/:n")?.map((f) => f.title), ["1 failed request on /en/jobs"], "only the matching symptom on a cluster page is absorbed");
  assert.ok(!out.visible.includes(symptom), "an absorbed symptom stops being counted as its own issue");
  assert.ok(out.visible.includes(otherPage), "a page outside the cluster keeps its own finding");
  assert.ok(out.visible.includes(unrelatedAgent), "an a11y finding is never absorbed, even when its text mentions the endpoint");
  assert.ok(out.visible.includes(unrelatedText), "a symptom whose text doesn't match the signature stays visible");
  assert.deepStrictEqual(absorbRootCauseMembers([symptom], []).visible, [symptom], "no clusters → nothing is touched");
  console.log("selftest OK: root-cause clusters absorb their own symptoms and never hide an unrelated finding");
}

// Run liveness. A second process (dev server, CLI, bench) must never declare a
// LIVE run dead: runProject polls the status, so a wrong verdict here makes the
// caller believe the run finished and exit, killing the fleet mid-run.
{
  const started = "2026-07-28T10:00:00.000Z";
  const now = Date.parse("2026-07-28T11:00:00.000Z"); // an hour in — a real full run
  assert.ok(!isRunAbandoned("2026-07-28T10:59:30.000Z", started, now), "a run beating 30s ago is alive, however long it has been running");
  assert.ok(isRunAbandoned("2026-07-28T10:50:00.000Z", started, now), "no beat for 10 minutes means the process is gone");
  assert.ok(isRunAbandoned(null, started, now), "a pre-heartbeat row falls back to its start time");
  assert.ok(!isRunAbandoned(null, "2026-07-28T10:58:00.000Z", now), "a just-started run without a beat yet is not abandoned");
  assert.ok(!isRunAbandoned("not a date", started, now), "an unparseable timestamp never destroys a run on a guess");
  console.log("selftest OK: run liveness is decided by heartbeat, so a long run is never mistaken for an orphan");
}

// Observation quality (§3.6): the gate that stops the learning layer from
// trusting unstable execution. Pure classifier first, then the deterministic
// recovery tree (`observe`) that produces those facts.
{
  assert.strictEqual(classifyObservation({ succeeded: true, attempts: 1, recoveredVia: null, stateVerified: true }), "clean", "first-try verified success is clean");
  assert.strictEqual(classifyObservation({ succeeded: true, attempts: 2, recoveredVia: null, stateVerified: true }), "recovered", "a retry that then verifies is recovered");
  assert.strictEqual(classifyObservation({ succeeded: true, attempts: 1, recoveredVia: "reload", stateVerified: true }), "recovered", "needing a recovery rung is recovered even at attempt 1");
  assert.strictEqual(classifyObservation({ succeeded: true, attempts: 1, recoveredVia: null, stateVerified: false }), "ambiguous", "success we can't confirm is ambiguous, not clean");
  assert.strictEqual(classifyObservation({ succeeded: true, attempts: 3, recoveredVia: "re-auth", stateVerified: false }), "ambiguous", "unverifiable state wins over recovered");
  assert.strictEqual(classifyObservation({ succeeded: false, attempts: 2, recoveredVia: "reload", stateVerified: false }), "failed", "no result is always failed");
  // The learning gate: never learn from unstable execution.
  assert.ok(isTrustworthy("clean") && isTrustworthy("recovered"), "clean/recovered feed the graph");
  assert.ok(!isTrustworthy("ambiguous") && !isTrustworthy("failed"), "ambiguous/failed are quarantined from the graph");
  console.log("selftest OK: observation classifier gates clean/recovered in, ambiguous/failed out");
}
(async () => {
  // Clean: action succeeds first try, no ladder touched.
  const clean = await observe(async () => 42);
  assert.deepStrictEqual([clean.result, clean.quality, clean.attempts, clean.recoveredVia], [42, "clean", 1, null], "first-try success is a clean observation");
  // Recovered: first attempt throws, the reload rung fixes it.
  let n = 0;
  const rec = await observe(async () => { if (n++ === 0) throw new Error("flake"); return "ok"; }, { ladder: [{ name: "reload", apply: async () => {} }] });
  assert.deepStrictEqual([rec.result, rec.quality, rec.recoveredVia], ["ok", "recovered", "reload"], "a rung that fixes the action yields a recovered observation naming the rung");
  // Ambiguous: succeeds but verify can't confirm the state.
  const amb = await observe(async () => "maybe", { verify: () => false });
  assert.strictEqual(amb.quality, "ambiguous", "a success verify rejects is ambiguous");
  // A recovery step that itself throws is skipped to the next rung.
  let m = 0;
  const skip = await observe(async () => { if (m++ < 1) throw new Error("flake"); return "done"; }, {
    ladder: [{ name: "bad-step", apply: async () => { throw new Error("reload failed"); } }, { name: "wait-idle", apply: async () => {} }],
  });
  assert.deepStrictEqual([skip.result, skip.quality, skip.recoveredVia], ["done", "recovered", "wait-idle"], "a failed remediation is skipped; the next rung that works is credited");
  // Failed: exhausts the ladder without ever succeeding.
  const failed = await observe(async () => { throw new Error("always"); }, { ladder: [{ name: "reload", apply: async () => {} }] });
  assert.deepStrictEqual([failed.result, failed.quality], [null, "failed"], "exhausting the recovery tree yields a failed observation, never a throw");
  console.log("selftest OK: recovery tree produces clean/recovered/ambiguous/failed and skips failed remediations");
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

// Write-IDOR oracle (Plan-v7 §3.2a): the deterministic brain behind the
// non-destructive cross-role write test. Only tag-carrying, same-origin
// mutations are ever replayable; the verdict is read purely from status codes.
{
  const origin = "https://x.com";
  const tag = "qabot-ab12cd34-editor-0";
  // isWriteMethod: mutations vs safe reads.
  for (const m of ["POST", "put", "Patch", "DELETE"]) assert.ok(isWriteMethod(m), `${m} is a write`);
  for (const m of ["GET", "HEAD", "OPTIONS"]) assert.ok(!isWriteMethod(m), `${m} is not a write`);
  // isReplayableWrite: the non-destructive guard — write + same-origin + carries our tag.
  assert.ok(isReplayableWrite({ method: "POST", url: `${origin}/api/items`, postData: `{"name":"${tag}"}` }, origin, tag), "a create POST whose body carries our tag is replayable");
  assert.ok(isReplayableWrite({ method: "DELETE", url: `${origin}/api/items/${tag}`, postData: null }, origin, tag), "a DELETE whose URL carries our tag is replayable");
  assert.ok(!isReplayableWrite({ method: "GET", url: `${origin}/api/items/${tag}`, postData: null }, origin, tag), "a GET is never a replayable write (read-IDOR is a separate safe probe)");
  assert.ok(!isReplayableWrite({ method: "POST", url: `${origin}/api/items`, postData: `{"name":"real-user-data"}` }, origin, tag), "a write WITHOUT our tag is never replayed — real data is off-limits");
  assert.ok(!isReplayableWrite({ method: "POST", url: `https://evil.com/api/items`, postData: `{"name":"${tag}"}` }, origin, tag), "a cross-origin write is not replayed");
  // classifyWriteIdor: 2xx owner baseline required; cross-role 2xx = vulnerable, denials = protected.
  assert.strictEqual(classifyWriteIdor(200, 200), "vulnerable", "owner could write and so could another role → IDOR");
  assert.strictEqual(classifyWriteIdor(201, 204), "vulnerable", "any 2xx cross-role status is a successful cross-role mutation");
  assert.strictEqual(classifyWriteIdor(200, 404), "protected", "cross-role not-found (object hidden) counts as protected");
  assert.strictEqual(classifyWriteIdor(500, 200), "inconclusive", "without a real owner-write baseline there is nothing to conclude");
  assert.strictEqual(classifyWriteIdor(200, 500), "inconclusive", "a server error on replay is not an authorization signal");
  // §8.1 CSRF/nonce guard: a 401/403 is only "protected" when identity was isolated.
  assert.strictEqual(classifyWriteIdor(200, 403), "inconclusive", "default: a 403 may be a token mismatch, not authz — never a silent pass");
  assert.strictEqual(classifyWriteIdor(200, 401), "inconclusive", "default: a 401 under a replayed token is untested, not protected");
  assert.strictEqual(classifyWriteIdor(200, 403, true), "protected", "once identity is the only variable, a 403 is a real authz denial");
  assert.strictEqual(classifyWriteIdor(200, 401, true), "protected", "identity-isolated 401 is also a real denial");
  assert.strictEqual(classifyWriteIdor(200, 200, true), "vulnerable", "isolation does not change the 2xx verdict");
  console.log("selftest OK: write-IDOR oracle replays only tagged same-origin writes; 401/403 stays inconclusive until identity is isolated (§8.1)");
}

// Write-IDOR replay ordering (§3.2a): the non-destructive safety property — a
// successful cross-role DELETE removes the entity, so DELETEs must be probed
// LAST, after POST/PUT/PATCH have been checked against the still-live object.
{
  const ws = [{ method: "DELETE", id: 1 }, { method: "POST", id: 2 }, { method: "delete", id: 3 }, { method: "PATCH", id: 4 }];
  assert.deepStrictEqual(orderForReplay(ws).map((w) => w.id), [2, 4, 1, 3], "non-DELETE writes keep their order and run before both DELETEs (case-insensitive)");
  assert.deepStrictEqual(orderForReplay([{ method: "PUT", id: 9 }]).map((w) => w.id), [9], "a single write is unchanged");
  console.log("selftest OK: write-IDOR replay orders DELETEs last so probing never destroys the entity first");
}

// §8.1 replay isolation: only claim the replaying role's identity was the only variable
// when we could actually neutralise the owner's token — else stay un-isolated so a denial
// reads as inconclusive, never a false "protected".
{
  // No token anywhere → the replay carries only the role's own cookies → isolated.
  assert.deepStrictEqual(replayIsolation({ csrfHeader: null, postData: null }, null), { headers: {}, isolated: true }, "no CSRF header and no body token → isolated");
  assert.deepStrictEqual(replayIsolation({ csrfHeader: null, postData: '{"name":"x"}' }, null), { headers: {}, isolated: true }, "a plain JSON body with no token → isolated");
  // Header-based CSRF (double-submit): inject THIS role's own token → isolated.
  assert.deepStrictEqual(replayIsolation({ csrfHeader: "x-xsrf-token", postData: null }, "role-b-tok"), { headers: { "x-xsrf-token": "role-b-tok" }, isolated: true }, "role's own token injected into the CSRF header → isolated");
  // Header expected but this role has no token cookie → can't neutralise → NOT isolated.
  assert.deepStrictEqual(replayIsolation({ csrfHeader: "x-csrf-token", postData: null }, null), { headers: {}, isolated: false }, "CSRF header expected but no token for the role → not isolated");
  // Token embedded in the owner's BODY (Rails authenticity_token) still leaks identity → NOT isolated.
  assert.strictEqual(replayIsolation({ csrfHeader: null, postData: "authenticity_token=abc&name=x" }, null).isolated, false, "owner token in the request body → not isolated even with no header");
  assert.strictEqual(replayIsolation({ csrfHeader: "x-xsrf-token", postData: "_csrf=abc" }, "role-b-tok").isolated, false, "a body token we can't rewrite keeps it un-isolated even after fixing the header");
  console.log("selftest OK: §8.1 replay injects the replaying role's own CSRF token and only claims isolation when the owner's token is fully neutralised");
}

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

// Human-in-the-loop: what a person types into the live-run question box has to
// map to a login retry — or to "they handled it themselves", which is NOT a retry.
{
  assert.deepStrictEqual(parseCredentialAnswer("pass: hunter2", "a@b.com"), { username: "a@b.com", password: "hunter2" }, "labelled password reuses the configured username");
  assert.deepStrictEqual(parseCredentialAnswer("user: x@y.com / pass: s3cret", "a@b.com"), { username: "x@y.com", password: "s3cret" }, "both labels are honoured");
  assert.deepStrictEqual(parseCredentialAnswer("x@y.com s3cret", "a@b.com"), { username: "x@y.com", password: "s3cret" }, "unlabelled email+password pair");
  assert.deepStrictEqual(parseCredentialAnswer("s3cret", "a@b.com"), { username: "a@b.com", password: "s3cret" }, "a bare token is the password");
  assert.strictEqual(parseCredentialAnswer("continue", "a@b.com"), null, "'continue' means the human signed in themselves, not a retry");
  assert.strictEqual(parseCredentialAnswer("", "a@b.com"), null, "empty answer is not credentials");
  assert.strictEqual(parseCredentialAnswer("user: x@y.com", "a@b.com"), null, "a username with no password can't be attempted");
  console.log("selftest OK: human credential answers parse into a retry or a hands-off continue");
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

// PLAN-REPORT-TRUST §1: lock the coverage-denominator invariant directly, so it
// can never regress even if the union in computeCoverageTotals is ever touched.
// The exact bug: a page adopted mid-run by the interaction agent (a click that
// reveals a route the crawler never linked) lands in testedUrls but not pages.
{
  const pages = [{ url: "https://x.com/a" }, { url: "https://x.com/b" }]; // crawler-discovered
  const adopted = "https://x.com/adopted-by-click"; // never in `pages`, only in testedUrls
  const tested = new Set(["https://x.com/a", adopted]);
  const totals = computeCoverageTotals(pages, tested, { controlsSeen: 0, controlsClicked: 0, journeysDefined: 0, journeysPassed: 0 });
  assert.ok(totals.pagesTested <= totals.pagesDiscovered, `pagesTested (${totals.pagesTested}) must never exceed pagesDiscovered (${totals.pagesDiscovered})`);
  assert.ok(totals.templatesTested <= totals.templatesDiscovered, `templatesTested (${totals.templatesTested}) must never exceed templatesDiscovered (${totals.templatesDiscovered})`);
  assert.strictEqual(totals.pagesDiscovered, 3, "the adopted route counts toward discovered, closing the 115-of-114 bug");
  console.log("selftest OK: pagesTested/templatesTested can never exceed their discovered denominator, even with an adopted route");
}

// PLAN-REPORT-TRUST §2: the rendered report can never show an agent as both
// having run (findings/activity) and "did not run" — the renderer derives the
// skip list from agentsRan at render time instead of trusting a stored list
// that may have been computed before a late agent (senior-review) finished.
{
  const run: Run = {
    id: "r1", projectId: "p1", mode: "smart", status: "passed", startedAt: "2026-07-28T10:00:00.000Z",
    finishedAt: "2026-07-28T10:05:00.000Z", summary: null, aiTokens: 7769,
    reportJson: JSON.stringify({
      sessions: [{ role: "Admin", ok: true, detail: "1 page(s) tested" }],
      coverage: [{ role: "Admin", pagesTested: 1, findings: 1 }],
      agentsRan: ["login", "senior-review"],
      // Stale skip entry: senior-review ran late, but the list built before it finished still names it.
      agentsSkipped: [{ name: "senior-review", reason: "AI layer did not run" }],
    } satisfies RunReport),
    missionAgents: ["login", "senior-review"], commitSha: null, humanTakeoverAt: null,
  };
  const finding: Finding = {
    id: 1, runId: "r1", agent: "senior-review", severity: "info", kind: "improvement", source: "ai", confidence: 1,
    title: "Fix checkout first", detail: "business-impact note", pageUrl: null, role: "Admin",
    evidence: null, fingerprint: "fp1", fingerprintV: 1, afterHuman: false,
  };
  const md = buildReportMarkdown(run, "Acme", "https://acme.test", [finding], []);
  assert.ok(!md.includes("did not run"), "an agent present in agentsRan must never be rendered as skipped, however stale the stored skip list is");

  // The case that actually shipped broken: stored agentsRan does NOT list the agent
  // (the report was serialized before senior-review finished), but its finding is
  // right there in the table. Findings are the stronger evidence — an agent that
  // produced one demonstrably ran. Rendering a real run caught this; the assertion
  // above did not, because it put the agent in agentsRan where the filter saw it.
  const staleRun: Run = { ...run, reportJson: JSON.stringify({
    sessions: [{ role: "Admin", ok: true, detail: "1 page(s) tested" }],
    coverage: [{ role: "Admin", pagesTested: 1, findings: 1 }],
    agentsRan: ["login"],
    agentsSkipped: [{ name: "senior-review", reason: "AI layer did not run" }],
  } satisfies RunReport) };
  const staleMd = buildReportMarkdown(staleRun, "Acme", "https://acme.test", [finding], []);
  assert.ok(!staleMd.includes("did not run"), "an agent that produced a finding is never reported as 'did not run', whatever the stored lists say");

  // And an agent that genuinely produced nothing still gets its honest skip line —
  // the fix must not silently swallow the whole section.
  const reallySkipped: Run = { ...staleRun, reportJson: JSON.stringify({
    sessions: [], coverage: [], agentsRan: ["login"],
    agentsSkipped: [{ name: "crud", reason: "full mode only" }],
  } satisfies RunReport) };
  assert.ok(buildReportMarkdown(reallySkipped, "Acme", "https://acme.test", [], []).includes("crud (full mode only)"), "a genuinely skipped agent keeps its reason in the report");
  console.log("selftest OK: an agent with findings is never rendered as 'did not run', and real skips keep their reason");
}

// Coverage denominators are derived at render time, not trusted (PLAN-REPORT-TRUST
// §1). The producer now unions discovered ∪ tested, but a report_json stored before
// that fix still holds an impossible ratio — and "115 of 114 pages tested" makes a
// reader doubt every other number on the page.
{
  const run: Run = {
    id: "r2", projectId: "p1", mode: "smart", status: "passed", startedAt: "2026-07-28T10:00:00.000Z",
    finishedAt: "2026-07-28T10:05:00.000Z", summary: null, aiTokens: 0,
    reportJson: JSON.stringify({
      sessions: [], coverage: [], agentsRan: [], agentsSkipped: [],
      coverageTotals: { pagesDiscovered: 114, pagesTested: 115, templatesDiscovered: 98, templatesTested: 99, controlsSeen: 1498, controlsClicked: 324, journeysDefined: 0, journeysPassed: 0 },
    } satisfies RunReport),
    missionAgents: [], commitSha: null, humanTakeoverAt: null,
  };
  const md = buildReportMarkdown(run, "Acme", "https://acme.test", [], []);
  assert.ok(md.includes("115 of 115 discovered pages tested"), "a stale impossible ratio renders as 100%, never as more-tested-than-discovered");
  assert.ok(md.includes("(99/99 unique page types)"), "the template denominator is derived the same way");
  assert.ok(!md.includes("of 114"), "the impossible stored denominator never reaches the page");
  console.log("selftest OK: coverage denominators can never render above 100%, even from a pre-fix stored report");
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

  // Plan-v8 §3.3 human-FP feed: reviewer-suppressed fingerprints count as
  // confirmed noise — additive, so every pre-v8 metric above stays untouched.
  const fpFindings = findings.map((x, i) => ({ ...x, fingerprint: `fp-${i}` }));
  const withFp = scoreBench(defects, fpFindings, new Set(["fp-2", "fp-999"]));
  assert.strictEqual(withFp.humanFalsePositives, 1, "only fingerprints present in this run's findings are counted");
  assert.strictEqual(withFp.humanFpRate, 1 / 4, "human-FP rate is over all findings");
  assert.deepStrictEqual([withFp.detected.length, withFp.unseededFindings], [s.detected.length, s.unseededFindings], "existing metrics are unchanged by the feedback feed");
  const noFp = scoreBench(defects, fpFindings);
  assert.deepStrictEqual([noFp.humanFalsePositives, noFp.humanFpRate], [0, 0], "no suppressed set → metric is zero, never undefined");
  console.log("selftest OK: bench scorer counts reviewer-marked false positives without disturbing baseline metrics");
}

// Semantic snapshot (Plan-v7 §3.1): the pure a11y+DOM derivation the browser
// walk feeds into. Role from tag/type, W3C-ish name priority, semantic-first
// ref, and the interactive predicate that catches div[onclick] — the whole
// reason a raw a11y tree isn't enough. The in-page DOM walk is exercised by
// real runs, not here; these are the selftestable parts.
{
  // implicitRole: the QA-relevant subset of implicit ARIA roles.
  assert.strictEqual(implicitRole("a", null), "link");
  assert.strictEqual(implicitRole("BUTTON", null), "button", "tag match is case-insensitive");
  assert.strictEqual(implicitRole("input", "checkbox"), "checkbox");
  assert.strictEqual(implicitRole("input", "submit"), "button", "submit inputs are buttons, not textboxes");
  assert.strictEqual(implicitRole("input", null), "textbox", "a bare input defaults to a textbox");
  assert.strictEqual(implicitRole("input", "hidden"), "", "hidden inputs have no role");
  assert.strictEqual(implicitRole("h3", null), "heading");
  assert.strictEqual(implicitRole("select", null), "combobox");
  assert.strictEqual(implicitRole("div", null), "", "a plain div has no implicit role");

  // chooseName: aria-label wins, then falls through to placeholder/etc, trims, caps.
  assert.strictEqual(chooseName({ ariaLabel: "Close", text: "X" }), "Close", "aria-label outranks text");
  assert.strictEqual(chooseName({ placeholder: "Email" }), "Email", "falls through to placeholder when higher slots are empty");
  assert.strictEqual(chooseName({ ariaLabel: "  Save  " }), "Save", "the chosen name is trimmed");
  assert.strictEqual(chooseName({}), "", "no name candidates yields empty string");
  assert.strictEqual(chooseName({ text: "a".repeat(200) }).length, 120, "names are capped so one label can't blow the token budget");

  // computeRef: semantic identity first (the plan's thesis), CSS/positional last.
  assert.strictEqual(computeRef({ role: "button", name: "Save", id: "submit", testId: null, testIdAttr: null, tag: "button", idx: 2 }), 'role=button[name="Save"]', "role+name beats a present id");
  assert.strictEqual(computeRef({ role: "button", name: "", id: "submit", testId: null, testIdAttr: null, tag: "button", idx: 2 }), "#submit", "no name falls back to #id");
  assert.strictEqual(computeRef({ role: "", name: "", id: null, testId: "save-btn", testIdAttr: "data-testid", tag: "button", idx: 2 }), '[data-testid="save-btn"]', "then to a test-id attribute");
  assert.strictEqual(computeRef({ role: "", name: "", id: null, testId: null, testIdAttr: null, tag: "span", idx: 7 }), "span#7", "positional tag#idx is the last resort");

  // isInteresting: the predicate consumers filter by — must catch onclick/tabindex too.
  assert.ok(isInteresting("link", false, null), "an interactive role is interesting");
  assert.ok(!isInteresting("heading", false, null), "a heading is not interactive");
  assert.ok(isInteresting("", true, null), "a roleless element with onclick is interactive");
  assert.ok(isInteresting("", false, 0), "tabindex=0 makes it focusable, so interactive");
  assert.ok(!isInteresting("", false, -1), "tabindex=-1 is programmatic focus only, not interactive");
  assert.ok(!isInteresting("", false, null), "no role, no onclick, no tabindex = not interactive");

  // enrich: the integration — raw facts to a semantic node. The div[onclick] case
  // is the motivating example a pure a11y tree would miss entirely.
  const rawLink = {
    tag: "a", type: null, roleAttr: null, id: null, testId: null, testIdAttr: null,
    nameParts: { text: "Delete account" }, href: "/x", value: null, states: [],
    bbox: { x: 0, y: 0, w: 10, h: 10 }, visible: true, hasOnclick: false, tabindex: null, idx: 0,
  };
  const linkNode = enrich(rawLink, null);
  assert.strictEqual(linkNode.role, "link");
  assert.strictEqual(linkNode.name, "Delete account");
  assert.strictEqual(linkNode.ref, 'role=link[name="Delete account"]');
  assert.ok(linkNode.interactive, "a link is interactive");
  assert.strictEqual(linkNode.frameUrl, null, "main-frame nodes carry a null frameUrl");

  const rawDiv = {
    tag: "div", type: null, roleAttr: null, id: "trash", testId: null, testIdAttr: null,
    nameParts: {}, href: null, value: null, states: [],
    bbox: null, visible: false, hasOnclick: true, tabindex: null, idx: 3,
  };
  const divNode = enrich(rawDiv, "https://x.com/frame");
  assert.strictEqual(divNode.role, "", "a plain div still has no role");
  assert.ok(divNode.interactive, "onclick alone makes the div interactive — this is what a11y-only misses");
  assert.strictEqual(divNode.ref, "#trash", "no role+name, so ref falls back to #id");
  assert.strictEqual(divNode.frameUrl, "https://x.com/frame", "child-frame url is stamped through");

  console.log("selftest OK: semantic snapshot derives role/name/ref and flags div[onclick] a pure a11y tree would miss");
}

// Canonical state key (Plan-v7 §3.3 + §8.2): normalize snapshots to a state key so
// sibling-row/count/toast variation collapses (no explosion), while genuinely
// different control sets never merge (no silent coverage hole — the §8.2 guard).
{
  const sn = (role: string, name: string, interactive = true): SemanticNode => ({
    ref: "", role, name, tag: "button", type: null, href: null, value: null,
    testId: null, states: [], bbox: null, visible: true, interactive, frameUrl: null,
  });
  const snap = (url: string, nodes: SemanticNode[]): SemanticSnapshot => ({ url, nodes, truncated: false });

  // normName: strip volatile ids/counts, keep the semantic label.
  assert.strictEqual(normName("Row 47"), "row", "digits (row numbers/counts) are stripped");
  assert.strictEqual(normName("qabot-ab12cd34-admin-0 item"), "item", "our run tag is stripped");
  assert.notStrictEqual(normName("Save"), normName("Publish"), "distinct labels stay distinct");

  // Explosion guard: a list with 3 vs 5 identically-shaped rows is ONE state.
  const list3 = snap("/candidates", [sn("navigation", "", false), sn("button", "Row 1"), sn("button", "Row 2"), sn("button", "Row 3")]);
  const list5 = snap("/candidates?page=2", [sn("navigation", "", false), sn("button", "Row 4"), sn("button", "Row 5"), sn("button", "Row 6"), sn("button", "Row 7"), sn("button", "Row 8")]);
  assert.strictEqual(canonicalStateKey(list3), canonicalStateKey(list5), "row count/content must not explode into distinct states");
  // A transient toast/timestamp (non-interactive, non-landmark) must not change the key.
  const withToast = snap("/candidates", [sn("navigation", "", false), sn("button", "Row 9"), sn("button", "Row 10"), sn("button", "Row 11"), sn("alert", "Saved at 12:04", false)]);
  assert.strictEqual(canonicalStateKey(list3), canonicalStateKey(withToast), "a transient toast/timestamp must not change the state key");

  // §8.2 FALSE-MERGE GUARD: genuinely different control sets must NOT collapse.
  const editScreen = snap("/x", [sn("button", "Save"), sn("button", "Delete")]);
  const otherScreen = snap("/y", [sn("button", "Publish"), sn("button", "Archive")]);
  assert.notStrictEqual(canonicalStateKey(editScreen), canonicalStateKey(otherScreen), "different interactive controls must produce different state keys");
  assert.ok(!isStateCollision(editScreen, otherScreen), "distinct shapes → distinct keys → not a collision");
  assert.ok(!isStateCollision(list3, list5), "same shape same key is a legitimate merge, not a collision");
  assert.deepStrictEqual(interactiveShape(editScreen), ["button:delete", "button:save"], "shape is the sorted unique interactive role:name set");
  console.log("selftest OK: canonical state key collapses sibling/volatile states but never false-merges distinct control sets (§8.2)");
}

// Entity-lifecycle learning (Plan-v7 §3.3): learn the normal transition direction
// from clean history, then flag post-terminal/backward/wrong-role transitions —
// never learning from or judging an unstable execution (§3.6 interlock).
{
  const t = (from: string, to: string, actorRole = "admin", quality: ObservationQuality = "clean", action = "advance", entityType = "application"): Transition =>
    ({ entityType, action, from, to, actorRole, quality });
  const model = learnLifecycle([t("applied", "screening"), t("screening", "hired"), t("draft", "published", "editor", "clean", "publish", "post")]);
  assert.deepStrictEqual(lifecycleViolations(model, [t("screening", "applied")]).map((v) => v.kind), ["backward"], "reversing a learned edge is a backward transition");
  assert.deepStrictEqual(lifecycleViolations(model, [t("cancelled", "active")]).map((v) => v.kind), ["post-terminal"], "terminal→active resurrects a finished entity");
  assert.deepStrictEqual(lifecycleViolations(model, [t("draft", "published", "viewer", "clean", "publish", "post")]).map((v) => v.kind), ["wrong-role"], "an unseen actor for a learned action is flagged");
  assert.deepStrictEqual(lifecycleViolations(model, [t("applied", "screening")]), [], "the learned forward direction is fine");
  assert.strictEqual(learnLifecycle([t("a", "b", "admin", "ambiguous")]).edges.size, 0, "unstable observations are not learned");
  assert.deepStrictEqual(lifecycleViolations(model, [t("cancelled", "active", "admin", "failed")]), [], "unstable observations are not judged");
  console.log("selftest OK: lifecycle learning flags post-terminal/backward/wrong-role and never learns from unstable execution");
}

// Fact store (Plan-v7 §3.4): triples deduped by identity, keeping the strongest
// belief and unioning evidence; knows() drives the §3.5 'already learned?' gate.
{
  const store = new FactStore();
  const f = (source: Fact["source"], confidence: number, evidence: string[]): Fact =>
    ({ subject: "Archive button", predicate: "effect", object: "sets status=archived", evidence, confidence, source });
  store.assert(f("inferred", 0.5, ["ai-guess"]));
  assert.strictEqual(store.size, 1, "first assert stores the fact");
  store.assert(f("observed", 0.9, ["saw-PATCH-200"]));
  const got = store.get("Archive button", "effect");
  assert.strictEqual(got.length, 1, "the same triple dedupes, not duplicates");
  assert.strictEqual(got[0].source, "observed", "the stronger source (observed > inferred) wins the belief");
  assert.deepStrictEqual(got[0].evidence.slice().sort(), ["ai-guess", "saw-PATCH-200"], "evidence from both assertions is unioned");
  store.assert(f("ai", 0.99, ["hallucination"]));
  assert.strictEqual(store.get("Archive button", "effect")[0].source, "observed", "a weaker source can't overwrite a stronger belief even at higher confidence");
  assert.ok(store.knows("Archive button", "effect"), "knows() reports a believed subject+predicate");
  assert.ok(!store.knows("Archive button", "colour"), "knows() is false for an unbelieved predicate");
  console.log("selftest OK: fact store dedupes by triple, keeps the strongest belief, unions evidence, answers knows()");
}

// Relationship-aware authz oracle (Plan-v7 §3.2b): the verdict depends on the actor's
// relationship to the resource (owner/same-tenant/other-tenant), respecting §8.1.
{
  assert.strictEqual(relationshipOf(true, "t1", "t2"), "owner", "owner beats tenancy");
  assert.strictEqual(relationshipOf(false, "t1", "t1"), "same-tenant", "matching tenants when not owner");
  assert.strictEqual(relationshipOf(false, "t1", "t2"), "other-tenant", "different tenants");
  // WEBTESTER-AUDIT P1-13: unlearned tenancy is NOT evidence of separate tenancy —
  // two roles sharing a tenant were previously reported as a critical cross-tenant leak.
  assert.strictEqual(relationshipOf(false, null, null), "unknown", "unknown tenancy is 'unknown', never assumed other-tenant");
  assert.strictEqual(relationshipOf(false, "t1", null), "unknown", "a missing resource tenant is still unknown");
  assert.strictEqual(classifyRelAuthz("unknown", 200), "inconclusive", "a 2xx with unknown tenancy is inconclusive, not vulnerable (P1-13)");
  assert.strictEqual(classifyRelAuthz("unknown", 404), "protected", "404 hides the resource whatever the tenancy");
  assert.strictEqual(classifyRelAuthz("other-tenant", 200), "vulnerable", "cross-tenant 2xx is a leak");
  assert.strictEqual(classifyRelAuthz("owner", 200), "protected", "the owner succeeding is correct");
  assert.strictEqual(classifyRelAuthz("same-tenant", 200), "inconclusive", "intra-org access may be legitimate sharing");
  assert.strictEqual(classifyRelAuthz("other-tenant", 404), "protected", "a hidden resource is protected");
  assert.strictEqual(classifyRelAuthz("other-tenant", 403), "inconclusive", "§8.1: a 403 without token isolation is inconclusive");
  assert.strictEqual(classifyRelAuthz("other-tenant", 403, true), "protected", "identity-isolated 403 is a real denial");
  console.log("selftest OK: relationship-aware authz oracle flags cross-tenant 2xx and respects §8.1 token isolation");
}

// Safe active probing (Plan-v7 §3.5): the boolean gate probes only on-path safe
// unknowns; the escalation ladder puts AI second-to-last, not first.
{
  const base = { onTestPath: true, disposableEntityExists: true, readOnly: false, alreadyLearned: false };
  assert.ok(shouldProbe(base), "'Archive' on-path with a disposable entity → probe");
  assert.ok(!shouldProbe({ ...base, onTestPath: false }), "'Help Center' off the test path → skip");
  assert.ok(!shouldProbe({ ...base, alreadyLearned: true }), "already-learned effect → skip");
  assert.ok(shouldProbe({ ...base, disposableEntityExists: false, readOnly: true }), "a read-only action is safe to probe without a disposable entity");
  assert.ok(!shouldProbe({ ...base, disposableEntityExists: false, readOnly: false }), "a mutating action with no disposable entity is unsafe → skip");
  assert.strictEqual(resolveStrategy({ ...base, known: true, hasCodeSignal: true, aiAvailable: true }), "use-known", "known wins");
  assert.strictEqual(resolveStrategy({ ...base, known: false, hasCodeSignal: true, aiAvailable: true }), "probe", "a safe probe beats inferring and AI");
  assert.strictEqual(resolveStrategy({ ...base, onTestPath: false, known: false, hasCodeSignal: true, aiAvailable: true }), "infer", "off-path unknown with a code signal → infer, not AI");
  assert.strictEqual(resolveStrategy({ ...base, onTestPath: false, known: false, hasCodeSignal: false, aiAvailable: true }), "ai", "AI only when nothing cheaper applies");
  assert.strictEqual(resolveStrategy({ ...base, onTestPath: false, known: false, hasCodeSignal: false, aiAvailable: false }), "record-unknown", "no AI budget → record the unknown");
  console.log("selftest OK: probe gate greenlights only on-path safe unknowns; escalation puts AI second-to-last");
}

// Probe-executor loop (Plan-v7 §3.5): a greenlit probe turns its before/after delta into
// a learned fact — but only from a trustworthy observation, and it must gate the re-probe.
{
  const changed: ProbeOutcome = { action: "Archive", subject: "candidate", stateKeyBefore: "aaa", stateKeyAfter: "bbb", apiStatus: 200, quality: "clean" };
  const f = factFromProbe(changed);
  assert.ok(f && f.object === "mutates-state" && f.source === "probed", "a clean probe where state changed → learns 'mutates-state' as probed fact");
  assert.strictEqual(f!.confidence, 0.9, "a clean observation is high-confidence");

  // API accepted it but the visible state didn't move → server-effect-only, not a mutation of state we saw.
  assert.strictEqual(factFromProbe({ ...changed, stateKeyAfter: "aaa" })!.object, "server-effect-only", "2xx with unchanged state key → server-effect-only");
  // Nothing changed and no request → the action is inert (safe to treat as no-op).
  assert.strictEqual(factFromProbe({ ...changed, stateKeyAfter: "aaa", apiStatus: null })!.object, "no-effect", "no state change and no request → no-effect");
  // §3.6 interlock: an ambiguous/failed observation must NOT mint a fact.
  assert.strictEqual(factFromProbe({ ...changed, quality: "ambiguous" }), null, "never learn from an ambiguous execution");
  assert.strictEqual(factFromProbe({ ...changed, quality: "recovered" })!.confidence, 0.7, "a recovered observation still learns, at lower confidence");

  // The loop asserts into the store and makes the effect known → next time shouldProbe skips it.
  const store = new FactStore();
  learnFromProbe(store, changed);
  assert.ok(store.knows("candidate", "effect-of:Archive"), "a learned probe fact makes the effect known — the gate won't re-probe it");
  assert.strictEqual(learnFromProbe(store, { ...changed, quality: "failed" }), null, "a failed probe learns nothing");
  console.log("selftest OK: §3.5 probe-executor learns a probed fact from trustworthy deltas only and gates its own re-probe via knows()");
}

// Probe driver decision layer (§3.5): classify controls by mutation risk, plan which to
// probe (safe-gated, deduped), and run the plan end-to-end through a fake browser IO.
{
  assert.strictEqual(classifyControl("button", "Delete user"), "mutating", "a delete verb is mutating");
  assert.strictEqual(classifyControl("button", "Archive"), "mutating", "archive is a known mutating verb");
  assert.strictEqual(classifyControl("button", "Reconcile"), "unknown", "a bare button with no known verb is unknown (safety-gated as mutating)");
  assert.strictEqual(classifyControl("link", "Help Center"), "read-only", "a help link is read-only");
  assert.strictEqual(classifyControl("link", "Delete account"), "mutating", "a mutating verb beats the link default");

  const controls: ProbeTarget[] = [
    { ref: "r1", role: "button", name: "Archive" },   // unknown → needs disposable entity
    { ref: "r2", role: "link", name: "Help Center" },  // read-only → safe regardless
    { ref: "r3", role: "button", name: "Archive" },    // duplicate action → deduped
  ];
  const plan = planProbes("candidate", controls, {
    disposableEntityExists: true,
    onTestPath: () => true,
    knows: () => false,
  });
  assert.strictEqual(plan.length, 2, "duplicate actions are deduped to one plan item");
  assert.ok(plan.every((p) => p.decision), "with a disposable entity on-path, both the unknown and the read-only control are greenlit");

  // No disposable entity → the mutating/unknown control is NOT probed, the read-only one still is.
  const guarded = planProbes("candidate", controls, { disposableEntityExists: false, onTestPath: () => true, knows: () => false });
  assert.strictEqual(guarded.find((p) => p.action === "Archive")!.decision, false, "no disposable entity → unknown/mutating control is not probed");
  assert.strictEqual(guarded.find((p) => p.action === "Help Center")!.decision, true, "read-only control is safe to probe without a disposable entity");
  console.log("selftest OK: §3.5 driver classifies control risk and safe-gates + dedups the probe plan");
}

// Behavioral contracts (Plan-v7 §3.7): freeze a semantic invariant only from a clean
// holding run; validate later runs; an unstable execution can neither mint nor fail one.
{
  const clean: Observation = { kind: "create-retrievable", subject: "candidate", holds: true, quality: "clean" };
  const contract = freezeContract(clean);
  assert.ok(contract && contract.expected === true, "a clean, holding observation freezes a contract");
  assert.strictEqual(freezeContract({ ...clean, quality: "recovered" }), null, "a recovered (non-clean) run does not mint a contract");
  assert.strictEqual(freezeContract({ ...clean, holds: false }), null, "a broken invariant is never frozen as expected");
  assert.strictEqual(checkContract(contract!, clean), "pass", "the invariant still holding is a pass");
  assert.strictEqual(checkContract(contract!, { ...clean, holds: false }), "fail", "the invariant breaking is a regression fail");
  assert.strictEqual(checkContract(contract!, { ...clean, holds: false, quality: "ambiguous" }), "inconclusive", "an unstable execution can't fail a contract");
  assert.strictEqual(checkContract(contract!, { ...clean, subject: "invoice" }), "inconclusive", "a different subject is not this contract");
  console.log("selftest OK: contracts freeze only from clean holding runs and flag regressions without punishing flaky executions");
}

// ARR accounting (Plan-v7 §6, live consumer): each unknown effect on a page's probe plan
// lands in exactly one bucket — already-known (byFacts), learned-by-probe (byProbe),
// greenlit-but-too-unstable (unresolved), or gate-refused → the AI-escalation target
// (requiredAI). "Known" must win over "refused" (a known action's gate also declines it).
{
  const item = (action: string, decision: boolean): ProbePlanItem => ({ ref: "", role: "button", name: action, action, risk: "unknown", decision });
  const plan: ProbePlanItem[] = [
    item("View", false), // preKnown → byFacts even though the gate also declined to re-probe it
    item("Archive", true), // greenlit + a fact was learned → byProbe
    item("Recompute", true), // greenlit but learned nothing (unstable) → unresolved
    item("Delete", false), // unknown + gate-refused (no disposable entity) → would need AI
  ];
  const tally = accountArr(plan, new Set(["View"]), new Set(["Archive"]));
  assert.deepStrictEqual(tally, { encountered: 4, byFacts: 1, byProbe: 1, requiredAI: 1, unresolved: 1 }, "each control lands in exactly one ARR bucket, known before refused");
  const rate = (tally.byFacts + tally.byProbe) / tally.encountered;
  assert.ok(formatArr({ ...tally, rate }).includes("50%"), "ARR formats (byFacts+byProbe)/encountered as a percentage");
  console.log("selftest OK: §6 ARR accounting buckets known/probed/would-need-AI and formats the rate");
}

// Lifecycle status observation (Plan-v7 §3.3 live consumer): a clean single-status swap
// across a probe is a transition; ambiguous multi-swaps and non-status badge noise are
// not — then the transition feeds the same post-terminal detection the core selftests.
{
  assert.deepStrictEqual(statusTransition(["Draft"], ["Published"]), { from: "Draft", to: "Published" }, "one recognized status out, one in → a transition");
  assert.strictEqual(statusTransition(["Archived"], ["Archived"]), null, "no change → no transition");
  assert.strictEqual(statusTransition(["Draft", "Open"], ["Published", "Closed"]), null, "a two-status swap is ambiguous → don't guess");
  assert.strictEqual(statusTransition(["Row 47", "3 items"], ["Row 48", "4 items"]), null, "count/row badge text is not a lifecycle status");
  const tr = statusTransition(["Archived"], ["Active"]);
  assert.ok(tr, "archived→active is a recognized transition");
  const trans: Transition[] = [{ entityType: "candidate", action: "(probed)", from: tr!.from, to: tr!.to, actorRole: "admin", quality: "clean" }];
  assert.ok(lifecycleViolations(learnLifecycle(trans), trans).some((v) => v.kind === "post-terminal"), "a probe that resurrects an archived entity is flagged post-terminal");
  console.log("selftest OK: §3.3 status-transition reads a clean single swap and feeds post-terminal detection");
}

// Cross-run lifecycle (Plan-v7 §3.3 live): a model learned from PRIOR runs' known-good
// history flags a backward transition in a later run — and a flagged (buggy) transition
// is excluded from what gets persisted, so it can never self-silence on the next run.
{
  const tr = (from: string, to: string, actorRole = "admin", action = "advance", entityType = "application"): Transition =>
    ({ entityType, action, from, to, actorRole, quality: "clean" });
  const model = learnLifecycle([tr("applied", "hired")]); // known-good direction from a past run
  const thisRun = [tr("hired", "applied"), tr("screening", "hired")]; // one backward, one fine
  const violations = lifecycleViolations(model, thisRun);
  assert.ok(violations.some((v) => v.kind === "backward"), "a prior-run model flags a backward transition seen in a later run");

  const flagged = new Set(violations.map((v) => transitionKey(v.transition)));
  const persisted = thisRun.filter((t) => !flagged.has(transitionKey(t)));
  assert.ok(!persisted.some((t) => t.from === "hired" && t.to === "applied"), "a flagged backward transition is NOT persisted into known-good history");
  assert.ok(persisted.some((t) => t.from === "screening" && t.to === "hired"), "a clean, non-violating transition IS persisted for next run");
  console.log("selftest OK: §3.3 cross-run lifecycle judges against prior history and never persists a flagged transition");
}

// Cross-run experience (Plan-v8 §1/§2): merge/contradiction/promotion/recall are pure,
// selftested without a database — db.ts is a thin, untested CRUD layer (same split as
// lifecycle.ts/contracts.ts above).
{
  const row = (over: Partial<ExperienceRow> = {}): ExperienceRow => ({
    id: 1, origin: "https://a.com", scope: "site", kind: "fact", subject: "s", predicate: "p", object: "o",
    confidence: 0.8, source: "observed", evidence: "[]", runCount: 3, successCount: 3, lastRunId: "r1", updatedAt: 1000, contradictedAt: null,
    ...over,
  });
  const input = (over: Partial<ExperienceInput> = {}): ExperienceInput => ({
    origin: "https://a.com", scope: "site", kind: "fact", subject: "s", predicate: "p", object: "o",
    confidence: 0.5, source: "observed", evidence: ["e1"], runId: "r2", ...over,
  });

  const created = mergeExperience(null, input(), 2000);
  assert.strictEqual(created.runCount, 1, "a brand-new row starts at run_count 1");
  assert.strictEqual(created.confidence, 0.5, "a brand-new row takes the asserted confidence");

  const merged = mergeExperience(row(), input({ confidence: 0.4 }), 2000);
  assert.strictEqual(merged.runCount, 4, "run_count always increments on conflict");
  assert.strictEqual(merged.confidence, 0.8, "confidence takes the max, not the newest");

  const recWorked = mergeExperience(row({ kind: "recovery", runCount: 5, successCount: 5, confidence: 0.9 }), input({ kind: "recovery", workedThisRun: true }), 2000);
  assert.strictEqual(recWorked.successCount, 6, "a working recovery increments success_count");
  assert.strictEqual(recWorked.confidence, 0.9, "a working recovery does not touch confidence");

  const trusted = row({ kind: "recovery", runCount: 10, successCount: 8, confidence: 0.9 });
  const failed = mergeExperience(trusted, input({ kind: "recovery", workedThisRun: false }), 5000);
  assert.strictEqual(failed.confidence, 0.45, "a trusted (≥70%) recovery failing halves confidence — the poison-guard contradiction");
  assert.strictEqual(failed.contradictedAt, 5000, "the contradiction is stamped");

  const shaky = row({ kind: "recovery", runCount: 10, successCount: 3, confidence: 0.7 });
  const stillFailing = mergeExperience(shaky, input({ kind: "recovery", workedThisRun: false }), 5000);
  assert.strictEqual(stillFailing.confidence, 0.7, "an already-unreliable recovery failing again is not a new contradiction");
  assert.strictEqual(stillFailing.contradictedAt, null, "no contradiction stamped below the trust floor");

  console.log("selftest OK: §1.2 experience upsert increments run_count, takes max confidence, and poison-guards a contradicted recovery");
}

{
  const conflicting: ExperienceRow[] = [
    { id: 1, origin: "https://a.com", scope: "site", kind: "fact", subject: "s", predicate: "p", object: "old", confidence: 0.8, source: "observed", evidence: "[]", runCount: 2, successCount: 2, lastRunId: "r1", updatedAt: 1, contradictedAt: null },
  ];
  const [c] = contradictRows(conflicting, 9000);
  assert.strictEqual(c.confidence, 0.4, "a contradicted fact row's confidence is halved");
  assert.strictEqual(c.contradictedAt, 9000, "contradicted_at is stamped on the old, now-wrong row");
  console.log("selftest OK: §1.2 contradictRows halves confidence and stamps contradicted_at on conflicting rows");
}

{
  assert.strictEqual(generalizeSubject("#user-42"), "#id", "a hash id generalizes");
  assert.strictEqual(generalizeSubject('[data-testid="row-7"]'), "[data-testid]", "a data-testid selector generalizes");
  assert.strictEqual(generalizeSubject("order/123e4567-e89b-12d3-a456-426614174000"), "order/:uuid", "a uuid generalizes");
  assert.strictEqual(generalizeSubject("row-58"), "row-:n", "bare digit runs generalize");
  console.log("selftest OK: §2 generalizeSubject strips origin-specific identifiers to a site-agnostic signature");
}

{
  const mkRow = (origin: string, runCount: number, successCount: number): ExperienceRow => ({
    id: 1, origin, scope: "site", kind: "recovery", subject: "#login-button-42", predicate: "recovery", object: "waitUntilEnabled",
    confidence: 0.8, source: "observed", evidence: "[]", runCount, successCount, lastRunId: "r", updatedAt: 1, contradictedAt: null,
  });
  const threeOrigins = [mkRow("https://a.com", 5, 5), mkRow("https://b.com", 5, 4), mkRow("https://c.com", 5, 4)];
  const promoted = computeGlobalPromotions(threeOrigins, 9999);
  assert.strictEqual(promoted.length, 1, "a recovery seen across ≥3 origins at ≥70% success promotes to a global row");
  assert.strictEqual(promoted[0].scope, "global", "the promoted row is global-scoped");
  assert.strictEqual(promoted[0].origin, "", "a global row carries no origin");
  assert.strictEqual(promoted[0].subject, "#id", "the promoted subject is generalized, not any one origin's literal selector");

  const twoOrigins = [mkRow("https://a.com", 5, 5), mkRow("https://b.com", 5, 5)];
  assert.strictEqual(computeGlobalPromotions(twoOrigins, 9999).length, 0, "fewer than 3 distinct origins does not promote");

  const lowRate = [mkRow("https://a.com", 5, 1), mkRow("https://b.com", 5, 1), mkRow("https://c.com", 5, 1)];
  assert.strictEqual(computeGlobalPromotions(lowRate, 9999).length, 0, "below the success-rate threshold does not promote");
  console.log("selftest OK: §2 computeGlobalPromotions promotes a recovery pattern only across ≥3 origins at ≥70% success");
}

{
  const facts = new FactStore();
  const rows: ExperienceRow[] = [
    { id: 1, origin: "https://a.com", scope: "site", kind: "fact", subject: "candidate", predicate: "state", object: "hired", confidence: 0.9, source: "observed", evidence: "[]", runCount: 3, successCount: 3, lastRunId: "r", updatedAt: 1, contradictedAt: null },
    { id: 2, origin: "https://a.com", scope: "site", kind: "fact", subject: "candidate", predicate: "state", object: "stale", confidence: 0.3, source: "observed", evidence: "[]", runCount: 1, successCount: 1, lastRunId: "r", updatedAt: 1, contradictedAt: 5 },
    { id: 3, origin: "https://a.com", scope: "site", kind: "recovery", subject: "x", predicate: "recovery", object: "y", confidence: 0.9, source: "observed", evidence: "[]", runCount: 3, successCount: 3, lastRunId: "r", updatedAt: 1, contradictedAt: null },
  ];
  const seeded = recallFacts(facts, rows);
  assert.strictEqual(seeded, 1, "only the fact row above the confidence floor is seeded — recovery rows and contradicted facts are not facts");
  assert.ok(facts.knows("candidate", "state"), "the seeded fact is queryable — this is what lets §3.5 skip re-probing it");
  assert.ok(summarizeForPrompt(rows)!.includes("candidate"), "the prompt summary mentions a notable recalled row");
  console.log("selftest OK: §1.3 recallFacts seeds only trustworthy fact rows, gating §3.5 re-probing");
}

{
  const rows: ExperienceRow[] = [
    { id: 1, origin: "a", scope: "site", kind: "recovery", subject: "login:role1", predicate: "recovery", object: "lowercase-email", confidence: 0.7, source: "observed", evidence: "[]", runCount: 9, successCount: 8, lastRunId: "r", updatedAt: 1, contradictedAt: null },
    { id: 2, origin: "a", scope: "site", kind: "recovery", subject: "login:role1", predicate: "recovery", object: "flaky-strategy", confidence: 0.7, source: "observed", evidence: "[]", runCount: 9, successCount: 2, lastRunId: "r", updatedAt: 1, contradictedAt: null },
  ];
  const best = recallRecoveryStrategy(rows, "login:role1");
  assert.ok(best && best.strategy === "lowercase-email", "recall picks the strategy with the highest success rate above the trust floor");
  assert.strictEqual(recallRecoveryStrategy(rows, "login:unknown-role"), null, "no match for a subject with no recorded recovery");
  console.log("selftest OK: §1.3 recallRecoveryStrategy recalls the reliable strategy for a known failure signature");
}

// Human feedback loop (Plan-v8 §3): normalization and suppression are pure, selftested
// without a database.
{
  const same = (a: [string, string, string | null], b: [string, string, string | null]): boolean => {
    const na = normalizeForFingerprint(...a);
    const nb = normalizeForFingerprint(...b);
    return na.agent === nb.agent && na.title === nb.title && na.pageUrl === nb.pageUrl;
  };
  assert.ok(same(["security", "Order #4521 failed to load", "https://x.com/orders/4521"], ["security", "Order #9981 failed to load", "https://x.com/orders/9981"]),
    "a dynamic id in both title and URL normalizes to the same identity");
  assert.ok(same(["a11y", "Missing alt text", "https://x.com/checkout?ref=abc"], ["a11y", "Missing alt text", "https://x.com/checkout#top"]),
    "query string and hash fragment are dropped");
  assert.ok(same(["security", "Weak cookie on user/00000000-0000-4000-8000-000000000000", "https://x.com/a"], ["security", "Weak cookie on user/11111111-1111-4111-8111-111111111111", "https://x.com/a"]),
    "a uuid embedded in the title normalizes the same");
  assert.ok(!same(["security", "x", "https://x.com/users/42"], ["security", "x", "https://x.com/orders/42"]),
    "different literal path segments are NOT the same finding");
  assert.ok(!same(["security", "x", "https://x.com/a"], ["a11y", "x", "https://x.com/a"]),
    "different agents are NOT the same finding");
  console.log("selftest OK: §3.2 normalizeForFingerprint collapses dynamic ids/counts to a stable identity without merging distinct findings");
}

{
  const findings = [{ fingerprint: "fp1", title: "A" }, { fingerprint: "fp2", title: "B" }, { fingerprint: "fp3", title: "C" }];
  const feedback = new Map<string, FeedbackEntry>([
    ["fp1", { verdict: "false_positive", reason: "shadow DOM" }],
    ["fp2", { verdict: "confirmed", reason: "" }],
  ]);
  const { visible, suppressed, confirmed } = partitionByFeedback(findings, feedback);
  assert.strictEqual(visible.length, 2, "false-positive is removed from visible, confirmed and unmarked stay");
  assert.ok(!visible.some((f) => f.fingerprint === "fp1"), "the false-positive finding is not in the visible set");
  assert.strictEqual(suppressed.length, 1, "exactly one suppressed entry");
  assert.strictEqual(suppressed[0].reason, "shadow DOM", "the stored reason is carried through, never dropped");
  assert.ok(confirmed.has("fp2"), "a confirmed finding is tagged, not suppressed");
  console.log("selftest OK: §3.3 partitionByFeedback suppresses false-positive/intended, tags confirmed, never deletes");
}

// OWASP Top 10 mapping (Plan-v8 §6): CWE map, coverage matrix, npm audit parsing, and
// the A07 lockout-probe safety guard are all pure, selftested without a database/network.
{
  for (const [cwe, cats] of Object.entries(CWE_TO_OWASP)) {
    for (const c of cats) assert.ok(OWASP_CATEGORIES.includes(c), `CWE ${cwe} maps to a real OWASP category (${c})`);
  }
  assert.deepStrictEqual(owaspForCwe(79), ["A03:2021"], "a mapped CWE (XSS) resolves to its category");
  assert.strictEqual(owaspForCwe(999999), undefined, "an unmapped CWE gets no tag — never a guess");
  assert.strictEqual(owaspForCwe(null), undefined, "no CWE id at all gets no tag");
  console.log("selftest OK: §6.3 CWE→OWASP map is total over its own key set and never guesses on an unmapped CWE");
}

{
  const tested = new Map<string, Set<string>>([
    ["https://x.com/a", new Set(["permissions", "crawler"])],
    ["https://x.com/b", new Set(["security"])],
  ]);
  const findings = [{ owasp: ["A01:2021"] }, { owasp: ["A01:2021", "A05:2021"] }, { owasp: undefined }];
  const rows = buildOwaspCoverage(tested, findings, { "A06:2021": 1, "A07:2021": 3 });
  assert.strictEqual(rows.length, 10, "all ten categories are always listed, never omitted");
  const a01 = rows.find((r) => r.category === "A01:2021")!;
  assert.strictEqual(a01.tested, 1, "A01 'tested' comes from the existing url×agent map — one url touched by permissions");
  assert.strictEqual(a01.findings, 2, "A01 findings count sums findings tagged with that category");
  const a04 = rows.find((r) => r.category === "A04:2021")!;
  assert.strictEqual(a04.tested, null, "A04 is honestly not tested — never a fake zero");
  assert.ok(a04.notTestedReason, "a not-tested category carries its reason");
  const a06 = rows.find((r) => r.category === "A06:2021")!;
  assert.strictEqual(a06.tested, 1, "A06's one-off tested count (npm audit ran) is passed through, not derived from the url map");
  console.log("selftest OK: §6.4 buildOwaspCoverage lists all ten categories, sources counts from the existing tested map, never invents partial coverage");
}

{
  const fixture = { vulnerabilities: { lodash: { severity: "high", fixAvailable: true }, minimist: { severity: "moderate", fixAvailable: false } } };
  const vulns = parseNpmAudit(fixture);
  assert.strictEqual(vulns.length, 2, "npm audit fixture parses both vulnerable packages");
  assert.ok(vulns.find((v) => v.name === "lodash" && v.severity === "high" && v.fixAvailable), "severity and fixAvailable are read through");
  assert.strictEqual(parseNpmAudit({}).length, 0, "a report with no vulnerabilities key parses to an empty list, not a crash");
  console.log("selftest OK: §6.5 parseNpmAudit reads a fixture JSON report with no network call");
}

{
  const roles = [{ username: "admin@example.com" }, { username: "user@example.com" }];
  assert.ok(isSafeProbeUsername("qabot-nonexistent-123@example.invalid", roles), "a fabricated username not matching any configured role is safe to probe");
  assert.ok(!isSafeProbeUsername("admin@example.com", roles), "a username matching a configured role is NEVER safe — the lockout probe must refuse it");
  assert.ok(!isSafeProbeUsername("Admin@Example.com", roles), "the check is case-insensitive — a differently-cased real account is still a real account");
  console.log("selftest OK: §6.5 A07 lockout probe's username guard refuses any username matching a configured role's credentials");
}

// Multi-model verification + routing (Plan-v8 §4): routing is pure, selftested
// without a network call.
{
  assert.deepStrictEqual(parseAiRoute('{"vision":"google/gemini-2.0-flash","classify":"qwen/qwen-2.5-7b"}'),
    { vision: "google/gemini-2.0-flash", classify: "qwen/qwen-2.5-7b" }, "AI_ROUTE JSON parses purpose->model");
  assert.deepStrictEqual(parseAiRoute("not json"), {}, "malformed AI_ROUTE never throws, just yields no routes");
  assert.deepStrictEqual(parseAiRoute(undefined), {}, "unset AI_ROUTE yields no routes");
  assert.strictEqual(resolveRoutedModel("verify", "openai/gpt-4o-mini", {}), "openai/gpt-4o-mini", "the verify purpose routes to AI_VERIFY_MODEL");
  assert.strictEqual(resolveRoutedModel("verify", undefined, {}), null, "verify purpose with no AI_VERIFY_MODEL does not route");
  assert.strictEqual(resolveRoutedModel("vision", undefined, { vision: "google/gemini-2.0-flash" }), "google/gemini-2.0-flash", "a non-verify purpose routes via AI_ROUTE");
  assert.strictEqual(resolveRoutedModel(undefined, "x", { plan: "y" }), null, "no purpose at all never routes — today's default behavior is untouched");
  console.log("selftest OK: §4.1 AI_ROUTE parsing and purpose→model resolution never silently falls back to the primary provider");
}

{
  assert.deepStrictEqual(classifyVerifyResult({ verdict: "refuted", reason: "no evidence of X" }), { verdict: "refuted", reason: "no evidence of X" }, "a valid verdict parses through");
  assert.strictEqual(classifyVerifyResult({ verdict: "maybe" }), null, "an invalid verdict value is rejected, not coerced");
  assert.strictEqual(classifyVerifyResult(null), null, "no response at all is rejected");
  console.log("selftest OK: §4.2 classifyVerifyResult narrows untrusted tool output to a real verdict or null");
}

// MCP server target-origin guard (Plan-v8 §5.1): pure, selftested. Defaults to
// loopback-only since an MCP server is a standing process any connected client
// can call `run_test` on — unlike the CLI, which is unguarded by design (whoever
// runs it already has that access).
{
  assert.ok(targetOriginAllowed("http://localhost:3400/anything", undefined), "loopback is always allowed with no allowlist configured");
  assert.ok(targetOriginAllowed("http://127.0.0.1:3400", undefined), "127.0.0.1 counts as loopback too");
  assert.ok(!targetOriginAllowed("https://example.com", undefined), "a non-loopback origin is refused with no allowlist configured — the safe default");
  assert.ok(targetOriginAllowed("https://staging.example.com/foo", "https://staging.example.com,http://localhost:3000"), "an origin in MCP_ALLOWED_ORIGINS is allowed regardless of path");
  assert.ok(!targetOriginAllowed("https://evil.example.com", "https://staging.example.com"), "an origin NOT in MCP_ALLOWED_ORIGINS is refused even when the env var is set");
  assert.ok(!targetOriginAllowed("not a url", undefined), "an unparseable url is refused, not thrown");
  console.log("selftest OK: §5.1 targetOriginAllowed defaults to loopback-only and MCP_ALLOWED_ORIGINS is an exact-origin allowlist");
}

// §3.5 probe-executor loop, end-to-end through a fake browser IO. Kept in a guarded async
// IIFE at the file's end because the selftest runner is cjs (no top-level await); a thrown
// assertion becomes an explicit non-zero exit so a regression still fails the run.
void (async (): Promise<void> => {
  try {
    const controls: ProbeTarget[] = [
      { ref: "r1", role: "button", name: "Archive" },
      { ref: "r2", role: "link", name: "Help Center" },
    ];
    const plan = planProbes("candidate", controls, { disposableEntityExists: true, onTestPath: () => true, knows: () => false });
    // Fake IO: "Archive" moves the state key and fires a 2xx; "Help Center" leaves it unchanged.
    const after = new Map<string, string>([["Archive", "s2"], ["Help Center", "s1"]]);
    let cur = "s1";
    const io: ProbeIO = {
      async stateKey() { return cur; },
      async perform(item: ProbePlanItem) { cur = after.get(item.action) ?? cur; return { quality: "clean", apiStatus: item.action === "Archive" ? 200 : null }; },
    };
    const facts = new FactStore();
    const learned = await runProbePlan(facts, "candidate", plan, io);
    assert.strictEqual(learned.length, 2, "both greenlit probes learned a fact");
    assert.strictEqual(learned.find((f) => f.predicate === "effect-of:Archive")!.object, "mutates-state", "the state-changing probe learned 'mutates-state'");
    assert.ok(facts.knows("candidate", "effect-of:Archive"), "the driver's learned facts land in the store and gate re-probing");
    console.log("selftest OK: §3.5 probe-executor runs a greenlit plan end-to-end into learned facts");
  } catch (e) {
    console.error("selftest FAIL: §3.5 probe-executor loop", e);
    process.exit(1);
  }
})();

// §4.2 crossModelVerify, end-to-end through a mocked global.fetch — kept guarded and
// async for the same cjs-no-top-level-await reason as the block above.
void (async (): Promise<void> => {
  const originalFetch = global.fetch;
  const savedVerifyModel = process.env.AI_VERIFY_MODEL;
  const savedOpenRouterKey = process.env.OPENROUTER_API_KEY;
  try {
    const mkFinding = (over: Partial<Finding> = {}): Finding => ({
      id: 1, runId: "r", agent: "ai-reviewer", severity: "high", kind: "bug", source: "ai", confidence: 0.7,
      title: "X", detail: "evidence", pageUrl: null, role: null, evidence: null, fingerprint: "fp1", fingerprintV: 2, afterHuman: false, owasp: [],
      ...over,
    });

    delete process.env.AI_VERIFY_MODEL;
    let fetchCalls = 0;
    global.fetch = (() => { fetchCalls++; throw new Error("should not be called without AI_VERIFY_MODEL"); }) as typeof fetch;
    const noEnvResult = await crossModelVerify([mkFinding()], new Set());
    assert.deepStrictEqual(noEnvResult, [], "no AI_VERIFY_MODEL → no verdicts");
    assert.strictEqual(fetchCalls, 0, "no AI_VERIFY_MODEL → zero fetch calls, never a silent fallback to the primary provider");

    process.env.AI_VERIFY_MODEL = "openai/gpt-4o-mini";
    process.env.OPENROUTER_API_KEY = "test-key";
    global.fetch = (async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ verdict: "refuted", reason: "not reproducible from the evidence given" }) } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      text: async () => "",
    })) as unknown as typeof fetch;
    const verified = await crossModelVerify([mkFinding()], new Set());
    assert.strictEqual(verified.length, 1, "a mocked refute call produces one verdict");
    assert.strictEqual(verified[0].verdict, "refuted", "the verdict is read through — report-doc.ts demotes this to the Unverified section");

    const skipped = await crossModelVerify([mkFinding()], new Set(["fp1"]));
    assert.deepStrictEqual(skipped, [], "a finding already confirmed by a human (Phase 3) is never sent for a second opinion");

    console.log("selftest OK: §4.2 crossModelVerify makes zero calls without AI_VERIFY_MODEL, demotes a mocked refuted verdict, and skips human-confirmed findings");
  } catch (e) {
    console.error("selftest FAIL: §4.2 crossModelVerify", e);
    process.exit(1);
  } finally {
    global.fetch = originalFetch;
    if (savedVerifyModel === undefined) delete process.env.AI_VERIFY_MODEL; else process.env.AI_VERIFY_MODEL = savedVerifyModel;
    if (savedOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
  }
})();

// Page-judge multi-viewport shots: full mode gets extra below-the-fold shots on
// tall pages so the AI eye sees more than the top viewport; smart/quick stay at
// one shot (breadth over depth), and a zero-height viewport never divides by 0.
{
  assert.deepStrictEqual(judgeShotFractions(800, 800, "full"), [0], "short page: one shot even in full mode");
  assert.deepStrictEqual(judgeShotFractions(2000, 800, "full"), [0, 1], "2-5 viewports tall: top + bottom");
  assert.deepStrictEqual(judgeShotFractions(8000, 800, "full"), [0, 0.5, 1], ">=5 viewports tall: top + middle + bottom");
  assert.deepStrictEqual(judgeShotFractions(8000, 800, "smart"), [0], "smart mode always one shot — keeps page breadth within the AI budget");
  assert.deepStrictEqual(judgeShotFractions(8000, 0, "full"), [0], "zero viewport height falls back to one shot, no division by zero");
  console.log("selftest OK: judgeShotFractions scales AI-judge shots by page height and run mode");
}

// Page-judge target picking: one page per inferred type first, then top up from
// the ranked crawl. Regression guard — a real run against a dashboard-style SaaS
// inferred a single page type for every page, so the AI judge looked at exactly
// 1 page of 205 and left ~95% of its token slice unspent.
{
  const types = new Map([["/a", "list"], ["/b", "list"], ["/c", "list"]]);
  const ranked = ["/a", "/b", "/c", "/d", "/e"];
  const collapsed = pickJudgeTargets(types, ranked, 4);
  assert.strictEqual(collapsed.length, 4, "one collapsed page type still fills every judge slot from the ranked crawl");
  assert.deepStrictEqual(collapsed.map((t) => t[1]), ["/a", "/b", "/c", "/d"], "type representative first, then ranked order, no repeats");
  assert.strictEqual(collapsed[3][0], "unknown", "a topped-up page with no inferred type is labelled unknown, not mislabelled");

  const varied = pickJudgeTargets(new Map([["/x", "list"], ["/y", "detail"], ["/z", "form"]]), ["/x", "/y", "/z", "/w"], 3);
  assert.deepStrictEqual(varied.map((t) => t[0]), ["list", "detail", "form"], "distinct types win the slots over topping up");
  assert.deepStrictEqual(pickJudgeTargets(new Map(), ["/only"], 4), [["unknown", "/only"]], "no page types at all still judges the crawled pages");
  assert.deepStrictEqual(pickJudgeTargets(new Map(), [], 4), [], "nothing crawled means nothing to judge");
  console.log("selftest OK: pickJudgeTargets spreads across page types then tops up so the AI judge budget is not left unspent");
}
