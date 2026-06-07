// Unit test for the IoC reader facet `listActive` on the artifact handler.
// Lives in the UNIT suite (no DB) — the native object-type registry is mocked.
//
// Contract: the object-type registry is the artifact VISIBILITY + capability
// authority. listActive reads objectTypeRegistry.listArtifacts(), derives each
// descriptor's package identity from the typeId namespace (`@scope/pkg:slug` ->
// `@scope/pkg`), and keeps only those whose package is BOTH lifecycle-live AND
// owner-visible per the shared visibility gate. This fixes BOTH over-exposure
// (never surfaced by package name alone) and under-exposure (a visible-live
// descriptor is always surfaced).

import { describe, it, expect, vi, beforeEach } from "vitest";

const listArtifactsMock = vi.fn();

vi.mock("@cinatra-ai/objects", () => ({
  objectTypeRegistry: {
    listArtifacts: () => listArtifactsMock(),
  },
}));

import { createArtifactExtensionHandler } from "../artifact-handler";

const actor = { userId: "u1", actorType: "human", source: "ui" } as never;

function artifactDef(typeId: string) {
  // Minimal projection — the facet only reads `.type`.
  return { type: typeId, isArtifact: true };
}

function manifest(packageName: string, overrides: Record<string, unknown> = {}) {
  return {
    id: packageName,
    packageName,
    kind: "artifact",
    ownerLevel: "platform",
    ownerId: null,
    organizationId: null,
    status: "active",
    ...overrides,
  };
}

function scopeWith(overrides: Record<string, unknown> = {}) {
  return {
    userId: "u1",
    organizationId: null,
    teamIds: [],
    ...overrides,
  } as never;
}

describe("artifact handler listActive (IoC reader facet)", () => {
  let handler: ReturnType<typeof createArtifactExtensionHandler>;
  beforeEach(() => {
    vi.resetAllMocks();
    handler = createArtifactExtensionHandler();
  });

  it("INTERSECTS registered artifacts with the visible-live manifest set by typeId-namespace", async () => {
    listArtifactsMock.mockReturnValue([
      artifactDef("@cinatra-ai/invoice-artifact:invoice"),
      artifactDef("@cinatra-ai/contract-artifact:contract"),
      artifactDef("@cinatra-ai/not-live-artifact:thing"),
    ]);
    const result = (await handler.listActive!({
      actor,
      scope: scopeWith(),
      manifests: [
        manifest("@cinatra-ai/invoice-artifact"),
        manifest("@cinatra-ai/contract-artifact"),
      ],
    })) as Array<{ type: string }>;
    expect(result.map((d) => d.type).sort()).toEqual(
      [
        "@cinatra-ai/contract-artifact:contract",
        "@cinatra-ai/invoice-artifact:invoice",
      ].sort(),
    );
  });

  it("does NOT surface a registered artifact whose package is not lifecycle-live", async () => {
    listArtifactsMock.mockReturnValue([
      artifactDef("@cinatra-ai/invoice-artifact:invoice"),
      artifactDef("@cinatra-ai/archived-artifact:old"),
    ]);
    const result = await handler.listActive!({
      actor,
      scope: scopeWith(),
      manifests: [manifest("@cinatra-ai/invoice-artifact")], // archived absent from live set
    });
    expect(result).toHaveLength(1);
    expect((result[0] as { type: string }).type).toBe(
      "@cinatra-ai/invoice-artifact:invoice",
    );
  });

  it("EXCLUDES an out-of-scope org-owned artifact (visible by package name alone is not enough)", async () => {
    listArtifactsMock.mockReturnValue([
      artifactDef("@acme-private/secret-artifact:secret"),
    ]);
    // The manifest is org-owned by a different org than the actor's scope, so
    // the shared visibility gate drops its package name from the live set.
    const result = await handler.listActive!({
      actor,
      scope: scopeWith({ organizationId: "org-actor" }),
      manifests: [
        manifest("@acme-private/secret-artifact", {
          ownerLevel: "organization",
          organizationId: "org-OTHER",
        }),
      ],
    });
    expect(result).toHaveLength(0);
  });

  it("INCLUDES an org-owned artifact when the actor's org matches", async () => {
    listArtifactsMock.mockReturnValue([
      artifactDef("@acme-private/secret-artifact:secret"),
    ]);
    const result = await handler.listActive!({
      actor,
      scope: scopeWith({ organizationId: "org-actor" }),
      manifests: [
        manifest("@acme-private/secret-artifact", {
          ownerLevel: "organization",
          organizationId: "org-actor",
        }),
      ],
    });
    expect(result).toHaveLength(1);
  });

  it("returns empty when no artifacts are registered even if manifests are live", async () => {
    listArtifactsMock.mockReturnValue([]);
    const result = await handler.listActive!({
      actor,
      scope: scopeWith(),
      manifests: [manifest("@cinatra-ai/invoice-artifact")],
    });
    expect(result).toHaveLength(0);
  });
});
