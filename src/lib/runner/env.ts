import fs from "fs";
import path from "path";

/**
 * Minimal .env.local loader for tsx CLI entrypoints (cli/e2e/bench/selftest).
 * Next.js loads .env.local for UI-launched runs; plain tsx does not, which
 * silently ran every CLI run with the AI layer off. Existing env vars win.
 */
export function loadEnvLocal(): void {
  const file = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    const [, key, raw] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^["']|["']$/g, "");
  }
}
