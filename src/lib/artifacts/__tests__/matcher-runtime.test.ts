import { beforeEach, describe, expect, it, vi } from "vitest";

// Async LLM artifact matcher.
// Covers: pure mime/trust helpers; orphan-guard exit; no-candidate
// exit; runtime-unconfigured skip; package-owned trust (foreign
// rejected); boot-order lazy-register-then-retry; frontmatter-strip;
// strict response parse; threshold gate; assert + blockedByPrecedence.

const {
  runPgMock,
  registerAllObjectTypesMock,
  listArtifactsMock,
  resolveRuntimeMock,
  runLlmMock,
  listSkillsMock,
  parseFrontmatterMock,
  buildPortsMock,
  assertSemanticTypeMock,
  lazyRegisterMock,
} = vi.hoisted(() => ({
  runPgMock: vi.fn(),
  registerAllObjectTypesMock: vi.fn(),
  listArtifactsMock: vi.fn(),
  resolveRuntimeMock: vi.fn(),
  runLlmMock: vi.fn(),
  listSkillsMock: vi.fn(),
  parseFrontmatterMock: vi.fn(),
  buildPortsMock: vi.fn(),
  assertSemanticTypeMock: vi.fn(),
  lazyRegisterMock: vi.fn(),
}));

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: runPgMock,
}));
vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => "postgres://test",
  ensurePostgresSchema: () => {},
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/register-all-object-types", () => ({
  registerAllObjectTypes: registerAllObjectTypesMock,
}));
vi.mock("@cinatra-ai/objects/registry", () => ({
  objectTypeRegistry: { listArtifacts: listArtifactsMock },
}));
vi.mock("@cinatra-ai/llm", () => ({
  resolveConfiguredLlmRuntime: resolveRuntimeMock,
  runResolvedDeterministicLlmTask: runLlmMock,
}));
vi.mock("@cinatra-ai/skills", () => ({
  listInstalledSkills: listSkillsMock,
  parseFrontmatter: parseFrontmatterMock,
}));
vi.mock("../attachment-resolver-ports", () => ({
  buildAttachmentResolverPorts: buildPortsMock,
}));
vi.mock("../semantic-assertion-store", () => ({
  assertSemanticType: assertSemanticTypeMock,
}));
vi.mock("@/lib/extensions-dev-watcher", () => ({
  registerArtifactExtensionSkillsForPackage: lazyRegisterMock,
}));

import {
  runArtifactMatch,
  buildArtifactMatcherActorContext,
  __test,
} from "../matcher-runtime";

const PAYLOAD = {
  orgId: "org-a",
  artifactId: "art-1",
  representationRevisionId: "rep-1",
};
const ACTOR = buildArtifactMatcherActorContext({ orgId: "org-a" });

function stageAuthoritative(
  row:
    | { digest: string; mime: string; storage_key: string; origin_kind: string }
    | undefined,
) {
  // 1st pg call = authoritative read.
  runPgMock.mockReturnValueOnce([
    { rows: row ? [row] : [], rowCount: row ? 1 : 0 },
  ]);
  // Subsequent pg calls = the pre-assert `objectStillLive` re-check.
  // Default: object still live.
  runPgMock.mockReturnValue([{ rows: [{ "?column?": 1 }], rowCount: 1 }]);
}
function artifactDef(opts: {
  pkg: string;
  matcherSkillId?: string;
  mimeTypes?: string[];
  threshold?: number;
}) {
  return {
    type: `${opts.pkg}:artifact`,
    isArtifact: {
      accepts: { file: { mimeTypes: opts.mimeTypes ?? ["application/pdf"] } },
      skills: opts.matcherSkillId
        ? { matchers: [opts.matcherSkillId] }
        : undefined,
      matcherConfidenceThreshold: opts.threshold,
    },
  };
}

describe("matcher-runtime pure helpers", () => {
  it("normalizeMime strips params + lowercases", () => {
    expect(__test.normalizeMime("text/plain; charset=utf-8")).toBe(
      "text/plain",
    );
    expect(__test.normalizeMime("  APPLICATION/PDF ")).toBe("application/pdf");
  });
  it("mimeMatches: exact, subtype wildcard, any wildcard", () => {
    expect(__test.mimeMatches("application/pdf", "application/pdf")).toBe(true);
    expect(__test.mimeMatches("image/png", "image/*")).toBe(true);
    expect(__test.mimeMatches("text/csv", "image/*")).toBe(false);
    expect(__test.mimeMatches("anything/x", "*/*")).toBe(true);
    expect(
      __test.mimeMatches("text/plain; charset=utf-8", "text/plain"),
    ).toBe(true);
  });
  it("skillTrusted: exact packageName, slug compat fallback, foreign rejected", () => {
    expect(
      __test.skillTrusted(
        { id: "s", packageName: "@v/icp-artifact", packageSlug: "x", content: "" },
        "@v/icp-artifact",
      ),
    ).toBe(true);
    expect(
      __test.skillTrusted(
        { id: "s", packageName: "WRONG", packageSlug: "v-icp-artifact", content: "" },
        "@v/icp-artifact",
      ),
    ).toBe(true); // slug compat
    expect(
      __test.skillTrusted(
        { id: "s", packageName: "@evil/pkg", packageSlug: "evil-pkg", content: "" },
        "@v/icp-artifact",
      ),
    ).toBe(false);
  });
});

describe("runArtifactMatch", () => {
  beforeEach(() => {
    runPgMock.mockReset();
    registerAllObjectTypesMock.mockReset();
    listArtifactsMock.mockReset();
    resolveRuntimeMock.mockReset();
    runLlmMock.mockReset();
    listSkillsMock.mockReset();
    parseFrontmatterMock.mockReset();
    buildPortsMock.mockReset();
    assertSemanticTypeMock.mockReset();
    lazyRegisterMock.mockReset();
    buildPortsMock.mockReturnValue({});
    parseFrontmatterMock.mockImplementation((c: string) => ({ body: c }));
  });

  it("orphan guard: authoritative read empty → no LLM, no assert", async () => {
    stageAuthoritative(undefined);
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    expect(listArtifactsMock).not.toHaveBeenCalled();
    expect(runLlmMock).not.toHaveBeenCalled();
    expect(assertSemanticTypeMock).not.toHaveBeenCalled();
  });

  it("no MIME-matching candidate → exit, no assert", async () => {
    stageAuthoritative({
      digest: "sha", mime: "text/csv", storage_key: "k", origin_kind: "upload",
    });
    listArtifactsMock.mockReturnValue([
      artifactDef({ pkg: "@v/pdf-artifact", matcherSkillId: "s1", mimeTypes: ["application/pdf"] }),
    ]);
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    expect(resolveRuntimeMock).not.toHaveBeenCalled();
    expect(assertSemanticTypeMock).not.toHaveBeenCalled();
  });

  it("runtime unconfigured → skip (no assert, no crash)", async () => {
    stageAuthoritative({
      digest: "sha", mime: "application/pdf", storage_key: "k", origin_kind: "upload",
    });
    listArtifactsMock.mockReturnValue([
      artifactDef({ pkg: "@v/pdf-artifact", matcherSkillId: "s1" }),
    ]);
    resolveRuntimeMock.mockResolvedValue(null);
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    expect(runLlmMock).not.toHaveBeenCalled();
    expect(assertSemanticTypeMock).not.toHaveBeenCalled();
  });

  it("foreign-package matcher skill is REJECTED (trust anchor)", async () => {
    stageAuthoritative({
      digest: "sha", mime: "application/pdf", storage_key: "k", origin_kind: "upload",
    });
    listArtifactsMock.mockReturnValue([
      artifactDef({ pkg: "@v/pdf-artifact", matcherSkillId: "s1" }),
    ]);
    resolveRuntimeMock.mockResolvedValue({ provider: "openai", connection: {} });
    listSkillsMock.mockResolvedValue([
      { id: "s1", packageName: "@evil/other", packageSlug: "evil-other", content: "body" },
    ]);
    lazyRegisterMock.mockResolvedValue(0); // lazy register finds nothing
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    expect(runLlmMock).not.toHaveBeenCalled();
    expect(assertSemanticTypeMock).not.toHaveBeenCalled();
  });

  it("boot-order: catalog miss → lazy register → reload → match asserts", async () => {
    stageAuthoritative({
      digest: "sha", mime: "application/pdf", storage_key: "k", origin_kind: "upload",
    });
    listArtifactsMock.mockReturnValue([
      artifactDef({ pkg: "@v/pdf-artifact", matcherSkillId: "s1" }),
    ]);
    resolveRuntimeMock.mockResolvedValue({ provider: "openai", connection: {} });
    // First listInstalledSkills: empty (miss). After lazy register: present.
    listSkillsMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "s1", packageName: "@v/pdf-artifact", packageSlug: "v-pdf-artifact", content: "---\nx: 1\n---\nClassify it." },
      ]);
    lazyRegisterMock.mockResolvedValue(1); // registered 1 skill
    parseFrontmatterMock.mockReturnValue({ body: "Classify it." });
    runLlmMock.mockResolvedValue({
      text: JSON.stringify({ matches: true, confidence: 0.9 }),
    });
    assertSemanticTypeMock.mockReturnValue({ inserted: true, blockedByPrecedence: false });
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    expect(lazyRegisterMock).toHaveBeenCalledWith("@v/pdf-artifact");
    expect(runLlmMock).toHaveBeenCalledTimes(1);
    // declaredToolboxIds:[] + system is frontmatter-stripped body.
    const llmArg = runLlmMock.mock.calls[0][0];
    expect(llmArg.declaredToolboxIds).toEqual([]);
    expect(llmArg.system).toBe("Classify it.");
    expect(assertSemanticTypeMock).toHaveBeenCalledWith({
      orgId: "org-a",
      artifactId: "art-1",
      extension: "@v/pdf-artifact",
      assertedBy: "matcher",
      confidence: 0.9,
    });
  });

  it("malformed / out-of-range LLM response → skip (strict parse)", async () => {
    stageAuthoritative({
      digest: "sha", mime: "application/pdf", storage_key: "k", origin_kind: "upload",
    });
    listArtifactsMock.mockReturnValue([
      artifactDef({ pkg: "@v/pdf-artifact", matcherSkillId: "s1" }),
    ]);
    resolveRuntimeMock.mockResolvedValue({ provider: "openai", connection: {} });
    listSkillsMock.mockResolvedValue([
      { id: "s1", packageName: "@v/pdf-artifact", packageSlug: "v-pdf-artifact", content: "b" },
    ]);
    parseFrontmatterMock.mockReturnValue({ body: "b" });
    runLlmMock.mockResolvedValue({
      text: JSON.stringify({ matches: true, confidence: 1.5 }), // out of range
    });
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    expect(assertSemanticTypeMock).not.toHaveBeenCalled();
  });

  it("confidence below per-extension threshold → no assert", async () => {
    stageAuthoritative({
      digest: "sha", mime: "application/pdf", storage_key: "k", origin_kind: "upload",
    });
    listArtifactsMock.mockReturnValue([
      artifactDef({ pkg: "@v/pdf-artifact", matcherSkillId: "s1", threshold: 0.8 }),
    ]);
    resolveRuntimeMock.mockResolvedValue({ provider: "openai", connection: {} });
    listSkillsMock.mockResolvedValue([
      { id: "s1", packageName: "@v/pdf-artifact", packageSlug: "v-pdf-artifact", content: "b" },
    ]);
    parseFrontmatterMock.mockReturnValue({ body: "b" });
    runLlmMock.mockResolvedValue({
      text: JSON.stringify({ matches: true, confidence: 0.75 }),
    });
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    expect(assertSemanticTypeMock).not.toHaveBeenCalled();
  });

  it("blockedByPrecedence → no throw (expected no-op)", async () => {
    stageAuthoritative({
      digest: "sha", mime: "application/pdf", storage_key: "k", origin_kind: "upload",
    });
    listArtifactsMock.mockReturnValue([
      artifactDef({ pkg: "@v/pdf-artifact", matcherSkillId: "s1" }),
    ]);
    resolveRuntimeMock.mockResolvedValue({ provider: "openai", connection: {} });
    listSkillsMock.mockResolvedValue([
      { id: "s1", packageName: "@v/pdf-artifact", packageSlug: "v-pdf-artifact", content: "b" },
    ]);
    parseFrontmatterMock.mockReturnValue({ body: "b" });
    runLlmMock.mockResolvedValue({
      text: JSON.stringify({ matches: true, confidence: 0.95 }),
    });
    assertSemanticTypeMock.mockReturnValue({
      inserted: false,
      blockedByPrecedence: true,
    });
    await expect(
      runArtifactMatch(PAYLOAD, { actorContext: ACTOR }),
    ).resolves.toBeUndefined();
    expect(assertSemanticTypeMock).toHaveBeenCalledTimes(1);
  });

  it("boundary guard: a setup-path throw is caught (job NOT failed/retried)", async () => {
    stageAuthoritative({
      digest: "sha", mime: "application/pdf", storage_key: "k", origin_kind: "upload",
    });
    // registerAllObjectTypes throws BEFORE the per-candidate loop —
    // must be swallowed by the top-level boundary guard.
    registerAllObjectTypesMock.mockImplementation(() => {
      throw new Error("registry boom");
    });
    await expect(
      runArtifactMatch(PAYLOAD, { actorContext: ACTOR }),
    ).resolves.toBeUndefined();
    expect(assertSemanticTypeMock).not.toHaveBeenCalled();
  });

  it("tombstoned DURING classification → liveness re-check skips the assert", async () => {
    // 1st pg = authoritative (live). 2nd pg = objectStillLive → empty
    // (tombstoned during the LLM call).
    runPgMock.mockReturnValueOnce([
      {
        rows: [
          { digest: "sha", mime: "application/pdf", storage_key: "k", origin_kind: "upload" },
        ],
        rowCount: 1,
      },
    ]);
    runPgMock.mockReturnValue([{ rows: [], rowCount: 0 }]); // re-check: gone
    listArtifactsMock.mockReturnValue([
      artifactDef({ pkg: "@v/pdf-artifact", matcherSkillId: "s1" }),
    ]);
    resolveRuntimeMock.mockResolvedValue({ provider: "openai", connection: {} });
    listSkillsMock.mockResolvedValue([
      { id: "s1", packageName: "@v/pdf-artifact", packageSlug: "v-pdf-artifact", content: "b" },
    ]);
    parseFrontmatterMock.mockReturnValue({ body: "b" });
    runLlmMock.mockResolvedValue({
      text: JSON.stringify({ matches: true, confidence: 0.99 }),
    });
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    expect(runLlmMock).toHaveBeenCalledTimes(1);
    expect(assertSemanticTypeMock).not.toHaveBeenCalled();
  });

  it("actor context is a System principal anchored to the org", () => {
    expect(ACTOR.principalType).toBe("System");
    expect(ACTOR.organizationId).toBe("org-a");
    expect(ACTOR.authSource).toBe("worker");
  });

  // -------------------------------------------------------------------------
  // MAX_CANDIDATES is 24 so broad same-MIME families can all run while still
  // bounding LLM calls. The 25-candidate regression pins cap behavior, and the
  // 12-candidate test pins the pack-level invariant that ordinary same-MIME
  // overlap stays below the cap.
  // -------------------------------------------------------------------------
  it("12 same-MIME candidates ALL reach LLM classification (fits under cap=24)", async () => {
    stageAuthoritative({
      digest: "sha",
      mime: "text/markdown",
      storage_key: "k",
      origin_kind: "upload",
    });
    // 12 mock artifact extensions, all matching text/markdown — a
    // generous over-bound on expected same-MIME overlap (real same-MIME
    // count for text/markdown is ~10: GTM 6 + Content 2 [blog-post,
    // blog-idea] + Email/Legal 2 [email-body, contract]; slide-deck is
    // application/pdf and screenshot is image/* — both excluded). The
    // 12 chosen here exercises the same-MIME overlap envelope with a
    // 2-extension safety margin: still well under cap=24.
    const defs = Array.from({ length: 12 }, (_, i) =>
      artifactDef({
        pkg: `@cinatra-ai/seed-${i}-artifact`,
        matcherSkillId: `@cinatra-ai/seed-${i}-artifact:seed-${i}-matcher`,
        mimeTypes: ["text/markdown"],
      }),
    );
    listArtifactsMock.mockReturnValue(defs);
    resolveRuntimeMock.mockResolvedValue({ provider: "openai", connection: {} });
    listSkillsMock.mockResolvedValue(
      defs.map((d) => ({
        id: d.isArtifact.skills!.matchers![0],
        packageName: d.type.replace(":artifact", ""),
        packageSlug: d.type.replace(":artifact", "").replace("/", "-"),
        content: "Classify.",
      })),
    );
    runLlmMock.mockResolvedValue({
      text: JSON.stringify({ matches: false, confidence: 0.1 }),
    });
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    // All 12 candidates classified — none skipped by the cap.
    expect(runLlmMock).toHaveBeenCalledTimes(12);
  });

  it("25 same-MIME candidates: cap truncates at 24 + cap log fires", async () => {
    stageAuthoritative({
      digest: "sha",
      mime: "text/markdown",
      storage_key: "k",
      origin_kind: "upload",
    });
    const defs = Array.from({ length: 25 }, (_, i) =>
      artifactDef({
        pkg: `@cinatra-ai/over-${i}-artifact`,
        matcherSkillId: `@cinatra-ai/over-${i}-artifact:over-${i}-matcher`,
        mimeTypes: ["text/markdown"],
      }),
    );
    listArtifactsMock.mockReturnValue(defs);
    resolveRuntimeMock.mockResolvedValue({ provider: "openai", connection: {} });
    listSkillsMock.mockResolvedValue(
      defs.map((d) => ({
        id: d.isArtifact.skills!.matchers![0],
        packageName: d.type.replace(":artifact", ""),
        packageSlug: d.type.replace(":artifact", "").replace("/", "-"),
        content: "Classify.",
      })),
    );
    runLlmMock.mockResolvedValue({
      text: JSON.stringify({ matches: false, confidence: 0.1 }),
    });
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
      // Cap=24: only 24 candidates classified, 1 skipped.
      expect(runLlmMock).toHaveBeenCalledTimes(24);
      // The cap log fires with the literal cap value (regression: a future
      // bump must update this assertion too).
      const sawCapLog = infoSpy.mock.calls.some((args) =>
        String(args[0]).includes("candidate cap (24) reached"),
      );
      expect(sawCapLog).toBe(true);
    } finally {
      infoSpy.mockRestore();
    }
  });
});
