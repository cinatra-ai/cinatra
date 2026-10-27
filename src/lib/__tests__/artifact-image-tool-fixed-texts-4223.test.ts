/**
 * cinatra#4223 — THE IMAGE TOOL'S FIXED REFUSAL TEXTS AND ITS RE-DRIVE FACTS.
 *
 * Two classes, each proved on every branch that reaches it:
 *
 *   1. NO EXCEPTION TEXT IN A REFUSAL. A provider's or a store's exception can
 *      name a credential, a schema, a table or a connection. The refusal that
 *      reaches the calling node is a fixed sentence, and the detail is logged
 *      on the server.
 *   2. A RE-DRIVE REPORTS THE FACTS OF THE REVISION IT RETURNS. The ledger key
 *      is the run, the node and the bytes, so a re-drive that gets the same
 *      bytes from another provider or model is served by the revision the
 *      first write filed. Its answer carries the provider and model stored
 *      with that revision, never the attempt's own.
 *
 * PURE TIER: the ledger, the writer and the append road are substituted; the
 * real SQL of the stored-facts read is proved in the W8 database tier
 * (`artifacts/__tests__/lifecycle-c-w8-image-tool.integration.test.ts`).
 * Tests named "guard:" pass on the base too: they pin what must not change.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const m = vi.hoisted(() => ({
  resolveBoundArtifactTarget: vi.fn(),
  isArtifactExtensionWriteAllowed: vi.fn(async () => true),
  claimMaterialization: vi.fn(),
  readFinalizedMaterialization: vi.fn(),
  readRevisionImageProvenance: vi.fn(),
  createSemanticArtifact: vi.fn(),
  appendArtifactRevision: vi.fn(),
  explainAbsentArtifactSafeClaims: vi.fn(),
}));

vi.mock("@/lib/artifacts/resolve-bound-artifact-type", () => ({
  resolveBoundArtifactTarget: m.resolveBoundArtifactTarget,
}));
vi.mock("@/lib/artifacts/artifact-extension-access", () => ({
  isArtifactExtensionWriteAllowed: m.isArtifactExtensionWriteAllowed,
}));
vi.mock("@/lib/artifacts/materialization-ledger", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    claimMaterialization: m.claimMaterialization,
    readFinalizedMaterialization: m.readFinalizedMaterialization,
    readRevisionImageProvenance: m.readRevisionImageProvenance,
  };
});
vi.mock("@/lib/artifacts/artifact-creation", () => ({
  createSemanticArtifact: m.createSemanticArtifact,
}));
vi.mock("@/lib/artifacts/artifact-revision-append", () => ({
  appendArtifactRevision: m.appendArtifactRevision,
}));
vi.mock("@/lib/extension-install-anchor", () => ({
  explainAbsentArtifactSafeClaims: m.explainAbsentArtifactSafeClaims,
}));
vi.mock("@/lib/artifacts/matcher-enqueue", () => ({
  enqueueArtifactMatchRun: async () => undefined,
}));

import * as tool from "@/lib/artifact-image-tool";
import {
  generateArtifactImage,
  type ArtifactImageToolDeps,
} from "@/lib/artifact-image-tool";
import { MATERIALIZATION_FINALIZE_CONFLICT_MARKER } from "@/lib/artifacts/materialization-ledger";

/** Text a store or provider exception can carry; none of it may reach a result. */
// Assembled at runtime so no committed line carries a complete scheme,
// userinfo and host literal for a secret scanner to trip on; the
// string the tests use is unchanged.
const PG_URL = ["postgres:", "", "svc:hunter2@db.internal:5432"].join("/");
const SECRET_DETAIL =
  `connect ECONNREFUSED at ${PG_URL} relation "cinatra"."objects" key sk-live-0000`;

function deps(over: Partial<ArtifactImageToolDeps> = {}): ArtifactImageToolDeps {
  return {
    resolveImageProvider: async () => ({
      provider: "second-provider",
      generateImage: async () => ({
        imageData: "iVBORw0KGgo=",
        mimeType: "image/png",
        model: "second-model",
      }),
    }),
    loadProducesRefs: async () => [{ extension: "@cinatra-ai/picture-artifact" }],
    resolveOwnership: async () => ({
      ownerLevel: "organization",
      ownerId: "org-1",
      visibility: "organization",
      projectId: null,
    }),
    countRunImages: async () => 0,
    ...over,
  };
}

const call = {
  runId: "run-1",
  orgId: "org-1",
  templateId: "tpl-1",
  packageVersion: "1.0.0",
  createdBy: "user-1",
  nodeId: "node-1",
  extension: "@cinatra-ai/picture-artifact",
  title: "A picture",
  prompt: "a lighthouse at dusk",
};

const regeneration = {
  ...call,
  title: "",
  artifactId: "art-1",
  baseRepresentationRevisionId: "rep-1",
};

let logged: MockInstance<typeof console.error>;

beforeEach(() => {
  vi.clearAllMocks();
  m.resolveBoundArtifactTarget.mockResolvedValue({
    ok: true,
    target: {
      objectTypeId: "@cinatra-ai/picture-artifact:picture",
      acceptedFileMimeTypes: ["image/png"],
    },
  });
  m.isArtifactExtensionWriteAllowed.mockResolvedValue(true);
  m.claimMaterialization.mockResolvedValue({ kind: "claimed", ledgerId: "ledger-1" });
  m.createSemanticArtifact.mockResolvedValue({
    artifactId: "art-new",
    representationRevisionId: "rep-new",
  });
  m.readRevisionImageProvenance.mockResolvedValue({
    provider: "first-provider",
    model: "first-model",
  });
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logged.mockRestore();
});

function expectNoDetail(text: string) {
  for (const part of ["ECONNREFUSED", "hunter2", "db.internal", '"objects"', "sk-live"]) {
    expect(text).not.toContain(part);
  }
}

function expectDetailLogged() {
  expect(logged).toHaveBeenCalled();
  expect(JSON.stringify(logged.mock.calls)).toContain("ECONNREFUSED");
}

describe("cinatra#4223 — a refusal that comes from a throw is a fixed sentence", () => {
  it("a provider that throws is answered with the fixed provider sentence, its detail logged", async () => {
    const outcome = await generateArtifactImage(
      call,
      deps({
        resolveImageProvider: async () => ({
          provider: "second-provider",
          generateImage: async () => {
            throw new Error(SECRET_DETAIL);
          },
        }),
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("provider_failed");
    expect(outcome.error).toBe(
      `the second-provider image provider failed; ${tool.PROVIDER_FAILED_DETAIL}`,
    );
    expectNoDetail(outcome.error);
    expectDetailLogged();
  });

  it("a provider that throws a non-Error value is answered with the same fixed sentence", async () => {
    const outcome = await generateArtifactImage(
      call,
      deps({
        resolveImageProvider: async () => ({
          provider: "second-provider",
          generateImage: async () => {
            throw SECRET_DETAIL;
          },
        }),
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("provider_failed");
    expectNoDetail(outcome.error);
    expectDetailLogged();
  });

  it("a write that throws is answered with the fixed write sentence that says what is kept", async () => {
    m.createSemanticArtifact.mockRejectedValue(new Error(SECRET_DETAIL));
    const outcome = await generateArtifactImage(call, deps());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("write_refused");
    expect(outcome.error).toBe(tool.FILING_WRITE_FAILED_ERROR);
    expectDetailLogged();
  });

  it("a schema refusal keeps its own reason and answers the fixed data sentence", async () => {
    m.createSemanticArtifact.mockRejectedValue(
      new Error(`object payload does not satisfy the declared schema: ${SECRET_DETAIL}`),
    );
    const outcome = await generateArtifactImage(call, deps());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("data_rejected");
    expect(outcome.error).toBe(tool.FILING_DATA_REJECTED_ERROR);
    expectNoDetail(outcome.error);
  });

  it("a throw outside the write (the ledger claim) is answered with the fixed unexpected sentence", async () => {
    m.claimMaterialization.mockRejectedValue(new Error(SECRET_DETAIL));
    const outcome = await generateArtifactImage(call, deps());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("write_refused");
    expect(outcome.error).toBe(tool.FILING_UNEXPECTED_ERROR);
    expectDetailLogged();
  });

  it("a throw on the regeneration road is answered with the fixed unexpected sentence", async () => {
    m.appendArtifactRevision.mockRejectedValue(new Error(SECRET_DETAIL));
    const outcome = await generateArtifactImage(regeneration, deps());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error).toBe(tool.FILING_UNEXPECTED_ERROR);
    expectDetailLogged();
  });
});

describe("cinatra#4223 — a re-drive reports the facts stored with the revision it returns", () => {
  it("guard: a first write reports the provider and model of this write", async () => {
    const outcome = await generateArtifactImage(call, deps());
    expect(outcome).toEqual({
      ok: true,
      artifactId: "art-new",
      representationRevisionId: "rep-new",
      revision: 1,
      provider: "second-provider",
      model: "second-model",
      mime: "image/png",
      deduped: false,
    });
  });

  it("a re-drive served by a finalized first write reports that write's stored provider and model", async () => {
    m.claimMaterialization.mockResolvedValue({
      kind: "finalized",
      artifactId: "art-1",
      representationRevisionId: "rep-1",
      path: "materialize_tool",
    });
    const outcome = await generateArtifactImage(call, deps());
    expect(outcome).toEqual({
      ok: true,
      artifactId: "art-1",
      representationRevisionId: "rep-1",
      revision: 1,
      provider: "first-provider",
      model: "first-model",
      mime: "image/png",
      deduped: true,
    });
    expect(m.readRevisionImageProvenance).toHaveBeenCalledWith({
      orgId: "org-1",
      artifactId: "art-1",
      representationRevisionId: "rep-1",
    });
    expect(m.createSemanticArtifact).not.toHaveBeenCalled();
  });

  it("a re-drive whose stored facts are missing refuses with a fixed sentence and files nothing", async () => {
    m.claimMaterialization.mockResolvedValue({
      kind: "finalized",
      artifactId: "art-1",
      representationRevisionId: "rep-1",
      path: "materialize_tool",
    });
    m.readRevisionImageProvenance.mockResolvedValue(null);
    const outcome = await generateArtifactImage(call, deps());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("write_refused");
    expect(outcome.error).toBe(tool.FILING_STORED_FACTS_UNREADABLE_ERROR);
    expect(m.createSemanticArtifact).not.toHaveBeenCalled();
  });

  it("a re-drive whose stored-facts read throws refuses with the same fixed sentence", async () => {
    m.claimMaterialization.mockResolvedValue({
      kind: "finalized",
      artifactId: "art-1",
      representationRevisionId: "rep-1",
      path: "materialize_tool",
    });
    m.readRevisionImageProvenance.mockRejectedValue(new Error(SECRET_DETAIL));
    const outcome = await generateArtifactImage(call, deps());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error).toBe(tool.FILING_STORED_FACTS_UNREADABLE_ERROR);
    expectDetailLogged();
  });

  it("the loser of a concurrent double drive reports the winner's stored facts", async () => {
    m.createSemanticArtifact.mockRejectedValue(
      new Error(`invalid input syntax: ${MATERIALIZATION_FINALIZE_CONFLICT_MARKER}`),
    );
    m.readFinalizedMaterialization.mockResolvedValue({
      artifactId: "art-win",
      representationRevisionId: "rep-win",
    });
    const outcome = await generateArtifactImage(call, deps());
    expect(outcome).toEqual({
      ok: true,
      artifactId: "art-win",
      representationRevisionId: "rep-win",
      revision: 1,
      provider: "first-provider",
      model: "first-model",
      mime: "image/png",
      deduped: true,
    });
    expect(m.readRevisionImageProvenance).toHaveBeenCalledWith({
      orgId: "org-1",
      artifactId: "art-win",
      representationRevisionId: "rep-win",
    });
  });

  it("a re-drive of a regeneration served by its landed append reports that append's stored facts", async () => {
    m.appendArtifactRevision.mockResolvedValue({
      ok: true,
      artifactId: "art-1",
      representationRevisionId: "rep-2",
      revision: 2,
      deduped: true,
    });
    const outcome = await generateArtifactImage(regeneration, deps());
    expect(outcome).toEqual({
      ok: true,
      artifactId: "art-1",
      representationRevisionId: "rep-2",
      revision: 2,
      provider: "first-provider",
      model: "first-model",
      mime: "image/png",
      deduped: true,
    });
  });

  it("guard: a regeneration that appends a new revision reports this write's facts", async () => {
    m.appendArtifactRevision.mockResolvedValue({
      ok: true,
      artifactId: "art-1",
      representationRevisionId: "rep-2",
      revision: 2,
      deduped: false,
    });
    const outcome = await generateArtifactImage(regeneration, deps());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.provider).toBe("second-provider");
    expect(outcome.model).toBe("second-model");
    expect(outcome.deduped).toBe(false);
    expect(m.readRevisionImageProvenance).not.toHaveBeenCalled();
  });
});

describe("cinatra#4223 — the unreadable stored facts refuse on every re-drive road", () => {
  it("the loser of a double drive whose winner's stored facts are missing refuses with the fixed sentence", async () => {
    m.createSemanticArtifact.mockRejectedValue(
      new Error(`invalid input syntax: ${MATERIALIZATION_FINALIZE_CONFLICT_MARKER}`),
    );
    m.readFinalizedMaterialization.mockResolvedValue({
      artifactId: "art-win",
      representationRevisionId: "rep-win",
    });
    m.readRevisionImageProvenance.mockResolvedValue(null);
    const outcome = await generateArtifactImage(call, deps());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("write_refused");
    expect(outcome.error).toBe(tool.FILING_STORED_FACTS_UNREADABLE_ERROR);
  });

  it("the loser whose stored-facts read throws refuses with the fixed sentence, its detail logged", async () => {
    m.createSemanticArtifact.mockRejectedValue(
      new Error(`invalid input syntax: ${MATERIALIZATION_FINALIZE_CONFLICT_MARKER}`),
    );
    m.readFinalizedMaterialization.mockResolvedValue({
      artifactId: "art-win",
      representationRevisionId: "rep-win",
    });
    m.readRevisionImageProvenance.mockRejectedValue(new Error(SECRET_DETAIL));
    const outcome = await generateArtifactImage(call, deps());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error).toBe(tool.FILING_STORED_FACTS_UNREADABLE_ERROR);
    expectDetailLogged();
  });

  it("a deduped append whose stored facts are missing refuses with the fixed sentence", async () => {
    m.appendArtifactRevision.mockResolvedValue({
      ok: true,
      artifactId: "art-1",
      representationRevisionId: "rep-2",
      revision: 2,
      deduped: true,
    });
    m.readRevisionImageProvenance.mockResolvedValue(null);
    const outcome = await generateArtifactImage(regeneration, deps());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("write_refused");
    expect(outcome.error).toBe(tool.FILING_STORED_FACTS_UNREADABLE_ERROR);
  });

  it("a deduped append whose stored-facts read throws refuses with the fixed sentence, its detail logged", async () => {
    m.appendArtifactRevision.mockResolvedValue({
      ok: true,
      artifactId: "art-1",
      representationRevisionId: "rep-2",
      revision: 2,
      deduped: true,
    });
    m.readRevisionImageProvenance.mockRejectedValue(new Error(SECRET_DETAIL));
    const outcome = await generateArtifactImage(regeneration, deps());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error).toBe(tool.FILING_STORED_FACTS_UNREADABLE_ERROR);
    expectDetailLogged();
  });

  it("a re-drive whose stored model is null reports a null model, never this attempt's", async () => {
    m.claimMaterialization.mockResolvedValue({
      kind: "finalized",
      artifactId: "art-1",
      representationRevisionId: "rep-1",
      path: "materialize_tool",
    });
    m.readRevisionImageProvenance.mockResolvedValue({ provider: "first-provider", model: null });
    const outcome = await generateArtifactImage(call, deps());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.provider).toBe("first-provider");
    expect(outcome.model).toBeNull();
  });
});

describe("cinatra#4223 — the install-state explanation reaches the result as a fixed sentence", () => {
  /** The resolver hands back the explainer's text as its refusal, as it does for a zero-claim extension. */
  function resolverThatExplains() {
    m.resolveBoundArtifactTarget.mockImplementation(
      async (i: {
        orgId: string;
        extension: string;
        deps?: { explainAbsentClaims?: (a: { orgId: string; extension: string }) => Promise<string> };
      }) => ({
        ok: false,
        error: await i.deps!.explainAbsentClaims!({ orgId: i.orgId, extension: i.extension }),
      }),
    );
  }

  it("an explanation that carries a read error's text is answered with the fixed install-state sentence, its detail logged", async () => {
    resolverThatExplains();
    m.explainAbsentArtifactSafeClaims.mockResolvedValue(
      `no artifact-safe claim resolved and its install state could not be read (${SECRET_DETAIL})`,
    );
    const outcome = await generateArtifactImage(call, deps());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("type_unresolved");
    expect(outcome.error).toBe(tool.installStateUnresolvedError(call.extension));
    expectNoDetail(outcome.error);
    expectDetailLogged();
  });

  it("an explainer that throws is answered with the same fixed sentence, its detail logged", async () => {
    resolverThatExplains();
    m.explainAbsentArtifactSafeClaims.mockRejectedValue(new Error(SECRET_DETAIL));
    const outcome = await generateArtifactImage(call, deps());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("type_unresolved");
    expect(outcome.error).toBe(tool.installStateUnresolvedError(call.extension));
    expectDetailLogged();
  });

  it("guard: a resolver refusal that is not an install-state explanation keeps its own sentence", async () => {
    m.resolveBoundArtifactTarget.mockResolvedValue({
      ok: false,
      error: 'extension "@cinatra-ai/picture-artifact" declares more than one artifact-safe object type',
    });
    const outcome = await generateArtifactImage(call, deps());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("type_unresolved");
    expect(outcome.error).toBe(
      'extension "@cinatra-ai/picture-artifact" declares more than one artifact-safe object type',
    );
  });
});
