// Bundle the Better Auth migration runner into a self-contained ESM file so it
// runs in the Next.js standalone production image, whose pruned node_modules
// does NOT include better-auth (only the migrate runner / mcp-server use it,
// not the Next server). See packages/cli/src/index.mjs `runBetterAuthMigrate`
// and the Dockerfile (`RUN pnpm build:auth-migrate-bundle`).
//
// Run from the repo root (full node_modules present, after sources are copied):
//   pnpm build:auth-migrate-bundle
import { build } from "esbuild";

await build({
  entryPoints: ["scripts/better-auth-migrate.mts"],
  outfile: "scripts/better-auth-migrate.bundle.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // ESM output bundling CJS deps (pg, better-auth, …) leaves `require("events")`
  // and friends as runtime `__require` calls. ESM has no native `require`, so
  // esbuild's shim throws "Dynamic require of … is not supported". Define a real
  // `require` via createRequire so builtins (and lazily-required externals)
  // resolve at runtime.
  banner: {
    js: "import { createRequire as __cinatraCreateRequire } from 'node:module'; const require = __cinatraCreateRequire(import.meta.url);",
  },
  // Optional native / non-node DB drivers that better-auth + pg only require
  // LAZILY for code paths we never hit (we pass a pg Pool). Keep them external
  // so esbuild doesn't try to bundle native bindings or the Workers-only
  // `cloudflare:sockets` import; the lazy requires are never reached here.
  external: ["pg-native", "pg-cloudflare", "better-sqlite3", "mysql2", "@prisma/client"],
});
