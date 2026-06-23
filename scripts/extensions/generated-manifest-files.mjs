// The generator-owned output file set — the SINGLE definition shared by the
// generator (`generate-extension-manifest.mjs`, which emits exactly these
// files) and the extension-coupling gate taxonomy
// (`scripts/audit/lib/extension-reference-classification.mjs`, which
// permanently exempts exactly these files per the owner ruling on
// cinatra-ai/cinatra#36: the generated `src/lib/generated/**` tree is the ONE
// permanent-exempt class).
//
// Deliberately a tiny, dependency-free module: the gates import it at audit
// time and the generator imports it at emit time, so the exempt set and the
// emitted set CANNOT drift apart (a gate test additionally pins the
// equality). The exemption is this EXPLICIT list — never a directory prefix —
// so a hand-added extra file under `src/lib/generated/` is counted by the
// coupling scanners like any other source file. Integrity of the listed
// files themselves is enforced by the fail-closed generator drift check
// (`generate-extension-manifest.mjs --check`, wired in CI): a hand-edit of a
// generated file fails CI against the generator's byte-exact output.
//
// Paths are repo-relative, forward-slash.
export const GENERATED_MANIFEST_FILES = Object.freeze([
  "src/lib/generated/extensions.server.ts",
  "src/lib/generated/connector-setup-pages.ts",
  "src/lib/generated/extensions.client.tsx",
  // Agent UI bindings + agent role bindings (cinatra#151 Stage 5): pure-data
  // map of x-renderer ID -> host renderer KIND (+ mid-run classification,
  // a2ui translator kind, params) and role -> package, derived from each
  // present extension's `cinatra.fieldRenderers` / `cinatra.roles` manifest
  // metadata, validated fail-closed (agent-binding-kinds.mjs).
  "src/lib/generated/agent-bindings.ts",
  // The semantic-floor artifact binding (cinatra#151 Stage 6): the single
  // "artifact-default-floor" role claimant, emitted INTO packages/objects
  // (a package-local generated file — the one emitted path outside
  // src/lib/generated/) because packages/objects is consumed from graphs
  // where the host `@/` alias does not resolve (sdk-extensions /
  // extension-repo typechecks). Same owner-ruled exempt class as the rest
  // of this list: the exemption is THIS explicit list, never a directory,
  // and `--check` byte-pins the file (policy note in
  // scripts/audit/extension-coupling-gates.md).
  "packages/objects/src/generated/artifact-floor.ts",
  "src/lib/generated/widget-stream-public-paths.ts",
  // Inbound-webhook facility (cinatra#340): the host-owned generated maps for
  // the generic /webhook route. webhooks.server.ts carries the dispatch
  // registry (server loaders, server-only); webhook-public-paths.ts is the
  // import-free declared-prefix list (registry/UI + route dispatch allowlist);
  // webhook-registry-meta.ts is the import-free hook metadata for the #342 UI.
  // Inert until #343 (no extension declares cinatra.webhooks yet).
  "src/lib/generated/webhooks.server.ts",
  "src/lib/generated/webhook-public-paths.ts",
  "src/lib/generated/webhook-registry-meta.ts",
  // The generated guarded-optional-loaders test (cinatra#7). A test file
  // is ALREADY exempt from the coupling gates by path (__tests__), so listing
  // it here adds no exemption surface — it puts the file under the same
  // fail-closed `--check` byte-exact integrity pin as the maps it asserts.
  "src/lib/generated/__tests__/guarded-optional-loaders.test.ts",
]);
