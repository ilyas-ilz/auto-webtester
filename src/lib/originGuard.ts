/**
 * Who may drive the live browser.
 *
 * The app has no login of its own, so the live-view control endpoint would
 * otherwise be open to any page in the user's browser: a simple JSON POST needs
 * no preflight and no cookie, so any site you visit while the dev server runs
 * could click and type inside your authenticated test browser. Origin is the
 * one header a page cannot forge, and a shared token covers hosted setups.
 */
export function controlAllowed(
  h: { origin: string | null; host: string | null; token: string | null },
  expectedToken: string | undefined,
  allowedHosts?: string | undefined
): boolean {
  if (expectedToken && h.token !== expectedToken) return false;
  // DNS-rebinding guard. Origin===Host proves the two headers AGREE, not that the
  // caller is us: attacker.example with a 0-TTL record rebound to 127.0.0.1 sends
  // Origin: attacker.example AND Host: attacker.example, satisfies the equality
  // below, and the request still lands on this server. So the Host must also be one
  // we actually answer on — loopback, or explicitly configured. A configured token
  // vouches on its own (a drive-by page cannot read it), which keeps hosted setups
  // working without also having to list their hostname.
  if (!expectedToken && !isOurHost(h.host, allowedHosts)) return false;
  // A same-origin fetch may omit Origin; a cross-origin one from a browser never does. But a
  // non-browser client omits it freely, so only trust the omission when the request came in on
  // loopback — off-box, an Origin (or the token) is required.
  // (a matching token has already been checked above, so off-box it is what vouches here)
  if (!h.origin) return isLoopback(h.host) || !!expectedToken;
  try {
    return new URL(h.origin).host === h.host;
  } catch {
    return false; // unparseable Origin — not something a real same-origin request sends
  }
}

/** Hosts this server admits to being: loopback, plus anything in WEBTESTER_ALLOWED_HOSTS. */
function isOurHost(host: string | null, allowedHosts: string | undefined): boolean {
  if (isLoopback(host)) return true;
  if (!host || !allowedHosts?.trim()) return false;
  return allowedHosts.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).includes(host.toLowerCase());
}

function isLoopback(host: string | null): boolean {
  const name = (host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return name === "localhost" || name === "127.0.0.1" || name === "::1";
}

/**
 * Which target URLs an MCP client may point `run_test` at (Plan-v8 §5.1).
 *
 * The CLI (`cli.ts`) itself is unguarded — whoever runs it on their own machine
 * already has that access by definition. An MCP server is different: it's a
 * standing process any connected client (Claude Desktop, etc.) can send
 * `run_test` to, so "MCP adds zero new capability" (the plan's own invariant)
 * needs an explicit allowlist here, not an implicit one that doesn't exist yet
 * in the CLI to "reuse". Defaults to loopback-only — the safe default for a
 * long-running server — widened via `MCP_ALLOWED_ORIGINS` (comma-separated
 * origins, e.g. "https://staging.example.com,http://localhost:3000").
 */
export function targetOriginAllowed(url: string, allowlistEnv: string | undefined): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (!allowlistEnv?.trim()) return isLoopback(u.host);
  const allowed = allowlistEnv.split(",").map((s) => s.trim()).filter(Boolean);
  return allowed.some((entry) => {
    try { return new URL(entry).origin === u.origin; } catch { return false; }
  });
}
