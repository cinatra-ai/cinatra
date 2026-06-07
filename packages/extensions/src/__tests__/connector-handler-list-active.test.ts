// Unit test for the IoC reader facet `listActive` on the connector handler.
// Lives in the UNIT suite (no DB) — the connector catalog is mocked to a
// fixture so the assertion is purely about the intersection logic.
//
// Contract: the connector catalog carries no per-owner visibility, so the
// active-gate `manifests` (run through the shared owner-scope helper) are the
// sole authority for which descriptors this actor may discover. A descriptor
// surfaces only when its `packageId` is BOTH lifecycle-live AND owner-visible.
// The descriptor's `defaultVisibility` is NOT enforced here (connector-policy
// owns the read/use/manage gate downstream).

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@cinatra-ai/connectors-catalog", () => ({
  listConnectorDescriptors: vi.fn(),
}));

import { createConnectorExtensionHandler } from "../connector-handler";
import { listConnectorDescriptors } from "@cinatra-ai/connectors-catalog";

const actor = { userId: "u1", actorType: "human", source: "ui" } as never;

function descriptor(packageId: string, defaultVisibility: "admin" | "workspace" = "workspace") {
  return {
    packageId,
    slug: packageId.split("/")[1] ?? packageId,
    displayName: packageId,
    defaultVisibility,
    mcpPrimitivePrefixes: [],
    setupSubroute: "setup",
  };
}

// Minimal ActiveExtensionManifest factory. `ownerLevel: "platform"` is
// deployment-wide (visible to every actor); `user`/`organization` rows gate.
function manifest(
  packageName: string,
  over: Partial<{ ownerLevel: string; ownerId: string | null; organizationId: string | null }> = {},
) {
  return {
    id: packageName,
    packageName,
    kind: "connector",
    ownerLevel: over.ownerLevel ?? "platform",
    ownerId: over.ownerId ?? null,
    organizationId: over.organizationId ?? null,
    status: "active",
  };
}

function scope(
  over: Partial<{ userId: string | null; organizationId: string | null; teamIds: string[] }> = {},
) {
  return {
    userId: over.userId ?? "u1",
    organizationId: over.organizationId ?? null,
    teamIds: over.teamIds ?? [],
  } as never;
}

describe("connector handler listActive (IoC reader facet)", () => {
  let handler: ReturnType<typeof createConnectorExtensionHandler>;
  beforeEach(() => {
    vi.resetAllMocks();
    handler = createConnectorExtensionHandler();
  });

  it("INTERSECTS the catalog with the lifecycle-live + owner-visible manifest set by packageId", async () => {
    vi.mocked(listConnectorDescriptors).mockReturnValue([
      descriptor("@cinatra-ai/openai-connector"),
      descriptor("@cinatra-ai/apollo-connector"),
      descriptor("@cinatra-ai/gmail-connector"),
    ] as never);
    const result = (await handler.listActive!({
      actor,
      scope: scope(),
      // gmail is NOT in the live set -> excluded
      manifests: [
        manifest("@cinatra-ai/openai-connector"),
        manifest("@cinatra-ai/apollo-connector"),
      ],
    })) as Array<{ packageId: string }>;
    expect(result.map((d) => d.packageId).sort()).toEqual([
      "@cinatra-ai/apollo-connector",
      "@cinatra-ai/openai-connector",
    ]);
  });

  it("EXCLUDES a descriptor whose only live manifest is an out-of-scope owner row", async () => {
    vi.mocked(listConnectorDescriptors).mockReturnValue([
      descriptor("@cinatra-ai/openai-connector"),
      descriptor("@cinatra-ai/apollo-connector"),
    ] as never);
    const result = (await handler.listActive!({
      actor,
      scope: scope({ userId: "u1" }),
      manifests: [
        // platform row -> visible
        manifest("@cinatra-ai/openai-connector"),
        // user-owned by a DIFFERENT user -> NOT visible to u1, so apollo drops
        manifest("@cinatra-ai/apollo-connector", { ownerLevel: "user", ownerId: "someone-else" }),
      ],
    })) as Array<{ packageId: string }>;
    expect(result.map((d) => d.packageId)).toEqual(["@cinatra-ai/openai-connector"]);
  });

  it("does NOT surface a catalog descriptor that has no lifecycle-live manifest", async () => {
    vi.mocked(listConnectorDescriptors).mockReturnValue([
      descriptor("@cinatra-ai/openai-connector"),
      descriptor("@cinatra-ai/github-connector"),
    ] as never);
    const result = (await handler.listActive!({
      actor,
      scope: scope(),
      manifests: [manifest("@cinatra-ai/openai-connector")],
    })) as Array<{ packageId: string }>;
    expect(result.map((d) => d.packageId)).toEqual(["@cinatra-ai/openai-connector"]);
  });

  it("does NOT enforce the descriptor's defaultVisibility (admin descriptors still surface when live + owner-visible)", async () => {
    vi.mocked(listConnectorDescriptors).mockReturnValue([
      descriptor("@cinatra-ai/github-connector", "admin"),
    ] as never);
    const result = (await handler.listActive!({
      actor,
      scope: scope(),
      manifests: [manifest("@cinatra-ai/github-connector")],
    })) as Array<{ packageId: string }>;
    expect(result.map((d) => d.packageId)).toEqual(["@cinatra-ai/github-connector"]);
  });
});
