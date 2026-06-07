import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

// Import-boundary lock for the classifier-signal intake path.
// `src/lib/artifacts/artifact-creation.ts` MUST import the classifier-signals
// leaf via the SUBPATH alias `@cinatra-ai/objects/classifier-signals`, NEVER
// the heavy `@cinatra-ai/objects` barrel.

const artifactCreationPath = path.join(
  __dirname,
  "..",
  "artifact-creation.ts",
);

describe("classifier-signals import boundary source-shape lock", () => {
  const src = readFileSync(artifactCreationPath, "utf8");

  it("imports classifier-signals via the LEAF subpath alias", () => {
    // Multi-line imports (`import {\n  …\n} from "…"`) require an
    // [\s\S] class to cross newlines.
    expect(src).toMatch(
      /import\s+[\s\S]*?from\s+["']@cinatra-ai\/objects\/classifier-signals["']/,
    );
  });

  it("does NOT import the heavy @cinatra-ai/objects barrel anywhere", () => {
    // Any `from "@cinatra-ai/objects"` (no trailing path) would pull
    // the barrel — which drags mcp/registries surface. Use the
    // quoted-only check so a longer subpath import (e.g.
    // `objects/renderer-types`) does not false-positive.
    expect(src).not.toMatch(/["']@cinatra-ai\/objects["']/);
  });

  it("uses the typed `chatContextSource` handle (NOT a pre-built classifierSignals blob)", () => {
    // Pre-built blob would be a smuggling vector. The public input shape on
    // `CreateSemanticArtifactInput` accepts
    // ONLY the handle. A caller passing `classifierSignals` via
    // `as any` is dropped because the service destructures only typed
    // fields and the strict schema rejects extras at compose time.
    expect(src).toMatch(/chatContextSource\?:\s*\{\s*threadId:\s*string\s*\}/);
    // The type must NOT carry a `classifierSignals` field — that would
    // re-open the smuggling surface.
    const typeBody = src.slice(
      src.indexOf("export type CreateSemanticArtifactInput"),
      src.indexOf("export type CreateSemanticArtifactResult"),
    );
    expect(typeBody).not.toMatch(/^\s*classifierSignals\??:/m);
  });

  it("composes via composeAndValidateClassifierSignals (the strict pipeline)", () => {
    expect(src).toMatch(/composeAndValidateClassifierSignals\(/);
  });
});
