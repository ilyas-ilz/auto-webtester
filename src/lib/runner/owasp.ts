/**
 * OWASP Top 10 2021 mapping (Plan-v8 §6) — labeling and reporting, not a new
 * scanner. The security testing this fleet already does (write-IDOR, cross-role
 * replay, header/cookie checks) is real A01/A02/A05 coverage; this makes it
 * reportable against the standard categories, plus the two genuinely missing
 * checks (A06 dependency audit, A07 auth-failure probes — see login.ts).
 */

import { execFile } from "child_process";
import { promisify } from "util";
import type { Finding, Severity, OwaspCoverageRow, Project } from "../types";
import type { RunContext } from "./context";

const execFileAsync = promisify(execFile);

export const OWASP_LABELS: Record<string, string> = {
  "A01:2021": "Broken Access Control",
  "A02:2021": "Cryptographic Failures",
  "A03:2021": "Injection",
  "A04:2021": "Insecure Design",
  "A05:2021": "Security Misconfiguration",
  "A06:2021": "Vulnerable and Outdated Components",
  "A07:2021": "Identification and Authentication Failures",
  "A08:2021": "Software and Data Integrity Failures",
  "A09:2021": "Security Logging and Monitoring Failures",
  "A10:2021": "Server-Side Request Forgery",
};
export const OWASP_CATEGORIES = Object.keys(OWASP_LABELS);

// §6.6: never scanned from outside the app — a real "not tested", not an invented partial.
export const OWASP_NOT_TESTABLE: Record<string, string> = {
  "A04:2021": "threat-modeling activity, not black-box observable",
  "A09:2021": "whether a login attempt was logged is unobservable from outside the app",
  "A10:2021": "needs an out-of-band collaborator server — its own project",
};

/**
 * Pure — selftested (total over its own key set, per the acceptance check). ZAP's
 * baseline scan emits CWE ids, not OWASP categories — this is the maintained
 * translation table. Small on purpose: baseline is passive-only, ~25 distinct
 * CWEs in practice. Unmapped CWEs get no `owasp` tag rather than a guess.
 */
export const CWE_TO_OWASP: Record<number, string[]> = {
  79: ["A03:2021"], // XSS
  89: ["A03:2021"], // SQL injection
  90: ["A03:2021"], // LDAP injection
  611: ["A03:2021"], // XXE
  918: ["A10:2021"], // SSRF
  22: ["A01:2021"], // path traversal
  284: ["A01:2021"], // improper access control
  285: ["A01:2021"], // improper authorization
  639: ["A01:2021"], // IDOR
  352: ["A01:2021"], // CSRF
  200: ["A01:2021"], // information exposure
  312: ["A02:2021"], // cleartext storage
  319: ["A02:2021"], // cleartext transmission
  326: ["A02:2021"], // weak crypto
  327: ["A02:2021"], // broken/risky crypto algorithm
  798: ["A02:2021"], // hardcoded credentials
  1004: ["A02:2021"], // missing HttpOnly cookie flag
  614: ["A02:2021"], // missing Secure cookie flag
  16: ["A05:2021"], // configuration
  2: ["A05:2021"], // environment
  548: ["A05:2021"], // directory listing
  1021: ["A05:2021"], // clickjacking (missing frame-ancestors)
  693: ["A05:2021"], // protection mechanism failure (missing security headers)
  1035: ["A06:2021"], // vulnerable third-party component
  937: ["A06:2021"], // using components with known vulnerabilities
  287: ["A07:2021"], // improper authentication
  384: ["A07:2021"], // session fixation
  613: ["A07:2021"], // insufficient session expiration
  345: ["A08:2021"], // insufficient verification of data authenticity
  502: ["A08:2021"], // deserialization of untrusted data
  778: ["A09:2021"], // insufficient logging
};

/** Pure — selftested. CWE ids the baseline scan doesn't map get no tag, never a guess. */
export function owaspForCwe(cweid: number | null): string[] | undefined {
  return cweid == null ? undefined : CWE_TO_OWASP[cweid];
}

// Agents whose already-recorded `ctx.tested` entries (route × dimension coverage,
// V4 — no parallel counter per §6.4) double as the "tested" count for a category.
const OWASP_AGENTS: Record<string, string[]> = {
  "A01:2021": ["permissions"],
  "A02:2021": ["security"],
  "A03:2021": ["form-validation"],
  "A05:2021": ["security"],
};

/**
 * Pure — selftested. Builds the ten-row coverage matrix from data callers already
 * have: `tested` is the SAME url→agent map every other coverage view reads (§6.4,
 * no parallel counter); `findings` counts this run's findings tagged with each
 * category. A06/A07 are supplied by the caller (one-off checks, not per-URL) since
 * they aren't in the url×agent map at all. A04/A09/A10 are always "not tested".
 */
export function buildOwaspCoverage(
  tested: ReadonlyMap<string, ReadonlySet<string>>,
  findings: readonly Pick<Finding, "owasp">[],
  extra: Partial<Record<string, number | null>> = {},
): OwaspCoverageRow[] {
  const findingCounts = new Map<string, number>();
  for (const f of findings) for (const cat of f.owasp ?? []) findingCounts.set(cat, (findingCounts.get(cat) ?? 0) + 1);

  return OWASP_CATEGORIES.map((category) => {
    const notTestedReason = OWASP_NOT_TESTABLE[category];
    let testedCount: number | null = notTestedReason ? null : (extra[category] ?? null);
    if (!notTestedReason && testedCount === null && OWASP_AGENTS[category]) {
      const agents = new Set(OWASP_AGENTS[category]);
      let count = 0;
      for (const agentSet of tested.values()) if ([...agentSet].some((a) => agents.has(a))) count++;
      testedCount = count;
    }
    return { category, label: OWASP_LABELS[category], tested: testedCount, findings: findingCounts.get(category) ?? 0, notTestedReason };
  });
}

export interface NpmAuditVuln { name: string; severity: string; fixAvailable: boolean }

/** Pure — selftested against a fixture (no network in selftest, per the acceptance check). */
export function parseNpmAudit(json: unknown): NpmAuditVuln[] {
  const root = json as { vulnerabilities?: Record<string, { severity?: string; fixAvailable?: unknown }> } | null;
  const vulns = root?.vulnerabilities ?? {};
  return Object.entries(vulns).map(([name, v]) => ({
    name, severity: v.severity ?? "unknown", fixAvailable: !!v.fixAvailable,
  }));
}

const AUDIT_SEVERITY: Record<string, Severity> = { critical: "critical", high: "high", moderate: "medium", low: "low", info: "info" };

/**
 * §6.5 A06 — one `npm audit --json`, no new dependency. Skips silently when no
 * repo path is configured (extending the same guard every repo-connected feature
 * in this fleet already uses).
 */
export async function runNpmAudit(repoPath: string): Promise<NpmAuditVuln[]> {
  try {
    const { stdout } = await execFileAsync("npm", ["audit", "--json"], { cwd: repoPath, timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
    return parseNpmAudit(JSON.parse(stdout));
  } catch (e) {
    // npm audit exits non-zero when it finds vulnerabilities — that's the normal
    // case, and the JSON is still on stdout, captured in the error object.
    const stdout = (e as { stdout?: string }).stdout;
    if (stdout) { try { return parseNpmAudit(JSON.parse(stdout)); } catch { /* malformed output — no findings */ } }
    return [];
  }
}

export function auditSeverity(sev: string): Severity {
  return AUDIT_SEVERITY[sev] ?? "info";
}

/** §6.5 A06 entry point — skips silently when no repo path is configured. */
export async function npmAuditFindings(ctx: RunContext, project: Project): Promise<void> {
  const repo = project.repoPath.trim();
  if (!repo) return;
  const vulns = await runNpmAudit(repo);
  ctx.owaspTestedExtra["A06:2021"] = 1;
  for (const v of vulns) {
    if (v.severity === "info" || v.severity === "unknown") continue;
    ctx.finding({
      agent: "security", severity: auditSeverity(v.severity), kind: "bug", role: null, pageUrl: null,
      title: `Vulnerable dependency: ${v.name} (${v.severity})`,
      detail: `npm audit reports a ${v.severity} vulnerability in "${v.name}"${v.fixAvailable ? " — a fix is available (npm audit fix)." : " — no automatic fix is available yet; check the advisory."}`,
      evidence: null, owasp: ["A06:2021"],
    });
  }
  ctx.log("security", "pass", `npm audit: ${vulns.length} vulnerable package(s) found in the connected repo`);
}
