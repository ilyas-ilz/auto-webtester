// Adversarial input catalogue (Plan-v4 P9). Pure — no Playwright, no DB — so it
// is reused by CRUD, the journey Executor ({edge:*} tokens), and the optional
// form-fuzz pass, and is fully selftestable. "Detection only": XSS/SQLi payloads
// are submitted to observe how the app *handles* them, never to exploit — the
// reflected-XSS check below reads the served HTML back and flags only if the
// payload rendered unescaped.

export type FuzzKind =
  | "long" | "unicode" | "emoji" | "xss" | "sqli"
  | "empty" | "whitespace" | "bignum" | "negative" | "future" | "leap";

export type FieldType = "text" | "number" | "date";

interface FuzzEntry { kind: FuzzKind; value: string; appliesTo: FieldType[]; note: string }

// One canonical value per kind. Dates are ISO so a <input type=date> accepts them.
export const FUZZ_CATALOGUE: FuzzEntry[] = [
  { kind: "long", value: "A".repeat(5000), appliesTo: ["text"], note: "5k-char string — length limits / layout overflow" },
  { kind: "unicode", value: "مرحبا بالعالم اختبار", appliesTo: ["text"], note: "RTL Arabic — bidi / encoding handling" },
  { kind: "emoji", value: "test 🧪💥🔥 end", appliesTo: ["text"], note: "astral-plane emoji — surrogate-pair handling" },
  { kind: "xss", value: `"><img src=x onerror="window.__xss=1">`, appliesTo: ["text"], note: "reflected-XSS probe (detection only)" },
  { kind: "sqli", value: "' OR 1=1--", appliesTo: ["text"], note: "SQL-ish probe (detection only)" },
  { kind: "empty", value: "", appliesTo: ["text", "number", "date"], note: "empty — required-field handling" },
  { kind: "whitespace", value: "   ", appliesTo: ["text"], note: "whitespace-only — trim/validation handling" },
  { kind: "bignum", value: "999999999999999999", appliesTo: ["number"], note: "huge number — overflow / precision" },
  { kind: "negative", value: "-1", appliesTo: ["number"], note: "negative where positive expected" },
  { kind: "future", value: "2999-12-31", appliesTo: ["date"], note: "far-future date" },
  { kind: "leap", value: "2024-02-29", appliesTo: ["date"], note: "leap-day date" },
];

const BY_KIND = new Map(FUZZ_CATALOGUE.map((e) => [e.kind, e]));

/** The fuzz value for a kind. Journey `{edge:long}` etc. resolves through here. */
export function genFuzzInput(kind: FuzzKind): string {
  return BY_KIND.get(kind)?.value ?? "";
}

/** Fuzz entries valid to try against a given field type. */
export function fuzzFor(field: FieldType): FuzzEntry[] {
  return FUZZ_CATALOGUE.filter((e) => e.appliesTo.includes(field));
}

/**
 * Reflected-XSS signal: the payload came back in the served HTML *unescaped*.
 * If the app escaped it, the HTML holds `&lt;img …` (payload substring absent);
 * if it rendered live, the raw `<img … onerror>` is present verbatim. Only
 * angle-bracket payloads can be reflected XSS — plain values appearing in the
 * DOM are normal echoing, not a vulnerability.
 */
export function looksReflectedXss(servedHtml: string, payload: string): boolean {
  if (!/[<>]/.test(payload)) return false;
  return servedHtml.includes(payload);
}

/** Expand `{edge:long}` / `{edge:xss}` … tokens in a string to their fuzz values. */
export function expandEdgeTokens(text: string): string {
  return text.replace(/\{edge:(\w+)\}/g, (_m, k: string) => genFuzzInput(k as FuzzKind));
}
