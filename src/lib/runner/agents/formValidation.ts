import type { BrowserContext } from "playwright";
import { RunContext } from "../context";
import type { RoleCred, Project } from "../../types";

const AGENT = "form-validation";

/**
 * Verification agent (Plan-v2 V4) — STATIC markup audit, plus ONE active check
 * off production (Plan-v4 P9.3). The static pass never clicks submit — it audits
 * markup that predicts validation bugs (unlabeled required fields, sensitive
 * inputs missing autocomplete). The active pass (non-production only) submits a
 * required form *empty* and expects visible validation, not a 5xx or a silent
 * accept. The never-submit rule stays absolute on production.
 */
export async function formValidationAgent(ctx: RunContext, browserCtx: BrowserContext, role: RoleCred, sample: number, envTag?: Project["envTag"]): Promise<void> {
  const urls = ctx.sampleFor(role.name, sample, AGENT).map((p) => p.url);

  for (const url of urls) {
    const page = await browserCtx.newPage();
    try {
      ctx.status(AGENT, `Testing form on ${url} as ${role.name}`, { url });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      const audit = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll("input, select, textarea")) as HTMLInputElement[];
        let unlabeledRequired = 0;
        let noAutocompleteOnSensitive = 0;
        let missingNameOrId = 0;
        for (const el of inputs) {
          const hasLabel =
            !!el.labels?.length ||
            !!el.getAttribute("aria-label") ||
            !!el.getAttribute("aria-labelledby") ||
            !!el.closest("label");
          if (el.required && !hasLabel) unlabeledRequired++;
          const type = (el.getAttribute("type") || "").toLowerCase();
          if ((type === "password" || type === "email") && !el.autocomplete) noAutocompleteOnSensitive++;
          if (!el.name && !el.id) missingNameOrId++;
        }
        return { unlabeledRequired, noAutocompleteOnSensitive, missingNameOrId, total: inputs.length };
      });

      if (audit.total === 0) continue;
      if (audit.unlabeledRequired > 0) {
        ctx.finding({ agent: AGENT, severity: "medium", role: role.name, pageUrl: url,
          title: `${audit.unlabeledRequired} required field(s) without an accessible label`,
          detail: "Required inputs need a <label>, aria-label, or aria-labelledby so screen readers and error messages can reference them.", evidence: null });
      }
      if (audit.noAutocompleteOnSensitive > 0) {
        ctx.finding({ agent: AGENT, severity: "low", role: role.name, pageUrl: url,
          title: `${audit.noAutocompleteOnSensitive} password/email field(s) missing autocomplete`,
          detail: 'Add autocomplete="current-password"/"new-password"/"email" so password managers work correctly.', evidence: null });
      }
      if (audit.missingNameOrId > 0) {
        ctx.finding({ agent: AGENT, severity: "low", role: role.name, pageUrl: url,
          title: `${audit.missingNameOrId} form field(s) missing both name and id`,
          detail: "Fields without name or id break autofill, form submission, and test-selector stability.", evidence: null });
      }

      // P9.3 active check — non-production only. Submit a required form empty and
      // see whether validation catches it, the server 5xx's, or it silently accepts.
      if (envTag && envTag !== "production") {
        const form = page.locator("form").filter({ has: page.locator("[required]") }).first();
        const submit = form.locator('button[type="submit"], input[type="submit"], button:has-text("submit")').first();
        if ((await form.count()) && (await submit.count())) {
          const before = page.url();
          let serverError = false;
          page.on("response", (r) => { if (r.status() >= 500) serverError = true; });
          await submit.click({ timeout: 4000 }).catch(() => {});
          await page.waitForTimeout(1000);
          await ctx.screenshot(page, `${role.name}-form-submitted`, { role: role.name });
          const navigated = page.url() !== before;
          if (serverError) {
            ctx.finding({ agent: AGENT, severity: "high", role: role.name, pageUrl: url,
              title: "Empty required form submit returns a server error",
              detail: "Submitting the form with every required field empty produced a 5xx response — the app should reject empty input with client-side validation before it reaches the server.",
              evidence: await ctx.screenshot(page, "empty-submit-500", { role: role.name }) });
          } else if (navigated) {
            // ponytail: navigation heuristic — a server-rendered "fix errors" page also navigates, hence confidence 0.6.
            ctx.finding({ agent: AGENT, severity: "medium", confidence: 0.6, role: role.name, pageUrl: url,
              title: "Empty required form appears to submit without validation",
              detail: "Submitting with required fields empty navigated away instead of showing a validation error — the form may accept empty input or fail silently. Verify the target page.",
              evidence: await ctx.screenshot(page, "empty-submit-silent", { role: role.name }) });
          } else {
            ctx.log(AGENT, "pass", `Empty-submit validation held on ${url}`);
          }
        }
      }
    } catch (e) {
      ctx.log(AGENT, "warn", `form-validation failed on ${url}: ${String(e).slice(0, 160)}`);
    } finally {
      await page.close();
    }
  }
  ctx.log(AGENT, "pass", `Form audit complete (${urls.length} pages, ${role.name})`);
}
