import Anthropic from "@anthropic-ai/sdk";

// Provider selection: Anthropic key wins when both are set; OpenRouter is the
// cheap fallback (any OpenAI-compatible model with vision + tool calling).
// Keys live in .env.local — Next.js loads it into the server process that
// executes runs; nothing is sent anywhere except the chosen provider.
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash";
// P1-9 (WEBTESTER-AUDIT): no AI call may hang a run forever. Generous because
// vision calls with several screenshots are legitimately slow.
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 90_000;
const HEALTH_TIMEOUT_MS = 15_000;

export function aiAvailable(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY);
}

/** Which provider/model a run will use — shown in logs so cost is traceable. */
export function aiProviderLabel(): string {
  if (process.env.ANTHROPIC_API_KEY) return `anthropic/${ANTHROPIC_MODEL}`;
  if (process.env.OPENROUTER_API_KEY) return `openrouter/${OPENROUTER_MODEL}`;
  return "none";
}

/**
 * Proves the configured AI provider actually answers (a key can exist but be
 * dead — expired/revoked keys return 401 and every agent call would fail
 * late and quietly). One ~10-token completion; called once at run start.
 */
export async function aiHealthCheck(): Promise<{ ok: boolean; error: string | null }> {
  if (!aiAvailable()) return { ok: false, error: "no API key configured" };
  try {
    if (process.env.ANTHROPIC_API_KEY) {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: HEALTH_TIMEOUT_MS });
      await client.messages.create({ model: ANTHROPIC_MODEL, max_tokens: 4, messages: [{ role: "user", content: "ping" }] });
      return { ok: true, error: null };
    }
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: OPENROUTER_MODEL, max_tokens: 4, messages: [{ role: "user", content: "ping" }] }),
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `OpenRouter ${res.status}: ${(await res.text()).slice(0, 160)}` };
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

// Plan-v8 §4.1 — provider-agnostic routing. `purpose` lets a caller ask for a
// SPECIFIC model regardless of the run's primary provider: 'verify' is a genuine
// second opinion (a different model than whatever produced the finding), and
// AI_ROUTE lets per-purpose models (vision/classify/plan/review) be pinned
// without touching agent code. Unset purpose or unset routes → today's behavior
// (primary provider's default model), so this is purely additive.
export type AiPurpose = "plan" | "review" | "verify" | "vision" | "classify";

/** Pure — selftested. `AI_ROUTE='{"vision":"google/gemini-2.0-flash"}'` → { vision: "..." }.
 * Malformed JSON or non-string values are dropped, never thrown. */
export function parseAiRoute(json: string | undefined): Partial<Record<AiPurpose, string>> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const out: Partial<Record<AiPurpose, string>> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k as AiPurpose] = v;
    return out;
  } catch {
    return {};
  }
}

/** Pure given its env-derived inputs — selftested. A routed purpose ALWAYS goes
 * through OpenRouter (the one provider-agnostic gateway) at the pinned model —
 * never silently falls back to the primary provider's model, which would defeat
 * the point of asking for a specific second opinion. */
export function resolveRoutedModel(purpose: AiPurpose | undefined, verifyModel: string | undefined, route: Partial<Record<AiPurpose, string>>): string | null {
  if (!purpose) return null;
  if (purpose === "verify") return verifyModel ?? null;
  return route[purpose] ?? null;
}

export interface AiToolRequest {
  maxTokens: number;
  tool: { name: string; description: string; schema: Record<string, unknown> };
  text: string;
  /** One image, or several (e.g. top/middle/bottom viewport shots of a tall page), in reading order. */
  imagePngBase64?: string | string[];
  purpose?: AiPurpose;
}

export interface AiToolResult {
  input: unknown; // the forced tool call's arguments, already parsed
  tokens: number; // input + output tokens actually used
}

/**
 * Runtime shape-check of a tool call's returned arguments against the tool's own
 * declared JSON schema (P1-10 — TypeScript casts validate nothing at runtime).
 * Checks: object shape, every `required` key present, and rough type agreement
 * for declared property types. Pure — selftested.
 */
export function validateToolOutput(input: unknown, schema: Record<string, unknown>): boolean {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const props = (schema.properties ?? {}) as Record<string, { type?: string }>;
  for (const key of required) {
    const v = (input as Record<string, unknown>)[key];
    if (v === undefined) return false;
    const t = props[key]?.type;
    if (!t) continue;
    if (t === "array" && !Array.isArray(v)) return false;
    if (t === "string" && typeof v !== "string") return false;
    if (t === "number" && typeof v !== "number") return false;
    if (t === "integer" && !Number.isInteger(v)) return false;
    if (t === "boolean" && typeof v !== "boolean") return false;
    if (t === "object" && (typeof v !== "object" || v === null || Array.isArray(v))) return false;
  }
  return true;
}

/**
 * One forced-tool-call completion, provider-agnostic. Both AI agents go
 * through here so adding a provider is one function, not N agent edits.
 * A response failing its own tool schema surfaces as `input: null` — an
 * execution failure the caller must handle, never "zero findings" (P1-10).
 */
export async function aiToolCall(req: AiToolRequest): Promise<AiToolResult | null> {
  const routedModel = resolveRoutedModel(req.purpose, process.env.AI_VERIFY_MODEL, parseAiRoute(process.env.AI_ROUTE));
  let result: AiToolResult | null;
  if (routedModel) {
    if (!process.env.OPENROUTER_API_KEY) return null; // a routed purpose with no OpenRouter key makes NO call — never falls back to the primary provider
    result = await openrouterCall(req, routedModel);
  } else if (process.env.ANTHROPIC_API_KEY) {
    result = await anthropicCall(req);
  } else if (process.env.OPENROUTER_API_KEY) {
    result = await openrouterCall(req, OPENROUTER_MODEL);
  } else {
    return null;
  }
  if (result && result.input !== null && !validateToolOutput(result.input, req.tool.schema)) result.input = null;
  return result;
}

async function anthropicCall(req: AiToolRequest): Promise<AiToolResult> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: AI_TIMEOUT_MS, maxRetries: 1 });
  const content: Anthropic.ContentBlockParam[] = [];
  for (const img of req.imagePngBase64 ? [req.imagePngBase64].flat() : []) content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: img } });
  content.push({ type: "text", text: req.text });

  const resp = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: req.maxTokens,
    tools: [{ name: req.tool.name, description: req.tool.description, input_schema: req.tool.schema as Anthropic.Tool.InputSchema }],
    tool_choice: { type: "tool", name: req.tool.name },
    messages: [{ role: "user", content }],
  });
  const toolUse = resp.content.find((b) => b.type === "tool_use");
  return {
    input: toolUse && "input" in toolUse ? toolUse.input : null,
    tokens: resp.usage.input_tokens + resp.usage.output_tokens,
  };
}

async function openrouterCall(req: AiToolRequest, model: string): Promise<AiToolResult> {
  const content: unknown[] = [{ type: "text", text: req.text }];
  for (const img of req.imagePngBase64 ? [req.imagePngBase64].flat() : []) content.push({ type: "image_url", image_url: { url: `data:image/png;base64,${img}` } });

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: req.maxTokens,
      messages: [{ role: "user", content }],
      tools: [{ type: "function", function: { name: req.tool.name, description: req.tool.description, parameters: req.tool.schema } }],
      tool_choice: { type: "function", function: { name: req.tool.name } },
    }),
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as {
    choices?: { message?: { tool_calls?: { function?: { arguments?: string } }[] } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const args = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  let input: unknown = null;
  try { input = args ? JSON.parse(args) : null; } catch { /* model returned malformed JSON args — treated as no findings */ }
  return { input, tokens: (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0) };
}
