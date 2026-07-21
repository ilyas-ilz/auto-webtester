import { devices as pwDevices } from "playwright";
import type { RunMode } from "../types";

export type BrowserEngine = "chromium" | "firefox" | "webkit";

export interface DeviceProfile {
  name: string;
  browserType: BrowserEngine;
  // Spread directly into browser.newContext() — Playwright's documented pattern
  // (playwright.devices['iPhone 14']). Includes a `defaultBrowserType` field we
  // don't use here (we pick the engine ourselves); Playwright ignores it.
  contextOptions: Record<string, unknown>;
}

const PROFILES: Record<string, DeviceProfile> = {
  "Desktop Chrome": { name: "Desktop Chrome", browserType: "chromium", contextOptions: pwDevices["Desktop Chrome"] },
  "Desktop Firefox": { name: "Desktop Firefox", browserType: "firefox", contextOptions: pwDevices["Desktop Firefox"] },
  "Desktop Safari": { name: "Desktop Safari", browserType: "webkit", contextOptions: pwDevices["Desktop Safari"] },
  "Mobile Chrome": { name: "Mobile Chrome", browserType: "chromium", contextOptions: pwDevices["Pixel 7"] },
  "Mobile Safari": { name: "Mobile Safari", browserType: "webkit", contextOptions: pwDevices["iPhone 14"] },
};

export const PRIMARY_PROFILE = PROFILES["Desktop Chrome"];

/** Whether a profile name runs on Chromium — some agents (memory-leak) need Chromium-only APIs. */
export function profileIsChromium(name: string): boolean {
  return PROFILES[name]?.browserType === "chromium";
}

/**
 * Execution dimension (Plan-v2 §4: "multiply coverage, add zero agents").
 * Profile [0] is always Desktop Chrome and is the one the full deterministic
 * pipeline (crawl, security, forms, permissions, AI review) runs against —
 * everything after [0] only re-renders already-discovered pages (ui/a11y/perf)
 * under a different engine/viewport, so cost scales with sample size, not a
 * second full crawl. Curated list, not a full browser×device cross-product —
 * that would be 3×2=6 combos for marginal extra signal over these 5.
 */
export function profilesForMode(mode: RunMode): DeviceProfile[] {
  if (mode === "quick") return [PROFILES["Desktop Chrome"]];
  if (mode === "smart") return [PROFILES["Desktop Chrome"], PROFILES["Mobile Chrome"]];
  return [PROFILES["Desktop Chrome"], PROFILES["Desktop Firefox"], PROFILES["Desktop Safari"], PROFILES["Mobile Chrome"], PROFILES["Mobile Safari"]];
}
