import { createHash } from "crypto";
import type { Page, Frame } from "playwright";

/**
 * Semantic snapshot (Plan-v7 §3.1) — a11y **fused with** DOM.
 *
 * A pure a11y tree misses `<div onclick="deleteUser(42)">🗑</div>`; a pure DOM
 * dump is CSS-brittle and token-heavy. So we fuse: accessible role/name/state +
 * DOM facts (tag/type/href/value/testid) + geometry (bbox/visibility) + a
 * relocation ref, per element, per frame.
 *
 * Design (Plan-v7 decisions):
 *  - ADDITIVE / opt-in (#3): a new module. Nothing here changes how interaction/
 *    expectations resolve targets today — consumers adopt `semanticSnapshot`
 *    when they choose. Zero blast radius on the 73% bench.
 *  - Heavy DOM walk runs in-page (`evaluate`); all *semantic derivation*
 *    (role/name/ref/interactive) is pure TS below and is selftested without a
 *    browser. The in-page code only gathers raw facts.
 *  - Per-frame (#4): `semanticSnapshotAll` iterates `page.frames()` so embedded
 *    iframes aren't a blind spot. Canvas/WebGL content is out of scope — it has
 *    no DOM to read (ponytail: declared ceiling, not an oversight).
 */

const MAX_NODES = 600; // ponytail: bound output; raise if deep apps truncate too often
const STR_CAP = 120;

export interface NameParts {
  ariaLabel?: string;
  labelledby?: string;
  label?: string;
  alt?: string;
  value?: string; // only set for button-like inputs — a text input's value is content, not a name
  placeholder?: string;
  title?: string;
  text?: string;
}

/** Raw per-element facts gathered in-page. Names are resolved in-page (needs the tree); everything semantic is derived in TS. */
interface RawEl {
  tag: string;
  type: string | null;
  roleAttr: string | null;
  id: string | null;
  testId: string | null;
  testIdAttr: string | null;
  nameParts: NameParts;
  href: string | null;
  value: string | null;
  states: string[];
  bbox: { x: number; y: number; w: number; h: number } | null;
  visible: boolean;
  hasOnclick: boolean;
  tabindex: number | null;
  idx: number;
}

export interface SemanticNode {
  ref: string; // relocation hint, semantic-first: role=…[name=…] › #id › [data-testid=…] › tag#idx
  role: string;
  name: string;
  tag: string;
  type: string | null;
  href: string | null;
  value: string | null;
  testId: string | null;
  states: string[];
  bbox: { x: number; y: number; w: number; h: number } | null;
  visible: boolean;
  interactive: boolean;
  frameUrl: string | null; // null = main frame; set by semanticSnapshotAll for child frames
}

export interface SemanticSnapshot {
  url: string;
  nodes: SemanticNode[];
  truncated: boolean;
}

// ---- pure derivation (selftested) ----

/** Implicit ARIA role from tag + input type — the subset that matters for QA. */
export function implicitRole(tag: string, type: string | null): string {
  const t = tag.toLowerCase();
  switch (t) {
    case "a": return "link"; // ponytail: a[no-href] isn't truly a link, but nearly all we capture have href
    case "button": return "button";
    case "select": return "combobox";
    case "textarea": return "textbox";
    case "img": return "img";
    case "nav": return "navigation";
    case "main": return "main";
    case "header": return "banner";
    case "footer": return "contentinfo";
    case "summary": return "button";
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": return "heading";
    case "input":
      switch ((type ?? "text").toLowerCase()) {
        case "button": case "submit": case "reset": case "image": return "button";
        case "checkbox": return "checkbox";
        case "radio": return "radio";
        case "range": return "slider";
        case "search": return "searchbox";
        case "hidden": return "";
        default: return "textbox"; // text/email/tel/url/password/number/…
      }
    default: return "";
  }
}

/** Accessible-name resolution by W3C-ish priority. Inputs are already-extracted strings, so this is pure. */
export function chooseName(p: NameParts): string {
  for (const s of [p.ariaLabel, p.labelledby, p.label, p.alt, p.value, p.placeholder, p.title, p.text]) {
    const t = (s ?? "").trim();
    if (t) return t.slice(0, STR_CAP);
  }
  return "";
}

/** Is the element something a user acts on? Drives the `interactive` flag consumers filter by. */
export function isInteresting(role: string, hasOnclick: boolean, tabindex: number | null): boolean {
  const interactiveRoles = new Set([
    "link", "button", "checkbox", "radio", "textbox", "combobox", "searchbox",
    "slider", "menuitem", "menuitemcheckbox", "tab", "switch", "option",
  ]);
  if (interactiveRoles.has(role)) return true;
  if (hasOnclick) return true;
  return tabindex !== null && tabindex >= 0;
}

/** Stable-ish relocation ref, semantic identity first (the plan's thesis: role/name over CSS). */
export function computeRef(f: {
  role: string; name: string; id: string | null;
  testId: string | null; testIdAttr: string | null; tag: string; idx: number;
}): string {
  if (f.role && f.name) return `role=${f.role}[name=${JSON.stringify(f.name)}]`;
  if (f.id) return `#${f.id}`;
  if (f.testId && f.testIdAttr) return `[${f.testIdAttr}=${JSON.stringify(f.testId)}]`;
  return `${f.tag}#${f.idx}`; // ponytail: positional fallback — brittle, used only when nothing semantic exists
}

/** Pure raw→node enrichment. Shared by the in-page collector's output. */
export function enrich(r: RawEl, frameUrl: string | null): SemanticNode {
  const role = r.roleAttr || implicitRole(r.tag, r.type);
  const name = chooseName(r.nameParts);
  return {
    ref: computeRef({ role, name, id: r.id, testId: r.testId, testIdAttr: r.testIdAttr, tag: r.tag, idx: r.idx }),
    role, name,
    tag: r.tag, type: r.type, href: r.href, value: r.value,
    testId: r.testId, states: r.states, bbox: r.bbox, visible: r.visible,
    interactive: isInteresting(role, r.hasOnclick, r.tabindex),
    frameUrl,
  };
}

// ---- in-page collection (browser side; exercised by real runs, not selftest) ----

/**
 * Serialized into the page (passed directly to `frame.evaluate`): walks the DOM
 * once, returns bounded raw facts. Takes a single tuple arg because Playwright
 * evaluate passes exactly one argument. References NO outer symbol — everything
 * is an in-page global or an erased type — so `.toString()` serialization is clean.
 */
function collectRaw([cap, strCap]: readonly [number, number]): RawEl[] {
  // ponytail: self-contained __name guard so this works even on a context that
  // didn't run startTrace's shim (see context.ts). Harmless if already defined.
  const g = self as unknown as { __name?: (f: unknown) => unknown };
  g.__name = g.__name || ((f) => f);

  const out: RawEl[] = [];
  const all = document.querySelectorAll("*");
  let idx = 0;
  for (const node of Array.from(all)) {
    if (out.length >= cap) break;
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute("type");
    const roleAttr = el.getAttribute("role");
    const tiAttr = el.getAttribute("tabindex");
    const tabindex = tiAttr == null ? null : Number(tiAttr);
    const hasOnclick = el.hasAttribute("onclick") || typeof (el as unknown as { onclick?: unknown }).onclick === "function";

    const testIdAttr = ["data-testid", "data-test", "data-cy", "data-qa"].find((a) => el.hasAttribute(a)) ?? null;
    const testId = testIdAttr ? el.getAttribute(testIdAttr) : null;

    const structural = ["a", "button", "input", "select", "textarea", "summary",
      "h1", "h2", "h3", "h4", "h5", "h6", "nav", "main"].includes(tag);
    const clickable = hasOnclick || (tabindex !== null && tabindex >= 0);
    if (!(structural || roleAttr || testId || clickable)) continue;
    if (type === "hidden") continue;

    // accessible-name candidates (labelledby resolved here — needs the tree)
    const isButtonInput = tag === "input" && ["button", "submit", "reset", "image"].includes((type ?? "").toLowerCase());
    let labelledby = "";
    const lb = el.getAttribute("aria-labelledby");
    if (lb) labelledby = lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
    let label = "";
    if (["input", "select", "textarea"].includes(tag)) {
      const forId = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      label = (forId?.textContent ?? el.closest("label")?.textContent ?? "").trim();
    }
    const directText = (["a", "button", "summary", "h1", "h2", "h3", "h4", "h5", "h6"].includes(tag) || roleAttr)
      ? (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, strCap)
      : "";
    const nameParts: RawEl["nameParts"] = {
      ariaLabel: el.getAttribute("aria-label") ?? "",
      labelledby,
      label,
      alt: el.getAttribute("alt") ?? "",
      value: isButtonInput ? ((el as HTMLInputElement).value ?? "") : "",
      placeholder: el.getAttribute("placeholder") ?? "",
      title: el.getAttribute("title") ?? "",
      text: directText,
    };

    const states: string[] = [];
    const anyEl = el as unknown as { disabled?: boolean; readOnly?: boolean; required?: boolean; checked?: boolean };
    if (anyEl.disabled || el.getAttribute("aria-disabled") === "true") states.push("disabled");
    if (anyEl.readOnly) states.push("readonly");
    if (anyEl.required || el.getAttribute("aria-required") === "true") states.push("required");
    if (anyEl.checked) states.push("checked");
    const expanded = el.getAttribute("aria-expanded");
    if (expanded) states.push(expanded === "true" ? "expanded" : "collapsed");
    if (el.getAttribute("aria-selected") === "true") states.push("selected");
    if (el.getAttribute("aria-invalid") === "true") states.push("invalid");

    const rect = el.getBoundingClientRect();
    const bbox = rect.width || rect.height ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null;
    const checkVis = (el as unknown as { checkVisibility?: () => boolean }).checkVisibility;
    const visible = typeof checkVis === "function" ? checkVis.call(el) : !!bbox;

    const rawValue = (tag === "input" && !isButtonInput) || tag === "textarea" || tag === "select"
      ? ((el as HTMLInputElement).value ?? null)
      : null;

    out.push({
      tag, type, roleAttr, id: el.id || null, testId, testIdAttr,
      nameParts,
      href: tag === "a" ? (el.getAttribute("href") ?? null) : null,
      value: rawValue == null ? null : String(rawValue).slice(0, strCap),
      states, bbox, visible, hasOnclick, tabindex, idx: idx++,
    });
  }
  return out;
}

/** Snapshot a single frame. `frameUrl` is stamped onto every node (null for main). */
async function snapshotFrame(frame: Frame, frameUrl: string | null): Promise<SemanticNode[]> {
  // Pass collectRaw straight to evaluate: Playwright serializes it via toString and
  // runs it in-page. No lexical capture, no new Function() — just the one definition.
  const raw = await frame
    .evaluate(collectRaw, [MAX_NODES, STR_CAP] as [number, number])
    .catch(() => [] as RawEl[]);
  return raw.map((r) => enrich(r, frameUrl));
}

/** Main-frame semantic snapshot — the default consumers use. */
export async function semanticSnapshot(page: Page): Promise<SemanticSnapshot> {
  const nodes = await snapshotFrame(page.mainFrame(), null);
  return { url: page.url(), nodes, truncated: nodes.length >= MAX_NODES };
}

/** Main frame + every child frame merged (#4 iframe decision). Cross-origin/detached frames are skipped, not fatal. */
export async function semanticSnapshotAll(page: Page): Promise<SemanticSnapshot> {
  const main = page.mainFrame();
  const nodes: SemanticNode[] = [];
  for (const frame of page.frames()) {
    const isMain = frame === main;
    const part = await snapshotFrame(frame, isMain ? null : frame.url()).catch(() => [] as SemanticNode[]);
    for (const n of part) {
      if (nodes.length >= MAX_NODES) break;
      nodes.push(n);
    }
  }
  return { url: page.url(), nodes, truncated: nodes.length >= MAX_NODES };
}

// ---- canonical state key (Plan-v7 §3.3 — designed here, consumed by the graph) ----
//
// Raw snapshots can't be graph nodes directly: /candidates with 3 vs 4 vs 5 rows
// (or a transient toast) would explode into many "states" that are one (Crawljax's
// state-explosion problem). We normalize to a canonical key = a hash of the state's
// *interactive shape*, with volatile text/counts/ids stripped. §8.2: because the key
// is derived from the interactive role/name SET, two genuinely different control
// sets can never collapse to one key — the inverse failure (silent over-merge, a
// coverage hole) is guarded, not just explosion.

const KEY_STR_CAP = 40;
const LANDMARK_ROLES = new Set(["navigation", "main", "banner", "contentinfo", "search"]);

/**
 * Normalize an interactive element's name so sibling rows/counts collapse but
 * distinct controls stay distinct: lowercase, drop our qabot run tag, strip
 * hex/uuid-ish ids and digits (row numbers, counts, prices, timestamps), collapse
 * whitespace, cap length. "Row 47" → "row"; "Save" and "Publish" stay different.
 */
export function normName(name: string): string {
  return name
    .toLowerCase()
    .replace(/qabot-[a-z0-9-]+/g, "")
    .replace(/[0-9a-f]{8,}/g, "")
    .replace(/\d+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, KEY_STR_CAP);
}

/**
 * The discriminating shape of a state: sorted unique `role:normName` of every
 * interactive element, plus the landmark roles present. This is exactly what a
 * genuine state change must alter — the §8.2 invariant is "different shape ⇒
 * different key", enforced by making the key a hash of this.
 */
export function interactiveShape(snap: SemanticSnapshot): string[] {
  const set = new Set<string>();
  for (const n of snap.nodes) {
    if (n.interactive) set.add(`${n.role || n.tag}:${normName(n.name)}`);
    else if (LANDMARK_ROLES.has(n.role)) set.add(`landmark:${n.role}`);
  }
  return [...set].sort();
}

/** Crawljax-style canonical state key: a stable hash of the interactive shape. */
export function canonicalStateKey(snap: SemanticSnapshot): string {
  return createHash("sha1").update(interactiveShape(snap).join("\n")).digest("hex").slice(0, 16);
}

/**
 * §8.2 false-merge guard: same key but a different interactive shape means a hash
 * collision is hiding two real states — the caller should log a collision candidate
 * rather than silently merge. With shape-derived keys this only fires on a true SHA
 * collision, but the check is cheap insurance and pins the invariant in code.
 */
export function isStateCollision(a: SemanticSnapshot, b: SemanticSnapshot): boolean {
  if (canonicalStateKey(a) !== canonicalStateKey(b)) return false;
  const sa = interactiveShape(a), sb = interactiveShape(b);
  return sa.length !== sb.length || sa.some((x, i) => x !== sb[i]);
}
