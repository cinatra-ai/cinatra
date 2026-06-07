import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit tests for materializeArtifactFromTemplate. Mocks the heavy
// createSemanticArtifact + postgres-sync paths because this suite focuses on
// manifest lookup, MIME/template defaulting, and authoring_skill assertion writes.

const { listArtifactsMock, registerAllObjectTypesMock, createSemanticArtifactMock, assertSemanticTypeMock } = vi.hoisted(() => ({
  listArtifactsMock: vi.fn(),
  registerAllObjectTypesMock: vi.fn(),
  createSemanticArtifactMock: vi.fn(),
  assertSemanticTypeMock: vi.fn(),
}));

vi.mock("@cinatra-ai/objects/registry", () => ({
  objectTypeRegistry: { listArtifacts: listArtifactsMock },
}));
vi.mock("@/lib/register-all-object-types", () => ({
  registerAllObjectTypes: registerAllObjectTypesMock,
}));
vi.mock("../artifact-creation", () => ({
  createSemanticArtifact: createSemanticArtifactMock,
}));
vi.mock("../semantic-assertion-store", () => ({
  assertSemanticType: assertSemanticTypeMock,
}));

import { materializeArtifactFromTemplate } from "../artifact-template";
import type { ActorContext } from "@/lib/authz/actor-context";

const ACTOR: ActorContext = {
  principalType: "HumanUser",
  principalId: "user-1",
  organizationId: "org-a",
  teamIds: [],
  projectIds: [],
  authSource: "ui",
  policyVersion: "v2",
};

function makeDef(extension: string, mimeTypes: string[]) {
  return {
    type: `${extension}:artifact`,
    isArtifact: {
      accepts: { file: { mimeTypes } },
    },
  };
}

describe("materializeArtifactFromTemplate", () => {
  beforeEach(() => {
    listArtifactsMock.mockReset();
    registerAllObjectTypesMock.mockReset();
    createSemanticArtifactMock.mockReset();
    assertSemanticTypeMock.mockReset();
    createSemanticArtifactMock.mockResolvedValue({
      objectId: "art-1",
      artifactId: "art-1",
      resourceId: "res-1",
      representationRevisionId: "rep-1",
      representationRevision: 1,
      ref: { artifactId: "art-1", representationRevisionId: "rep-1" },
    });
    assertSemanticTypeMock.mockReturnValue({ inserted: true });
  });

  it("returns extension-not-found when the registry has no matching type", async () => {
    listArtifactsMock.mockReturnValue([]);
    const res = await materializeArtifactFromTemplate({
      orgId: "org-a",
      actor: ACTOR,
      extension: "@cinatra-ai/marketing-icp-artifact",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("extension-not-found");
  });

  it("returns extension-not-file-form when manifest has no file.mimeTypes", async () => {
    listArtifactsMock.mockReturnValue([
      {
        type: "@cinatra-ai/dashboard-only-artifact:artifact",
        isArtifact: { accepts: { dashboard: true } },
      },
    ]);
    const res = await materializeArtifactFromTemplate({
      orgId: "org-a",
      actor: ACTOR,
      extension: "@cinatra-ai/dashboard-only-artifact",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("extension-not-file-form");
  });

  it("warms the artifact registry before listing (boot-order resilience)", async () => {
    listArtifactsMock.mockReturnValue([]);
    await materializeArtifactFromTemplate({
      orgId: "org-a",
      actor: ACTOR,
      extension: "@cinatra-ai/x-artifact",
    });
    expect(registerAllObjectTypesMock).toHaveBeenCalled();
  });

  it("materializes with the first text-compatible MIME and calls assertSemanticType", async () => {
    listArtifactsMock.mockReturnValue([
      makeDef("@cinatra-ai/marketing-icp-artifact", [
        "text/markdown",
        "text/plain",
      ]),
    ]);
    const res = await materializeArtifactFromTemplate({
      orgId: "org-a",
      actor: ACTOR,
      extension: "@cinatra-ai/marketing-icp-artifact",
      title: "ACME Corp ICP",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.artifactId).toBe("art-1");
    expect(res.representationRevisionId).toBe("rep-1");

    // createSemanticArtifact called with the first text-compatible
    // MIME + upload origin + org-level ownership.
    expect(createSemanticArtifactMock).toHaveBeenCalledTimes(1);
    const call = createSemanticArtifactMock.mock.calls[0][0];
    expect(call.declaredMime).toBe("text/markdown");
    // origin is "upload", the closest existing kind for a user-initiated
    // create; use "agent_generated" only when an agent ran.
    expect(call.originKind).toBe("upload");
    expect(call.ownerLevel).toBe("organization");
    expect(call.ownerId).toBe("org-a");
    expect(call.title).toBe("ACME Corp ICP");

    // assertSemanticType handles the assertion write so the floor rebalance
    // and Graphiti outbox refresh run atomically. assertedBy is "user"
    // because no skill participates in this UI-created artifact.
    expect(assertSemanticTypeMock).toHaveBeenCalledTimes(1);
    expect(assertSemanticTypeMock).toHaveBeenCalledWith({
      orgId: "org-a",
      artifactId: "art-1",
      extension: "@cinatra-ai/marketing-icp-artifact",
      assertedBy: "user",
      principal: "user-1",
    });
  });

  it("rejects binary-only extensions (image/PDF) with no-text-template-mime", async () => {
    listArtifactsMock.mockReturnValue([
      makeDef("@cinatra-ai/screenshot-artifact", [
        "image/png",
        "image/jpeg",
        "image/webp",
      ]),
    ]);
    const res = await materializeArtifactFromTemplate({
      orgId: "org-a",
      actor: ACTOR,
      extension: "@cinatra-ai/screenshot-artifact",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("no-text-template-mime");
  });

  it("rejects PDF-only extensions with no-text-template-mime", async () => {
    listArtifactsMock.mockReturnValue([
      makeDef("@cinatra-ai/slide-deck-artifact", ["application/pdf"]),
    ]);
    const res = await materializeArtifactFromTemplate({
      orgId: "org-a",
      actor: ACTOR,
      extension: "@cinatra-ai/slide-deck-artifact",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("no-text-template-mime");
  });

  it("returns structured template-path-not-supported when manifest declares a template path", async () => {
    listArtifactsMock.mockReturnValue([
      {
        type: "@cinatra-ai/future-artifact:artifact",
        isArtifact: {
          accepts: { file: { mimeTypes: ["text/markdown"] } },
          templates: [
            {
              id: "default",
              form: "file",
              mimeType: "text/markdown",
              path: "./templates/default.md",
              default: true,
            },
          ],
        },
      },
    ]);
    const res = await materializeArtifactFromTemplate({
      orgId: "org-a",
      actor: ACTOR,
      extension: "@cinatra-ai/future-artifact",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("template-path-not-supported");
    expect(res.message).toMatch(/file template/i);
  });

  it("prefers text-compatible MIME even when binary forms come first in accepts", async () => {
    // Hypothetical extension that accepts PDF + markdown should pick markdown.
    listArtifactsMock.mockReturnValue([
      makeDef("@cinatra-ai/contract-artifact", [
        "application/pdf",
        "text/markdown",
      ]),
    ]);
    await materializeArtifactFromTemplate({
      orgId: "org-a",
      actor: ACTOR,
      extension: "@cinatra-ai/contract-artifact",
    });
    expect(createSemanticArtifactMock.mock.calls[0][0].declaredMime).toBe(
      "text/markdown",
    );
  });

  it("defaults title to the extension short label when not provided", async () => {
    listArtifactsMock.mockReturnValue([
      makeDef("@cinatra-ai/marketing-icp-artifact", ["text/markdown"]),
    ]);
    await materializeArtifactFromTemplate({
      orgId: "org-a",
      actor: ACTOR,
      extension: "@cinatra-ai/marketing-icp-artifact",
    });
    expect(createSemanticArtifactMock.mock.calls[0][0].title).toBe(
      "marketing-icp starter",
    );
  });
});
