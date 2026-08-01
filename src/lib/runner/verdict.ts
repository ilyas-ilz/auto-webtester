// Verdict policy (WEBTESTER-AUDIT P0-2 + P1-12). Pure — selftested.
//
// A finding may fail the run ONLY when it is a real, still-standing bug:
//   kind === "bug"  AND  critical/high  AND  not human-suppressed  AND  not cross-model-refuted.
// And a PASS is only honest when every scheduled agent actually completed —
// otherwise the evidence is incomplete and the verdict is "inconclusive".
import type { Severity, FindingKind } from "../types";

export interface VerdictFinding {
  severity: Severity;
  kind: FindingKind;
  fingerprint: string;
}

export interface Verdict {
  status: "passed" | "failed" | "inconclusive";
  reason: string;
  eligibleCount: number; // findings that actually drove a FAIL
}

export function decideRunStatus(
  findings: readonly VerdictFinding[],
  suppressed: ReadonlySet<string>,
  refuted: ReadonlySet<string>,
  agentsFailedCount: number,
): Verdict {
  const eligible = findings.filter(
    (f) =>
      (f.severity === "critical" || f.severity === "high") &&
      f.kind === "bug" &&
      !suppressed.has(f.fingerprint) &&
      !refuted.has(f.fingerprint),
  );
  if (eligible.length) {
    return { status: "failed", reason: `${eligible.length} unsuppressed critical/high bug finding(s)`, eligibleCount: eligible.length };
  }
  if (agentsFailedCount > 0) {
    return {
      status: "inconclusive",
      reason: `${agentsFailedCount} agent(s) failed after retries — evidence incomplete, an honest PASS is not possible`,
      eligibleCount: 0,
    };
  }
  return { status: "passed", reason: "no unsuppressed critical/high bug findings; all scheduled agents completed", eligibleCount: 0 };
}
