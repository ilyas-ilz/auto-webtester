import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A sibling package-lock.json one level up (outside this app) made Next guess the
  // wrong workspace root — pin it explicitly instead of relying on lockfile detection.
  turbopack: { root: path.join(__dirname) },
};

export default nextConfig;
