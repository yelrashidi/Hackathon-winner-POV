import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // tsconfig.json is the shared TypeScript setup (src/, scripts/); the app's pages add their
  // Next.js settings on top of it in tsconfig.next.json.
  typescript: { tsconfigPath: "tsconfig.next.json" },
  /* config options here */
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
