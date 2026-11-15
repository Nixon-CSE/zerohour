import type { NextConfig } from "next";
import { resolve } from "node:path";

// Static export: the consoles are plain files that read QoreChain directly from the browser.
// There is no ZeroHour server to trust, and any judge can host or diff the build.
const config: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ["@zerohour/hourglass"],
  turbopack: { root: resolve(import.meta.dirname, "../..") },
};
export default config;
