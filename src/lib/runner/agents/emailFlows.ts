import type { BrowserContext } from "playwright";
import type { Project } from "../../types";
import { RunContext } from "../context";
import { readInbox, extractVerifyLink } from "./register";

const AGENT = "email-flows";

/**
 * Transactional-email agent (Plan-v5 R9) — extends the signup-OTP coverage to
 * the forgot-password flow, the other email path every app has. Needs a test
 * inbox (Mailpit/MailHog) AND at least one role (whose username is the email to
 * reset). Triggers "forgot password" from the login page and checks a reset
 * email actually arrives — a silent no-email is a real, common bug (misconfigured
 * SMTP, wrong template). Non-destructive: it only requests a reset, never
 * completes it. Skipped when no inbox is configured.
 */
export async function emailFlowsAgent(ctx: RunContext, browserCtx: BrowserContext, project: Project): Promise<void> {
  if (!project.testInboxUrl) { ctx.log(AGENT, "step", "No test inbox configured — skipping email-flow checks."); return; }
  const email = project.roles[0]?.username;
  if (!email || !email.includes("@")) { ctx.log(AGENT, "step", "No role with an email address — skipping forgot-password check."); return; }

  const origin = new URL(project.baseUrl).origin;
  const page = await browserCtx.newPage();
  try {
    await page.goto(new URL(project.loginPath, project.baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    const link = page.locator('a:has-text("forgot"), a:has-text("reset"), button:has-text("forgot"), a:has-text("Forgot password")').first();
    if (!(await link.count())) {
      ctx.finding({ agent: AGENT, severity: "info", kind: "improvement", role: null, pageUrl: page.url(),
        title: "No visible forgot-password link on the login page",
        detail: "Could not find a 'forgot password' / 'reset' link to test the password-reset email. Users who forget their password have no self-service path here.", evidence: await ctx.screenshot(page, "forgot-missing") });
      return;
    }
    await link.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const emailField = page.locator('input[type="email"], input[name*="email" i], input[id*="email" i]').first();
    if (await emailField.count()) {
      await emailField.fill(email).catch(() => {});
      const submit = page.locator('button[type="submit"], input[type="submit"], button:has-text("reset"), button:has-text("send")').first();
      if (await submit.count()) await submit.click({ timeout: 5000 }).catch(() => {});
      else await emailField.press("Enter").catch(() => {});
    }
    await page.waitForTimeout(1500);

    const body = await readInbox(project.testInboxUrl, email, 8);
    if (body) {
      const resetLink = extractVerifyLink(body, origin);
      ctx.finding({ agent: AGENT, severity: "info", kind: "improvement", role: null, pageUrl: page.url(),
        title: "Password-reset email delivered",
        detail: `Requested a reset for ${email} and an email arrived in the test inbox${resetLink ? ` with a reset link (${resetLink})` : ""}. Forgot-password flow works end to end (reset not completed — non-destructive).`, evidence: null });
    } else {
      ctx.finding({ agent: AGENT, severity: "medium", role: null, pageUrl: page.url(),
        title: "Password-reset email never arrived",
        detail: `Triggered a password reset for ${email} but no email reached the test inbox within ~12s. SMTP may be misconfigured or the reset silently failed — users would be locked out with no recovery.`, evidence: await ctx.screenshot(page, "forgot-no-email") });
    }
  } catch (e) {
    ctx.log(AGENT, "warn", `Email-flow check errored: ${String(e).slice(0, 180)}`);
  } finally {
    await page.close();
  }
}
