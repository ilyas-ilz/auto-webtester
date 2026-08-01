Webtester — a local autonomous black-box regression assistant with deterministic checks and optional AI-assisted review.

> **Deployment boundary: local, single trusted user only.** There is no application
> authentication, no tenant isolation, and runtime artifacts (screenshots, traces)
> are served from `public/`. Do not expose this to untrusted users or deploy it to
> Vercel/serverless — in-process background runs and writable SQLite are
> incompatible with that runtime. See `WEBTESTER-AUDIT.md`.

## Getting Started

First, run the development server:

```bash
npm run dev
```

Open [http://localhost:3400](http://localhost:3400) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Coverage model

- **Sitemap seeding** — before crawling, the crawler reads `robots.txt` + `sitemap.xml` (up to 500 URLs, one nested index level) so the site's self-declared page inventory is known upfront; the timeline reports "N URLs declared, M page types".
- **Crawler** — BFS over `<a href>` + SPA routes, up to 40 pages, with URL-template sampling: `/surah/2` and `/surah/113` count as one page *type* (max 3 representatives per template, 8 per parent dir), so big content sites get breadth instead of 40 copies of the same template.
- **Site classifier** — fingerprints the target once per run (static / content / spa / saas / ecommerce + framework) and feeds the verdict to the report and the AI reviewer.
- **Page-expectations agent** — infers each sampled page's type from DOM structure (landing / list / detail / article / search / form / error), then checks type-specific invariants: pages must render real content (catches blank client-side crashes), detail prev/next must navigate, search must react to a query. Emits a per-template site map in the findings.
- **AI provider** — set `ANTHROPIC_API_KEY` (uses Haiku) *or* `OPENROUTER_API_KEY` (cheap models; default `google/gemini-2.0-flash-001`, override with `OPENROUTER_MODEL`) in `.env.local`. Anthropic wins if both are set. All AI agents share one provider layer (`src/lib/runner/ai.ts`).
- **AI page judge** (smart/full + an AI key) — picks one representative page per inferred page type, sends a screenshot + page text to Claude, and reports what a human would notice: broken layout, placeholder/missing content, wrong information, confusing UX. Gets ~60% of the run's AI token budget; the whole-site AI reviewer gets the rest.
- **Interaction agent** — clicks visible non-link controls (menus, tabs, custom players; destructive-looking labels skipped), reports click-only routes, JS errors on click, and suspect dead controls; plays every `<audio>`/`<video>` element and verifies playback time actually advances. Discovered routes are **adopted into the tested page set** (up to 8, template-sampled) and explored themselves — on button-nav SPAs where the crawler sees almost no `<a href>`, this is how the deep pages get covered by every other agent.

## Known limitations (Phase 1)

- **No CAPTCHA/2FA/OTP bypass** — the login agent fills username+password and submits; if the target requires a captcha or one-time code it reports "Login failed" rather than solving it. Use a test env with these disabled, or storage-state/session-cookie injection.
- **CRUD agent** — implemented with tagged disposable entities (`qabot-…`); destructive steps are skipped on production targets.
- **Custom JS audio players** — media verification covers real `<audio>`/`<video>` elements; playback driven purely by `new Audio()` in JS is only caught indirectly (dead-control heuristics).
- **No video recording** — screenshots, console logs, and network capture are recorded per run; full video is not.
- **Role sessions capped** — at most `MAX_SIMULTANEOUS_ROLE_SESSIONS` (6) roles run concurrently per project (see `src/lib/runner/orchestrate.ts`) to bound browser memory use.



Deployment: intentionally none. Run it locally (`npm run dev` / `npm run build && npm run start`, port 3400). See the deployment boundary note at the top.
