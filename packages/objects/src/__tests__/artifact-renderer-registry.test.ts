/**
 * The TWO artifact-renderer arbitration registries (cinatra#1629, epic #1620
 * S2). Pins: semantic per-claimant winner-binding; representation unified
 * specificity-dominant precedence (incl. first-party exact > extension
 * catch-all); org scoping; activation-generation upgrade/stale; teardown;
 * derived generated-keys (never caller-supplied); and disjoint keyspaces.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { EffectiveIdentity } from "../effective-identity";
import {
  semanticRendererRegistry,
  representationProviderRegistry,
  generatedArtifactRendererKey,
  representationMatchSpecificity,
  isRepresentationPatternKey,
  isSemanticTypeKey,
} from "../artifact-renderer-registry";

const winner = (extension: string): EffectiveIdentity => ({
  kind: "extension",
  extension,
  basis: "classic",
  selectable: true,
  assertionId: "sa_1",
});

afterEach(() => {
  semanticRendererRegistry._clearForTests();
  representationProviderRegistry._clearForTests(true);
});

describe("generatedArtifactRendererKey", () => {
  it("joins package + slot with the shared `::` separator", () => {
    expect(generatedArtifactRendererKey("@cinatra-ai/foo-artifact", "detail")).toBe(
      "@cinatra-ai/foo-artifact::detail",
    );
  });
});

describe("semantic-type renderer registry — per-claimant winner binding", () => {
  it("derives the generated key from the package (never caller-supplied)", () => {
    semanticRendererRegistry.register({
      objectTypeId: "@cinatra-ai/contract-artifact:artifact",
      packageName: "@cinatra-ai/contract-artifact",
    });
    expect(
      semanticRendererRegistry.resolve(
        "@cinatra-ai/contract-artifact:artifact",
        winner("@cinatra-ai/contract-artifact"),
      ),
    ).toEqual({
      objectTypeId: "@cinatra-ai/contract-artifact:artifact",
      packageName: "@cinatra-ai/contract-artifact",
      generatedKey: "@cinatra-ai/contract-artifact::detail",
    });
  });

  it("resolves each competing claimant of the SAME type to ITS OWN renderer (winners never overwrite each other)", () => {
    const TYPE = "@cinatra-ai/shared:contract";
    semanticRendererRegistry.register({ objectTypeId: TYPE, packageName: "@cinatra-ai/ext-a" });
    semanticRendererRegistry.register({ objectTypeId: TYPE, packageName: "@cinatra-ai/ext-b" });
    // org-1 winner is A → A's module; org-2 winner is B → B's module.
    expect(semanticRendererRegistry.resolve(TYPE, winner("@cinatra-ai/ext-a"))).toMatchObject({
      packageName: "@cinatra-ai/ext-a",
      generatedKey: "@cinatra-ai/ext-a::detail",
    });
    expect(semanticRendererRegistry.resolve(TYPE, winner("@cinatra-ai/ext-b"))).toMatchObject({
      packageName: "@cinatra-ai/ext-b",
      generatedKey: "@cinatra-ai/ext-b::detail",
    });
    // A winner that ships no renderer for the type resolves to null (no leak).
    expect(semanticRendererRegistry.resolve(TYPE, winner("@cinatra-ai/ext-c"))).toBeNull();
  });

  it("returns null for a non-extension identity", () => {
    semanticRendererRegistry.register({ objectTypeId: "@cinatra-ai/x:artifact", packageName: "@cinatra-ai/x" });
    const floor: EffectiveIdentity = { kind: "default-artifact", selectable: true, assertionId: "f" };
    expect(semanticRendererRegistry.resolve("@cinatra-ai/x:artifact", floor)).toBeNull();
  });

  it("refuses a MIME-pattern-shaped objectTypeId (keyspace guard)", () => {
    semanticRendererRegistry.register({ objectTypeId: "application/pdf", packageName: "@cinatra-ai/x" });
    expect(semanticRendererRegistry.resolve("application/pdf", winner("@cinatra-ai/x"))).toBeNull();
    expect(semanticRendererRegistry._snapshot()).toHaveLength(0);
  });

  it("removeByPackage retires every type the package registered", () => {
    semanticRendererRegistry.register({ objectTypeId: "@cinatra-ai/x:artifact", packageName: "@cinatra-ai/x" });
    semanticRendererRegistry.register({ objectTypeId: "@cinatra-ai/x:memo", packageName: "@cinatra-ai/x" });
    semanticRendererRegistry.register({ objectTypeId: "@cinatra-ai/x:memo", packageName: "@cinatra-ai/y" });
    const removed = semanticRendererRegistry.removeByPackage("@cinatra-ai/x");
    expect(removed.sort()).toEqual(["@cinatra-ai/x:artifact", "@cinatra-ai/x:memo"]);
    expect(semanticRendererRegistry.resolve("@cinatra-ai/x:artifact", winner("@cinatra-ai/x"))).toBeNull();
    // A different package's renderer for the same type survives.
    expect(semanticRendererRegistry.resolve("@cinatra-ai/x:memo", winner("@cinatra-ai/y"))).not.toBeNull();
  });
});

describe("representationMatchSpecificity", () => {
  it("ranks exact > type-wildcard > catch-all and rejects non-matches", () => {
    expect(representationMatchSpecificity("application/pdf", "application/pdf")).toBe(3);
    expect(representationMatchSpecificity("image/*", "image/png")).toBe(2);
    expect(representationMatchSpecificity("*/*", "video/mp4")).toBe(1);
    expect(representationMatchSpecificity("image/*", "video/mp4")).toBe(-1);
    expect(representationMatchSpecificity("application/pdf", "application/json")).toBe(-1);
  });
});

describe("representation-provider registry — unified specificity precedence", () => {
  const provider = (packageName: string, pattern: string, generation = 1) => ({
    packageName,
    pattern,
    slot: "preview" as const,
    generation,
  });

  it("prefers the exact-match extension provider over a wildcard extension provider", () => {
    representationProviderRegistry.registerProvider("org_1", provider("@cinatra-ai/any-viewer", "*/*"));
    representationProviderRegistry.registerProvider("org_1", provider("@cinatra-ai/pdf-viewer", "application/pdf"));
    expect(representationProviderRegistry.resolve("org_1", "application/pdf", "preview")).toMatchObject({
      tier: "extension",
      packageName: "@cinatra-ai/pdf-viewer",
      generatedKey: "@cinatra-ai/pdf-viewer::preview",
    });
    expect(representationProviderRegistry.resolve("org_1", "text/plain", "preview")).toMatchObject({
      tier: "extension",
      packageName: "@cinatra-ai/any-viewer",
    });
  });

  it("SPECIFICITY dominates tier — a first-party EXACT default beats an extension CATCH-ALL provider", () => {
    representationProviderRegistry.registerFirstPartyDefault({ pattern: "application/pdf", slot: "preview", ref: "pdf" });
    representationProviderRegistry.registerProvider("org_1", provider("@cinatra-ai/any-viewer", "*/*"));
    expect(representationProviderRegistry.resolve("org_1", "application/pdf", "preview")).toMatchObject({
      tier: "first-party",
      ref: "pdf",
    });
    // For a non-pdf MIME the extension catch-all wins (no more-specific default).
    expect(representationProviderRegistry.resolve("org_1", "text/plain", "preview")).toMatchObject({
      tier: "extension",
      packageName: "@cinatra-ai/any-viewer",
    });
  });

  it("an extension provider outranks a first-party default at EQUAL specificity", () => {
    representationProviderRegistry.registerFirstPartyDefault({ pattern: "application/pdf", slot: "preview", ref: "pdf" });
    representationProviderRegistry.registerProvider("org_1", provider("@cinatra-ai/pdf-viewer", "application/pdf"));
    expect(representationProviderRegistry.resolve("org_1", "application/pdf", "preview")).toMatchObject({
      tier: "extension",
      packageName: "@cinatra-ai/pdf-viewer",
    });
  });

  it("is ORG-SCOPED — a provider bound to one org is invisible to another", () => {
    representationProviderRegistry.registerProvider("org_1", provider("@cinatra-ai/pdf-viewer", "application/pdf"));
    expect(representationProviderRegistry.resolve("org_2", "application/pdf", "preview")).toBeNull();
  });

  it("falls through to the always-effective first-party default until a provider is effective", () => {
    representationProviderRegistry.registerFirstPartyDefault({ pattern: "image/*", slot: "preview", ref: "image" });
    expect(representationProviderRegistry.resolve("org_9", "image/png", "preview")).toMatchObject({
      tier: "first-party",
      ref: "image",
    });
  });

  it("returns null when nothing matches (dispatch falls to the generic floor)", () => {
    expect(representationProviderRegistry.resolve("org_1", "application/x-unknown", "preview")).toBeNull();
  });
});

describe("representation-provider registry — activation generation + teardown", () => {
  const reg = (packageName: string, pattern: string, generation: number) => ({
    packageName,
    pattern,
    slot: "preview" as const,
    generation,
  });
  const pdf = (packageName: string, generation: number) => reg(packageName, "application/pdf", generation);

  it("a higher generation supersedes; a stale (lower) generation is ignored — never stacks a duplicate", () => {
    representationProviderRegistry.registerProvider("org_1", pdf("@cinatra-ai/pdf-viewer", 1));
    representationProviderRegistry.registerProvider("org_1", pdf("@cinatra-ai/pdf-viewer", 2)); // upgrade
    representationProviderRegistry.registerProvider("org_1", pdf("@cinatra-ai/pdf-viewer", 1)); // stale — no-op
    const snap = representationProviderRegistry._snapshotOrgProviders("org_1");
    expect(snap).toHaveLength(1);
    expect(snap[0]!.generation).toBe(2);
  });

  it("a generation UPGRADE retires the package's ENTIRE prior binding set — a removed/changed pattern cannot leak", () => {
    // gen 1: the package declares an EXACT application/pdf provider.
    representationProviderRegistry.registerProvider("org_1", reg("@cinatra-ai/p", "application/pdf", 1));
    // gen 2: the package re-activates declaring ONLY a catch-all (the pdf
    // declaration was removed). The stale gen-1 pdf binding must be purged.
    representationProviderRegistry.registerProvider("org_1", reg("@cinatra-ai/p", "*/*", 2));
    const snap = representationProviderRegistry._snapshotOrgProviders("org_1");
    expect(snap).toHaveLength(1);
    expect(snap[0]!.pattern).toBe("*/*");
    // A pdf row now resolves the gen-2 catch-all, NOT the removed exact provider.
    expect(representationProviderRegistry.resolve("org_1", "application/pdf", "preview")).toMatchObject({
      packageName: "@cinatra-ai/p",
      pattern: "*/*",
    });
    // A late STALE gen-1 pdf re-register is rejected (generation < active 2).
    representationProviderRegistry.registerProvider("org_1", reg("@cinatra-ai/p", "application/pdf", 1));
    expect(representationProviderRegistry._snapshotOrgProviders("org_1")).toHaveLength(1);
    expect(representationProviderRegistry.resolve("org_1", "application/pdf", "preview")).toMatchObject({
      pattern: "*/*",
    });
  });

  it("same-generation registrations are one activation batch — multiple patterns coexist", () => {
    representationProviderRegistry.registerProvider("org_1", reg("@cinatra-ai/p", "application/pdf", 3));
    representationProviderRegistry.registerProvider("org_1", reg("@cinatra-ai/p", "image/*", 3));
    expect(representationProviderRegistry._snapshotOrgProviders("org_1")).toHaveLength(2);
    expect(representationProviderRegistry.resolve("org_1", "application/pdf", "preview")).toMatchObject({ pattern: "application/pdf" });
    expect(representationProviderRegistry.resolve("org_1", "image/png", "preview")).toMatchObject({ pattern: "image/*" });
  });

  it("a different package's generation is independent (per (org,package) tracking)", () => {
    representationProviderRegistry.registerProvider("org_1", pdf("@cinatra-ai/a", 5));
    representationProviderRegistry.registerProvider("org_1", reg("@cinatra-ai/b", "image/*", 1));
    // A upgrading does not disturb B's lower-generation binding.
    representationProviderRegistry.registerProvider("org_1", reg("@cinatra-ai/a", "*/*", 6));
    expect(representationProviderRegistry.resolve("org_1", "image/png", "preview")).toMatchObject({
      packageName: "@cinatra-ai/b",
    });
  });

  it("retireProvidersByPackage drops the package across every org; a real reinstall (higher generation) re-activates", () => {
    representationProviderRegistry.registerProvider("org_1", pdf("@cinatra-ai/pdf-viewer", 5));
    representationProviderRegistry.registerProvider("org_2", pdf("@cinatra-ai/pdf-viewer", 5));
    expect(representationProviderRegistry.retireProvidersByPackage("@cinatra-ai/pdf-viewer")).toBe(2);
    expect(representationProviderRegistry.resolve("org_1", "application/pdf", "preview")).toBeNull();
    expect(representationProviderRegistry.resolve("org_2", "application/pdf", "preview")).toBeNull();
    // A real reinstall carries a strictly higher activation generation → re-activates.
    representationProviderRegistry.registerProvider("org_1", pdf("@cinatra-ai/pdf-viewer", 6));
    expect(representationProviderRegistry.resolve("org_1", "application/pdf", "preview")).not.toBeNull();
  });

  it("ABA-safe: a delayed straggler from the TORN-DOWN epoch cannot resurrect the provider", () => {
    representationProviderRegistry.registerProvider("org_1", pdf("@cinatra-ai/pdf-viewer", 5));
    representationProviderRegistry.retireProvidersByPackage("@cinatra-ai/pdf-viewer");
    // A delayed same-generation (gen 5) registration arrives AFTER teardown — the
    // generation floor is retained as a tombstone, so it is rejected (no live
    // binding at the floor generation), not resurrected.
    representationProviderRegistry.registerProvider("org_1", pdf("@cinatra-ai/pdf-viewer", 5));
    expect(representationProviderRegistry.resolve("org_1", "application/pdf", "preview")).toBeNull();
    // A LOWER-generation straggler is likewise rejected.
    representationProviderRegistry.registerProvider("org_1", pdf("@cinatra-ai/pdf-viewer", 4));
    expect(representationProviderRegistry.resolve("org_1", "application/pdf", "preview")).toBeNull();
  });

  it("retireOrgProvider drops only the named org's binding (upgrade/uninstall semantics)", () => {
    representationProviderRegistry.registerProvider("org_1", pdf("@cinatra-ai/pdf-viewer", 1));
    representationProviderRegistry.registerProvider("org_2", pdf("@cinatra-ai/pdf-viewer", 1));
    expect(representationProviderRegistry.retireOrgProvider("org_1", "@cinatra-ai/pdf-viewer")).toBe(1);
    expect(representationProviderRegistry.resolve("org_1", "application/pdf", "preview")).toBeNull();
    expect(representationProviderRegistry.resolve("org_2", "application/pdf", "preview")).not.toBeNull();
  });
});

describe("the two registries never share a keyspace", () => {
  it("a semantic key is an object-type id; a representation key is a MIME pattern — disjoint by construction", () => {
    expect(isSemanticTypeKey("@cinatra-ai/contract-artifact:artifact")).toBe(true);
    expect(isRepresentationPatternKey("@cinatra-ai/contract-artifact:artifact")).toBe(false);

    expect(isRepresentationPatternKey("application/pdf")).toBe(true);
    expect(isRepresentationPatternKey("image/*")).toBe(true);
    expect(isRepresentationPatternKey("*/*")).toBe(true);
    expect(isSemanticTypeKey("application/pdf")).toBe(false);
    expect(isSemanticTypeKey("image/*")).toBe(false);
  });
});
