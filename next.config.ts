import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // tsconfig.json is the shared TypeScript setup (src/, scripts/); the app's pages add their
  // Next.js settings on top of it in tsconfig.next.json.
  typescript: { tsconfigPath: "tsconfig.next.json" },
  // PGlite (the in-process Postgres the demo runs on without DATABASE_URL) loads its WebAssembly
  // and data files at runtime; bundling would break those paths, so Node loads it natively.
  serverExternalPackages: ["@electric-sql/pglite"],
  cacheComponents: true,
  // Embedded Postgres for the no-Docker demo (DATABASE_URL=pglite:…): load it from node_modules
  // at runtime instead of bundling its WebAssembly and data files.
  serverExternalPackages: ["@electric-sql/pglite"],
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
