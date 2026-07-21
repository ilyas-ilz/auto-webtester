import type { BrowserContext } from "playwright";
import type { Project, RoleCred } from "../../types";
import { RunContext } from "../context";

const AGENT = "crud";
const MAX_FORMS = 3; // ponytail: bound how many create-forms we exercise per role

/** A unique, greppable marker written into created records so they can be found and swept. */
export function crudTag(runId: string): string {
  return `qabot-${runId.slice(0, 8)}`;
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
      const value = `${tag}-${exercised}`;
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
