import type { BrowserContext } from "playwright";
import type { Project } from "../../types";
import { RunContext } from "../context";

const AGENT = "register";

// --- pure helpers (unit-tested in selftest.ts) ---

/** A unique, obviously-synthetic address so created accounts are easy to spot/sweep. */
export function genTestEmail(domain: string, seed: string): string {
  const clean = (domain || "example.test").replace(/^@/, "");
  return `qa-bot-${seed.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10)}@${clean}`;
}

/** First 4–8 digit run of digits in an OTP/verification email body. */
export function extractOtp(text: string): string | null {
  const m = text.match(/\b(\d{4,8})\b/);
  return m ? m[1] : null;
}

/** First same-origin link that looks like a verify/confirm/activate link. */
export function extractVerifyLink(text: string, origin: string): string | null {
  const links = text.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
  return links.find((l) => l.startsWith(origin) && /(verify|confirm|activate|validation|token)/i.test(l)) ?? null;
}

// --- Mailpit/MailHog inbox reader (both expose a compatible REST API) ---

interface InboxMessage { ID: string; To: { Address: string }[] }

/** Polls the test inbox for the newest message to `email`; returns its plain-text body. Shared with the email-flows agent. */
export async function readInbox(inboxUrl: string, email: string, tries = 10): Promise<string | null> {
  const base = inboxUrl.replace(/\/$/, "");
  for (let i = 0; i < tries; i++) {
    try {
      const list = (await (await fetch(`${base}/api/v1/messages?limit=50`)).json()) as { messages?: InboxMessage[] };
      const hit = (list.messages ?? []).find((m) => m.To?.some((t) => t.Address?.toLowerCase() === email.toLowerCase()));
      if (hit) {
        const msg = (await (await fetch(`${base}/api/v1/message/${hit.ID}`)).json()) as { Text?: string; HTML?: string };
        return msg.Text || msg.HTML || "";
      }
    } catch {
      /* inbox not reachable — treated as "no OTP available" by the caller */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

/**
 * Self-registration agent (Plan-v2 V1). Creates a brand-new account through the
 * signup form instead of using supplied credentials, then — if a test inbox is
 * configured — reads the OTP/verify-link and completes confirmation. Runs once
 * per project (not per role). Skipped entirely when no registerPath is set.
 */
export async function registerAgent(ctx: RunContext, browserCtx: BrowserContext, project: Project): Promise<void> {
  if (!project.registerPath) return;
  const origin = new URL(project.baseUrl).origin;
  const url = new URL(project.registerPath, project.baseUrl).toString();
  const email = genTestEmail(new URL(project.baseUrl).hostname.replace(/^www\./, ""), ctx.runId);
  const password = `Qa!${ctx.runId.slice(0, 8)}A1`;
  const page = await browserCtx.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const emailField = page.locator('input[type="email"], input[name*="email" i], input[id*="email" i]').first();
    const passFields = page.locator('input[type="password"]');
    if (!(await emailField.count()) || !(await passFields.count())) {
      ctx.log(AGENT, "warn", `No signup form found at ${url} — skipping self-registration.`);
      return;
    }

    await emailField.fill(email);
    // Fill password + confirm-password (if present) with the same value.
    const nPass = await passFields.count();
    for (let i = 0; i < Math.min(nPass, 2); i++) await passFields.nth(i).fill(password);
    // A visible name/username text field, if the form has one.
    const nameField = page.locator('input[name*="name" i]:not([type="password"]), input[name*="user" i]:not([type="password"])').first();
    if (await nameField.count()) await nameField.fill("QA Bot").catch(() => {});
    await ctx.screenshot(page, "register-filled");

    const submit = page.locator('button[type="submit"], input[type="submit"], button:has-text("sign up"), button:has-text("register"), button:has-text("create")').first();
    if (await submit.count()) await submit.click({ timeout: 5000 }).catch(() => {});
    else await passFields.first().press("Enter");
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // OTP / email-verification step, only if an inbox is configured.
    if (project.testInboxUrl) {
      const body = await readInbox(project.testInboxUrl, email);
      if (!body) {
        ctx.log(AGENT, "warn", `Registered ${email} but no verification email arrived in the test inbox within ~15s.`);
      } else {
        const link = extractVerifyLink(body, origin);
        const otp = extractOtp(body);
        if (link) {
          await page.goto(link, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
          ctx.log(AGENT, "step", `Followed email verification link for ${email}.`);
        } else if (otp) {
          const otpField = page.locator('input[name*="otp" i], input[name*="code" i], input[autocomplete="one-time-code"], input[inputmode="numeric"]').first();
          if (await otpField.count()) {
            await otpField.fill(otp);
            const verify = page.locator('button[type="submit"], button:has-text("verify"), button:has-text("confirm")').first();
            if (await verify.count()) await verify.click({ timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(1500);
            ctx.log(AGENT, "step", `Entered OTP ${otp} for ${email}.`);
          } else {
            ctx.log(AGENT, "warn", `Got OTP ${otp} from inbox but found no OTP input to enter it.`);
          }
        }
      }
    }

    const stillOnForm = new URL(page.url()).pathname.toLowerCase().includes(project.registerPath.toLowerCase()) && (await passFields.first().isVisible().catch(() => false));
    const shot = await ctx.screenshot(page, "register-result");
    if (stillOnForm) {
      ctx.finding({
        agent: AGENT, severity: "high", role: null, pageUrl: url,
        title: "Self-registration did not complete",
        detail: `Filled the signup form as ${email} and submitted, but the page still shows the registration form. Registration may be broken, or a captcha/manual step blocks it.`,
        evidence: shot,
      });
    } else {
      ctx.finding({
        agent: AGENT, severity: "info", kind: "improvement", role: null, pageUrl: url,
        title: `Self-registration succeeded (${email})`,
        detail: `A fresh account was created${project.testInboxUrl ? " and email verification completed" : " (no inbox configured, verification step skipped)"}. New-user signup flow works end to end.`,
        evidence: shot,
      });
    }
  } catch (e) {
    ctx.log(AGENT, "warn", `Self-registration errored: ${String(e).slice(0, 200)}`);
  } finally {
    await page.close();
  }
}
