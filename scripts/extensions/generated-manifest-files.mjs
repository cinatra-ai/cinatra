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
  "src/lib/generated/widget-stream-public-paths.ts",
]);
