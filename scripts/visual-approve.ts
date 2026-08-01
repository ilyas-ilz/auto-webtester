// Approve pending visual changes (WEBTESTER-AUDIT P1-7).
// The visual agent never overwrites an approved baseline; it writes
// `<key>.candidate.png` beside it. This promotes candidates to approved.
//   npm run visual:approve            → list what is pending
//   npm run visual:approve -- --all   → promote every candidate
//   npm run visual:approve -- <substr> → promote candidates whose path matches
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(process.cwd(), "public", "baselines");

function findCandidates(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findCandidates(p, out);
    else if (e.name.endsWith(".candidate.png")) out.push(p);
  }
  return out;
}

const args = process.argv.slice(2);
const all = args.includes("--all");
const filter = args.find((a) => !a.startsWith("--"));
const candidates = findCandidates(ROOT).filter((p) => !filter || p.includes(filter));

if (!candidates.length) {
  console.log("No pending visual changes.");
  process.exit(0);
}

if (!all && !filter) {
  console.log(`${candidates.length} pending visual change(s):`);
  for (const c of candidates) console.log(`  ${path.relative(process.cwd(), c)}`);
  console.log("\nApprove with:  npm run visual:approve -- --all      (or a path substring)");
  process.exit(0);
}

for (const c of candidates) {
  const approved = c.replace(/\.candidate\.png$/, ".png");
  fs.renameSync(c, approved);
  console.log(`approved ${path.relative(process.cwd(), approved)}`);
}
console.log(`\n${candidates.length} baseline(s) approved.`);
