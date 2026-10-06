/**
 * cinatra#3033 (CELL4, the claim ledger) — a pack's claim over a type id in
 * ANOTHER package's namespace is remembered by the pack's name, forgotten when
 * the pack re-registers without it and forgotten on request, and the ledger
 * never registers a type.
 *
 * Built over the PINNED linkedin-artifacts manifest read from disk (never
 * re-typed): its one objectTypes claim is `@cinatra-ai/linkedin:post-draft`,
 * an id in the host's namespace, so the bridge registers no type for it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { matcherManifestRegistry, objectTypeRegistry } from "../../registry";
import { semanticRendererRegistry } from "../../artifact-renderer-registry";
import { parseSemanticArtifactManifest } from "../../semantic-manifest";
import type { SemanticArtifactManifest } from "../../types";
import {
  crossNamespaceClaimantsOf,
  crossNamespaceClaimsBy,
  forgetCrossNamespaceClaimsOf,
  registerParsedArtifactManifest,
} from "../register-artifact-extensions";

const PACK = "@cinatra-ai/linkedin-artifacts";
const CLAIMED = "@cinatra-ai/linkedin:post-draft";

const PINNED_MANIFEST_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "extensions",
  "cinatra-ai",
  "linkedin-artifacts",
  "package.json",
);

function pinnedManifest(): { name: string; manifest: SemanticArtifactManifest } {
  const pkg = JSON.parse(readFileSync(PINNED_MANIFEST_PATH, "utf8")) as {
    name: string;
    cinatra: { artifact: unknown };
  };
  const parsed = parseSemanticArtifactManifest(pkg.cinatra.artifact);
  if (!parsed.ok) throw new Error(`pinned manifest does not parse: ${parsed.errors.join("; ")}`);
  return { name: pkg.name, manifest: parsed.manifest };
}

function clearAll(): void {
  objectTypeRegistry._clearForTests();
  matcherManifestRegistry._clearForTests();
  semanticRendererRegistry._clearForTests();
}

describe("the cross-namespace claim ledger over the pinned linkedin-artifacts manifest (cinatra#3033)", () => {
  beforeEach(() => {
    clearAll();
  });
  afterEach(() => {
    forgetCrossNamespaceClaimsOf(PACK);
    clearAll();
  });

  it("reads the pinned pack as the task states it: one claim, in the host's namespace", () => {
    const { name, manifest } = pinnedManifest();
    expect(name).toBe(PACK);
    expect((manifest.objectTypes ?? []).map((c) => c.type)).toEqual([CLAIMED]);
  });

  it("remembers the claim by the claiming pack's name, and registers no type for it", () => {
    const { name, manifest } = pinnedManifest();
    const registered = registerParsedArtifactManifest(manifest, name);

    expect(crossNamespaceClaimantsOf(CLAIMED)).toEqual([PACK]);
    expect(crossNamespaceClaimsBy(PACK)).toEqual([CLAIMED]);
    // A reading, never a registration: the pack still owns no type.
    expect(registered).toBe(false);
    expect(objectTypeRegistry.resolve(CLAIMED)).toBeNull();
    expect(objectTypeRegistry.getTypesForPackage(PACK)).toEqual([]);
  });

  it("forgets the claim when the same pack re-registers with the claim removed", () => {
    const { name, manifest } = pinnedManifest();
    registerParsedArtifactManifest(manifest, name);
    expect(crossNamespaceClaimsBy(PACK)).toEqual([CLAIMED]);

    const withoutClaim: SemanticArtifactManifest = {
      ...manifest,
      objectTypes: (manifest.objectTypes ?? []).filter((c) => c.type !== CLAIMED),
    };
    registerParsedArtifactManifest(withoutClaim, name);

    expect(crossNamespaceClaimantsOf(CLAIMED)).toEqual([]);
    expect(crossNamespaceClaimsBy(PACK)).toEqual([]);
  });

  it("forgets every claim of a package through forgetCrossNamespaceClaimsOf", () => {
    const { name, manifest } = pinnedManifest();
    registerParsedArtifactManifest(manifest, name);
    expect(crossNamespaceClaimantsOf(CLAIMED)).toEqual([PACK]);

    forgetCrossNamespaceClaimsOf(PACK);

    expect(crossNamespaceClaimantsOf(CLAIMED)).toEqual([]);
    expect(crossNamespaceClaimsBy(PACK)).toEqual([]);
  });
});
