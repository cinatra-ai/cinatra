// NO EDIT CAPABILITY OUTSIDE THE ARTIFACT PAGE, ANYWHERE (cinatra#3319, acceptance 7).
//
// "... a test asserts no `grantArtifactEdit` call is reachable from outside the
//  artifact page."
//
// `w4-edit-capability-page-only.test.ts` pins the split over the Artifacts area
// (src/app/artifacts, src/components/artifacts, src/lib/artifacts). The review
// itself is drawn from outside that area too - the lifecycle review island lives
// under src/app/lifecycle, and the review preparation is reached from workspace
// packages - so a grant named there would not be seen by that sweep. This one
// reads every production TypeScript source of the host and of its workspace
// packages: the only files that may name the grant are the page that mints it
// and the module that defines it. A file that does not name it cannot call it,
// alias it or re-export it, so no other module can reach it.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..", "..");
const THE_ARTIFACT_PAGE = "src/app/artifacts/[id]/page.tsx";
/** Where the capability is DEFINED - a definition is not a call site. */
const THE_DEFINITION = "src/lib/artifacts/artifact-renderer-props.ts";

/** Directories that hold no production source. */
const SKIPPED_DIRS = new Set([
  "node_modules",
  "__tests__",
  "__stubs__",
  "__mocks__",
  "__fixtures__",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
]);

function productionSources(root: string, out: string[] = []): string[] {
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root)) {
    if (SKIPPED_DIRS.has(name)) continue;
    const full = join(root, name);
    if (statSync(full).isDirectory()) {
      productionSources(full, out);
      continue;
    }
    if (!/\.(ts|tsx|mts|cts)$/.test(name)) continue;
    if (/\.d\.ts$/.test(name)) continue;
    if (/\.(test|spec)\.(ts|tsx|mts|cts)$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const SOURCES = [
  ...productionSources(join(REPO_ROOT, "src")),
  ...productionSources(join(REPO_ROOT, "packages")),
];

describe("acceptance 7 - grantArtifactEdit is reachable from the artifact page alone, repository-wide", () => {
  it("the sweep reads the review surfaces outside the Artifacts area", () => {
    // A sweep that silently read nothing would pass below; it must at least see
    // the review island and the review preparation it is meant to cover.
    const seen = new Set(SOURCES.map((f) => relative(REPO_ROOT, f)));
    expect(seen.has(THE_ARTIFACT_PAGE)).toBe(true);
    expect(seen.has(THE_DEFINITION)).toBe(true);
    expect(seen.has("src/app/lifecycle/review-island/page.tsx")).toBe(true);
    expect(seen.has("src/lib/artifacts/artifact-review-preparation.ts")).toBe(true);
    expect([...seen].some((f) => f.startsWith("packages/"))).toBe(true);
  });

  it("no production source of the host or its packages names it, except the page and its definition", () => {
    const named = SOURCES.filter((file) =>
      /\bgrantArtifactEdit\b/.test(stripComments(readFileSync(file, "utf8"))),
    )
      .map((file) => relative(REPO_ROOT, file))
      .sort();
    expect(named).toEqual([THE_ARTIFACT_PAGE, THE_DEFINITION].sort());
  });
});
