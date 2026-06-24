import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    resolveAlias: {
      module: { browser: "./lib/empty-module.js" },
    },
  },
};

export default nextConfig;
