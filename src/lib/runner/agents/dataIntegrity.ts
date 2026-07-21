import type { BrowserContext } from "playwright";
import { RunContext } from "../context";
import type { RoleCred } from "../../types";

const AGENT = "data-integrity";

// ponytail: this is the deterministic-only slice of Plan-v2's Data Integrity
// Engineer (V8) — same-page formatting CONSISTENCY, nothing more.
// Duplicate prevention, referential integrity, and legal state transitions
// (the rest of V8) need real entity/state semantics (§3.4) that no generic
// crawler can infer — faking them would produce noise, not signal.
// CRUD Engineer (V5) is not built at all: it means performing real
// create/update/delete against the target, which the plan itself gates
// behind a data factory + env snapshot/reset that doesn't exist yet
// (Phase 5). Mutating an arbitrary app with no rollback is the exact
// "destructive action" risk the plan's safety section calls a ship-blocker.
const CURRENCY_RE = /[$€£]\s?\d[\d,]*(\.\d+)?/g;
const DATE_RE = /\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2,8}\s\d{1,2},?\s\d{4})\b/g;

export function classifyCurrencyFormat(match: string): string {
  const decimals = match.match(/\.(\d+)$/)?.[1]?.length ?? 0;
  const grouped = /\d,\d{3}/.test(match);
  return `${decimals}dp${grouped ? "-grouped" : ""}`;
}

export function classifyDateFormat(match: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(match)) return "ISO (YYYY-MM-DD)";
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(match)) return "slash (M/D/Y)";
  if (/^\d{1,2}-\d{1,2}-\d{2,4}$/.test(match)) return "dash (M-D-Y)";
  return "written (Month D, Y)";
}

/**
 * Verification agent — static/safe, same pattern as form-validation: scans
 * rendered text for currency and date tokens and flags when the SAME page
 * mixes formatting conventions (e.g. "$1,200.00" next to "$45.5"). Doesn't
 * know what's "correct," only that inconsistency within one page is itself
 * the bug — a real, common class senior testers catch by eye.
 */
export async function dataIntegrityAgent(ctx: RunContext, browserCtx: BrowserContext, role: RoleCred, sample: number): Promise<void> {
  const urls = ctx.sampleFor(role.name, sample, AGENT).map((p) => p.url);

  for (const url of urls) {
    const page = await browserCtx.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      const text = await page.evaluate(() => document.body?.innerText ?? "");

      const currencies = text.match(CURRENCY_RE) ?? [];
      const currencyFormats = new Map<string, string[]>();
      for (const c of currencies) {
        const f = classifyCurrencyFormat(c);
        currencyFormats.set(f, [...(currencyFormats.get(f) ?? []), c]);
      }
      if (currencies.length >= 2 && currencyFormats.size > 1) {
        ctx.finding({ agent: AGENT, severity: "medium", role: role.name, pageUrl: url,
          title: `Inconsistent currency formatting (${[...currencyFormats.keys()].join(", ")})`,
          detail: `${currencies.length} amount(s) on this page use ${currencyFormats.size} different conventions: ${[...currencyFormats.entries()].map(([f, ex]) => `${f} e.g. "${ex[0]}"`).join("; ")}`,
          evidence: null });
      }

      const dates = text.match(DATE_RE) ?? [];
      const dateFormats = new Map<string, string[]>();
      for (const d of dates) {
        const f = classifyDateFormat(d);
        dateFormats.set(f, [...(dateFormats.get(f) ?? []), d]);
      }
      if (dates.length >= 2 && dateFormats.size > 1) {
        ctx.finding({ agent: AGENT, severity: "low", role: role.name, pageUrl: url,
          title: `Inconsistent date formatting (${[...dateFormats.keys()].join(", ")})`,
          detail: `${dates.length} date(s) on this page use ${dateFormats.size} different formats: ${[...dateFormats.entries()].map(([f, ex]) => `${f} e.g. "${ex[0]}"`).join("; ")}`,
          evidence: null });
      }
    } catch (e) {
      ctx.log(AGENT, "warn", `data-integrity failed on ${url}: ${String(e).slice(0, 160)}`);
    } finally {
      await page.close();
    }
  }
  ctx.log(AGENT, "pass", `Data formatting check complete (${urls.length} pages, ${role.name})`);
}
