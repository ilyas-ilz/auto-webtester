import type { BrowserContext } from "playwright";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";
import { RunContext } from "../context";
import type { Project, Severity } from "../../types";

const AGENT = "security";
const execFileAsync = promisify(execFile);

/**
 * Passive, safe security scan (no active probing). Checks response headers,
 * HTTPS, and session-cookie flags on the authenticated context.
 * `emitHeaders` gates the role-agnostic header findings so multi-role runs
 * do not duplicate them.
 */
export async function securityAgent(
  ctx: RunContext,
  browserCtx: BrowserContext,
  project: Project,
  emitHeaders: boolean
): Promise<void> {
  const url = project.baseUrl;
  const isHttps = url.startsWith("https://");

  if (emitHeaders) {
    if (!isHttps && project.envTag === "production") {
      ctx.finding({ agent: AGENT, severity: "high", role: null, pageUrl: url,
        title: "Production site not served over HTTPS", detail: "Traffic is unencrypted.", evidence: null });
    }
    try {
      const resp = await browserCtx.request.get(url, { timeout: 15000 });
      const h = resp.headers();
      const missing: { key: string; sev: Severity; msg: string }[] = [
        { key: "content-security-policy", sev: "medium", msg: "Missing Content-Security-Policy (primary XSS mitigation)." },
        { key: "x-content-type-options", sev: "low", msg: "Missing X-Content-Type-Options: nosniff." },
        { key: "x-frame-options", sev: "medium", msg: "Missing X-Frame-Options / frame-ancestors (clickjacking)." },
        { key: "referrer-policy", sev: "low", msg: "Missing Referrer-Policy." },
      ];
      for (const c of missing) {
        if (!h[c.key]) ctx.finding({ agent: AGENT, severity: c.sev, role: null, pageUrl: url, title: c.msg, detail: `Header "${c.key}" absent on ${url}.`, evidence: null });
      }
      if (isHttps && !h["strict-transport-security"]) {
        ctx.finding({ agent: AGENT, severity: "medium", role: null, pageUrl: url, title: "Missing Strict-Transport-Security (HSTS).", detail: "HTTPS sites should send HSTS.", evidence: null });
      }
    } catch (e) {
      ctx.log(AGENT, "warn", `Header fetch failed: ${String(e).slice(0, 160)}`);
    }
  }

  const cookies = await browserCtx.cookies();
  const session = cookies.find((c) => /sess|token|auth|sid|jwt/i.test(c.name));
  if (session) {
    const bad: string[] = [];
    if (!session.httpOnly) bad.push("not HttpOnly (readable by JS → XSS token theft)");
    if (!session.secure && project.envTag !== "localhost") bad.push("not Secure (can be sent over HTTP)");
    if (session.sameSite === "None") bad.push("SameSite=None (CSRF exposure)");
    if (bad.length) {
      ctx.finding({ agent: AGENT, severity: "high", role: null, pageUrl: url,
        title: `Session cookie "${session.name}" is weakly configured`, detail: bad.join("; "), evidence: null });
    }
  }
  ctx.recordTested(url, AGENT); // V4 coverage matrix — security only checks the base URL, not a page sample
  ctx.log(AGENT, "pass", "Security header + cookie scan complete");
}

// ---- ZAP baseline (Plan-v6 V6) — extra sensor for the security agent, flagged off by default ----
// Passive scan only (no active attack mode): safe to point at the same targets
// this fleet already crawls. Cross-role/business-logic security (IDOR, auth
// bypass) is deliberately NOT ZAP's job here — that's permissions/journey/fuzz's
// moat and ZAP can't do it; this only adds passive header/cookie/info-disclosure
// coverage beyond the deterministic checks above.

interface ZapAlert { name: string; riskcode: string; desc: string; solution: string; instances?: { uri: string }[] }
interface ZapReport { site?: { alerts?: ZapAlert[] }[] }
export interface ParsedZapFinding { severity: Severity; title: string; detail: string; pageUrl: string | null }

const ZAP_RISK_TO_SEVERITY: Record<string, Severity> = { "3": "high", "2": "medium", "1": "low", "0": "info" };
// Alert names ZAP's baseline reliably flags that our own header checks above
// already cover — skipped so the report doesn't say the same thing twice.
// Fingerprint-exact dedup doesn't work here: our titles and ZAP's alert names
// are worded differently by construction, so they'd never hash-match; matching
// on the alert category is what actually prevents a literal duplicate line.
const ZAP_DEDUPE_SUBSTR = ["content security policy", "x-content-type-options", "anti-clickjacking", "strict-transport-security", "referrer-policy"];

/** Pure — selftested. Turns a ZAP baseline JSON report into findings, deduped against our own header checks. */
export function parseZapAlerts(report: ZapReport): ParsedZapFinding[] {
  const alerts = (report.site ?? []).flatMap((s) => s.alerts ?? []);
  const findings: ParsedZapFinding[] = [];
  for (const a of alerts) {
    if (ZAP_DEDUPE_SUBSTR.some((s) => a.name.toLowerCase().includes(s))) continue;
    findings.push({
      severity: ZAP_RISK_TO_SEVERITY[a.riskcode] ?? "info",
      title: `ZAP: ${a.name}`,
      detail: `${a.desc}${a.solution ? `\n\nSolution: ${a.solution}` : ""}${(a.instances?.length ?? 0) > 1 ? `\n\n${a.instances!.length} instance(s) found.` : ""}`,
      pageUrl: a.instances?.[0]?.uri ?? null,
    });
  }
  return findings;
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync(process.platform === "win32" ? "where" : "which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

async function detectZapMode(): Promise<"docker" | "cli" | null> {
  if (await commandExists("docker")) return "docker";
  if (await commandExists(process.platform === "win32" ? "zap.bat" : "zap.sh")) return "cli";
  return null;
}

async function runZapBaseline(targetUrl: string, mode: "docker" | "cli"): Promise<ZapReport | null> {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), "zap-"));
  const reportFile = "zap-report.json";
  try {
    const args = mode === "docker"
      ? ["run", "--rm", "-v", `${reportDir}:/zap/wrk/:rw`, "-t", "zaproxy/zap-stable", "zap-baseline.py", "-t", targetUrl, "-J", reportFile, "-m", "2"]
      : ["-t", targetUrl, "-J", path.join(reportDir, reportFile), "-m", "2"];
    await execFileAsync(mode === "docker" ? "docker" : "zap-baseline.py", args, { timeout: 5 * 60 * 1000 });
  } catch {
    // zap-baseline.py exits non-zero when it finds WARN/FAIL alerts by design —
    // that's the normal case, not a failure. Only the JSON file's presence matters.
  }
  const reportPath = path.join(reportDir, reportFile);
  try {
    if (!fs.existsSync(reportPath)) return null;
    return JSON.parse(fs.readFileSync(reportPath, "utf-8")) as ZapReport;
  } catch {
    return null;
  } finally {
    fs.rmSync(reportDir, { recursive: true, force: true });
  }
}

/**
 * ZAP baseline scan (V6) — off unless ZAP=1 is set AND docker or a local ZAP
 * install (zap.sh/zap.bat) is detectable, in which case docker is preferred
 * (the documented, reproducible way to run ZAP's baseline scan; a bare local
 * install's zap-baseline.py location isn't reliably discoverable). Runs once
 * per run against the project's base URL, independent of role/profile.
 */
export async function zapBaselineScan(ctx: RunContext, project: Project): Promise<void> {
  if (process.env.ZAP !== "1") return;
  const mode = await detectZapMode();
  if (!mode) { ctx.log(AGENT, "warn", "ZAP=1 set but no ZAP install (zap.sh/zap.bat) or docker was found — skipping the baseline scan."); return; }

  ctx.status(AGENT, `Running ZAP baseline scan (${mode}) against ${project.baseUrl}`, { url: project.baseUrl });
  ctx.log(AGENT, "step", `ZAP baseline scan starting via ${mode} — passive only, no active attacks.`);
  const report = await runZapBaseline(project.baseUrl, mode);
  if (!report) { ctx.log(AGENT, "warn", "ZAP baseline scan produced no report — check docker/zap-baseline.py output."); return; }

  const parsed = parseZapAlerts(report);
  for (const f of parsed) {
    ctx.finding({ agent: AGENT, severity: f.severity, source: "zap", role: null, pageUrl: f.pageUrl, title: f.title, detail: f.detail, evidence: null });
  }
  ctx.log(AGENT, "pass", `ZAP baseline scan complete — ${parsed.length} finding(s) (deduped against header checks).`);
}
