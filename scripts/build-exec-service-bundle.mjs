// Bundle the execution-plane SERVICE entrypoints into self-contained ESM files,
// for the same reason scripts/build-auth-migrate-bundle.mjs and
// scripts/build-schema-bootstrap-bundle.mjs exist: the Next.js standalone
// production image only ships SERVER-traced node_modules and no TypeScript
// source, so a loose `packages/execution-plane/src/service/*-entry.ts` could
// neither be executed nor resolve its workspace imports there.
//
// Two entries, deliberately separate artifacts:
//
//   exec-broker-service.bundle.mjs — the broker. It rides INSIDE the app image
//     (the runtime-stage COPY in the Dockerfile): the broker is pure Node — it
//     opens the sealed carrier, revalidates liveness, bounds load, audits, and
//     talks mTLS to a worker. It needs no docker binary of its own.
//
//   exec-worker-service.bundle.mjs — the sandbox worker. Built here so the
//     artifact exists and is proven to build, but deliberately NOT copied into
//     the app runtime stage: the worker shells out to `docker` for every
//     command, so it belongs in a worker image with a docker client, which is a
//     later slice. Adding docker-cli to the app image to host it would widen the
//     app's attack surface for no benefit.
//
// Run from the repo root, AFTER sources are copied (full node_modules present):
//   pnpm build:exec-service-bundle
import { build } from "esbuild";

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // The entries resolve `@cinatra-ai/llm/execution-plane` through the root
  // tsconfig's `paths` (packages/llm/package.json deliberately does not export
  // that subpath). Pinning the tsconfig explicitly means resolution does not
  // depend on which directory esbuild happens to walk up from.
  tsconfig: "tsconfig.json",
  // ESM output bundling any CJS corner leaves `require(...)` as an esbuild
  // `__require` shim that throws at runtime. Define a real `require` so node
  // builtins resolve — same banner the two existing bundle scripts use.
  banner: {
    js: "import { createRequire as __cinatraCreateRequire } from 'node:module'; const require = __cinatraCreateRequire(import.meta.url);",
  },
};

await build({
  ...shared,
  entryPoints: ["packages/execution-plane/src/service/broker-entry.ts"],
  outfile: "scripts/exec-broker-service.bundle.mjs",
});

await build({
  ...shared,
  entryPoints: ["packages/execution-plane/src/service/worker-entry.ts"],
  outfile: "scripts/exec-worker-service.bundle.mjs",
});
