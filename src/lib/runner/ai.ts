import Anthropic from "@anthropic-ai/sdk";

// Provider selection: Anthropic key wins when both are set; OpenRouter is the
// cheap fallback (any OpenAI-compatible model with vision + tool calling).
// Keys live in .env.local — Next.js loads it into the server process that
// executes runs; nothing is sent anywhere except the chosen provider.
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash";

export function aiAvailable(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY);
}

/** Which provider/model a run will use — shown in logs so cost is traceable. */
export function aiProviderLabel(): string {
  if (process.env.ANTHROPIC_API_KEY) return `anthropic/${ANTHROPIC_MODEL}`;
  if (process.env.OPENROUTER_API_KEY) return `openrouter/${OPENROUTER_MODEL}`;
  return "none";
}

export interface AiToolRequest {
  maxTokens: number;
  tool: { name: string; description: string; schema: Record<string, unknown> };
  text: string;
  imagePngBase64?: string;
}

export interface AiToolResult {
  input: unknown; // the forced tool call's arguments, already parsed
  tokens: number; // input + output tokens actually used
}

/**
 * One forced-tool-call completion, provider-agnostic. Both AI agents go
 * through here so adding a provider is one function, not N agent edits.
 */
export async function aiToolCall(req: AiToolRequest): Promise<AiToolResult | null> {
  if (process.env.ANTHROPIC_API_KEY) return anthropicCall(req);
  if (process.env.OPENROUTER_API_KEY) return openrouterCall(req);
  return null;
}

async function anthropicCall(req: AiToolRequest): Promise<AiToolResult> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const content: Anthropic.ContentBlockParam[] = [];
  if (req.imagePngBase64) content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: req.imagePngBase64 } });
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

async function openrouterCall(req: AiToolRequest): Promise<AiToolResult> {
  const content: unknown[] = [{ type: "text", text: req.text }];
  if (req.imagePngBase64) content.push({ type: "image_url", image_url: { url: `data:image/png;base64,${req.imagePngBase64}` } });

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      max_tokens: req.maxTokens,
      messages: [{ role: "user", content }],
      tools: [{ type: "function", function: { name: req.tool.name, description: req.tool.description, parameters: req.tool.schema } }],
      tool_choice: { type: "function", function: { name: req.tool.name } },
    }),
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
