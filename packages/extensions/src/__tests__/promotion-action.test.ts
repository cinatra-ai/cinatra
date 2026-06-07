// promoteExtensionToPublicAction tests.
//
// Behavior covered:
//   Test 1: throws when no origin row exists for the package
//   Test 2: throws ExtensionAlreadyPublicError when the package is already public
//   Test 3: calls resolvePublishDestination('public'), publishes, updates origin, writes audit log
//   Test 4: audit log failure does NOT roll back the promotion (fire-and-forget)

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
// actions.ts does a side-effect `import "./handler-bootstrap"`, which pulls the
// @cinatra-ai/agents / @cinatra-ai/skills / @cinatra-ai/workflows extension-handler
// barrels (-> object-type registry -> @cinatra-ai/mcp-server) into the graph. This
// suite never exercises handler registration (extensionRegistry is mocked below),
// so stub the bootstrap to keep the heavy, unresolvable barrel chain out of vitest.
vi.mock("../handler-bootstrap", () => ({}));

// Provide a stable mock for next/navigation (redirect used by other actions in same file)
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

// Provide stable base mocks for extensionRegistry + top-level imports in actions.ts
vi.mock("@cinatra-ai/registries", () => ({
  getAgentPackage: vi.fn(async () => null),
  comparePluginVersions: vi.fn(() => "current"),
  listAgentPackages: vi.fn(async () => []),
  ensureConfig: vi.fn((cfg: unknown) => cfg),
}));

vi.mock("../index", () => ({
  extensionRegistry: {
    install: vi.fn(),
    update: vi.fn(),
    uninstall: vi.fn(),
    archive: vi.fn(),
    restore: vi.fn(),
    reinstall: vi.fn(),
    forceDelete: vi.fn(),
  },
}));

vi.mock("../utils", () => ({
  deriveTypeId: vi.fn(() => "agent"),
}));

vi.mock("../audit-log", () => ({
  readDanglingReferences: vi.fn(async () => []),
}));

describe("promoteExtensionToPublicAction", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("throws when no origin row exists for the package", async () => {
    vi.doMock("@/lib/auth-session", () => ({
      requireAdminSession: vi.fn(async () => ({ user: { id: "admin-1" } })),
    }));
    vi.doMock("@cinatra-ai/agents/store", () => ({
      readAgentTemplateOrigin: vi.fn(async () => null),
      readAgentTemplateByPackageName: vi.fn(async () => null),
      readAgentVersionsByTemplate: vi.fn(async () => []),
      updateAgentTemplateVisibility: vi.fn(),
    }));
    vi.doMock("@cinatra-ai/extensions/destination-resolver", () => ({
      resolvePublishDestination: vi.fn(async () => ({
        registryUrl: "https://registry.cinatra.ai",
        packageScope: "@x",
        token: "tok",
        uiUrl: "https://registry.cinatra.ai",
      })),
    }));
    vi.doMock("@cinatra-ai/agents/verdaccio/client", () => ({
      publishAgentPackage: vi.fn(async () => undefined),
    }));
    vi.doMock("@cinatra-ai/agents/verdaccio/publish-metadata", () => ({
      derivePublishMetadataFromSnapshot: vi.fn(() => ({
        riskLevel: "low",
        toolAccess: [],
        hasApprovalGates: false,
      })),
    }));
    vi.doMock("@/lib/authz", () => ({
      logAuditEvent: vi.fn(),
      POLICY_VERSION: "v1",
    }));

    const { promoteExtensionToPublicAction } = await import("@cinatra-ai/extensions/actions");
    await expect(
      promoteExtensionToPublicAction({ packageName: "@x/y", packageVersion: "1.0.0" }),
    ).rejects.toThrow();
  });

  it("throws ExtensionAlreadyPublicError when the package is already public", async () => {
    vi.doMock("@/lib/auth-session", () => ({
      requireAdminSession: vi.fn(async () => ({ user: { id: "admin-1" } })),
    }));
    vi.doMock("@cinatra-ai/agents/store", () => ({
      readAgentTemplateOrigin: vi.fn(async () => ({
        packageName: "@x/y",
        version: "1.0.0",
        destinationId: null,
        scope: "@x",
        visibility: "public" as const,
        registryUrl: "https://registry.cinatra.ai",
      })),
      readAgentTemplateByPackageName: vi.fn(async () => null),
      readAgentVersionsByTemplate: vi.fn(async () => []),
      updateAgentTemplateVisibility: vi.fn(),
    }));
    vi.doMock("@cinatra-ai/extensions/destination-resolver", () => ({
      resolvePublishDestination: vi.fn(),
    }));
    vi.doMock("@cinatra-ai/agents/verdaccio/client", () => ({
      publishAgentPackage: vi.fn(),
    }));
    vi.doMock("@cinatra-ai/agents/verdaccio/publish-metadata", () => ({
      derivePublishMetadataFromSnapshot: vi.fn(() => ({
        riskLevel: "low",
        toolAccess: [],
        hasApprovalGates: false,
      })),
    }));
    vi.doMock("@/lib/authz", () => ({
      logAuditEvent: vi.fn(),
      POLICY_VERSION: "v1",
    }));

    const { promoteExtensionToPublicAction } = await import(
      "@cinatra-ai/extensions/actions"
    );
    const { ExtensionAlreadyPublicError } = await import(
      "@cinatra-ai/extensions/promotion-errors"
    );
    await expect(
      promoteExtensionToPublicAction({ packageName: "@x/y", packageVersion: "1.0.0" }),
    ).rejects.toBeInstanceOf(ExtensionAlreadyPublicError);
  });

  it("calls resolvePublishDestination('public'), publishes, updates origin, and writes audit log", async () => {
    const updateMock = vi.fn();
    const publishMock = vi.fn(async () => ({
      packageName: "@x/y",
      packageVersion: "1.0.0",
      registryUrl: "https://registry.cinatra.ai",
      published: true,
      alreadyPublished: false,
    }));
    const resolveMock = vi.fn(async () => ({
      registryUrl: "https://registry.cinatra.ai",
      packageScope: "@x",
      token: "tok",
      uiUrl: "https://registry.cinatra.ai",
    }));
    const auditMock = vi.fn();
    const fakeTemplate = {
      id: "tmpl-1",
      packageName: "@x/y",
      packageVersion: "1.0.0",
      name: "Test Agent",
      description: "A test agent",
    };
    const fakeVersion = {
      id: "ver-1",
      templateId: "tmpl-1",
      versionNumber: "1.0.0",
      contentHash: "abc123",
      snapshot: { riskLevel: "low", toolAccess: [], hasApprovalGates: false },
      createdAt: new Date(),
    };

    vi.doMock("@/lib/auth-session", () => ({
      requireAdminSession: vi.fn(async () => ({ user: { id: "admin-1" } })),
    }));
    vi.doMock("@cinatra-ai/agents/store", () => ({
      readAgentTemplateOrigin: vi.fn(async () => ({
        packageName: "@x/y",
        version: "1.0.0",
        destinationId: "dest-01",
        scope: "@x",
        visibility: "private" as const,
        registryUrl: "https://private.example.com",
      })),
      readAgentTemplateByPackageName: vi.fn(async () => fakeTemplate),
      readAgentVersionsByTemplate: vi.fn(async () => [fakeVersion]),
      updateAgentTemplateVisibility: updateMock,
    }));
    vi.doMock("@cinatra-ai/extensions/destination-resolver", () => ({
      resolvePublishDestination: resolveMock,
    }));
    vi.doMock("@cinatra-ai/agents/verdaccio/client", () => ({
      publishAgentPackage: publishMock,
    }));
    vi.doMock("@cinatra-ai/agents/verdaccio/publish-metadata", () => ({
      derivePublishMetadataFromSnapshot: vi.fn(() => ({
        riskLevel: "low",
        toolAccess: [],
        hasApprovalGates: false,
      })),
    }));
    vi.doMock("@/lib/authz", () => ({
      logAuditEvent: auditMock,
      POLICY_VERSION: "v1",
    }));

    const { promoteExtensionToPublicAction } = await import("@cinatra-ai/extensions/actions");
    await promoteExtensionToPublicAction({ packageName: "@x/y", packageVersion: "1.0.0" });

    expect(resolveMock).toHaveBeenCalledWith("public");
    expect(publishMock).toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledWith("@x/y", "public", "https://registry.cinatra.ai");
    expect(auditMock).toHaveBeenCalled();
    const auditPayload = auditMock.mock.calls[0][0];
    expect(auditPayload.resourceType).toBe("extension_registry");
    expect(auditPayload.operation).toBe("promote");
    expect(auditPayload.metadata.from_visibility).toBe("private");
    expect(auditPayload.metadata.to_visibility).toBe("public");
    expect(auditPayload.metadata.package_name).toBe("@x/y");
    expect(auditPayload.metadata.package_version).toBe("1.0.0");
  });

  it("audit log failure does NOT roll back the promotion (fire-and-forget)", async () => {
    const updateMock = vi.fn();
    const publishMock = vi.fn(async () => ({
      packageName: "@x/y",
      packageVersion: "1.0.0",
      registryUrl: "https://registry.cinatra.ai",
      published: true,
      alreadyPublished: false,
    }));
    const resolveMock = vi.fn(async () => ({
      registryUrl: "https://registry.cinatra.ai",
      packageScope: "@x",
      token: "tok",
      uiUrl: "https://registry.cinatra.ai",
    }));
    // Audit log throws, but `void logAuditEvent(...)` MUST NOT propagate the error.
    const auditMock = vi.fn(() => {
      throw new Error("audit DB down");
    });
    const fakeTemplate = {
      id: "tmpl-1",
      packageName: "@x/y",
      packageVersion: "1.0.0",
      name: "Test Agent",
      description: "A test agent",
    };
    const fakeVersion = {
      id: "ver-1",
      templateId: "tmpl-1",
      versionNumber: "1.0.0",
      contentHash: "abc123",
      snapshot: { riskLevel: "low", toolAccess: [], hasApprovalGates: false },
      createdAt: new Date(),
    };

    vi.doMock("@/lib/auth-session", () => ({
      requireAdminSession: vi.fn(async () => ({ user: { id: "admin-1" } })),
    }));
    vi.doMock("@cinatra-ai/agents/store", () => ({
      readAgentTemplateOrigin: vi.fn(async () => ({
        packageName: "@x/y",
        version: "1.0.0",
        destinationId: "dest-01",
        scope: "@x",
        visibility: "private" as const,
        registryUrl: "https://private.example.com",
      })),
      readAgentTemplateByPackageName: vi.fn(async () => fakeTemplate),
      readAgentVersionsByTemplate: vi.fn(async () => [fakeVersion]),
      updateAgentTemplateVisibility: updateMock,
    }));
    vi.doMock("@cinatra-ai/extensions/destination-resolver", () => ({
      resolvePublishDestination: resolveMock,
    }));
    vi.doMock("@cinatra-ai/agents/verdaccio/client", () => ({
      publishAgentPackage: publishMock,
    }));
    vi.doMock("@cinatra-ai/agents/verdaccio/publish-metadata", () => ({
      derivePublishMetadataFromSnapshot: vi.fn(() => ({
        riskLevel: "low",
        toolAccess: [],
        hasApprovalGates: false,
      })),
    }));
    vi.doMock("@/lib/authz", () => ({ logAuditEvent: auditMock, POLICY_VERSION: "v1" }));

    const { promoteExtensionToPublicAction } = await import("@cinatra-ai/extensions/actions");
    // Promotion completes; audit error is swallowed by `void`.
    await expect(
      promoteExtensionToPublicAction({ packageName: "@x/y", packageVersion: "1.0.0" }),
    ).resolves.not.toThrow();
    expect(updateMock).toHaveBeenCalled();
  });
});
