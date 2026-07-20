import { beforeEach, describe, expect, it, vi } from "vitest";

// Effective type catalog resolver (cinatra#1425) — AC-4: catalog resolution
// honors the claiming install's access grants PER ACTOR (an actor outside the
// grant sees no claim) and exposes entry kinds + dispositions. Arbitration is
// the REAL pure policy leaf (only the stores/access gate are mocked). The
// type-driven DECLARED disposition (epic #1785) is read from the registry via
// the shared resolver, mirrored here against the fixture defs.

vi.mock("server-only", () => ({}));

type FixtureDef = {
  type: string;
  category: string;
  isArtifact?: unknown;
  dispositions?: { projection: "raw" | "artifact-safe" | "none" };
};
const listTypes = vi.fn<(...a: unknown[]) => FixtureDef[]>();
vi.mock("@cinatra-ai/objects", () => ({
  objectTypeRegistry: { list: (...a: unknown[]) => listTypes(...a) },
  // The shared type-driven resolver, mirrored against the fixture defs: an
  // unregistered type fails closed to 'none'; a registered type declares its
  // projection or defaults to artifact-safe.
  resolveTypeProjectionDisposition: (typeId: string) => {
    const def = listTypes().find((d) => d.type === typeId);
    if (!def) return "none";
    return def.dispositions?.projection ?? "artifact-safe";
  },
}));

const readArtifactTypeClaimsForOrg = vi.fn();
vi.mock("@/lib/objects/artifact-claim-store", () => ({
  readArtifactTypeClaimsForOrg: (...a: unknown[]) => readArtifactTypeClaimsForOrg(...a),
}));

const canActorAccessClaimedArtifactExtension = vi.fn();
vi.mock("@/lib/artifacts/artifact-extension-access", () => ({
  canActorAccessClaimedArtifactExtension: (...a: unknown[]) => canActorAccessClaimedArtifactExtension(...a),
}));

import type { ActorContext } from "@/lib/authz/actor-context";
import { resolveEffectiveTypeCatalog } from "@/lib/objects/effective-type-catalog";

const grantedActor = { principalId: "user-in", principalType: "HumanUser", organizationId: "org-1" } as unknown as ActorContext;
const outsideActor = { principalId: "user-out", principalType: "HumanUser", organizationId: "org-1" } as unknown as ActorContext;

function claimRow(partial: Record<string, unknown>) {
  return {
    id: "c1",
    scope: "org:org-1",
    objectTypeId: "@cinatra-ai/campaigns:campaign",
    claimKind: "dedicated",
    status: "active",
    extensionPackage: "@vendor/campaigns-artifact",
    extensionVersion: "1.0.0",
    generation: 3,
    dispositions: { projection: "artifact-safe", pinnable: true },
    installId: "inst1",
    createdAt: null,
    updatedAt: null,
    ...partial,
  };
}

beforeEach(() => {
  listTypes.mockReset().mockReturnValue([
    { type: "@cinatra-ai/campaigns:campaign", category: "campaign" },
    {
      type: "@vendor/report-artifact:artifact",
      category: "report",
      isArtifact: { accepts: {} },
      dispositions: { projection: "artifact-safe" },
    },
  ]);
  readArtifactTypeClaimsForOrg.mockReset().mockReturnValue([claimRow({})]);
  canActorAccessClaimedArtifactExtension.mockReset();
});

describe("resolveEffectiveTypeCatalog", () => {
  it("exposes entry kinds: row-type vs artifact-extension-descriptor", async () => {
    canActorAccessClaimedArtifactExtension.mockResolvedValue(true);
    const catalog = await resolveEffectiveTypeCatalog({ orgId: "org-1", actor: grantedActor });
    const byId = new Map(catalog.map((e) => [e.typeId, e]));
    expect(byId.get("@cinatra-ai/campaigns:campaign")?.entryKind).toBe("row-type");
    expect(byId.get("@vendor/report-artifact:artifact")?.entryKind).toBe("artifact-extension-descriptor");
    // The former ACTIVE-dynamic-types axis was removed with the engine teardown
    // (epic cinatra#1785 entry 95; #1793): every entry is now static- or
    // claim-sourced (the `"dynamic"` source was dropped from the union).
    expect(catalog.every((e) => e.source === "static" || e.source === "claim")).toBe(true);
  });

  it("AC-4: an actor inside the install's grant sees the winning claim WITH validated dispositions", async () => {
    canActorAccessClaimedArtifactExtension.mockResolvedValue(true);
    const catalog = await resolveEffectiveTypeCatalog({ orgId: "org-1", actor: grantedActor });
    const entry = catalog.find((e) => e.typeId === "@cinatra-ai/campaigns:campaign");
    // The gate is CLAIM-scoped (fail-closed): it receives the claim's
    // package, bound installId, and scope — not just the package name.
    expect(canActorAccessClaimedArtifactExtension).toHaveBeenCalledWith(
      { extensionPackage: "@vendor/campaigns-artifact", installId: "inst1", scope: "org:org-1" },
      grantedActor,
      "read",
    );
    expect(entry?.claim).toMatchObject({
      claimId: "c1",
      claimKind: "dedicated",
      extensionPackage: "@vendor/campaigns-artifact",
      generation: 3,
      dispositions: { projection: "artifact-safe", pinnable: true, snapshotPolicy: "none", sensitivity: "normal" },
    });
  });

  it("AC-4: an actor OUTSIDE the grant sees NO claim (the entry itself stays)", async () => {
    canActorAccessClaimedArtifactExtension.mockResolvedValue(false);
    const catalog = await resolveEffectiveTypeCatalog({ orgId: "org-1", actor: outsideActor });
    const entry = catalog.find((e) => e.typeId === "@cinatra-ai/campaigns:campaign");
    expect(entry).toBeDefined();
    expect(entry?.claim).toBeNull();
  });

  it("arbitrates kind-over-scope with the REAL policy leaf: dedicated-org beats default-platform", async () => {
    canActorAccessClaimedArtifactExtension.mockResolvedValue(true);
    readArtifactTypeClaimsForOrg.mockReturnValue([
      claimRow({ id: "plat-default", scope: "platform", claimKind: "default", extensionPackage: "@cinatra-ai/default-artifact" }),
      claimRow({ id: "org-dedicated", scope: "org:org-1", claimKind: "dedicated" }),
    ]);
    const catalog = await resolveEffectiveTypeCatalog({ orgId: "org-1", actor: grantedActor });
    const entry = catalog.find((e) => e.typeId === "@cinatra-ai/campaigns:campaign");
    expect(entry?.claim?.claimId).toBe("org-dedicated");
  });

  it("a claim on a type with no local definition still creates a catalog entry (DB state outranks the process cache)", async () => {
    canActorAccessClaimedArtifactExtension.mockResolvedValue(true);
    readArtifactTypeClaimsForOrg.mockReturnValue([
      claimRow({ id: "c9", objectTypeId: "@other/unregistered:thing" }),
    ]);
    const catalog = await resolveEffectiveTypeCatalog({ orgId: "org-1", actor: grantedActor });
    const entry = catalog.find((e) => e.typeId === "@other/unregistered:thing");
    expect(entry?.source).toBe("claim");
    expect(entry?.claim?.claimId).toBe("c9");
  });

  it("a DENIED claim-only type is not surfaced at all (no existence leak)", async () => {
    canActorAccessClaimedArtifactExtension.mockResolvedValue(false);
    readArtifactTypeClaimsForOrg.mockReturnValue([
      claimRow({ id: "c9", objectTypeId: "@other/unregistered:thing" }),
    ]);
    const catalog = await resolveEffectiveTypeCatalog({ orgId: "org-1", actor: outsideActor });
    expect(catalog.find((e) => e.typeId === "@other/unregistered:thing")).toBeUndefined();
  });

  it("invalid dispositions resolve to null (fail-closed), the claim itself still surfaces", async () => {
    canActorAccessClaimedArtifactExtension.mockResolvedValue(true);
    readArtifactTypeClaimsForOrg.mockReturnValue([
      claimRow({ dispositions: { projection: "everything-goes" } }),
    ]);
    const catalog = await resolveEffectiveTypeCatalog({ orgId: "org-1", actor: grantedActor });
    const entry = catalog.find((e) => e.typeId === "@cinatra-ai/campaigns:campaign");
    expect(entry?.claim?.claimId).toBe("c1");
    expect(entry?.claim?.dispositions).toBeNull();
  });

  it("epic #1785: a static entry surfaces its type-driven DECLARED disposition (registry authority)", async () => {
    canActorAccessClaimedArtifactExtension.mockResolvedValue(true);
    const catalog = await resolveEffectiveTypeCatalog({ orgId: "org-1", actor: grantedActor });
    // The artifact-extension def declares an artifact-safe disposition — surfaced
    // from the registry (not the DB claim).
    const artifactEntry = catalog.find((e) => e.typeId === "@vendor/report-artifact:artifact");
    expect(artifactEntry?.declaredDispositions).toEqual({ projection: "artifact-safe" });
    expect(artifactEntry?.projectionDisposition).toBe("artifact-safe");
    // The campaign def declares NO disposition — ungoverned, so no declared
    // payload, and the resolver defaults it to artifact-safe.
    const campaignEntry = catalog.find((e) => e.typeId === "@cinatra-ai/campaigns:campaign");
    expect(campaignEntry?.declaredDispositions).toBeNull();
    expect(campaignEntry?.projectionDisposition).toBe("artifact-safe");
  });

  it("epic #1785: a claim-only type (no local registration) fails the type-driven resolver closed to 'none'", async () => {
    canActorAccessClaimedArtifactExtension.mockResolvedValue(true);
    readArtifactTypeClaimsForOrg.mockReturnValue([
      claimRow({ id: "c9", objectTypeId: "@other/unregistered:thing" }),
    ]);
    const catalog = await resolveEffectiveTypeCatalog({ orgId: "org-1", actor: grantedActor });
    const entry = catalog.find((e) => e.typeId === "@other/unregistered:thing");
    expect(entry?.declaredDispositions).toBeNull();
    expect(entry?.projectionDisposition).toBe("none");
  });
});
