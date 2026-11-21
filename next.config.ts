import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // tsconfig.json is the shared TypeScript setup (src/, scripts/); the app's pages add their
  // Next.js settings on top of it in tsconfig.next.json.
  typescript: { tsconfigPath: "tsconfig.next.json" },
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
