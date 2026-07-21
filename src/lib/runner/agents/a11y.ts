import path from "path";
import type { BrowserContext } from "playwright";
import { RunContext, scrollToBottom } from "../context";
import type { RoleCred, Severity } from "../../types";

// ponytail: plain cwd path instead of require.resolve — Turbopack rewrites
// resolve() specifiers into bundle-internal names that don't exist on disk
// ("[project]\...\axe.min.js [app-rsc]"), which broke axe injection in dev.
const AXE_PATH = path.join(process.cwd(), "node_modules", "axe-core", "axe.min.js");
const AGENT = "a11y";

interface AxeViolation { id: string; impact: string | null; help: string; nodes: number; }

const bySeverity = (impact: string | null): Severity =>
  impact === "critical" || impact === "serious" ? "high" : impact === "moderate" ? "medium" : "low";

/**
 * Accessibility agent. Injects axe-core into a sample of crawled pages and
 * reports WCAG rule violations. Zero LLM cost.
 */
export async function a11yAgent(ctx: RunContext, browserCtx: BrowserContext, role: RoleCred, sample: number, profileLabel = ""): Promise<void> {
  const tag = (title: string) => (profileLabel ? `[${profileLabel}] ${title}` : title);
  const urls = ctx.sampleFor(role.name, sample, AGENT).map((p) => p.url);

  for (const url of urls) {
    const page = await browserCtx.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await scrollToBottom(page).catch(() => {}); // mount lazy content so axe audits the whole page, not just above the fold
      await page.addScriptTag({ path: AXE_PATH });
      const violations = (await page.evaluate(async () => {
        // @ts-expect-error axe is injected into the page at runtime
        const r = await axe.run(document, { resultTypes: ["violations"] });
        return r.violations.map((v: { id: string; impact: string | null; help: string; nodes: unknown[] }) => ({
          id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length,
        }));
      })) as AxeViolation[];

      for (const v of violations) {
        ctx.finding({ agent: AGENT, severity: bySeverity(v.impact), role: role.name, pageUrl: url,
          title: tag(`a11y: ${v.help} (${v.id})`), detail: `${v.nodes} element(s) affected. Impact: ${v.impact ?? "n/a"}.`, evidence: null });
      }
      ctx.log(AGENT, "step", `axe found ${violations.length} rule violation(s) on ${url}`);
    } catch (e) {
      ctx.log(AGENT, "warn", `axe failed on ${url}: ${String(e).slice(0, 160)}`);
    } finally {
      await page.close();
    }
  }
  ctx.log(AGENT, "pass", `Accessibility scan complete (${urls.length} pages, ${role.name})${profileLabel ? ` on ${profileLabel}` : ""}`);
}
