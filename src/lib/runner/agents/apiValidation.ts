import { RunContext, type ApiSample } from "../context";
import type { Severity } from "../../types";

const AGENT = "api-validation";

export interface ApiIssue { severity: Severity; template: string; title: string; detail: string }

/** Top-level key set of an object, or a synthetic tag for arrays/primitives. Used to detect shape drift. */
function shapeKey(body: unknown): string {
  if (Array.isArray(body)) return body.length ? `array<${shapeKey(body[0])}>` : "array<empty>";
  if (body && typeof body === "object") return Object.keys(body as object).sort().join(",") || "{}";
  return `primitive:${body === null ? "null" : typeof body}`;
}

/** True when every value of an object (or every element's every value) is null/"". Catches "200 but empty" responses. */
function allNull(body: unknown): boolean {
  if (Array.isArray(body)) return false; // an empty/whole-null array is a valid "no results"
  if (!body || typeof body !== "object") return body === null;
  const vals = Object.values(body as Record<string, unknown>);
  return vals.length > 0 && vals.every((v) => v === null || v === "");
}

/**
 * Heuristic API response checks (Plan-v5 R4). Pure — selftested. Black-box: we
 * have no schema, so we only flag what's observable across the captured samples:
 *  - a 2xx JSON response whose every field is null/empty ("silently empty"),
 *  - shape drift: the same endpoint template returning different top-level key
 *    sets across calls (a client relying on one shape will break on the other).
 * Deliberately conservative — arrays and normal optional-field variance don't fire.
 */
export function analyzeApiResponses(samples: ApiSample[]): ApiIssue[] {
  const out: ApiIssue[] = [];
  const byTemplate = new Map<string, ApiSample[]>();
  for (const s of samples) {
    if (s.status >= 200 && s.status < 300) {
      (byTemplate.get(s.template) ?? byTemplate.set(s.template, []).get(s.template)!).push(s);
    }
  }
  for (const [template, group] of byTemplate) {
    const nullOne = group.find((s) => allNull(s.body));
    if (nullOne) out.push({ severity: "medium", template,
      title: `API returns 200 but an all-empty body: ${template}`,
      detail: `${nullOne.method} ${template} responded 2xx yet every field was null/empty. A page relying on this endpoint will render blank with no error — a common cause of "the page loads but shows nothing".` });

    const shapes = new Set(group.map((s) => shapeKey(s.body)));
    if (shapes.size > 1) out.push({ severity: "low", template,
      title: `API response shape is inconsistent: ${template}`,
      detail: `Calls to ${template} returned ${shapes.size} different top-level shapes (${[...shapes].map((s) => `{${s.slice(0, 60)}}`).join(" vs ")}). Clients that assume one shape can break on the other.` });
  }
  return out;
}

/**
 * API-validation agent (Plan-v5 R4) — deterministic, no AI, no browser. Reads
 * the JSON response bodies the crawler captured and flags silently-empty and
 * shape-drifting endpoints. Inventory (which endpoints exist) stays with
 * api-mapper; this adds "are the responses actually sane".
 */
export function apiValidationAgent(ctx: RunContext): void {
  const issues = analyzeApiResponses(ctx.apiSamples);
  for (const i of issues) {
    ctx.finding({ agent: AGENT, severity: i.severity, kind: "bug", role: null, pageUrl: i.template,
      title: i.title, detail: i.detail, evidence: null });
  }
  ctx.log(AGENT, "pass", `API response check: ${ctx.apiSamples.length} JSON body(ies) sampled, ${issues.length} issue(s)`);
}
