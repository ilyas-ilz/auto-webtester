import type { Severity, AutonomousResolution } from "../types";

// Plan-v6 V9: pure scorer for the seeded-defect benchmark. Matches this run's
// findings against bench/defects.json and prints the honest numbers the 4th
// review demanded — detection rate, unseeded-finding rate, critical recall,
// duplicate rate. Pure — selftested; the bench runner (bench/run.ts) feeds it.

export interface SeededDefect {
  id: string;
  app: string;
  path: string; // pageUrl substring; "" = any page of the app
  dimension: string;
  keyword?: string; // must appear (case-insensitive) in title+detail; "" / absent = any wording
  severity: Severity;
  note?: string;
}

export interface BenchFinding {
  agent: string;
  severity: Severity;
  title: string;
  detail: string;
  pageUrl: string | null;
  fingerprint?: string; // present when fed from db findings; enables the human-FP metric
}

// Which fleet agents can legitimately claim a defect of each dimension. Wider
// than the coverage-matrix mapping on purpose: a seeded console error may be
// surfaced by route-health, the crawler, or expectations — any of them counts.
const AGENTS_BY_DIMENSION: Record<string, string[]> = {
  functional: ["route-health", "interaction", "crawler", "page-expectations", "root-cause", "crud", "journey", "explorer", "resilience", "chaos", "regression"],
  forms: ["form-validation"],
  a11y: ["a11y"],
  visual: ["visual"],
  security: ["security"],
  perf: ["perf"],
  seo: ["seo"],
  "data-integrity": ["data-integrity"],
  // Layout/responsive defects: ui-audit owns overflow, clipped text, dead links and
  // cross-page design-token drift; visual owns broken images and layout shift.
  ui: ["ui-audit", "visual"],
  permissions: ["permissions"],
  api: ["route-health", "api-validation", "api-mapper", "root-cause"],
};

export interface BenchScore {
  total: number;
  detected: SeededDefect[];
  missed: SeededDefect[];
  detectionRate: number; // detected / seeded
  criticalRecall: number; // detected critical+high seeded / all critical+high seeded
  totalFindings: number;
  unseededFindings: number; // findings matching no seeded defect — includes both noise AND legit unseeded observations
  unseededRate: number;
  duplicateRate: number; // findings repeating another finding's (normalized title, page)
  humanFalsePositives: number; // findings a human reviewer marked false_positive/intended (Plan-v8 §3.3) — confirmed noise, unlike unseeded which may be legit
  humanFpRate: number;
}

function defectMatchesFinding(d: SeededDefect, f: BenchFinding): boolean {
  if (d.path && !(f.pageUrl ?? "").includes(d.path)) return false;
  const agents = AGENTS_BY_DIMENSION[d.dimension] ?? [];
  if (agents.length && !agents.includes(f.agent)) return false;
  if (d.keyword && !`${f.title}\n${f.detail}`.toLowerCase().includes(d.keyword.toLowerCase())) return false;
  return true;
}

export function scoreBench(defects: SeededDefect[], findings: BenchFinding[], suppressedFingerprints?: ReadonlySet<string>): BenchScore {
  const detected: SeededDefect[] = [];
  const missed: SeededDefect[] = [];
  const matchedFindings = new Set<number>();
  for (const d of defects) {
    let hit = false;
    findings.forEach((f, i) => {
      if (defectMatchesFinding(d, f)) { hit = true; matchedFindings.add(i); }
    });
    (hit ? detected : missed).push(d);
  }

  const isCrit = (s: Severity): boolean => s === "critical" || s === "high";
  const critSeeded = defects.filter((d) => isCrit(d.severity)).length;
  const critDetected = detected.filter((d) => isCrit(d.severity)).length;

  const seen = new Map<string, number>();
  for (const f of findings) {
    const key = `${f.title.replace(/^\[[^\]]+\]\s*/, "").toLowerCase()}|${f.pageUrl ?? ""}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const duplicates = [...seen.values()].filter((c) => c > 1).reduce((acc, c) => acc + c - 1, 0);

  // Plan-v8 §3.3 human-FP feed — additive so every pre-v8 metric stays comparable
  // to the 73% baseline; a suppressed finding still participates in matching above.
  const humanFalsePositives = suppressedFingerprints?.size
    ? findings.filter((f) => f.fingerprint && suppressedFingerprints.has(f.fingerprint)).length
    : 0;

  return {
    total: defects.length,
    detected,
    missed,
    detectionRate: defects.length ? detected.length / defects.length : 0,
    criticalRecall: critSeeded ? critDetected / critSeeded : 1,
    totalFindings: findings.length,
    unseededFindings: findings.length - matchedFindings.size,
    unseededRate: findings.length ? (findings.length - matchedFindings.size) / findings.length : 0,
    duplicateRate: findings.length ? duplicates / findings.length : 0,
    humanFalsePositives,
    humanFpRate: findings.length ? humanFalsePositives / findings.length : 0,
  };
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;

/** Console report for one app's score — kept here (pure string building) so the runner stays thin. */
export function formatBenchReport(app: string, s: BenchScore): string {
  const lines = [
    `── ${app} ─────────────────────────────`,
    `  seeded defects  ${s.total}`,
    `  detected        ${s.detected.length}/${s.total} (${pct(s.detectionRate)})`,
    `  critical recall ${pct(s.criticalRecall)}`,
    `  findings total  ${s.totalFindings} (${s.unseededFindings} unseeded → ${pct(s.unseededRate)} unseeded rate)`,
    `  duplicate rate  ${pct(s.duplicateRate)}`,
  ];
  if (s.humanFalsePositives) lines.push(`  human FPs       ${s.humanFalsePositives} (${pct(s.humanFpRate)}) — reviewer-confirmed noise`);
  if (s.missed.length) {
    lines.push(`  MISSED:`);
    for (const d of s.missed) lines.push(`    ✗ [${d.id}] (${d.dimension}) ${d.note ?? d.keyword ?? d.path}`);
  }
  return lines.join("\n");
}

/**
 * ARR line for the bench console (Plan-v7 §6): unknowns resolved deterministically ÷
 * unknowns encountered — the actual "brain-like without AI" measure. It should climb as
 * §3.4/§3.5 land *while AI-calls fall*; detection % alone can't show that.
 */
export function formatArr(arr: AutonomousResolution): string {
  return `  ARR             ${pct(arr.rate)}  (${arr.byProbe} probed + ${arr.byFacts} known / ${arr.encountered} unknowns; ${arr.requiredAI} would need AI, ${arr.unresolved} unresolved)`;
}
