// Read-only progress peek at the newest run — safe to run while a run is live (WAL).
import Database from "better-sqlite3";
import path from "path";

const db = new Database(path.join(process.cwd(), "data", "webtester.db"), { readonly: true });
const run = db.prepare(`SELECT id, status, mode, started_at FROM runs ORDER BY started_at DESC LIMIT 1`).get() as { id: string; status: string; mode: string; started_at: string } | undefined;
if (!run) { console.log("no runs yet"); process.exit(0); }
console.log(`run ${run.id}  status=${run.status}  mode=${run.mode}`);

const agentRows = db.prepare(`SELECT agent, level, COUNT(*) c FROM run_events WHERE run_id=? GROUP BY agent, level`).all(run.id) as { agent: string; level: string; c: number }[];
const byAgent = new Map<string, Record<string, number>>();
for (const r of agentRows) { const e = byAgent.get(r.agent) ?? {}; e[r.level] = r.c; byAgent.set(r.agent, e); }
console.log("\nagent".padEnd(18), "step pass fail warn shot");
for (const [a, e] of [...byAgent.entries()].sort()) console.log(a.padEnd(18), String(e.step ?? 0).padStart(4), String(e.pass ?? 0).padStart(4), String(e.fail ?? 0).padStart(4), String(e.warn ?? 0).padStart(4), String(e.shot ?? 0).padStart(4));

const fc = db.prepare(`SELECT COUNT(*) c FROM findings WHERE run_id=?`).get(run.id) as { c: number };
console.log(`\nfindings so far: ${fc.c}`);
const login = db.prepare(`SELECT level, message FROM run_events WHERE run_id=? AND agent IN ('login','orchestrator') ORDER BY id`).all(run.id) as { level: string; message: string }[];
console.log("\nlogin/orchestrator trail:");
for (const e of login.slice(-25)) console.log(`  ${e.level.padEnd(4)} ${e.message.slice(0, 120)}`);
