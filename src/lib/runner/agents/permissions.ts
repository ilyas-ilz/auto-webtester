import type { BrowserContext } from "playwright";
import { RunContext, type CapturedWrite } from "../context";
import type { RoleCred } from "../../types";
import { classifyWriteIdor, type IdorVerdict } from "./crud";

const AGENT = "permissions";
const MAX_CHECKS = 20; // ponytail: bound the N² role×route sweep on apps with many roles/pages
const PER_PAIR = 6;
const IDOR_MAX = 20; // bound the writes×roles replay sweep too
const DENIED_TEXT = /(access denied|forbidden|not authorized|unauthorized|permission denied|log ?in to continue)/i;

export interface RoleSession {
  role: RoleCred;
  browserCtx: BrowserContext;
}

/**
 * Verification agent (Plan-v2 V7) — cross-role access matrix / safe IDOR
 * check. For each route Role A reached that Role B never discovered on its
 * own, B's *already-authenticated* context does a plain GET at that exact
 * URL. If B lands on real content instead of a login/denied page, that is a
 * permission boundary gap. Read-only navigation only — no writes, no
 * ID-guessing beyond routes the crawler already found.
 */
export async function permissionsAgent(ctx: RunContext, sessions: RoleSession[]): Promise<void> {
  if (sessions.length < 2) return;

  const urlsByRole = new Map<string, Set<string>>();
  for (const s of sessions) {
    urlsByRole.set(s.role.name, new Set(ctx.pages.filter((p) => p.role === s.role.name && (p.status ?? 200) < 400).map((p) => new URL(p.url).pathname)));
  }

  let checks = 0;
  let capped = false;
  outer: for (const a of sessions) {
    for (const b of sessions) {
      if (a.role.name === b.role.name) continue;
      const aOnly = ctx.pages.filter((p) => p.role === a.role.name && (p.status ?? 200) < 400 && !urlsByRole.get(b.role.name)!.has(new URL(p.url).pathname));
      for (const target of aOnly.slice(0, PER_PAIR)) {
        if (checks >= MAX_CHECKS) { capped = true; break outer; }
        checks++;
        ctx.status(AGENT, `Probing ${a.role.name}'s route as ${b.role.name}`, { url: target.url });
        const page = await b.browserCtx.newPage();
        try {
          const resp = await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 15000 });
          const status = resp?.status() ?? 0;
          const finalPath = new URL(page.url()).pathname;
          const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? "").catch(() => "");
          const blocked = status >= 400 || finalPath !== new URL(target.url).pathname || DENIED_TEXT.test(bodyText);
          if (!blocked) {
            const shot = await ctx.screenshot(page, `${b.role.name}-reached-${a.role.name}-route`);
            // P1-13 (WEBTESTER-AUDIT): "A found this route, B didn't" is a discovery
            // difference, not an authorization specification — B may be perfectly
            // entitled to the page and simply never linked to it. Reported as HIGH
            // needing review, not CRITICAL fact, and never with confidence 1.0.
            ctx.finding({
              agent: AGENT, severity: "high", kind: "bug", confidence: 0.5, role: b.role.name, pageUrl: target.url,
              title: `Role "${b.role.name}" can reach "${a.role.name}"'s route ${finalPath} — verify this is intended`,
              detail: `${b.role.name}'s session loaded ${target.url} (HTTP ${status}) without being redirected or denied. Only ${a.role.name} discovered this route during crawl, which is a DISCOVERY difference, not a documented permission rule — ${b.role.name} may legitimately be allowed here. Confirm against the intended role matrix before treating this as a real access-control gap.`,
              evidence: shot, owasp: ["A01:2021"],
            });
          }
        } catch (e) {
          ctx.log(AGENT, "warn", `permission check failed for ${target.url} as ${b.role.name}: ${String(e).slice(0, 160)}`);
        } finally {
          await page.close();
        }
      }
    }
  }
  if (capped) ctx.log(AGENT, "warn", `Permission matrix capped at ${MAX_CHECKS} checks — some role×route pairs were skipped.`);
  ctx.log(AGENT, "pass", `Cross-role permission matrix checked (${checks} check(s) across ${sessions.length} roles)`);
}

/**
 * Order writes so destructive DELETEs run LAST: probe POST/PUT/PATCH while the
 * qabot- entity still exists (a successful cross-role DELETE removes it, which
 * would mask a PUT/PATCH gap on the same object). Stable within each group.
 */
export function orderForReplay<T extends { method: string }>(writes: readonly T[]): T[] {
  return writes
    .map((w, i) => [w, i] as const)
    .sort((a, b) => (Number(a[0].method.toUpperCase() === "DELETE") - Number(b[0].method.toUpperCase() === "DELETE")) || a[1] - b[1])
    .map(([w]) => w);
}

// Fields a CSRF cookie commonly carries its token under (axios/Angular XSRF-TOKEN,
// Django csrftoken, Laravel/Rails variants). A replaying role's OWN value here is what
// we inject, so the token stops being the owner's.
const CSRF_TOKENISH = /csrf|xsrf|authenticity|_token/i;

/**
 * §8.1: decide what to inject and whether identity was truly isolated for one replay.
 * Pure so it can be selftested without a browser.
 *
 *  - `csrfHeader` set + we have the replaying role's own token → inject it; header side clean.
 *  - `csrfHeader` set but no token for this role → can't neutralise it; NOT isolated.
 *  - a CSRF/nonce token embedded in the owner's body (`postData`) still leaks the owner's
 *    identity and we can't rewrite arbitrary body fields → NOT isolated (stay inconclusive).
 *  - nothing token-bearing anywhere → the replay carries only the role's own cookies →
 *    isolated: a denial genuinely means authz, not a token mismatch.
 */
export function replayIsolation(
  w: Pick<CapturedWrite, "csrfHeader" | "postData">,
  roleToken: string | null,
): { headers: Record<string, string>; isolated: boolean } {
  const headers: Record<string, string> = {};
  const bodyToken = w.postData != null && CSRF_TOKENISH.test(w.postData);
  let headerClean = true;
  if (w.csrfHeader) {
    if (roleToken) headers[w.csrfHeader] = roleToken;
    else headerClean = false;
  }
  return { headers, isolated: headerClean && !bodyToken };
}

/**
 * Re-issue a captured write from `browserCtx`'s session (its cookies). Returns the status
 * plus whether the replaying role's identity was fully isolated (§8.1) — the oracle only
 * treats a denial as "protected" when it was.
 */
async function replayWrite(browserCtx: BrowserContext, w: CapturedWrite): Promise<{ status: number; isolated: boolean }> {
  const method = w.method.toUpperCase();
  // Resolve THIS role's own CSRF token from its cookies (browserCtx already carries them).
  let roleToken: string | null = null;
  if (w.csrfHeader) {
    const cookies = await browserCtx.cookies().catch(() => []);
    roleToken = cookies.find((c) => CSRF_TOKENISH.test(c.name))?.value ?? null;
  }
  const { headers: csrfHeaders, isolated } = replayIsolation(w, roleToken);

  const opts: { data?: string; headers?: Record<string, string> } = {};
  const headers: Record<string, string> = { ...csrfHeaders };
  if (w.postData != null) {
    opts.data = w.postData;
    if (w.contentType) headers["content-type"] = w.contentType;
  }
  if (Object.keys(headers).length) opts.headers = headers;

  const req = browserCtx.request;
  const resp =
    method === "POST" ? await req.post(w.url, opts)
    : method === "PUT" ? await req.put(w.url, opts)
    : method === "PATCH" ? await req.patch(w.url, opts)
    : method === "DELETE" ? await req.delete(w.url, opts)
    : await req.fetch(w.url, { method, ...opts });
  return { status: resp.status(), isolated };
}

/**
 * Write-IDOR replay (Plan-v7 §3.2a). crud captured the qabot-tagged writes each
 * role performed on its OWN disposable entities (`ctx.idorWrites`). Here we
 * re-issue each such write from every OTHER role's authenticated context and let
 * the oracle read the status: a 2xx where the owner's write was the only expected
 * success = broken object-level authorization (write-IDOR).
 *
 * Non-destructive by construction — every target is a qabot- entity THIS run
 * created, never real data. §8.1: header-based CSRF (double-submit cookie) is now
 * handled — we inject the replaying role's OWN token so a denial means authz.
 * Remaining ceiling: a token embedded in the request BODY (Rails authenticity_token,
 * synchronizer-token nonces) still leaks the owner's identity, so those replays stay
 * "inconclusive" rather than risk a false "protected" — a false-negative, never a false alarm.
 */
export async function writeIdorReplay(ctx: RunContext, sessions: RoleSession[]): Promise<void> {
  if (sessions.length < 2 || ctx.idorWrites.length === 0) return;
  let checks = 0;
  let capped = false;
  outer: for (const w of orderForReplay(ctx.idorWrites)) {
    for (const b of sessions) {
      if (b.role.name === w.ownerRole) continue; // the owner is the baseline, not a cross-role probe
      if (checks >= IDOR_MAX) { capped = true; break outer; }
      checks++;
      const path = new URL(w.url).pathname;
      ctx.status(AGENT, `Replaying ${w.ownerRole}'s ${w.method} ${path} as ${b.role.name}`, { url: w.url });
      try {
        const { status, isolated } = await replayWrite(b.browserCtx, w);
        // §8.1: `isolated` is decided per-replay — true only when the replaying role's
        // OWN token was injected (or there was no token to mismatch). A denial counts as
        // "protected" only then; otherwise it's a possible CSRF/nonce mismatch →
        // inconclusive, never a false "protected".
        const verdict = classifyWriteIdor(w.ownerStatus, status, isolated);
        if (verdict === "vulnerable") {
          ctx.finding({
            agent: AGENT, severity: "critical", kind: "bug", role: b.role.name, pageUrl: w.url,
            title: `Role "${b.role.name}" can write "${w.ownerRole}"'s data via ${w.method} ${path}`,
            detail: `${b.role.name}'s session re-issued a ${w.method} that ${w.ownerRole} used on its own record and got HTTP ${status} (owner baseline ${w.ownerStatus}). A cross-role write succeeded where it should have been denied — write-IDOR / broken object-level authorization. Confirmed against a disposable qabot- entity (${w.tag}); verify by hand before treating as production impact.`,
            evidence: JSON.stringify({ method: w.method, url: w.url, ownerRole: w.ownerRole, ownerStatus: w.ownerStatus, crossRole: b.role.name, crossRoleStatus: status }), owasp: ["A01:2021"],
          });
        } else {
          ctx.log(AGENT, verdict === "protected" ? "pass" : "warn", `${b.role.name} ${w.method} ${path} → HTTP ${status} (${verdict})`);
        }
      } catch (e) {
        ctx.log(AGENT, "warn", `write-IDOR replay failed for ${w.method} ${w.url} as ${b.role.name}: ${String(e).slice(0, 160)}`);
      }
    }
  }
  if (capped) ctx.log(AGENT, "warn", `Write-IDOR replay capped at ${IDOR_MAX} checks.`);
  ctx.log(AGENT, "pass", `Cross-role write-IDOR replay done (${checks} replay(s) across ${sessions.length} roles)`);
}

// --- Relationship-aware authorization oracle (Plan-v7 §3.2b) ---------------
//
// Flat IDOR asks "can role B touch role A's object?". The real dimension is the
// acting role's RELATIONSHIP to the resource — owner vs same-tenant vs other-tenant —
// which catches multi-tenant leaks (Tenant B GET /invoices/391 → 200) a flat
// role×route matrix misses. Ownership/tenancy is read off the §3.3 graph
// (created_by / belongs_to edges); this is the pure verdict layer over it.

// "unknown" (WEBTESTER-AUDIT P1-13): tenancy that was never learned is NOT evidence
// of separate tenancy. Two roles legitimately sharing a tenant would otherwise be
// reported as a critical cross-tenant leak.
export type Relationship = "owner" | "same-tenant" | "other-tenant" | "unknown";

/**
 * Resolve the actor's relationship to a resource from ownership + tenancy facts
 * (as recorded on the graph). Owner beats tenant match beats everything-else.
 * Missing tenancy facts on either side → "unknown", never "other-tenant" (P1-13).
 */
export function relationshipOf(actorIsOwner: boolean, actorTenant: string | null, resourceTenant: string | null): Relationship {
  if (actorIsOwner) return "owner";
  if (!actorTenant || !resourceTenant) return "unknown";
  return actorTenant === resourceTenant ? "same-tenant" : "other-tenant";
}

/**
 * The relationship verdict (§3.2b):
 *  - owner + 2xx        → protected (the owner is SUPPOSED to succeed)
 *  - other-tenant + 2xx → vulnerable (cross-tenant access/mutation — the worst case)
 *  - same-tenant + 2xx  → inconclusive (may be legitimate intra-org sharing)
 *  - unknown + 2xx      → inconclusive (P1-13: unlearned tenancy is not proof of separate tenancy)
 *  - 404                → protected (resource hidden from this actor)
 *  - 401/403            → §8.1: only "protected" when identity was isolated, else inconclusive
 *  - anything else      → inconclusive
 */
export function classifyRelAuthz(rel: Relationship, status: number, identityIsolated = false): IdorVerdict {
  const ok = status >= 200 && status < 300;
  if (rel === "owner") return ok ? "protected" : "inconclusive"; // owner failing is a different bug, not IDOR
  if (ok) return rel === "other-tenant" ? "vulnerable" : "inconclusive";
  if (status === 404) return "protected";
  if (status === 401 || status === 403) return identityIsolated ? "protected" : "inconclusive";
  return "inconclusive";
}

/**
 * Relationship-aware read-side replay (Plan-v7 §3.2b). Complements writeIdorReplay: that
 * one re-issues the MUTATION; this GETs the object URL crud created (PATCH/PUT/DELETE
 * targets are object URLs — a POST hits a collection, so it's skipped) from every OTHER
 * role. That created object was born this run and no crawler ever discovered it, so
 * route-level read-IDOR (permissionsAgent) can't reach it — this closes that gap.
 *
 * A GET carries no CSRF/nonce and only the replaying role's own cookies, so identity is
 * isolated by construction (§8.1) — a denial genuinely means authz. Tenancy off the §3.3
 * graph isn't populated live yet, so the actor is either the owner or, conservatively,
 * "other-tenant"; classifyRelAuthz then flags a non-owner 2xx read as vulnerable.
 * Non-destructive: GET only, on qabot- entities this run created.
 */
export async function relAuthzReplay(ctx: RunContext, sessions: RoleSession[]): Promise<void> {
  if (sessions.length < 2 || ctx.idorWrites.length === 0) return;
  const objectWrites = ctx.idorWrites.filter((w) => w.method.toUpperCase() !== "POST"); // object URLs only
  let checks = 0;
  let capped = false;
  outer: for (const w of objectWrites) {
    for (const b of sessions) {
      if (b.role.name === w.ownerRole) continue; // owner reading its own object is expected
      if (checks >= IDOR_MAX) { capped = true; break outer; }
      checks++;
      const path = new URL(w.url).pathname;
      ctx.status(AGENT, `Reading ${w.ownerRole}'s object ${path} as ${b.role.name}`, { url: w.url });
      try {
        const resp = await b.browserCtx.request.get(w.url);
        // P1-13: HTTP 200 alone is not exposure. Tenancy is unlearned, so the
        // relationship is "unknown" → inconclusive by policy; what upgrades this to a
        // real finding is the OTHER role's response actually containing the owner's
        // tagged data (proven exposure, not an inferred authorization spec).
        const rel = relationshipOf(false, null, null); // non-owner; tenancy unknown
        const verdict = classifyRelAuthz(rel, resp.status(), true); // GET → identity isolated
        const ok2xx = resp.status() >= 200 && resp.status() < 300;
        const body = ok2xx ? (await resp.text().catch(() => "")).slice(0, 20000) : "";
        const leaked = !!w.tag && body.includes(w.tag);
        if (leaked) {
          ctx.finding({
            agent: AGENT, severity: "critical", kind: "bug", role: b.role.name, pageUrl: w.url,
            title: `Role "${b.role.name}" can read "${w.ownerRole}"'s object via GET ${path}`,
            detail: `${b.role.name}'s session GET ${w.url} → HTTP ${resp.status()} AND the response body contained ${w.ownerRole}'s own tagged value (${w.tag}) — proven cross-role data exposure, not just a permissive status code. Confirmed against a disposable qabot- entity; verify by hand before treating as production impact.`,
            evidence: JSON.stringify({ method: "GET", url: w.url, ownerRole: w.ownerRole, crossRole: b.role.name, crossRoleStatus: resp.status(), tagFoundInBody: true }), owasp: ["A01:2021"],
          });
        } else if (ok2xx) {
          // Reachable but nothing of the owner's data proven in the body: a lead, not a verdict.
          ctx.finding({
            agent: AGENT, severity: "medium", kind: "bug", confidence: 0.4, role: b.role.name, pageUrl: w.url,
            title: `Role "${b.role.name}" gets HTTP ${resp.status()} on "${w.ownerRole}"'s object ${path} — needs review`,
            detail: `The request succeeded but the response did not contain ${w.ownerRole}'s tagged value, and this project has no learned tenancy facts — so this is NOT confirmed cross-tenant access. It may be legitimate shared access, an empty/placeholder response, or a real leak of untagged fields. Verify by hand.`,
            evidence: JSON.stringify({ method: "GET", url: w.url, ownerRole: w.ownerRole, crossRole: b.role.name, crossRoleStatus: resp.status(), tagFoundInBody: false, relationship: rel }), owasp: ["A01:2021"],
          });
        } else {
          ctx.log(AGENT, verdict === "protected" ? "pass" : "warn", `${b.role.name} GET ${path} → HTTP ${resp.status()} (${verdict})`);
        }
      } catch (e) {
        ctx.log(AGENT, "warn", `rel-authz read replay failed for GET ${w.url} as ${b.role.name}: ${String(e).slice(0, 160)}`);
      }
    }
  }
  if (capped) ctx.log(AGENT, "warn", `Rel-authz read replay capped at ${IDOR_MAX} checks.`);
  ctx.log(AGENT, "pass", `Cross-role object-read replay done (${checks} read(s) across ${sessions.length} roles)`);
}
