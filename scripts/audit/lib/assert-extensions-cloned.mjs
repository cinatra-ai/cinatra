import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Fail-closed guard for the cloned-back extension source.
//
// The extension SOURCE tree is not committed to this
// tree — it is cloned back from the companion repos (cinatra-ai/<slug>)
// before build/gate jobs run (CI: the `clone-extensions` composite action /
// `scripts/ci/sync-dev-extensions.mjs`; dev: `cinatra setup dev`). An IoC /
// inventory gate that scans an ABSENT or UNDER-POPULATED `extensions/` tree
// would derive an empty banned-set and pass VACUOUSLY — a silent protection
// regression. This asserts the tree carries at least as many extension packages
// as `cinatra.devExtensions` declares, so a job that forgot the clone-back step
// fails LOUDLY instead of greenwashing.
//
// Floor = the declared `cinatra.devExtensions` count (not a bare "0 extensions"
// check): a job that cloned back only SOME of the declared extensions still
// fails loudly, which a "found 0" check would miss.
export function assertExtensionsPresent(repoRoot, gateName) {
  let expected = 0;
  try {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    expected = Object.keys(pkg.cinatra?.devExtensions || {}).length;
  } catch {
    return; // no/unreadable package.json — not our concern here
  }
  if (expected === 0) return; // pre-cutover / unconfigured — nothing to assert

  const extRoot = path.join(repoRoot, "extensions");
  let found = 0;
  if (existsSync(extRoot)) {
    for (const scope of readdirSync(extRoot)) {
      const scopeDir = path.join(extRoot, scope);
      try {
        if (!statSync(scopeDir).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const slug of readdirSync(scopeDir)) {
        if (existsSync(path.join(scopeDir, slug, "package.json"))) found++;
      }
    }
  }

  if (found < expected) {
    console.error(
      `[${gateName}] FAIL-CLOSED: found ${found} extension package(s) under extensions/, but ` +
        `cinatra.devExtensions declares ${expected}. The extension source must be cloned back before ` +
        `this gate runs (CI: the clone-extensions action / scripts/ci/sync-dev-extensions.mjs; ` +
        `dev: cinatra setup dev). Refusing to run vacuously.`,
    );
    process.exit(1);
  }
}
