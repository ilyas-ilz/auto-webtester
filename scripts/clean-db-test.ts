// Clean-database startup test (WEBTESTER-AUDIT P0-1 acceptance).
// Imports src/lib/db.ts in a child process whose cwd is an EMPTY temp directory —
// exactly what a fresh clone experiences. Fails loudly if schema init throws
// (the fingerprint-index bug), or if the report CLI's default query is broken
// (the startedAt typo). Run: npm run db:cleantest
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const dbModuleUrl = pathToFileURL(path.resolve("src/lib/db.ts")).href;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "webtester-cleandb-"));
const entry = path.join(tmp, "entry.mjs");
fs.writeFileSync(
  entry,
  `const db = await import(${JSON.stringify(dbModuleUrl)});
const assert = (cond, msg) => { if (!cond) { console.error("FAIL: " + msg); process.exit(1); } };
assert(db.latestFinishedRunId() === null, "latestFinishedRunId() should be null on a clean database");
assert(db.listProjects().length === 0, "listProjects() should be empty on a clean database");
// Import twice-equivalent: re-running the schema/migration block against the now-initialized
// database must be idempotent. Simulate by importing with a cache-busting query.
await import(${JSON.stringify(dbModuleUrl)} + "?again=1");
console.log("clean-db-ok");
`
);

const res = spawnSync(process.execPath, [tsxCli, entry], { cwd: tmp, encoding: "utf8", timeout: 60000 });
fs.rmSync(tmp, { recursive: true, force: true });

if (res.status !== 0 || !res.stdout.includes("clean-db-ok")) {
  console.error("Clean-database test FAILED");
  console.error(res.stdout);
  console.error(res.stderr);
  process.exit(1);
}
console.log("Clean-database test passed: fresh schema initializes, queries run, re-init idempotent.");
