// Bundle the schema-bootstrap DDL pass (scripts/schema-bootstrap.mts — the
// exact `ensurePostgresSchema` boot baseline, buildCreateStoreSchemaQueries)
// into a self-contained ESM file so it runs in the Next.js standalone
// production image, which ships neither the TypeScript source nor tsx. The
// image's deploy-compat CLI entry (packages/cli/bin/cinatra.mjs) runs this
// bundle BEFORE handing `setup` / `db migrate` to the published CLI, so the
// versioned core migration chain always sees the bootstrap baseline it
// assumes (cinatra#1136 — the prod-deploy variant of cinatra-cli#115). See
// the Dockerfile (`RUN pnpm build:schema-bootstrap-bundle`).
//
// Run from the repo root (full node_modules present):
//   pnpm build:schema-bootstrap-bundle
import { build } from "esbuild";

await build({
  entryPoints: ["scripts/schema-bootstrap.mts"],
  outfile: "scripts/schema-bootstrap.bundle.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // ESM output bundling CJS deps (pg, drizzle-orm's CJS corners) leaves
  // `require("events")` and friends as runtime `__require` calls. ESM has no
  // native `require`, so esbuild's shim throws "Dynamic require of … is not
  // supported". Define a real `require` via createRequire so builtins (and
  // lazily-required externals) resolve at runtime.
  banner: {
    js: "import { createRequire as __cinatraCreateRequire } from 'node:module'; const require = __cinatraCreateRequire(import.meta.url);",
  },
  // Optional native drivers `pg` only requires LAZILY for code paths we never
  // hit. Keep them external so esbuild doesn't try to bundle native bindings
  // or the Workers-only `cloudflare:sockets` import.
  external: ["pg-native", "pg-cloudflare"],
});
