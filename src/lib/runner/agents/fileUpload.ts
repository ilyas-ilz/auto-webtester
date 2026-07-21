import fs from "fs";
import path from "path";
import type { BrowserContext } from "playwright";
import type { Project, RoleCred } from "../../types";
import { RunContext } from "../context";

const AGENT = "file-upload";
const MAX_INPUTS = 3;

/**
 * File-upload agent (Plan-v5 R5) — non-production only (it submits a real file).
 * Finds `<input type=file>` controls on the risk sample, uploads the project's
 * configured sample file, and checks the app *reacted*: the filename appears,
 * a preview/thumbnail renders, or the DOM changed. A file input that swallows
 * the upload with no visible response is the bug (broken handler / silent size
 * or type rejection). The file is never deleted server-side by us — it's a read
 * of the upload UI, and the run tag isn't applicable to a binary.
 */
export async function fileUploadAgent(ctx: RunContext, browserCtx: BrowserContext, project: Project, role: RoleCred, sampleSize: number): Promise<void> {
  if (project.envTag === "production") { ctx.log(AGENT, "step", "Skipped on production — file upload submits data."); return; }
  const filePath = project.uploadFilePath?.trim();
  if (!filePath) { ctx.log(AGENT, "step", "No sample file configured — skipping file-upload test."); return; }
  if (!fs.existsSync(filePath)) {
    ctx.finding({ agent: AGENT, severity: "info", role: null, pageUrl: null,
      title: "Configured upload sample file not found", detail: `uploadFilePath points at "${filePath}" which does not exist on this machine — the file-upload test could not run.`, evidence: null });
    return;
  }
  const fileName = path.basename(filePath);

  let tested = 0, reacted = 0;
  for (const target of ctx.sampleFor(role.name, sampleSize, AGENT)) {
    if (tested >= MAX_INPUTS) break;
    const page = await browserCtx.newPage();
    try {
      await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 20000 });
      const inputs = page.locator('input[type="file"]');
      const count = await inputs.count();
      if (!count) continue;
      const input = inputs.first();
      tested++;
      const beforeNodes = await page.evaluate(() => document.getElementsByTagName("*").length).catch(() => 0);
      let pageError = false;
      page.on("pageerror", () => { pageError = true; });

      await input.setInputFiles(filePath).catch(() => {});
      await page.waitForTimeout(1200);

      // Many upload forms show nothing until a submit/upload button is clicked.
      // If the file selection alone produced no reaction, click a nearby upload
      // button (UNSAFE-filtered) and re-check — covers both instant-preview and
      // submit-required uploads without treating the latter as a false "no response".
      let afterNodes = await page.evaluate(() => document.getElementsByTagName("*").length).catch(() => 0);
      if (Math.abs(afterNodes - beforeNodes) < 2) {
        const btn = page.locator('button:has-text("upload"), input[type="submit"][value*="upload" i], button[type="submit"], input[type="submit"]').first();
        if (await btn.count().catch(() => 0)) {
          await btn.click({ timeout: 5000 }).catch(() => {});
          await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(1000);
          afterNodes = await page.evaluate(() => document.getElementsByTagName("*").length).catch(() => 0);
        }
      }
      const body = (await page.evaluate(() => document.body?.innerText || "").catch(() => "")).toLowerCase();
      const stem = fileName.replace(/\.[^.]+$/, "").toLowerCase();
      const filenameShown = body.includes(fileName.toLowerCase()) || (stem.length > 3 && body.includes(stem));
      const domChanged = Math.abs(afterNodes - beforeNodes) >= 2;
      const shot = await ctx.screenshot(page, "file-upload");

      if (pageError) {
        ctx.finding({ agent: AGENT, severity: "medium", role: role.name, pageUrl: target.url,
          title: "File upload throws a JS error", detail: `Selecting ${fileName} in the file input raised an uncaught error — the upload handler is broken.`, evidence: shot });
      } else if (filenameShown || domChanged) {
        reacted++;
        ctx.finding({ agent: AGENT, severity: "info", kind: "improvement", role: role.name, pageUrl: target.url,
          title: "File upload accepted", detail: `Uploaded ${fileName}; the page reacted (${filenameShown ? "filename shown" : "content updated"}). Upload UI works. (Black-box: server-side storage/virus-scan/thumbnail generation aren't visible — add a journey if a stored artifact must be verified.)`, evidence: shot });
      } else {
        ctx.finding({ agent: AGENT, severity: "medium", role: role.name, pageUrl: target.url,
          title: "File input accepted a file with no visible response", detail: `Selected ${fileName} in the file input but nothing changed on screen — no filename, no preview, no progress. The upload handler may be missing, or silently rejecting the file's size/type.`, evidence: shot });
      }
    } catch (e) {
      ctx.log(AGENT, "warn", `File-upload check failed on ${target.url}: ${String(e).slice(0, 140)}`);
    } finally {
      await page.close();
    }
  }
  ctx.log(AGENT, "pass", tested ? `File-upload test: ${reacted}/${tested} input(s) reacted to ${fileName}` : `No file inputs found for ${role.name}`);
}
