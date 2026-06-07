/**
 * Artifact-authoring service unit tests.
 *
 *   npx vitest run src/lib/artifacts/__tests__/artifact-authoring.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  listArtifactsMock,
  registerAllObjectTypesMock,
  createSemanticArtifactMock,
  assertSemanticTypeMock,
  recordAuthoringInvocationMock,
  markCommittedMock,
  markAbortedMock,
  tombstoneArtifactMock,
} = vi.hoisted(() => ({
  listArtifactsMock: vi.fn(),
  registerAllObjectTypesMock: vi.fn(),
  createSemanticArtifactMock: vi.fn(),
  assertSemanticTypeMock: vi.fn(),
  recordAuthoringInvocationMock: vi.fn(),
  markCommittedMock: vi.fn(),
  markAbortedMock: vi.fn(),
  tombstoneArtifactMock: vi.fn(),
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
vi.mock("../authoring-recursion-ledger", () => ({
  recordAuthoringInvocation: recordAuthoringInvocationMock,
  markAuthoringInvocationCommitted: markCommittedMock,
  markAuthoringInvocationAborted: markAbortedMock,
  getAuthoringChain: vi.fn(),
}));
vi.mock("../artifact-service", () => ({
  tombstoneArtifact: tombstoneArtifactMock,
}));
// The uniform extension-access gate reads installed_extension (DB). These
// tests exercise search scoring / manifest shape, not access — allow all.
vi.mock("../artifact-extension-access", () => ({
  canAccessArtifactExtension: async () => true,
}));

import {
  authorArtifact,
  searchArtifactExtensions,
  getArtifactExtension,
} from "../artifact-authoring";
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

function makeIcpDef() {
  return {
    type: "@cinatra-ai/marketing-icp-artifact:artifact",
    isArtifact: {
      accepts: {
        file: { mimeTypes: ["text/markdown", "text/plain"] },
      },
      skills: {
        authoring: [
          "@cinatra-ai/marketing-icp-artifact:marketing-icp-author",
        ],
        matchers: [
          "@cinatra-ai/marketing-icp-artifact:marketing-icp-matcher",
        ],
      },
    },
  };
}

function makeBinaryDef() {
  return {
    type: "@cinatra-ai/screenshot-artifact:artifact",
    isArtifact: {
      accepts: {
        file: { mimeTypes: ["image/png", "image/jpeg"] },
      },
      skills: {
        authoring: ["@cinatra-ai/screenshot-artifact:author"],
      },
    },
  };
}

function makeNoAuthoringDef() {
  // An extension that has matchers but NO authoring skill must be refused
  // to block the self-classification smuggle path.
  return {
    type: "@cinatra-ai/brand-voice-artifact:artifact",
    isArtifact: {
      accepts: {
        file: { mimeTypes: ["text/markdown"] },
      },
      skills: {
        matchers: ["@cinatra-ai/brand-voice-artifact:brand-voice-matcher"],
      },
    },
  };
}

describe("authorArtifact — happy path", () => {
  beforeEach(() => {
    listArtifactsMock.mockReset();
    registerAllObjectTypesMock.mockReset();
    createSemanticArtifactMock.mockReset();
    assertSemanticTypeMock.mockReset();
    recordAuthoringInvocationMock.mockReset();
    markCommittedMock.mockReset();
    markAbortedMock.mockReset();
    tombstoneArtifactMock.mockReset();
    createSemanticArtifactMock.mockResolvedValue({
      objectId: "art-1",
      artifactId: "art-1",
      resourceId: "res-1",
      representationRevisionId: "rep-1",
      representationRevision: 1,
      ref: { artifactId: "art-1", representationRevisionId: "rep-1" },
    });
    assertSemanticTypeMock.mockReturnValue({ inserted: true });
    recordAuthoringInvocationMock.mockReturnValue({
      ok: true,
      stepId: "aut_root",
      depth: 0,
    });
  });

  it("emits the artifact, types it 'authoring_skill', and commits the ledger", async () => {
    listArtifactsMock.mockReturnValue([makeIcpDef()]);
    const res = await authorArtifact({
      orgId: "org-a",
      actor: ACTOR,
      extension: "@cinatra-ai/marketing-icp-artifact",
      content: "# ACME Corp ICP\n\nAt least one paragraph of real content.",
      declaredMime: "text/markdown",
      title: "ACME Corp ICP",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.artifactId).toBe("art-1");
    expect(res.depth).toBe(0);
    expect(res.authoringStepId).toBe("aut_root");

    // assertedBy is server-decided and must be "authoring_skill".
    expect(assertSemanticTypeMock).toHaveBeenCalledWith({
      orgId: "org-a",
      artifactId: "art-1",
      extension: "@cinatra-ai/marketing-icp-artifact",
      assertedBy: "authoring_skill",
      principal: "user-1",
    });

    // Authoring writes skip fallback classification.
    expect(createSemanticArtifactMock).toHaveBeenCalledTimes(1);
    const createCall = createSemanticArtifactMock.mock.calls[0][0];
    expect(createCall.skipFallbackClassification).toBe(true);
    // originKind reuses the existing agent-generated enum value.
    expect(createCall.originKind).toBe("agent_generated");

    // The ledger was opened and committed, not aborted.
    expect(recordAuthoringInvocationMock).toHaveBeenCalledTimes(1);
    expect(markCommittedMock).toHaveBeenCalledWith("org-a", "aut_root");
    expect(markAbortedMock).not.toHaveBeenCalled();
  });
});

describe("authorArtifact — validation failures (NO ledger / NO write)", () => {
  beforeEach(() => {
    listArtifactsMock.mockReset();
    registerAllObjectTypesMock.mockReset();
    createSemanticArtifactMock.mockReset();
    assertSemanticTypeMock.mockReset();
    recordAuthoringInvocationMock.mockReset();
    markCommittedMock.mockReset();
    markAbortedMock.mockReset();
    tombstoneArtifactMock.mockReset();
  });

  it("rejects with extension-not-found", async () => {
    listArtifactsMock.mockReturnValue([]);
    const res = await authorArtifact({
      orgId: "org-a",
      actor: ACTOR,
      extension: "@cinatra-ai/nonexistent-artifact",
      content: "x",
      declaredMime: "text/markdown",
      title: "X",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("extension-not-found");
    // No ledger, no write.
    expect(recordAuthoringInvocationMock).not.toHaveBeenCalled();
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
  });

  it("rejects with mime-not-accepted when declaredMime is not in manifest", async () => {
    listArtifactsMock.mockReturnValue([makeIcpDef()]);
    const res = await authorArtifact({
      orgId: "org-a",
      actor: ACTOR,
      extension: "@cinatra-ai/marketing-icp-artifact",
      content: "x",
      declaredMime: "application/pdf", // ICP manifest does NOT include pdf in this fixture
      title: "X",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("mime-not-accepted");
    expect(recordAuthoringInvocationMock).not.toHaveBeenCalled();
  });

  it("rejects binary-only extensions with mime-not-accepted when input MIME is text", async () => {
    listArtifactsMock.mockReturnValue([makeBinaryDef()]);
    const res = await authorArtifact({
      orgId: "org-a",
      actor: ACTOR,
      extension: "@cinatra-ai/screenshot-artifact",
      content: "x",
      declaredMime: "text/markdown",
      title: "X",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("mime-not-accepted");
  });

  it("rejects binary MIME with mime-not-text-authorable for a text-content/binary-MIME smuggle", async () => {
    listArtifactsMock.mockReturnValue([makeBinaryDef()]);
    const res = await authorArtifact({
      orgId: "org-a",
      actor: ACTOR,
      extension: "@cinatra-ai/screenshot-artifact",
      content: "this is text",
      declaredMime: "image/png", // binary mime + text content — refused
      title: "X",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("mime-not-text-authorable");
    expect(recordAuthoringInvocationMock).not.toHaveBeenCalled();
  });

  it("refuses extensions with no authoring skill to block self-classification smuggling", async () => {
    listArtifactsMock.mockReturnValue([makeNoAuthoringDef()]);
    const res = await authorArtifact({
      orgId: "org-a",
      actor: ACTOR,
      extension: "@cinatra-ai/brand-voice-artifact",
      content: "x",
      declaredMime: "text/markdown",
      title: "X",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("extension-has-no-authoring-skill");
    expect(recordAuthoringInvocationMock).not.toHaveBeenCalled();
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
  });

  it("rejects with content-too-large when content exceeds 10MB cap", async () => {
    listArtifactsMock.mockReturnValue([makeIcpDef()]);
    const large = "x".repeat(10 * 1024 * 1024 + 1);
    const res = await authorArtifact({
      orgId: "org-a",
      actor: ACTOR,
      extension: "@cinatra-ai/marketing-icp-artifact",
      content: large,
      declaredMime: "text/markdown",
      title: "X",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("content-too-large");
    if (res.reason !== "content-too-large") return;
    expect(res.bytes).toBeGreaterThan(10 * 1024 * 1024);
    expect(res.capBytes).toBe(10 * 1024 * 1024);
    expect(recordAuthoringInvocationMock).not.toHaveBeenCalled();
  });
});

describe("authorArtifact — ledger refusals", () => {
  beforeEach(() => {
    listArtifactsMock.mockReset();
    registerAllObjectTypesMock.mockReset();
    createSemanticArtifactMock.mockReset();
    assertSemanticTypeMock.mockReset();
    recordAuthoringInvocationMock.mockReset();
    markCommittedMock.mockReset();
    markAbortedMock.mockReset();
    tombstoneArtifactMock.mockReset();
  });

  it("refuses on cycle (does NOT write artifact)", async () => {
    listArtifactsMock.mockReturnValue([makeIcpDef()]);
    recordAuthoringInvocationMock.mockReturnValue({
      ok: false,
      reason: "cycle",
      chain: [],
      detail: "@cinatra-ai/marketing-icp-artifact already in chain at depth 0",
    });
    const res = await authorArtifact({
      orgId: "org-a",
      actor: ACTOR,
      extension: "@cinatra-ai/marketing-icp-artifact",
      content: "x",
      declaredMime: "text/markdown",
      title: "X",
      parentStepId: "aut_parent",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("cycle");
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
    expect(markCommittedMock).not.toHaveBeenCalled();
  });

  it("refuses on depth-cap-exceeded (does NOT write artifact)", async () => {
    listArtifactsMock.mockReturnValue([makeIcpDef()]);
    recordAuthoringInvocationMock.mockReturnValue({
      ok: false,
      reason: "depth-cap-exceeded",
      chain: [],
      detail: "attempted depth 9 exceeds cap 8",
    });
    const res = await authorArtifact({
      orgId: "org-a",
      actor: ACTOR,
      extension: "@cinatra-ai/marketing-icp-artifact",
      content: "x",
      declaredMime: "text/markdown",
      title: "X",
      parentStepId: "aut_deep",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("depth-cap-exceeded");
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
  });

  it("refuses on parent-not-found for a dangling parentStepId", async () => {
    listArtifactsMock.mockReturnValue([makeIcpDef()]);
    recordAuthoringInvocationMock.mockReturnValue({
      ok: false,
      reason: "parent-not-found",
      chain: [],
      detail: 'parentStepId "aut_spoofed" did not resolve',
    });
    const res = await authorArtifact({
      orgId: "org-a",
      actor: ACTOR,
      extension: "@cinatra-ai/marketing-icp-artifact",
      content: "x",
      declaredMime: "text/markdown",
      title: "X",
      parentStepId: "aut_spoofed",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("parent-not-found");
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
  });
});

describe("authorArtifact — abort on infra failure", () => {
  beforeEach(() => {
    listArtifactsMock.mockReset();
    registerAllObjectTypesMock.mockReset();
    createSemanticArtifactMock.mockReset();
    assertSemanticTypeMock.mockReset();
    recordAuthoringInvocationMock.mockReset();
    markCommittedMock.mockReset();
    markAbortedMock.mockReset();
    tombstoneArtifactMock.mockReset();
    recordAuthoringInvocationMock.mockReturnValue({
      ok: true,
      stepId: "aut_root",
      depth: 0,
    });
  });

  it("marks ledger aborted when createSemanticArtifact throws", async () => {
    listArtifactsMock.mockReturnValue([makeIcpDef()]);
    createSemanticArtifactMock.mockRejectedValue(new Error("blob store down"));
    await expect(
      authorArtifact({
        orgId: "org-a",
        actor: ACTOR,
        extension: "@cinatra-ai/marketing-icp-artifact",
        content: "x",
        declaredMime: "text/markdown",
        title: "X",
      }),
    ).rejects.toThrow(/blob store down/);
    expect(markAbortedMock).toHaveBeenCalledWith("org-a", "aut_root");
    expect(markCommittedMock).not.toHaveBeenCalled();
  });

  it("marks ledger aborted AND tombstones the orphan artifact when assertSemanticType throws", async () => {
    listArtifactsMock.mockReturnValue([makeIcpDef()]);
    createSemanticArtifactMock.mockResolvedValue({
      objectId: "art-x",
      artifactId: "art-x",
      resourceId: "res-x",
      representationRevisionId: "rep-x",
      representationRevision: 1,
      ref: { artifactId: "art-x", representationRevisionId: "rep-x" },
    });
    assertSemanticTypeMock.mockImplementation(() => {
      throw new Error("assertion service down");
    });
    await expect(
      authorArtifact({
        orgId: "org-a",
        actor: ACTOR,
        extension: "@cinatra-ai/marketing-icp-artifact",
        content: "x",
        declaredMime: "text/markdown",
        title: "X",
      }),
    ).rejects.toThrow(/assertion service down/);
    expect(markAbortedMock).toHaveBeenCalledWith("org-a", "aut_root");
    expect(markCommittedMock).not.toHaveBeenCalled();
    expect(tombstoneArtifactMock).toHaveBeenCalledWith({
      artifactId: "art-x",
      orgId: "org-a",
      actor: ACTOR,
      auditActor: "user-1",
    });
  });

  it("tombstone-failure does NOT mask the original assertion error", async () => {
    listArtifactsMock.mockReturnValue([makeIcpDef()]);
    createSemanticArtifactMock.mockResolvedValue({
      objectId: "art-y",
      artifactId: "art-y",
      resourceId: "res-y",
      representationRevisionId: "rep-y",
      representationRevision: 1,
      ref: { artifactId: "art-y", representationRevisionId: "rep-y" },
    });
    assertSemanticTypeMock.mockImplementation(() => {
      throw new Error("primary: assertion failure");
    });
    tombstoneArtifactMock.mockImplementation(() => {
      throw new Error("secondary: tombstone failure");
    });
    await expect(
      authorArtifact({
        orgId: "org-a",
        actor: ACTOR,
        extension: "@cinatra-ai/marketing-icp-artifact",
        content: "x",
        declaredMime: "text/markdown",
        title: "X",
      }),
    ).rejects.toThrow(/primary: assertion failure/);
  });
});

describe("searchArtifactExtensions", () => {
  beforeEach(() => {
    listArtifactsMock.mockReset();
    registerAllObjectTypesMock.mockReset();
  });

  it("ranks marketing-icp first for query 'icp'", async () => {
    listArtifactsMock.mockReturnValue([
      makeIcpDef(),
      {
        type: "@cinatra-ai/brand-voice-artifact:artifact",
        isArtifact: {
          accepts: { file: { mimeTypes: ["text/markdown"] } },
          skills: {},
        },
      },
    ]);
    const results = await searchArtifactExtensions({ query: "icp" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].packageName).toBe(
      "@cinatra-ai/marketing-icp-artifact",
    );
    expect(results[0].hasAuthoringSkill).toBe(true);
  });

  it("returns empty array for nonsense query", async () => {
    listArtifactsMock.mockReturnValue([makeIcpDef()]);
    const results = await searchArtifactExtensions({ query: "zzzzznothere" });
    expect(results).toEqual([]);
  });

  it("supports multi-token queries (matches on any token)", async () => {
    listArtifactsMock.mockReturnValue([
      makeIcpDef(),
      {
        type: "@cinatra-ai/brand-voice-artifact:artifact",
        isArtifact: {
          accepts: { file: { mimeTypes: ["text/markdown"] } },
          skills: {},
        },
      },
    ]);
    const results = await searchArtifactExtensions({ query: "brand voice" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].packageName).toBe(
      "@cinatra-ai/brand-voice-artifact",
    );
  });
});

describe("getArtifactExtension", () => {
  beforeEach(() => {
    listArtifactsMock.mockReset();
    registerAllObjectTypesMock.mockReset();
  });

  it("returns the manifest view for an installed extension", async () => {
    listArtifactsMock.mockReturnValue([makeIcpDef()]);
    const view = await getArtifactExtension(
      "@cinatra-ai/marketing-icp-artifact",
    );
    expect(view).not.toBeNull();
    if (!view) return;
    expect(view.label).toBe("marketing-icp");
    expect(view.authoringSkillIds).toEqual([
      "@cinatra-ai/marketing-icp-artifact:marketing-icp-author",
    ]);
    expect(view.matcherSkillIds.length).toBe(1);
    expect(view.acceptedMimes).toContain("text/markdown");
    expect(view.agentDependencies).toEqual([]);
  });

  it("returns null for a not-installed extension", async () => {
    listArtifactsMock.mockReturnValue([]);
    const view = await getArtifactExtension(
      "@cinatra-ai/nonexistent-artifact",
    );
    expect(view).toBeNull();
  });
});
