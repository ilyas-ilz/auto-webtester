import type { Browser, BrowserContext, Page } from "playwright";
import type { Project, RoleCred } from "../../types";
import { RunContext } from "../context";
import { genTestEmail } from "./register";

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

/**
 * Pure: read credentials out of a human's free-text answer to the login
 * question. Accepts "pass: x", "user: a@b.com / pass: x", "a@b.com hunter2",
 * or a bare password. Returns null when the answer isn't credentials at all
 * ("continue", "skip", "I logged in myself"), which means "look at the page".
 */
export function parseCredentialAnswer(answer: string, currentUsername: string): { username: string; password: string } | null {
  const text = answer.trim();
  if (!text) return null;
  if (/^(continue|done|ok|go|skip|i (logged|signed) in|logged in|signed in)\b/i.test(text)) return null;

  const pass = /(?:pass(?:word)?|pwd)\s*[:=]\s*(\S+)/i.exec(text)?.[1];
  const user = /(?:user(?:name)?|email|login)\s*[:=]\s*(\S+)/i.exec(text)?.[1];
  if (pass) return { username: user ?? currentUsername, password: pass };
  if (user) return null; // a username with no password can't be attempted

  // Unlabelled: "a@b.com hunter2" (two tokens) or a bare password (one token).
  const parts = text.split(/\s+/);
  if (parts.length === 2 && parts[0].includes("@")) return { username: parts[0], password: parts[1] };
  if (parts.length === 1 && !text.includes("@")) return { username: currentUsername, password: text };
  return null;
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

  const attempt = async (username: string, shotLabel: string, password = role.password): Promise<AttemptResult> => {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    const userField = page.locator(
      'input[type="email"], input[name*="email" i], input[name*="user" i], input[autocomplete="username"], input[id*="email" i], input[id*="user" i]'
    ).first();
    const passField = page.locator('input[type="password"]').first();

    try {
      // 20s, not 10s: cold-start / CPU-throttled hosting (a DigitalOcean app instance
      // in our own run took >10s to paint the form) made this abort before the login
      // page had rendered, and the run reported "could not locate login form fields"
      // on an app whose credentials were perfectly fine.
      await userField.waitFor({ state: "visible", timeout: 20000 });
      await passField.waitFor({ state: "visible", timeout: 20000 });
    } catch {
      return { ok: false, formFound: false, siteError: null };
    }

    // Let the page finish hydrating before interacting: on SSR SPAs (Next.js +
    // NextAuth, etc.) the fields render in the static HTML but the submit handler
    // (client-side signIn) isn't wired until hydration completes — clicking before
    // then does nothing and looks like a silent auth failure.
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

    await userField.fill(username);
    await passField.fill(password);
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
    for (let i = 0; i < 60; i++) { // up to ~30s — a manual sign-in on a throttled host took ~8s to redirect; 16s left no margin once the app was under crawl load
      ctx.checkCancelled(); // P1-3: a stop request must not wait out a 30s login poll
      if (await succeeded()) { ok = true; break; }
      if ((i === 8 || i === 18 || i === 36) && !(await extractLoginError(page))) await clickSubmit();
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
    ctx.recoveriesUsed.push({ subject: `login:${role.id}`, strategy: "lowercase-email", worked: !!second?.ok });
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

  // Ask the human before giving up (only when someone is watching the live view —
  // askHuman returns null after its wait window, so an unattended run is unaffected).
  // They can send a corrected password, "user: x / pass: y", or take over the live
  // browser by hand and reply "continue" once they're signed in.
  const help = await ctx.askHuman(
    AGENT,
    `Login failed for "${role.name}"${first.siteError ? ` — the site said: "${first.siteError}"` : ""}. Send the correct credentials (e.g. "pass: hunter2" or "user: a@b.com / pass: hunter2"), or sign in yourself in the live view above and reply "continue".`,
  );
  if (help !== null) {
    const fixed = parseCredentialAnswer(help, role.username);
    if (fixed) {
      ctx.log(AGENT, "step", `[${role.name}] Retrying with the credentials the human supplied`);
      const retry = await attempt(fixed.username, `${role.name}-login-human-retry`, fixed.password).catch(() => null);
      if (retry?.ok) {
        await ctx.screenshot(page, `${role.name}-logged-in`, { role: role.name });
        ctx.log(AGENT, "pass", `[${role.name}] Logged in with human-supplied credentials, landed on ${page.url()}`);
        ctx.finding({
          agent: AGENT, severity: "info", role: role.name, pageUrl: loginUrl,
          title: `Credentials for "${role.name}" were corrected by hand during the run`,
          detail: "The configured credentials were rejected but a human supplied working ones mid-run. Update the project's role so the next run doesn't need help.",
          evidence: null,
        });
        return page;
      }
      ctx.log(AGENT, "step", `[${role.name}] Human-supplied credentials were also rejected`);
    } else if (!(await looksLoggedOut(page, project))) {
      // They signed in themselves in the live view — the session is in this context.
      ctx.log(AGENT, "pass", `[${role.name}] Human signed in manually, landed on ${page.url()}`);
      ctx.finding({
        agent: AGENT, severity: "info", role: role.name, pageUrl: loginUrl,
        title: `Signed in manually by a human during the run`,
        detail: "Automated login failed but a human completed the sign-in in the live view (2FA, CAPTCHA, or a wrong stored password would all do this). The rest of the run used that session.",
        evidence: null,
      });
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

// ---- Plan-v8 §6.5 A07 — authentication-failure probes ---------------------
// Off unless SEC_PROBE=1 is set explicitly: unlike everything else in this file,
// these probes have side effects a wrong assumption could visit on a real
// account or a real signup flow, so the §3.5 safe-probing gate alone isn't
// enough — this needs its own opt-in on top.

const LOCKOUT_SIGNAL = /too many attempts|account (is |has been )?locked|try again later|temporarily (blocked|disabled)|verify you.?re human|captcha/i;
const WEAK_PASSWORD_REJECTION = /weak|too common|at least \d+ characters|must contain|stronger password|password.{0,20}(requirement|strength)/i;

/**
 * Pure — selftested. The account-lockout probe must NEVER hammer a real,
 * configured account — that could lock out an actual user in production. This
 * is the guard the plan calls out explicitly: the safe-probing gate (§3.5)
 * only encodes "safe to try", not "this action can affect a third party".
 */
export function isSafeProbeUsername(username: string, roles: readonly { username: string }[]): boolean {
  const u = username.trim().toLowerCase();
  return u.length > 0 && !roles.some((r) => r.username.trim().toLowerCase() === u);
}

/** A07: does the login endpoint show ANY lockout/rate-limit/CAPTCHA signal after
 * repeated failed attempts against a username that is guaranteed not to be a real,
 * configured account? Never uses a configured role's credentials. */
export async function accountLockoutProbe(ctx: RunContext, browserCtx: BrowserContext, project: Project): Promise<void> {
  const fakeUsername = `qabot-nonexistent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`;
  if (!isSafeProbeUsername(fakeUsername, project.roles)) {
    ctx.log(AGENT, "warn", "A07 lockout probe skipped — generated probe username unexpectedly collided with a configured role (should never happen).");
    return;
  }
  const loginUrl = new URL(project.loginPath, project.baseUrl).toString();
  const page = await browserCtx.newPage();
  let lockoutSeen = false;
  try {
    for (let i = 0; i < 6; i++) {
      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
      const userField = page.locator('input[type="email"], input[name*="email" i], input[name*="user" i], input[id*="email" i], input[id*="user" i]').first();
      const passField = page.locator('input[type="password"]').first();
      if (!(await userField.count().catch(() => 0)) || !(await passField.count().catch(() => 0))) break;
      await userField.fill(fakeUsername).catch(() => {});
      await passField.fill("Wr0ng-Password-Probe!").catch(() => {});
      const submit = page.locator('button[type="submit"], input[type="submit"], button:has-text("log in"), button:has-text("sign in")').first();
      if (await submit.count().catch(() => 0)) await submit.click({ timeout: 5000 }).catch(() => {});
      else await passField.press("Enter").catch(() => {});
      await page.waitForTimeout(1200);
      const body = (await page.evaluate(() => document.body?.innerText || "").catch(() => "")) as string;
      if (LOCKOUT_SIGNAL.test(body)) { lockoutSeen = true; break; }
    }
  } finally {
    await page.close();
  }
  if (lockoutSeen) {
    ctx.log(AGENT, "pass", "A07: account lockout / rate limiting observed after repeated failed login attempts");
  } else {
    ctx.finding({
      agent: AGENT, severity: "medium", role: null, pageUrl: loginUrl,
      title: "No account-lockout or rate-limiting observed after repeated failed logins",
      detail: "6 failed login attempts against a guaranteed-nonexistent username produced no lockout, CAPTCHA, or rate-limit message. The login endpoint may be brute-forceable. Probed with a fabricated username — never a configured role's credentials.",
      evidence: null, owasp: ["A07:2021"],
    });
  }
}

/** A07: session fixation — the session identifier must change across login. Needs
 * a FRESH, never-authenticated context (caller's job) so the "before" cookie is
 * genuinely pre-auth. Returns false only if login itself failed (already flagged
 * by loginAgent) — the probe couldn't reach a verdict. */
export async function sessionFixationProbe(ctx: RunContext, browserCtx: BrowserContext, project: Project, role: RoleCred): Promise<boolean> {
  const loginUrl = new URL(project.loginPath, project.baseUrl).toString();
  const pre = await browserCtx.newPage();
  await pre.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
  const sessionCookie = (cookies: { name: string; value: string }[]) => cookies.find((c) => /sess|token|auth|sid|jwt/i.test(c.name))?.value ?? null;
  const preSession = sessionCookie(await browserCtx.cookies());
  await pre.close();

  const loggedInPage = await loginAgent(ctx, browserCtx, project, role);
  if (!loggedInPage) return false;
  await loggedInPage.close();
  const postSession = sessionCookie(await browserCtx.cookies());

  if (preSession && postSession && preSession === postSession) {
    ctx.finding({
      agent: AGENT, severity: "high", role: role.name, pageUrl: loginUrl,
      title: "Session identifier does not change across login (session fixation)",
      detail: `The session cookie observed before authenticating as "${role.name}" is identical to the one after logging in. An attacker who plants a victim's session id before they log in can hijack the resulting authenticated session — regenerate the session id on every privilege change.`,
      evidence: null, owasp: ["A07:2021"],
    });
  } else {
    ctx.log(AGENT, "pass", "A07: session identifier changes across login — no fixation risk observed");
  }
  return true;
}

/** A07: does the registration flow accept an obviously weak/common password with
 * no strength requirement? Only runs on a registration flow the fleet already
 * exercises, with a throwaway generated account — never a real user's credentials. */
export async function weakPasswordProbe(ctx: RunContext, browserCtx: BrowserContext, project: Project): Promise<boolean> {
  const registerUrl = new URL(project.registerPath, project.baseUrl).toString();
  const page = await browserCtx.newPage();
  try {
    await page.goto(registerUrl, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
    const emailField = page.locator('input[type="email"], input[name*="email" i]').first();
    const passField = page.locator('input[type="password"]').first();
    if (!(await emailField.count().catch(() => 0)) || !(await passField.count().catch(() => 0))) return false;
    const email = genTestEmail(new URL(project.baseUrl).hostname, `secprobe${Date.now()}`);
    const weakPassword = "password123";
    await emailField.fill(email).catch(() => {});
    await passField.fill(weakPassword).catch(() => {});
    const submit = page.locator('button[type="submit"], input[type="submit"], button:has-text("sign up"), button:has-text("register"), button:has-text("create account")').first();
    const before = page.url();
    if (await submit.count().catch(() => 0)) await submit.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const stillOnForm = page.url() === before && (await passField.isVisible().catch(() => false));
    if (stillOnForm) {
      const body = (await page.evaluate(() => document.body?.innerText || "").catch(() => "")) as string;
      ctx.log(AGENT, "pass", WEAK_PASSWORD_REJECTION.test(body) ? "A07: registration rejects a weak/common password" : "A07: registration did not proceed (inconclusive — may be an unrelated validation error)");
    } else {
      ctx.finding({
        agent: AGENT, severity: "medium", role: null, pageUrl: registerUrl,
        title: "Registration accepts a weak/common password with no strength requirement",
        detail: `Signing up with the common password "${weakPassword}" succeeded (throwaway test account ${email}). Weak-password acceptance makes credential-stuffing and brute-force attacks far more effective against every account on this system.`,
        evidence: null, owasp: ["A07:2021"],
      });
    }
    return true;
  } finally {
    await page.close();
  }
}

/**
 * Entry point (Plan-v8 §6.5): runs all three A07 probes, each in its own fresh
 * browser context so cookie/session state never leaks between them or from the
 * run's real authenticated sessions. Records how many actually ran into
 * `ctx.owaspTestedExtra` for the §6.4 coverage matrix (honest "not tested"
 * beats an invented partial — see owasp.ts).
 */
export async function authFailureProbes(ctx: RunContext, browser: Browser, contextOptions: Record<string, unknown>, project: Project, role: RoleCred | undefined): Promise<void> {
  if (process.env.SEC_PROBE !== "1") return;
  ctx.log(AGENT, "step", "SEC_PROBE=1 — running OWASP A07 authentication-failure probes (lockout, session fixation, weak-password).");
  let ran = 0;

  const lockoutCtx = await browser.newContext(contextOptions);
  try { await accountLockoutProbe(ctx, lockoutCtx, project); ran++; }
  catch (e) { ctx.log(AGENT, "warn", `A07 lockout probe failed: ${String(e).slice(0, 160)}`); }
  finally { await lockoutCtx.close(); }

  if (role) {
    const fixationCtx = await browser.newContext(contextOptions);
    try { if (await sessionFixationProbe(ctx, fixationCtx, project, role)) ran++; }
    catch (e) { ctx.log(AGENT, "warn", `A07 session-fixation probe failed: ${String(e).slice(0, 160)}`); }
    finally { await fixationCtx.close(); }
  }

  if (project.registerPath && project.envTag !== "production") {
    const weakCtx = await browser.newContext(contextOptions);
    try { if (await weakPasswordProbe(ctx, weakCtx, project)) ran++; }
    catch (e) { ctx.log(AGENT, "warn", `A07 weak-password probe failed: ${String(e).slice(0, 160)}`); }
    finally { await weakCtx.close(); }
  }

  ctx.owaspTestedExtra["A07:2021"] = ran;
}
