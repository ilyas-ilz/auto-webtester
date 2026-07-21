import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A sibling package-lock.json one level up (outside this app) made Next guess the
  // wrong workspace root — pin it explicitly instead of relying on lockfile detection.
  turbopack: { root: path.join(__dirname) },
  // lighthouse does `await import(requirePath)` with a runtime-computed path —
  // Turbopack can't statically resolve that when it bundles the package, so it
  // must stay external and load via Node's real module resolver at runtime.
  serverExternalPackages: ["lighthouse", "chrome-launcher"],
};

export default nextConfig;
