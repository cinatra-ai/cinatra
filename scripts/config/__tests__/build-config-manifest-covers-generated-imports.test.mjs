// Every module specifier the generated extension maps hand to
// `guardedExtensionImport` has to resolve at build time, and for an extension
// subpath it resolves ONLY through a `compilerOptions.paths` alias: the
// extension packages are workspace checkouts under `extensions/`, and nothing
// else maps `@cinatra-ai/<pack>/src/...` to a file on disk.
//
// `config/build-config.manifest.json` is the single source of truth for that
// alias map — `scripts/config/generate-build-config.mjs` renders
// tsconfig.json's paths region from it. So a specifier the manifest does not
// carry is a drift already committed: hand-adding the alias to tsconfig.json
// makes typecheck green locally while
// `node scripts/config/generate-build-config.mjs --check` fails with DRIFT,
// because the generator would render that alias away again.
//
// This suite pins the invariant on the manifest, not on tsconfig.json, so the
// failure names the file that has to change.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

const MANIFEST = "config/build-config.manifest.json";

/** The generated maps that load extension code through the guarded import. */
const GENERATED_MAPS = [
  "src/lib/generated/artifact-renderers.ts",
  "src/lib/generated/extensions.server.ts",
];

function readRepoFile(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

function manifestAliases() {
  const manifest = JSON.parse(readRepoFile(MANIFEST));
  return new Set(manifest.tsconfigPaths.map((entry) => entry.alias));
}

/** The first argument of every `guardedExtensionImport("<specifier>", …)`. */
function guardedSpecifiers(relPath) {
  const source = readRepoFile(relPath);
  return [...source.matchAll(/guardedExtensionImport\("([^"]+)"/g)].map(
    (match) => match[1],
  );
}

describe("build-config manifest covers the generated extension imports", () => {
  it("finds guarded specifiers in every generated map (the suite is not vacuous)", () => {
    for (const relPath of GENERATED_MAPS) {
      expect(guardedSpecifiers(relPath).length).toBeGreaterThan(0);
    }
  });

  it.each(GENERATED_MAPS)(
    "%s: every guarded specifier has a tsconfigPaths alias in the manifest",
    (relPath) => {
      const aliases = manifestAliases();
      const missing = [
        ...new Set(
          guardedSpecifiers(relPath).filter((spec) => !aliases.has(spec)),
        ),
      ].sort();

      expect(
        missing,
        `${relPath} imports specifiers that ${MANIFEST} does not alias. Add them ` +
          `to tsconfigPaths and re-run \`node scripts/config/generate-build-config.mjs\` ` +
          `— never hand-edit the tsconfig.json paths region.`,
      ).toEqual([]);
    },
  );
});
