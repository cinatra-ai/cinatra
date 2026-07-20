/**
 * Consumer-wiring conformance for the presentation-identity resolver (epic
 * #1883 slice A6). The three NAMED presentation consumers — renderer dispatch,
 * the library Type facet, and row labeling — must read `presentationIdentity`,
 * NOT the shared `effectiveIdentity`. Effective identity stays reserved for the
 * shared path (context selection #1430, replay pinning, Graphiti projection).
 *
 * The repo runs vitest in a node environment without @testing-library/react, so
 * server-component wiring is pinned via source assertions (the established repo
 * pattern — see surface-conformance.test.ts / nav-modal-wiring.test.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("renderer dispatch (page.tsx) feeds the presentation identity", () => {
  const PAGE = read("src/app/artifacts/[id]/page.tsx");

  it("resolveArtifactDispatchInputs receives artifact.presentationIdentity", () => {
    expect(PAGE).toMatch(/identity:\s*artifact\.presentationIdentity/);
  });

  it("no longer feeds artifact.effectiveIdentity into dispatch resolution", () => {
    expect(PAGE).not.toMatch(/identity:\s*artifact\.effectiveIdentity/);
  });
});

describe("library Type facet (library-mode.tsx) keys on the presentation identity", () => {
  const LIB = read("src/components/artifacts/library-mode.tsx");

  it("the facet filter + options + row label read presentationIdentity", () => {
    expect(LIB).toMatch(/facetKeyOf\(a\.presentationIdentity\)/);
    expect(LIB).toMatch(/const id = a\.presentationIdentity/);
    expect(LIB).toMatch(/const id = summary\.presentationIdentity/);
  });

  it("the facet + label no longer read effectiveIdentity", () => {
    expect(LIB).not.toMatch(/a\.effectiveIdentity/);
    expect(LIB).not.toMatch(/summary\.effectiveIdentity/);
  });
});

describe("row labeling (library-row-glyph.tsx) reads the presentation identity", () => {
  const GLYPH = read("src/components/artifacts/library-row-glyph.tsx");

  it("the glyph tier + listRow dispatch read presentationIdentity", () => {
    expect(GLYPH).toMatch(/summary\.presentationIdentity\.kind === "extension"/);
    expect(GLYPH).toMatch(/const identity = summary\.presentationIdentity/);
  });

  it("the glyph no longer reads effectiveIdentity", () => {
    expect(GLYPH).not.toMatch(/summary\.effectiveIdentity/);
  });
});

describe("the shared effective identity is still carried on the summary (untouched path)", () => {
  it("ArtifactSummary keeps both identities — presentation for the three consumers, effective for the shared path", () => {
    const SERVICE = read("src/lib/artifacts/artifact-service.ts");
    expect(SERVICE).toMatch(/effectiveIdentity:\s*EffectiveIdentity/);
    expect(SERVICE).toMatch(/presentationIdentity:\s*EffectiveIdentity/);
    // The shared effective-identity resolver is invoked unchanged alongside the
    // new presentation resolver.
    expect(SERVICE).toMatch(/resolveArtifactEffectiveIdentities/);
    expect(SERVICE).toMatch(/resolveArtifactPresentationIdentities/);
  });

  it("the file path glob is stable (the page.tsx source read above resolved)", () => {
    expect(existsSync(path.join(ROOT, "src/app/artifacts/[id]/page.tsx"))).toBe(true);
  });
});
