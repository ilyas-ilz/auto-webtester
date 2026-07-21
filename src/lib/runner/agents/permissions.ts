import type { BrowserContext } from "playwright";
import { RunContext } from "../context";
import type { RoleCred } from "../../types";

const AGENT = "permissions";
const MAX_CHECKS = 20; // ponytail: bound the N² role×route sweep on apps with many roles/pages
const PER_PAIR = 6;
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
            ctx.finding({
              agent: AGENT, severity: "critical", role: b.role.name, pageUrl: target.url,
              title: `Role "${b.role.name}" can reach "${a.role.name}"'s route ${finalPath}`,
              detail: `${b.role.name}'s session loaded ${target.url} (HTTP ${status}) without being redirected or denied, but only ${a.role.name} discovered this route during crawl.`,
              evidence: shot,
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
