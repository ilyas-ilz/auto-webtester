import { isTrustworthy, type ObservationQuality } from "./recovery";

/**
 * Behavioral contracts (Plan-v7 §3.7) — ranked last, scoped tight.
 *
 * The first clean run freezes a SEMANTIC invariant; later runs validate it as a
 * regression oracle. Scoped hard to avoid a false-positive factory: only a small set of
 * deterministic, env-independent invariant kinds — never UI details (toast text, pixel
 * coords, response-time numbers), which would freeze env-specific behavior as a
 * "contract" and cry wolf every run.
 *
 * §3.6 interlock: only `clean`-quality observations may mint a contract, and an
 * unstable execution can't be used to fail one.
 */

// The only invariant kinds we trust to be deterministic and env-independent.
export type ContractKind =
  | "create-retrievable" // creating an entity → it is retrievable afterward
  | "session-persists" // login → session survives a reload
  | "unauthorized-cannot-mutate"; // a non-owner cannot mutate the entity

export interface Contract {
  kind: ContractKind;
  subject: string; // the entity type / flow the invariant is about
  expected: boolean; // the frozen truth (stored explicitly rather than assumed)
}

export interface Observation {
  kind: ContractKind;
  subject: string;
  holds: boolean; // did the invariant hold this run?
  quality: ObservationQuality;
}

/** Freeze a contract from an observation — only a clean run, and only if it held. */
export function freezeContract(o: Observation): Contract | null {
  if (o.quality !== "clean") return null; // never learn a contract from an unstable run
  if (!o.holds) return null; // don't freeze a broken invariant as the expected truth
  return { kind: o.kind, subject: o.subject, expected: true };
}

export type ContractResult = "pass" | "fail" | "inconclusive";

/** Validate a later observation against a frozen contract. */
export function checkContract(c: Contract, o: Observation): ContractResult {
  if (c.kind !== o.kind || c.subject !== o.subject) return "inconclusive"; // not the same invariant
  if (!isTrustworthy(o.quality)) return "inconclusive"; // an unstable execution can't fail a contract
  return o.holds === c.expected ? "pass" : "fail";
}
