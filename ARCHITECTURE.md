# webtester — Architecture & How It Works

> Status: current as of 2026-07-16. Includes Plan-v3 fixes (login transparency, anonymous fallback, structured report), **Plan-v4 batches 1+2** (risk sampling, multi-run memory, parallel verification, coverage totals, journey engine, senior reviewer, root-cause correlation, fault injection, input fuzzing, browser chaos), **and Plan-v5 batches 1+2** — batch 1: requirement-validation, SEO, adaptive sampling; batch 2: API response validation, analytics detection, memory-leak probe, file-upload, email flows, AI explorer, per-step journey assertions, recovery testing. Remaining boundary rejects are in §17.

webtester is a local Next.js app that points a fleet of Playwright agents at any target website and tests it the way a QA team would: log in as every configured role, crawl and click through the app, verify routes/forms/accessibility/performance/security/visuals deterministically, drive user-defined **business journeys** with an AI Navigator, break the site on purpose (fault injection, chaos), then let an AI layer judge what heuristics can't and a senior-QA AI pass sign off on the whole run. Everything lands in SQLite as findings with screenshot evidence; each run ends with a structured coverage report plus recurrence patterns and root-cause clusters.

**Stack:** Next.js 16 (App Router) · Playwright 1.60 (chromium/firefox/webkit) · better-sqlite3 · axe-core · @anthropic-ai/sdk / OpenRouter · tsx CLI.

---

## 1. Run lifecycle (the big picture)

```
UI "Run" button ──▶ startRun() ──▶ executeRun(runId, project, mode)   [background]
      (or CLI: npm run agents -- --url ...)

executeRun:
  planMission(mode)                      ← scopes everything: agents, sample size, AI budget, devices
  snapshot prior page labels             ← for change detection (§10)
  launch browser engines needed
  │
  ├─ register agent                      (once, unauthenticated, only if registerPath set)
  │
  ├─ OPEN SESSIONS (primary profile = Desktop Chrome)
  │    per role: password login (login agent)
  │    sessionState configured → inject Playwright storageState ("Session" pseudo-role)
  │    no roles at all → plain context ("Anonymous" pseudo-role)
  │    ALL logins failed → anonymous fallback session + info finding
  │    anonymous-only → detectAuthType() classifies the login page (password/oauth-only/magic-link/none)
  │
  ├─ PER SESSION (role):
  │    ── order-dependent spine (sequential) ──
  │    crawler → (reorder pages: new/changed first) → site-classifier (first role only)
  │    → interaction (clicks; adopts SPA routes — runs early ON PURPOSE)
  │    → route-health → page-expectations → api-mapper
  │    ── parallel verification (P3) ──
  │    Promise.all [security | form-validation | data-integrity]   (cheap DOM readers)
  │    Promise.all [a11y | ui-audit | seo]                         (CPU-heavier renderers)
  │    perf   (alone — concurrent load skews navigation timing)
  │    visual (last — writes baselines)
  │    ── full-mode adversarial passes ──
  │    resilience (5 injected faults, throwaway contexts)
  │    chaos      (viewport/emulation + double-click spam)
  │    crud       (full mode + non-production only)
  │
  ├─ permissions agent                   (cross-role IDOR matrix, needs ≥2 live sessions)
  │
  ├─ EXTRA DEVICE PROFILES (smart/full): fresh login per role, then re-render
  │    already-discovered pages: ui-audit, a11y, perf, visual only (no re-crawl)
  │
  ├─ root-cause agent                    (deterministic failure clustering — no AI, no browser)
  │
  ├─ AI LAYER (smart/full + API key), budget split:
  │    reserve ~2k for senior review
  │    journeys defined → journey engine gets 40% of the remainder
  │    requirements defined → requirement-validation gets 30% of what's left
  │    page-judge   ← 60% of what's left (vision: screenshot + text per page type)
  │    ai-reviewer  ← the rest (text-only whole-site reasoning)
  │
  ├─ regression agent                    (fingerprint diff vs previous run + multi-run patterns)
  │
  └─ FINISH: buildRunReport() + computeCoverageTotals() + patterns → runs.report_json
     senior-review agent (AI) reads the assembled report → report.seniorReview + info finding
     summary = headline + ✓/✗ per-role session lines + top-8 issue digest
     status  = "failed" if any critical/high finding, else "passed"
```

Every agent call is wrapped in `withRecovery` (§11): throw → retry once → report-and-continue. One flaky agent never kills the rest of the run.

---

## 2. Run modes & the Mission Planner (`planner.ts`)

The planner is deliberately heuristic — no LLM needed to scope a run.

| | quick | smart | full |
|---|---|---|---|
| Pages sampled per agent per role | 3 | 6 | 12 |
| Device profiles | Desktop Chrome | + Mobile Chrome | all 5 (adds Firefox, Safari, iPhone 14) |
| AI token budget | **0 (provably off)** | 20,000 | 60,000 |
| Journeys | — | ✓ | ✓ |
| Resilience / chaos / CRUD | — | — | ✓ (CRUD non-production only) |

Conditional agents: `permissions` only with >1 role; `register` only with a signup path; `journey` only with journeys defined + AI key; `requirements` only with acceptance criteria defined + AI key; `page-judge`/`ai-reviewer`/`senior-review` only with a key and mode ≠ quick. The mission's human-readable `reason` string is logged at run start.

Role cap: `MAX_SIMULTANEOUS_ROLE_SESSIONS = 6` — each Chromium context is ~100–300 MB and the permissions agent needs every role's session open at once; extra roles are skipped with a warning.

---

## 3. Sessions & authentication (`agents/login.ts`, `orchestrate.ts`)

Three ways a session gets established, tried in this order per spec:

1. **Password login** (roles with username+password). The login agent:
   - Opens `project.loginPath`, finds fields heuristically: user field = `input[type=email] | name/id contains "email"/"user" | autocomplete=username`; password = `input[type=password]`. Submit = `button/input[type=submit]` or text "log in"/"login"/"sign in", else presses Enter.
   - Success check handles modern async auth (NextAuth/authjs, Firebase, SPA XHR logins): it waits for the page to **hydrate** (`networkidle` after load) before clicking so the click doesn't land before `signIn()` is wired; it does **not** wait for networkidle *after* submit (these stacks poll `/api/auth/session` continuously, so the network never idles) and instead **polls ~16 s** for the URL leaving the login path or the password field detaching; and it **re-clicks** at ~4 s/~9 s if there's no progress and no error banner, covering a first click that raced hydration. (Diagnosed and fixed against a live 5-role NextAuth app that previously false-failed every login.)
   - **On failure it quotes the site**: scrapes visible text from `[role=alert]`, `[aria-live]`, `[class*=error|alert|danger|invalid]`; `pickLoginError()` prefers strings matching `/invalid|incorrect|wrong|fail|not match|denied|locked|too many|captcha|expired/i` over cookie-banner noise — so a bad credential is never mistaken for a tool bug.
   - **Case-sensitivity retry**: uppercase username + first attempt failed → retries once lowercased. Success → session proceeds **and** a high finding "Login email is case-sensitive" is filed (a real bug in the target).
   - Evidence screenshots at every stage: `-login-filled`, `-login-retry-lowercase`, `-logged-in`, `-login-failed`.
2. **Injected storage state** (`project.sessionState` = Playwright storageState JSON) — the only way to test OAuth-only sites. Verified by loading the app and checking `looksLoggedOut()` didn't bounce back to login; expired state → high finding with re-export instructions.
3. **Anonymous** — no roles configured, public surface only.

**Anonymous fallback**: if *every* configured login fails, the run opens a plain "Anonymous" context, files an info finding, and still runs the whole public-surface pipeline. The login criticals stay in the report.

**Auth-type detection**: on anonymous-only runs, `detectAuthType()` classifies the login page — `password` / `oauth-only` / `magic-link` / `none` — so the report explains *why* authenticated flows were skipped and what would enable them.

**Mid-crawl session expiry**: the crawler watches for a logged-out bounce (`looksLoggedOut`) and calls `reauth()` — a re-login in the *same* browser context, which re-auths every open page since cookies are context-scoped.

---

## 4. Device & browser matrix (`devices.ts`)

Five curated profiles: Desktop Chrome (chromium), Desktop Firefox, Desktop Safari (webkit), Mobile Chrome (Pixel 7), Mobile Safari (iPhone 14).

Only `profiles[0]` (always Desktop Chrome) runs the full pipeline including discovery. Additional profiles get a fresh login (catches device-specific auth bugs) then only **re-render already-discovered pages** through ui-audit, a11y, perf, and visual — server-derived data (headers, API map, form markup) would be identical, so re-crawling under every engine would just burn time.

---

## 5. Risk-weighted sampling (P1, `graph.ts` + `context.ts`)

Every sampling agent used to take the first N crawled pages; now they all call `ctx.sampleFor(role, n)`:

- Score per page = `riskScore(pathname)` (§10) **+ 40 if new since last run + 20 if changed** (reuses graph change detection) **+ 30 if the page carried a finding in a recent run** (adaptive sampling, Plan-v5 R3 — `ctx.hotPaths`, loaded from `recentFindingUrls()` at run start).
- Sort descending, take n — with a **type-diversity guarantee**: at least one page per known page type (from `ctx.pageTypes`), so a sample of 6 is never six list pages.
- Effect: `/checkout`, `/admin`, and anything with a history of breaking are always in the sample; `/faq` only rides along when there's room. Pure `rankPages()` is selftested. On a project's first run `hotPaths` is empty → identical to plain risk sampling.

---

## 6. The agent fleet (28 agents)

### Discovery

**crawler** — BFS over same-origin pages after login. `MAX_PAGES = 40`, with template sampling: `urlTemplate()` collapses numeric/uuid/hash path segments (`/surah/2` … `/surah/114` → one template, max 3 samples each, max 8 per parent directory). `seedFromSitemaps()` parses robots.txt + sitemap.xml first (500 URL cap, 3 nested index levels). Hooks `history.pushState/replaceState` for SPA routes, collects links from anchors, shadow DOM, and same-origin iframes; records per page: HTTP status, title, console errors, failed requests, same-origin API calls, screenshot. The `UNSAFE` regex (`logout|sign-out|delete|remove|destroy|deactivate|/api/|mailto:|tel:|javascript:`) guarantees the read-only crawler never logs itself out or triggers a destructive GET — selftested as security-critical.

**site-classifier** — runs once after the first role's crawl. Fingerprints the framework (`__NEXT_DATA__`, `__NUXT__`, `___gatsby`, `[ng-version]`, React roots…), counts commerce signals, measures `apiRatio` and `templatedRatio`. Verdict (first match): ≥2 commerce hits → **ecommerce**; auth + apiRatio > 1 → **saas**; framework + apiRatio > 0.5 → **spa**; templated/articles/CMS → **content**; else **static**. Stored on `ctx.siteProfile`; the AI layer uses it to reason about what "correct" looks like here.

**interaction** — fills the "crawler only sees `<a href>`" gap; runs **early** so everything it discovers is tested by the agents after it. On each sampled page it clicks up to 12 visible non-link controls, skipping destructive labels via `UNSAFE`, settling 700 ms per click:
- Click navigates → same-origin, unseen, safe, ≤2 per URL template → the route is **adopted** into `ctx.pages` (cap 8) and queued for probing. This is why button-nav SPAs still get coverage.
- Click throws a JS error → medium finding with console output.
- Click visibly does nothing (DOM node-count delta < 2, no nav, no error) → low-confidence "control appears to do nothing" finding.
- Mutes and `play()`s up to 3 `<audio>/<video>` elements, verifies `currentTime` advances after 1.5 s — catches players that render but can't play.
- Feeds `ctx.coverage.controlsSeen / controlsClicked` for the coverage totals (§13).

### Verification (deterministic, zero AI cost — runs in parallel groups, §1)

**route-health** — reads the crawl output, no re-navigation: status ≥500 → high, 4xx → medium, missing `<title>` → low, console errors → medium (up to 5), failed subresources → medium (up to 6).

**page-expectations** — deterministic "understand the page without AI". `inferPageType()` classifies each page (error / search / article / detail / list / form / landing / unknown) from structure. Then enforces per-type invariants on a sample: `<main>` text < 40 chars → high "renders almost no content" (catches silent client-side crashes); detail/article prev/next must navigate; search must react to a query. Also emits the site-map finding: URL template → page type.

**api-mapper** — reports the same-origin API endpoints accumulated by the crawler's network interception (persisted as graph nodes). Inventory only.

**api-validation** (Plan-v5 R4, `agents/apiValidation.ts`) — deterministic, no browser. The crawler now captures up to 60 same-origin JSON response *bodies*; pure `analyzeApiResponses()` (selftested) flags two black-box-observable defects per endpoint template: a **2xx response whose every field is null/empty** ("loads but shows nothing" — medium) and **shape drift** (the same template returning different top-level key sets across calls — low). Conservative by design: empty arrays and non-2xx are out of scope (route-health owns statuses).

**analytics** (Plan-v5 R7, `agents/analytics.ts`) — deterministic. The crawler tags requests to known telemetry hosts (GA/GTM, Meta Pixel, Segment, Mixpanel, Amplitude, Hotjar, Plausible, PostHog, Clarity) via `analyticsProvider()`; the agent reports which fired (info) and, via pure `assessAnalytics()`, flags a **revenue site (ecommerce/saas) with zero analytics** (low) — content/static sites legitimately run without it. Presence is observable; per-event correctness needs a journey (noted in the finding).

**form-validation** — static markup audit: required inputs without label → medium; password/email missing `autocomplete` → low; fields with neither name nor id → low. Plus one **active check on non-production only** (P9.3): submit an empty required form — 5xx → high, silent navigation → medium (conf 0.6), validation holds → pass. The never-submit rule stays absolute on production.

**data-integrity** — same-page formatting consistency: currency strings and dates classified by format; a page showing ≥2 values in ≥2 conventions → medium (currency) / low (dates).

**security** — passive only: production without HTTPS → high; missing CSP / x-frame-options → medium, x-content-type-options / referrer-policy → low; HTTPS without HSTS → medium. Session-ish cookies missing `httpOnly`/`secure` or `SameSite=None` → high. Header findings emitted once per run.

**a11y** — injects axe-core from an absolute disk path (`require.resolve` gets mangled by Turbopack), scrolls to mount lazy content, runs violations-only. critical/serious → high, moderate → medium, else low.

**perf** — navigation timing per sampled page: load > 8 s → high, 4–8 s → medium. Runs alone (parallel load would skew timing). No CWV/INP/Lighthouse yet — deliberate.

**ui-audit** — per page: dead links, horizontal overflow, clipped text. Cross-page: design-token outliers (body font, button color, h1 size) via `findOutliers()` — only with ≥3 samples and a >50% majority. Token check primary profile only.

**visual** — full-page screenshot regression per page per profile, baselines under `public/baselines/{project}/{profile}/`. No baseline → record; identical → silent; different → low finding + **auto-accept new baseline** (no approval UI yet). Also broken images (medium) and CLS > 0.25 (medium).

**seo** (Plan-v5 R2, `agents/seo.ts`) — deterministic discoverability audit. Per risk-weighted sample (primary profile) reads the tags a search crawler/social scraper reads via one `page.evaluate`: `<title>` presence/length, meta description, canonical, viewport, `<html lang>`, `<h1>` count, Open Graph title/image, `noindex`. Once per run checks robots.txt + sitemap.xml return 200. Pure `auditSeoTags()` (selftested) turns signals → issues. All findings are **improvements** (SEO is quality, never flips a run to failed) except a production `noindex`, which is a real "invisible to search" **bug**.

### Flows (state-changing, guarded)

**register** — once per run, unauthenticated, only if a signup path is configured. Synthetic sweepable identity (`qa-bot-{seed}@domain`), fills, submits; if a Mailpit/MailHog inbox URL is configured, polls its REST API (10 × 1.5 s), extracts OTP or verify link, completes verification. Still on the form at the end → high; success → info.

**crud** — full mode **and** non-production only (double-guarded). Up to 3 create-forms, fills with the run-unique tag `qabot-{runId8}`, submits, verifies the value appears, best-effort deletes, warns if junk left behind.

**permissions** — cross-role IDOR matrix using already-open sessions: role B GETs role A's unique routes (read-only). Reachable → **critical**. Bounded: 20 checks total, 6 routes per pair; needs ≥2 live sessions.

**file-upload** (Plan-v5 R5, `agents/fileUpload.ts`) — only when `project.uploadFilePath` is set, **non-production only** (it submits a real file). On the risk sample it finds `<input type=file>` controls, uploads the configured file, and checks the app *reacted* — filename shown, preview, or DOM change; if selection alone did nothing it clicks a nearby Upload/submit button (UNSAFE-filtered) and re-checks, so forms that need a submit aren't mis-flagged. No reaction → medium "accepted a file with no visible response"; upload handler throws → medium; reacted → info. (Server-side storage/scan/thumbnail are black-box — noted in the finding.)

**email-flows** (Plan-v5 R9, `agents/emailFlows.ts`) — only with a test inbox + a role email. Triggers "forgot password" from the login page, submits the role's email, and polls the Mailpit/MailHog inbox: reset email arrived → info (with the reset link if found); no email in ~12 s → **medium "password-reset email never arrived"** (locked-out users, no recovery); no forgot-password link at all → info. Non-destructive — requests a reset, never completes it.

**journey** (P5 — the "test like a human" centerpiece, `agents/journey.ts`) — user-defined business flows stored on the project (`journeys_json`, edited as JSON in the project form): `{ name, goal, steps: [{role, text}], maxActions?, persona? }`. For each journey a **Navigator (AI) → Executor (code) → Verifier (code)** loop runs:
- **Navigator**: one forced tool call per action. Sees the flow goal, current step, URL, a text digest of ≤60 visible interactive elements, and a rolling transcript. Returns `{action: click|fill|select|press|goto|step_done|journey_done|stuck, target?, value?, why}` with semantic targets ("the Publish button"), never selectors.
- **Executor**: resolves targets via `getByRole` → `getByLabel` → `getByPlaceholder` → `getByText(exact→loose)` (order selftested); applies personas — `keyboard-only` (focus+Enter), `mobile` (390×844 viewport), `slow-network` (CDP throttling); refuses UNSAFE targets; screenshots every action → replayable timeline.
- **Verifier**: `journey_done` claims checked deterministically (distinctive goal words present in body text). A step may also declare `expect` (Plan-v5 R6) — an observable the Verifier checks after that step; a cross-role step with `expect` is the black-box **cross-user-sync** check ("Jobseeker should now see QA-BOT {tag}" after the Employer created it), failing → high.
- **Cross-role steps = multi-user testing**: a step's role switches to that role's already-open session — Employer-creates → Jobseeker-applies → Employer-reviews with no new login machinery.
- **Budget & safety**: smart/full only; 40% of the post-reserve AI pool split per journey, capped at 8k tokens and 30 actions each; `{tag}` expands to `qabot-{runId8}` (sweepable data); `{edge:long}`/`{edge:xss}`/… expand to fuzz values (§8); destructive-verb steps (delete/pay/checkout/cancel…) refused on production.
- Findings: pass → info with the action transcript; break → **high** "Business flow `<name>` broke at step k" with the transcript and last screenshot. Feeds `journeysDefined/Passed` coverage.

### Adversarial (full mode only)

**resilience** (P8, `agents/resilience.ts`) — fault injection: re-loads a risk-ranked sample (≤4 pages) under one injected fault at a time — **offline**, **API-500** (`route` fulfill), **image-abort**, **slow-3G** (CDP), **JS-disabled** — each in a **throwaway context cloned from the role's storageState**, so faults never leak into the shared session. A pure `classifyReaction()` (selftested) decides graceful vs ungraceful: uncaught exception, raw stack trace shown, stuck spinner, or blank page → medium finding with screenshot; an explicit error/offline message passes. Read-only; safe on any environment.

**chaos** (P10, `agents/chaos.ts`) — cheap conditions a normal run never exercises, on ≤4 risk-ranked pages: (1) viewport/emulation sweep — mobile-320, wide-1920, dark-mode, reduced-motion, forced-colors — flagging horizontal overflow (> 4 px tolerance) → low finding; (2) double-click + rapid-spam ≤3 non-destructive controls (UNSAFE-filtered) watching for uncaught errors → medium "missing debounce/double-submit guard". Dialogs auto-dismissed.

**memory-leak** (Plan-v5 R18, `agents/memory.ts`) — Chromium only (needs `performance.memory`). Navigates the single riskiest page 8 times, sampling JS heap + live DOM node count each time; pure `classifyLeak()` (selftested) flags **sustained monotonic growth** past a factor (heap ≥1.8×, nodes ≥1.5× the post-warm-up baseline) → medium "possible memory leak on repeated navigation". A settled plateau passes; GC noise on one sample can't trigger it.

The **recovery scenario** (Plan-v5 R17) also lives in resilience: it takes the top page offline, reloads (broken), then reconnects and reloads — a page still blank after the network returns → medium "does not recover after the network returns" (worse than showing an offline message).

### Meta

**root-cause** (P7, `agents/rootCause.ts`) — deterministic correlation, no AI, no browser. Pure `clusterFailures()` groups this run's failures by shared signature: same `METHOD + urlTemplate` failing request on ≥2 pages, or same normalized console-error first line (URLs/numbers folded) on ≥3 pages. Each cluster → one **high** synthesis finding "N pages broken by one cause: GET /api/user/:n → 500" listing member pages — cause-reading instead of noise-reading. Clusters stashed on `ctx.rootCauses` for the senior reviewer.

**regression** (`agents/regression.ts`) — runs last. Set-diffs this run's finding fingerprints against the previous finished run → info "N new" / "N resolved". Plus **multi-run memory** (P2) via `findingHistory()` (one SQL query over existing tables, `idx_findings_fp` index): findings seen in ≥3 of the last 10 finished runs → info "recurring issue(s)"; absent last run but present in an older one → **medium "regression pattern: came back after being fixed"**. Results stashed on `ctx.patterns` → report + senior-reviewer prompt. Fingerprint = sha1 of `agent|title|pageUrl`.

---

## 7. The AI layer

### Provider abstraction (`ai.ts`)

- `ANTHROPIC_API_KEY` → Anthropic SDK, default model `claude-haiku-4-5-20251001` (`ANTHROPIC_MODEL` overrides).
- else `OPENROUTER_API_KEY` → OpenAI-compatible `chat/completions`, default `google/gemini-2.0-flash-001` (`OPENROUTER_MODEL` overrides). Anthropic wins when both exist. Keys live in `webtester/.env.local`.
- Everything goes through `aiToolCall()`: a **forced tool call** with a JSON schema — the model must return structured output, no free-text parsing. Supports base64 PNG images on both providers. Returns `{input, tokens}` feeding the budget.

### Budget waterfall (orchestrator)

```text
mission.aiTokenBudget (0 / 20k / 60k)
  − ~2k senior-review reserve
  → journeys defined? journey engine gets 40% of the remainder
  → requirements defined? requirement-validation gets 30% of what's left
  → full mode? AI explorer gets 25% of what's left
  → page-judge gets 60% of what's left (vision)
  → ai-reviewer gets the rest (text)
```

Quick mode's budget is literally 0 — the AI layer is *provably* off (selftested). Actual spend is stored on the run row (`ai_tokens`) and shown in the UI. AI findings are advisory: deterministic findings carry `confidence 1.0`, AI ones `0.7`, badged `AI` in the UI.

### page-judge (`agents/pageJudge.ts`) — vision

Picks **one representative page per page type** (max 4), viewport screenshot + first 1500 chars of visible text, asks: given a `{siteKind}` site and a `{pageType}` page, is anything visibly broken/missing/wrong? Up to 3 findings per page, per-page spend capped at min(700, remaining), stops cleanly at budget end.

### ai-reviewer (`agents/aiReviewer.ts`) — whole-site reasoning

Text-only. Input: site profile, project notes, top 8 pages from the knowledge graph by **risk score** (url + risk + console-error count). Asks for bugs *and* UX improvements; up to 6 findings; capped at min(1500, remaining).

### requirements (Plan-v5 R1, `agents/requirements.ts`) — acceptance testing

The flagship new capability: black-box acceptance testing against the project's own **acceptance criteria** (a free-text field, one criterion per line). Pure `parseRequirements()` strips bullets/numbering, dedupes, caps at 20. One forced tool call judges each criterion **against observed artifacts only** — the top discovered pages + this run's findings — as `met` / `not_met` / `unverifiable`. The prompt forbids inventing behavior and tells the model to answer `unverifiable` (not guess "met") when a criterion needs backend visibility or a flow this run didn't exercise. `not_met` → **high bug** "Requirement not met: …" (business-impact severity from the model, floored at high); `unverifiable` → info with a hint to add a journey/inbox check; plus one summary "N/M criteria met" info finding. Smart/full + AI; 30% of the post-journey pool.

### explorer (P5.7, `agents/explorer.ts`) — AI free-roam

Full mode only. The "test like a curious human, no script" capability, gated behind the journey guardrails that now exist. Starts at the riskiest page and lets the model wander: each turn it sees a text digest + transcript, picks ONE action (reusing the journey `pageDigest`/`execute` helpers), and may report a finding it noticed (source `ai`, confidence 0.6). Deterministic safety net — any console/page error during the wander is filed regardless of what the model says. UNSAFE targets refused; 14-action wander budget; 25% of the post-requirements AI pool.

### senior-review (P6, `agents/seniorReviewer.ts`) — executive sign-off

One AI call **after the report is assembled**, so it sees coverage totals, recurrence patterns, and root-cause clusters, plus the top 30 severity-ranked findings. Forced schema: `{ executive_summary, fix_first (≤3, ordered by BUSINESS impact — "a11y found more issues, but a broken checkout blocks revenue"), watchlist }`. The prompt forbids inventing findings not in the input. Stored on `report.seniorReview` (rendered as the violet top card on the run page) + echoed as one info finding (never flips pass/fail). ~1.2k tokens max.

---

## 8. Input fuzzing (P9, `fuzz.ts`)

Pure adversarial-input catalogue, reused by CRUD, journey `{edge:*}` tokens, and form-validation: 11 kinds — 5k-char string, RTL Arabic, emoji, XSS probe (`"><img onerror>` — **detection only**), SQL-ish (`' OR 1=1--` — detection only), empty, whitespace, huge/negative numbers, future/leap dates — each tagged with applicable field types. `looksReflectedXss()` flags only when an angle-bracket payload comes back in served HTML **unescaped**. Fully selftested.

---

## 9. Findings model

Every finding: `severity` (critical/high/medium/low/info) · `kind` (bug | improvement) · `source` (deterministic | ai) · `confidence` · `title` · `detail` · `pageUrl` · `role` · `evidence` (screenshot path) · `fingerprint`.

Run status gate: **any critical or high finding → run "failed"**; medium/low/info are advisory. The summary digest dedupes same-issue findings across pages/browsers (title minus `[Browser]` prefix) and lists the top 8 distinct issues by severity with occurrence counts.

---

## 10. Knowledge graph & change detection (`graph.ts`)

Two node types, lean on purpose: **page** (key = pathname) and **api** (key = `METHOD /path`), with `navigates_to` / `calls` edges, persisted per project across runs.

- `riskScore()`: login/auth/payment/billing/checkout/admin/delete/transfer → 90; account/profile/settings/orders/roles → 50; else → 20. Drives both the AI reviewer's page selection and the deterministic agents' risk-weighted samples (§5).
- **Change detection**: before each run's crawl overwrites the graph, the orchestrator snapshots the previous page labels; `reorderByChangeStatus()` sorts crawled pages **new → changed → unchanged** and stamps `changeRank` per page, feeding both sampling and the "+40 new / +20 changed" score bonus.

---

## 11. Resilience of the runner itself (`recovery.ts`)

`withRecovery(ctx, agent, fn)`: run → on throw, retry once → on second throw, log "failed after retry" and return null; the run continues. Records the agent into `ctx.agentsRan` for the report's ran/skipped split. Session-expiry mid-crawl is handled separately by the crawler's `reauth()` (§3). Concurrency safety for the parallel stage: better-sqlite3 is synchronous (writes serialize at the JS level) and the screenshot counter increments before any `await` (unique filenames).

---

## 12. The run report

At run end `buildRunReport()` (pure, selftested) assembles `runs.report_json`:

- **sessions** — one row per attempted role: `✓ role — N page(s) tested` or `✗ role — <first line of its login finding>` (which quotes the site's own error banner). Anonymous fallback appears as an extra ✓ row.
- **coverage** — pages tested + findings count per established role.
- **coverageTotals** (P4) — honest discovered-vs-tested ratios over the only things a black-box tester can count: `pages 12/47 · templates 6/6 · controls 38/112 · journeys 2/3`. No invented denominators.
- **patterns** (P2) — recurrent findings (seen in ≥3 of last 10 runs) + reappeared-after-fix regressions.
- **seniorReview** (P6) — executive summary, fix-first list, watchlist.
- **agentsRan / agentsSkipped** — skipped agents carry a reason ("needs 2+ logged-in roles", "full mode only", "AI layer did not run", …).

The plain-text `summary` leads with the headline (`N findings (c critical, h high) across P pages, k/n session(s) established`), then ✓/✗ session lines, then the top-8 digest.

---

## 13. Data model (SQLite, `data/webtester.db`, WAL)

| Table | What |
|---|---|
| `projects` | name, base_url, env_tag (localhost/staging/production), login/register paths, test inbox URL, notes, **requirements** (acceptance criteria), **upload_file_path** (sample file for the upload agent), **roles_json with AES-encrypted passwords** (key auto-generated at `data/secret.key`), sessionState (encrypted), **journeys_json** |
| `runs` | mode, status (queued/running/passed/failed/error), timestamps, summary, ai_tokens, **report_json** |
| `run_events` | live timeline: ts, agent, level (step/pass/fail/warn/shot), message — polled by the UI |
| `findings` | the findings model above; `idx_findings_fp` index for multi-run history |
| `graph_nodes` / `graph_edges` | knowledge graph (§10), persists across runs per project |

Migrations are additive `ALTER TABLE … ADD COLUMN` calls that swallow "duplicate column" — old databases upgrade in place. `getProjectSafe()` blanks passwords/sessionState before anything reaches the client. Screenshots → `public/shots/{runId}/NNN-label.png`; visual baselines → `public/baselines/`.

---

## 14. UI & API

- **Run page** (`LiveRun.tsx`): polls `/api/runs/[id]` + `/events?after=N` + `/findings` every 1.5 s while running. Senior-review card (violet, top) → summary card → coverage report card (sessions, totals, patterns, agents ran/skipped) → findings view (filter by severity/kind/agent, screenshot lightbox) / timeline view (live agent log).
- **API routes**: `GET /api/runs/[id]`, `GET /api/runs/[id]/events?after=N`, `GET /api/runs/[id]/findings`, `GET /api/projects/[id]/graph` (summary + top-50 risk-sorted nodes).
- **Project form**: roles, paths, env tag, storage state, notes, acceptance criteria (one per line → requirement-validation agent), journeys (JSON textarea validated by `journeySchema` in actions.ts).
- **CLI** (`npm run agents -- --url https://… --user u --pass p --mode smart`, or `--demo` for SauceDemo): creates a project, blocks until the run finishes, prints the findings table. Note: CLI-created projects have `journeys: []` (no CLI flag for journeys yet).

---

## 15. Safety rails (summary)

- Crawler/interaction/journey/chaos never click destructive or session-ending targets (`UNSAFE`, selftested).
- Form-validation submits only the empty-required-form probe and only off-production; security agent is passive; permissions checks are plain GETs.
- CRUD only in full mode **and** never on `production`; journey steps with destructive verbs refused on production; writes tagged `qabot-{run}` for sweeping.
- Resilience faults run in throwaway cloned contexts — never leak into shared sessions; read-only.
- XSS/SQLi fuzz payloads are detection-only (observe handling, never exploit).
- Credentials AES-encrypted at rest; never sent to the client; runs entirely local.
- AI spend hard-capped per mode and per journey; quick mode provably AI-free.
- Role sessions capped at 6 to bound memory.

## 16. Self-test

`npm run agents:test` — **31 assert-based sections** over the pure logic: UNSAFE filter, URL templating, route adoption, page-type inference, credential encryption round-trip, fingerprints, risk scoring, regression diff, recovery semantics, device matrix, change detection, format classifiers, visual diff, AI budget=0 in quick, register email/OTP/verify-link extraction, CRUD tag, UI outliers, login error scraping, run report building, risk+recency+history sampling, coverage totals, root-cause clustering, fuzz catalogue + reflected-XSS detector, journey pure parts (digest/target/tokens/destructive-guard), resilience reaction classifier, chaos control selection, SEO tag audit, requirement parsing, API response validation, memory-leak classifier, analytics provider matching. `npx tsc --noEmit` for types.

---

## 17. Gaps — not yet implemented / known limits (honest list)

> Plan-v5 batch 2 is now **shipped** (api-validation, analytics, memory-leak, file-upload, email-flows, explorer, per-step journey assertions, recovery scenario) — see §6/§7. What remains below is the honest boundary.

### Black-box boundary — rejected (would need a connector or a different tool)

- **Database / cache / queue / audit-log inspection** — invisible to a browser-only tester. Only via an *optional* user-provided DB connector, which is a separate product mode, not the core.
- **Performance under load (20–500 concurrent users)** — a different discipline; integrate a load tool (k6/Artillery) if ever needed rather than rebuilding one on Playwright.
- **Production monitoring / scheduling / Slack alerts** — an ops layer *around* the fleet (a cron that invokes runs), not an agent inside it.

### Planned but not built (Plan-v4 carryover)

- **P9.2 Standalone form-fuzz pass** — filling arbitrary create-forms with the fuzz catalogue + reflected-XSS check. Deferred because journeys already submit fuzz via `{edge:*}` tokens with the production guard; add only if a form outside any journey needs adversarial coverage.
- **P11 Plugin hooks** (`beforeRun / afterDiscovery / afterFinding / beforeReport` lifecycle for third-party agents) — deferred until an external extender actually appears.
- **P2.4 DB-fixture test** for `findingHistory()` — the SQL path isn't in the pure selftest suite (needs a seeded runs/findings fixture); decision logic is trivial and exercised live.
- **P3.4 Parallelization benchmark** — the parallel verification stage shipped but wall-clock gain was never measured against a live target.

### Auth & access

- Single-step password logins only — no email→Continue→password wizards, no 2FA/OTP login, no CAPTCHA solving, no bot-detection evasion. OAuth-only sites work solely via manually exported storageState.

### Runner infrastructure

- **No job queue / cancellation**: runs execute in-process in the Next.js server (`void executeRun(...)`); the `queued` status exists in the type but is never used, there is no way to stop a running run from the UI, and a server restart orphans a run as "running" forever. The 6-role memory cap is the placeholder for real per-host accounting.
- Runs are strictly sequential per project from the UI's perspective — no concurrency control if two runs are launched at once (they'll both write to the same graph tables).

### Coverage & detection ceilings

- Custom `new Audio()` JS players aren't detected (only `<audio>/<video>` elements).
- Dead-control detection uses DOM-node deltas — misses pure style/canvas effects.
- Perf is navigation-timing only — no INP/CWV field data, no Lighthouse.
- Visual baselines **auto-accept** on change (low finding + overwrite) — no approve/reject UI, so a real visual regression is only flagged once.
- Journey "mobile" persona is viewport-only (no touch events / mobile UA); upgrade to a device-profile context if mobile UA branching matters.
- Journey Navigator is text-digest-only (no vision per action — screenshots saved for replay but not sent to the model); add per-action vision if the digest proves too thin.
- Root-cause clusters don't back-mark member findings' rows (no findings-update path) — the synthesis finding lists members instead.
- Crawler caps (40 pages, 8 adopted routes, 12 controls/page) mean very large sites get sampled, not exhausted — by design, but worth knowing.

### Product

- Reports are in-app only — no PDF/HTML export, no CI integration (exit-code/JUnit output), no notifications.
- Journeys are edited as raw JSON in a textarea — no step-builder UI.
- CLI can't define journeys (`journeys: []` hardcoded).

### Explicitly rejected (won't build without new evidence)

- Standalone state-graph manager (journeys sequence state implicitly), component inventory (unreliable on utility-CSS sites), self-learning rule engine (recurrence memory covers the useful 80%), dependency graph beyond page→api (black-box boundary), per-agent context isolation (no observed coupling; would multiply run time), LLM mission planner (heuristics + risk sampling cover scoping).
