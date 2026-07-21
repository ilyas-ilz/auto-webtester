import type { BrowserContext, Page } from "playwright";
import type { Project, RoleCred } from "../../types";
import { RunContext } from "../context";

const AGENT = "login";

/** Counts visible OAuth/SSO sign-in affordances ("Sign in with Google" etc.). */
async function oauthButtonCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const rx = /google|github|microsoft|facebook|apple|okta|auth0|\bsso\b|oauth|openid/i;
    return Array.from(document.querySelectorAll("a, button, [role=button]"))
      .filter((el) => rx.test(`${el.textContent ?? ""} ${el.getAttribute("href") ?? ""}`)).length;
  }).catch(() => 0);
}

export type AuthType = "password" | "oauth-only" | "magic-link" | "none";

/**
 * No credentials configured for this project: classify the login page so the
 * report says WHY authenticated flows were skipped, and what would enable them
 * (e.g. OAuth-only → paste a Playwright storageState into the project).
 */
export async function detectAuthType(ctx: RunContext, browserCtx: BrowserContext, project: Project): Promise<AuthType> {
  const page = await browserCtx.newPage();
  const loginUrl = new URL(project.loginPath, project.baseUrl).toString();
  let type: AuthType = "none";
  try {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500); // let SPA login widgets render
    const hasPassword = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
    const oauthCount = await oauthButtonCount(page);
    const hasEmailOnly = !hasPassword && (await page.locator('input[type="email"], input[name*="email" i]').first().isVisible().catch(() => false));
    type = hasPassword ? "password" : oauthCount > 0 ? "oauth-only" : hasEmailOnly ? "magic-link" : "none";
  } catch {
    // login page unreachable — route-health will flag it; stay "none"
  }

  const detail: Record<AuthType, string> = {
    password: "A password login form exists but no credentials are configured. Add a role to test authenticated flows.",
    "oauth-only": "Only OAuth/SSO sign-in (e.g. Google) was found — automated password login is not possible. To test authenticated flows, log in manually once and paste a Playwright storageState JSON into the project's session state field. This run covers public pages only.",
    "magic-link": "Login appears to be email/magic-link only. Configure the test inbox URL and a role, or paste a session state, to test authenticated flows. This run covers public pages only.",
    none: "No login form or OAuth buttons were detected on the login path. This run covers public pages only.",
  };
  const shot = await ctx.screenshot(page, "auth-type-detect").catch(() => null);
  ctx.finding({
    agent: AGENT, severity: "info", role: "Anonymous", pageUrl: loginUrl,
    title: `Auth type detected: ${type} — authenticated flows skipped`,
    detail: detail[type], evidence: shot,
  });
  ctx.log(AGENT, "step", `Auth type on ${loginUrl}: ${type}`);
  await page.close();
  return type;
}

/**
 * Pure: choose the most meaningful error string scraped from a failed login
 * page. Prefers text that reads like an auth error over generic banners
 * (cookie notices etc. also match [class*=alert]).
 */
export function pickLoginError(texts: string[]): string | null {
  const clean = [...new Set(texts.map((t) => t.replace(/\s+/g, " ").trim()).filter((t) => t.length >= 3 && t.length <= 300))];
  if (!clean.length) return null;
  return clean.find((t) => /invalid|incorrect|wrong|fail|not match|no match|denied|locked|disabled|too many|captcha|required|expired/i.test(t)) ?? clean[0];
}

/** Scrapes visible error/alert text off the page after a failed submit. */
async function extractLoginError(page: Page): Promise<string | null> {
  const texts = await page.evaluate(() => {
    const sel = '[role="alert"], [aria-live], [class*="error" i], [class*="alert" i], [class*="danger" i], [class*="invalid" i]';
    return Array.from(document.querySelectorAll(sel))
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => (el.textContent ?? "").trim())
      .filter(Boolean);
  }).catch(() => [] as string[]);
  return pickLoginError(texts);
}

interface AttemptResult {
  ok: boolean;
  formFound: boolean;
  siteError: string | null; // what the page itself displayed after a failed submit
}

/**
 * Deterministic login agent: opens the login page, finds the credential
 * fields heuristically (works with most email/username + password forms),
 * submits, and verifies the session left the login page. On failure it
 * quotes the site's own error banner in the finding, and — because email
 * case-sensitivity is a real bug in the wild — retries once with the
 * lowercased username and reports a finding if THAT logs in.
 */
export async function loginAgent(
  ctx: RunContext,
  browserCtx: BrowserContext,
  project: Project,
  role: RoleCred
): Promise<Page | null> {
  const page = await browserCtx.newPage();
  const loginUrl = new URL(project.loginPath, project.baseUrl).toString();
  ctx.log(AGENT, "step", `[${role.name}] Opening login page ${loginUrl}`);
  ctx.status(AGENT, `Logging in as ${role.name}`, { url: loginUrl });

  const attempt = async (username: string, shotLabel: string): Promise<AttemptResult> => {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    const userField = page.locator(
      'input[type="email"], input[name*="email" i], input[name*="user" i], input[autocomplete="username"], input[id*="email" i], input[id*="user" i]'
    ).first();
    const passField = page.locator('input[type="password"]').first();

    try {
      await userField.waitFor({ state: "visible", timeout: 10000 });
      await passField.waitFor({ state: "visible", timeout: 10000 });
    } catch {
      return { ok: false, formFound: false, siteError: null };
    }

    // Let the page finish hydrating before interacting: on SSR SPAs (Next.js +
    // NextAuth, etc.) the fields render in the static HTML but the submit handler
    // (client-side signIn) isn't wired until hydration completes — clicking before
    // then does nothing and looks like a silent auth failure.
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

    await userField.fill(username);
    await passField.fill(role.password);
    await ctx.screenshot(page, shotLabel, { role: role.name });

    const submit = page.locator(
      'button[type="submit"], input[type="submit"], button:has-text("log in"), button:has-text("login"), button:has-text("sign in")'
    ).first();
    const urlBefore = page.url();
    const loginPathKey = new URL(loginUrl).pathname.toLowerCase().replace(/\/+$/, "");

    const clickSubmit = async (): Promise<void> => {
      if (await submit.count().catch(() => 0)) await submit.click({ timeout: 5000 }).catch(() => {});
      else await passField.press("Enter").catch(() => {});
    };
    const succeeded = async (): Promise<boolean> => {
      const url = page.url().toLowerCase();
      const leftLogin = url !== urlBefore.toLowerCase() && !(loginPathKey && loginPathKey !== "/" && url.includes(loginPathKey));
      const passGone = !(await passField.isVisible().catch(() => false));
      return leftLogin || passGone;
    };

    await clickSubmit();

    // NB: do NOT wait for networkidle after submit. Modern auth stacks
    // (NextAuth/authjs, Firebase, most SPA XHR logins) submit via fetch and THEN
    // client-redirect, and many poll /api/auth/session continuously so the network
    // never goes idle. Poll for success instead — URL left the login path, or the
    // password field detached — over ~16s. And re-click at ~4s/~9s if there's no
    // progress and no error banner yet: on SSR SPAs the submit handler is wired on
    // hydration, so a first click can land before signIn() exists and silently
    // no-op (seen under rapid multi-role logins with several contexts open).
    let ok = false;
    for (let i = 0; i < 32; i++) { // up to ~16s
      if (await succeeded()) { ok = true; break; }
      if ((i === 8 || i === 18) && !(await extractLoginError(page))) await clickSubmit();
      await page.waitForTimeout(500);
    }
    if (ok) return { ok: true, formFound: true, siteError: null };
    return { ok: false, formFound: true, siteError: await extractLoginError(page) };
  };

  // Retry once on an AMBIGUOUS failure — form fields not found (page slow to
  // render under concurrent multi-role load) or submitted-with-no-error-banner
  // (a timing/hydration miss). A real credential rejection surfaces a site error
  // banner and is NOT retried, so a genuinely-bad password still fails fast.
  const attemptResilient = async (username: string, label: string): Promise<AttemptResult> => {
    let r = await attempt(username, label);
    if (!r.ok && (!r.formFound || !r.siteError)) {
      ctx.log(AGENT, "step", `[${role.name}] Ambiguous login result — retrying once`);
      await page.waitForTimeout(1200);
      r = await attempt(username, label);
    }
    return r;
  };

  let first: AttemptResult;
  try {
    first = await attemptResilient(role.username, `${role.name}-login-filled`);
  } catch (e) {
    ctx.finding({
      agent: AGENT, severity: "critical", role: role.name, pageUrl: loginUrl,
      title: "Login page failed to load",
      detail: String(e), evidence: null,
    });
    await page.close();
    return null;
  }

  if (!first.formFound) {
    const shot = await ctx.screenshot(page, `${role.name}-login-form-not-found`, { role: role.name });
    const oauthCount = await oauthButtonCount(page);
    ctx.finding({
      agent: AGENT, severity: "high", role: role.name, pageUrl: loginUrl,
      title: "Could not locate login form fields",
      detail: oauthCount > 0
        ? "No password form found, but OAuth/SSO sign-in buttons are present — this site likely only supports OAuth login. Paste a Playwright storageState JSON into the project's session state field instead of username/password."
        : "No visible username/email + password inputs found within 10s. If login lives on another path, set the project's login path.",
      evidence: shot,
    });
    await page.close();
    return null;
  }

  if (first.ok) {
    await ctx.screenshot(page, `${role.name}-logged-in`, { role: role.name });
    ctx.log(AGENT, "pass", `[${role.name}] Logged in, landed on ${page.url()}`);
    return page;
  }

  // Rejected. If the username has uppercase, try once lowercased — a success
  // there is a case-sensitivity bug in the target site, not a tooling issue.
  const lower = role.username.toLowerCase();
  if (lower !== role.username) {
    ctx.log(AGENT, "step", `[${role.name}] Login rejected — retrying with lowercased email ${lower}`);
    let second: AttemptResult | null = null;
    try {
      second = await attempt(lower, `${role.name}-login-retry-lowercase`);
    } catch {
      second = null; // navigation flake on retry — fall through to the failure finding
    }
    if (second?.ok) {
      const shot = await ctx.screenshot(page, `${role.name}-logged-in`, { role: role.name });
      ctx.finding({
        agent: AGENT, severity: "high", role: role.name, pageUrl: loginUrl,
        title: "Login email is case-sensitive",
        detail: `"${role.username}" was rejected${first.siteError ? ` (site said: "${first.siteError}")` : ""}, but the lowercased "${lower}" logged in fine. The login endpoint compares emails case-sensitively — normalize emails server-side, this locks out real users who type their address with different capitalization.`,
        evidence: shot,
      });
      ctx.log(AGENT, "pass", `[${role.name}] Logged in with lowercased email, landed on ${page.url()}`);
      return page;
    }
  }

  const shot = await ctx.screenshot(page, `${role.name}-login-failed`, { role: role.name });
  const said = first.siteError
    ? `The site rejected the sign-in and displayed: "${first.siteError}".`
    : "Still on the login page with the password field visible after submitting; no error banner was detected.";
  ctx.finding({
    agent: AGENT, severity: "critical", role: role.name, pageUrl: loginUrl,
    title: `Login failed for role "${role.name}"`,
    detail: `${said} Verify these exact credentials work by hand at ${loginUrl}${lower !== role.username ? " (a lowercased-email retry also failed)" : ""}. If they do work manually, the likely blockers are 2FA, CAPTCHA, or bot detection.`,
    evidence: shot,
  });
  await page.close();
  return null;
}

/**
 * Cheap heuristic: does this page look like the app bounced us to a logged-out
 * state? A visible password field, or a URL back on the login path, is the
 * signal a long-running crawl's session expired mid-pass (Plan-v2 §9).
 */
export async function looksLoggedOut(page: Page, project: Project): Promise<boolean> {
  const path = new URL(page.url()).pathname.toLowerCase();
  const loginPath = project.loginPath.toLowerCase();
  if (loginPath && loginPath !== "/" && path.includes(loginPath.replace(/^\//, ""))) return true;
  return page.locator('input[type="password"]').first().isVisible().catch(() => false);
}

/**
 * Re-establish the role's session in the SAME browser context (cookies are
 * context-scoped, so a successful re-login re-auths every open page). Used by
 * the crawler when it detects a session-expiry bounce. Returns whether re-auth
 * succeeded.
 */
export async function reauth(ctx: RunContext, browserCtx: BrowserContext, project: Project, role: RoleCred): Promise<boolean> {
  const page = await loginAgent(ctx, browserCtx, project, role);
  if (!page) return false;
  await page.close();
  return true;
}
