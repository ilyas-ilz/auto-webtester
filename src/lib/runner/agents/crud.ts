import type { BrowserContext } from "playwright";
import type { Project, RoleCred } from "../../types";
import { RunContext, type CapturedWrite } from "../context";
import { getContract, saveContract } from "../../db";
import { freezeContract, checkContract, type ContractKind, type Observation } from "../contracts";

const AGENT = "crud";
const MAX_FORMS = 3; // ponytail: bound how many create-forms we exercise per role

/** A unique, greppable marker written into created records so they can be found and swept. */
export function crudTag(runId: string): string {
  return `qabot-${runId.slice(0, 8)}`;
}

// --- Write-IDOR oracle (Plan-v7 §3.2a) ------------------------------------
//
// Read-IDOR is safe to probe (a GET changes nothing). Write-IDOR is not: the
// only proof that role B can mutate role A's object is to perform the mutation —
// "the test is the damage". So we make it non-destructive by construction:
// we only ever remember, and later replay, writes that carry our own qabot- tag,
// i.e. writes against disposable entities THIS run created. Real user data is
// never a replay target.

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** State-mutating verb? GET/HEAD/OPTIONS are safe to probe freely; these are not. */
export function isWriteMethod(method: string): boolean {
  return WRITE_METHODS.has(method.toUpperCase());
}

/**
 * Should this request be remembered as a replayable write? Only if it is a
 * same-origin mutation that provably targets our own disposable entity (the tag
 * appears in the URL or the request body). This is the guard that keeps a later
 * cross-role replay from ever touching data we didn't create.
 */
export function isReplayableWrite(req: { method: string; url: string; postData: string | null }, origin: string, tag: string): boolean {
  if (!isWriteMethod(req.method)) return false;
  if (!req.url.startsWith(origin)) return false;
  return req.url.includes(tag) || (req.postData?.includes(tag) ?? false);
}

export type IdorVerdict = "vulnerable" | "protected" | "inconclusive";

/**
 * The cross-role oracle. The OWNER role performed a write on its own qabot-
 * entity (ownerStatus = the 2xx baseline); we replay the SAME write from a
 * DIFFERENT role's session and read the status:
 *  - owner write wasn't a real success   → inconclusive (no baseline to compare)
 *  - cross-role write returns 2xx         → vulnerable (role B mutated role A's object)
 *  - cross-role write returns 404         → protected (object hidden from the other role)
 *  - cross-role write returns 401/403     → depends on `identityIsolated` (see below)
 *  - anything else (5xx/429/0)            → inconclusive (server error ≠ authz signal)
 *
 * `identityIsolated` (Plan-v7 §8.1): a 401/403 only proves *authz denied* when
 * identity was the ONLY variable. If we replayed the owner's captured body/token
 * verbatim, a 403 may just be a CSRF/nonce **token mismatch** — authz was never
 * tested, so the honest verdict is `inconclusive`, NOT a pass. Only once the
 * executor injects the replay role's own fresh token may a 401/403 be trusted as
 * `protected`. Defaults false — the safe reading — so a token mismatch can never
 * masquerade as "authz works".
 */
export function classifyWriteIdor(ownerStatus: number, crossRoleStatus: number, identityIsolated = false): IdorVerdict {
  const ok = (s: number): boolean => s >= 200 && s < 300;
  if (!ok(ownerStatus)) return "inconclusive";
  if (ok(crossRoleStatus)) return "vulnerable";
  if (crossRoleStatus === 404) return "protected";
  if (crossRoleStatus === 401 || crossRoleStatus === 403) return identityIsolated ? "protected" : "inconclusive";
  return "inconclusive";
}

// Pages whose create-form is a login/search/signup, not a real entity create.
const NON_CRUD = /(login|sign-?in|sign-?up|register|search|forgot|reset|logout)/i;

/**
 * CRUD Engineer (Plan-v2 V5) — the create + verify + best-effort-delete slice.
 *
 * SAFETY (§7): never runs on production; only fires in `full` mode. It fills the
 * first plausible create-form on a discovered page with tagged data
 * (`qabot-<run>`), submits, verifies the tagged value shows up (create worked),
 * then tries to delete its own row so the target isn't polluted. It only ever
 * touches data it created. Heuristic by nature — it can't know an app's entity
 * model, so it reports what it managed to exercise, not "all CRUD works".
 */
export async function crudAgent(ctx: RunContext, browserCtx: BrowserContext, project: Project, role: RoleCred): Promise<void> {
  if (project.envTag === "production") {
    ctx.log(AGENT, "warn", "CRUD agent skipped on production (safety) — point it at localhost/staging to test writes.");
    return;
  }
  const tag = crudTag(ctx.runId);
  const candidates = ctx.pages
    .filter((p) => p.role === role.name && (p.status ?? 200) < 400 && !NON_CRUD.test(p.url))
    .map((p) => p.url);

  let exercised = 0;
  for (const url of candidates) {
    if (exercised >= MAX_FORMS) break;
    const page = await browserCtx.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      // A create-form: a form with text-ish inputs and a create/add/save submit.
      const form = page.locator("form").filter({ has: page.locator('input:not([type="hidden"]):not([type="search"]), textarea') }).first();
      if (!(await form.count())) continue;
      const submit = form.locator('button:has-text("create"), button:has-text("add"), button:has-text("save"), button:has-text("new"), button[type="submit"]').first();
      if (!(await submit.count())) continue;

      // Fill each visible text/textarea with a tagged value; pick the first real option for selects.
      const inputs = form.locator('input[type="text"], input[type="email"], input:not([type]), textarea');
      const n = await inputs.count();
      if (n === 0) continue;
      // Role in the tag (gap #6): `exercised` resets per role, so `qabot-<run>-<n>`
      // alone collides across roles. Scoping by role keeps each created entity — and
      // its captured write — attributable to exactly one owner for the IDOR replay.
      const roleSlug = role.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "role";
      const value = `${tag}-${roleSlug}-${exercised}`;

      // §3.2a: remember any same-origin mutation that carries our tag, with the
      // status it returned. This is the replayable write the cross-role oracle needs.
      const origin = new URL(page.url()).origin;
      const capturedWrites: CapturedWrite[] = [];
      page.on("response", (resp) => {
        const req = resp.request();
        const cand = { method: req.method(), url: req.url(), postData: req.postData() };
        if (isReplayableWrite(cand, origin, value)) {
          const rh = req.headers();
          const csrfHeader = Object.keys(rh).find((h) => /csrf|xsrf/i.test(h)) ?? null; // §8.1: which header carried the token, so replay can swap in the replaying role's own
          capturedWrites.push({ method: cand.method, url: cand.url, postData: cand.postData, contentType: rh["content-type"] ?? null, csrfHeader, ownerRole: role.name, ownerStatus: resp.status(), tag: value });
        }
      });

      for (let i = 0; i < n; i++) {
        const el = inputs.nth(i);
        if (!(await el.isVisible().catch(() => false)) || !(await el.isEditable().catch(() => false))) continue;
        const type = (await el.getAttribute("type")) ?? "text";
        await el.fill(type === "email" ? `${value}@example.test` : value).catch(() => {});
      }
      for (let i = 0; i < (await form.locator("select").count()); i++) {
        await form.locator("select").nth(i).selectOption({ index: 1 }).catch(() => {});
      }

      exercised++;
      ctx.status(AGENT, `Submitting create-form on ${url} as ${role.name}`, { url });
      ctx.recordTested(url, AGENT); // V4 coverage matrix — crud doesn't sample via sampleFor
      ctx.log(AGENT, "step", `[${role.name}] Submitting a create-form on ${url} (tag ${value})`);
      await submit.click({ timeout: 5000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1000);

      // Verify: does the tagged value now appear (in a list/detail/toast)?
      const created = await page.getByText(value, { exact: false }).count().catch(() => 0);
      const shot = await ctx.screenshot(page, `${role.name}-crud-${exercised}`);

      // §3.7 behavioral contract: "create-retrievable". The first clean run freezes the
      // invariant; a later run where the create silently stops being retrievable fails it
      // — a regression oracle over the app's own past behavior, not an env-specific guess.
      const subject = ctx.pageTypes.get(url) ?? new URL(url).pathname;
      const obs: Observation = { kind: "create-retrievable", subject, holds: created > 0, quality: "clean" };
      const frozen = getContract(project.id, "create-retrievable", subject);
      if (!frozen) {
        const c = freezeContract(obs);
        if (c) { saveContract(project.id, c); ctx.log(AGENT, "step", `Froze contract: create on ${subject} is retrievable`); }
      } else if (checkContract({ kind: frozen.kind as ContractKind, subject: frozen.subject, expected: frozen.expected }, obs) === "fail") {
        ctx.finding({
          agent: AGENT, severity: "high", kind: "bug", role: role.name, pageUrl: url,
          title: `Create no longer retrievable on ${subject}`,
          detail: `A create on ${subject} was retrievable in an earlier run (frozen §3.7 contract), but this run the created record "${value}" did not appear afterward — a behavioral regression, not a first-time observation.`,
          evidence: shot,
        });
      }

      // Stash the successful, tag-carrying writes so the cross-role replay step
      // (classifyWriteIdor) can later re-issue them from another role's session.
      // ponytail: 2xx only — targets JSON APIs (fetch POST /api → 200/201), where
      // write-IDOR actually lives. PRG form posts (302→GET) are dropped; widen to
      // 3xx here if a server-rendered target needs it.
      const replayable = capturedWrites.filter((w) => w.ownerStatus >= 200 && w.ownerStatus < 300);
      if (replayable.length) {
        ctx.idorWrites.push(...replayable);
        ctx.log(AGENT, "step", `Captured ${replayable.length} replayable write(s) for cross-role IDOR check (${replayable.map((w) => `${w.method} ${new URL(w.url).pathname}`).join(", ")})`);
      }
      if (created > 0) {
        ctx.finding({
          agent: AGENT, severity: "info", kind: "improvement", role: role.name, pageUrl: url,
          title: `Create flow works (${value})`,
          detail: `Submitted a create-form and the new record "${value}" appeared afterward. Attempting cleanup delete next.`,
          evidence: shot,
        });
        // Best-effort delete of our own row: a delete/remove control on the same row/text.
        const row = page.locator(`:has-text("${value}")`).last();
        const del = row.locator('button:has-text("delete"), button:has-text("remove"), a:has-text("delete")').first();
        if (await del.count()) {
          page.once("dialog", (d) => d.accept().catch(() => {}));
          await del.click({ timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(1000);
          const gone = (await page.getByText(value, { exact: false }).count().catch(() => 1)) === 0;
          ctx.log(AGENT, gone ? "pass" : "warn", gone ? `Cleaned up created record ${value}` : `Could not confirm delete of ${value} — sweep tag "${tag}" manually`);
        } else {
          ctx.log(AGENT, "warn", `No delete control found for ${value} — left in place. Sweep tag "${tag}" manually.`);
        }
      } else {
        ctx.finding({
          agent: AGENT, severity: "medium", role: role.name, pageUrl: url,
          title: "Create-form submit had no visible effect",
          detail: `Filled and submitted a create-form (tag ${value}) but the value did not appear afterward — the create may have silently failed or shown no confirmation.`,
          evidence: shot,
        });
      }
    } catch (e) {
      ctx.log(AGENT, "warn", `CRUD attempt on ${url} failed: ${String(e).slice(0, 160)}`);
    } finally {
      await page.close();
    }
  }
  ctx.log(AGENT, "pass", `CRUD agent exercised ${exercised} create-form(s) for ${role.name}`);
}
