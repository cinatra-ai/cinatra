// THE CORE CONTENT ARMS ARE GONE (cinatra#3319, acceptance 1).
//
// "`ArtifactRenderDispatch` has no `mime` variant; `ReviewTargetMount` has no
//  `form` variant; no production import of `MarkdownHandler`, `PlainTextHandler`
//  or `FallbackHandler` remains; no production `renderer=generic` path and no
//  error-boundary link to it."
//
// Each clause is measured against the tree, not asserted in prose: the two type
// unions are read from their own source, the imports are searched for across
// EVERY production file under src (a retirement that only holds in the two files
// someone remembered is not a retirement), and the query escape is searched for
// the same way. The behavioural half — a representation with no extension
// provider now lands on the terminal floor rather than on a host viewer — is
// driven through the pure leaf underneath.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { pickArtifactRenderer } from "../renderer-dispatch";

/** Comments out, so a retired name QUOTED in a docblock cannot read as a live
 * reference (every file in this tree explains what it retired). */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..", "..");
const SRC = join(REPO_ROOT, "src");
const PACKAGES = join(REPO_ROOT, "packages");

/** Every PRODUCTION TypeScript source under a root — test files, test folders
 * and fixture folders excluded, because a retirement is about what the running
 * application imports, and a test may legitimately name a retired thing. */
function productionSources(root: string, out: string[] = []): string[] {
  for (const name of readdirSync(root)) {
    if (name === "node_modules" || name === "__tests__" || name === "__stubs__" || name === "__fixtures__") continue;
    const full = join(root, name);
    if (statSync(full).isDirectory()) {
      productionSources(full, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(name)) continue;
    if (/\.(test|spec)\.tsx?$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

const PRODUCTION = [...productionSources(SRC), ...productionSources(PACKAGES)];

function hits(pattern: RegExp): string[] {
  return PRODUCTION.filter((f) => pattern.test(stripComments(readFileSync(f, "utf8")))).map((f) =>
    relative(REPO_ROOT, f),
  );
}

describe("acceptance 1 — the dispatch unions carry no core-content arm", () => {
  it("`ArtifactRenderDispatch` has no `mime` variant", () => {
    const source = stripComments(readFileSync(join(SRC, "app/artifacts/[id]/renderer-dispatch.ts"), "utf8"));
    expect(source).not.toMatch(/kind:\s*"mime"/);
    // And the tier that fed it: a representation resolves to an extension
    // provider or to nothing at all. A first-party host viewer is not a rung.
    expect(source).not.toMatch(/tier:\s*"first-party"/);
  });

  it("`ReviewTargetMount` has no `form` variant", () => {
    const source = stripComments(
      readFileSync(join(SRC, "lib/artifacts/artifact-review-preparation.ts"), "utf8"),
    );
    expect(source).not.toMatch(/kind:\s*"form"/);
  });
});

describe("acceptance 1 — no production import of the three core viewers", () => {
  it.each([
    ["MarkdownHandler", /handlers\/markdown-handler/],
    ["PlainTextHandler", /handlers\/plain-text-handler/],
    ["FallbackHandler", /handlers\/fallback-handler/],
  ])("%s is imported by no production source", (_name, module) => {
    expect(hits(module)).toEqual([]);
  });
});

describe("acceptance 1 — no production `renderer=generic` path", () => {
  it("no production source names the query escape, and the error boundary links to none", () => {
    expect(hits(/renderer=generic/)).toEqual([]);
    const boundary = stripComments(readFileSync(join(SRC, "app/artifacts/[id]/error.tsx"), "utf8"));
    expect(boundary).not.toMatch(/renderer=generic/);
    expect(boundary).not.toMatch(/forceGeneric/);
  });
});

describe("acceptance 1 — the pure leaf's terminal answer", () => {
  it("a row with no semantic renderer and no extension representation falls to the terminal floor", () => {
    expect(
      pickArtifactRenderer({
        identity: { kind: "no-primary" },
        semantic: null,
        representation: null,
      }),
    ).toEqual({ kind: "fallback" });
  });
});
