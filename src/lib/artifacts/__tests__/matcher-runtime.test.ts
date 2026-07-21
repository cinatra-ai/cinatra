import { beforeEach, describe, expect, it, vi } from "vitest";

// Async LLM MEANING-matcher (cinatra#1891, epic #1883 A3).
// Covers: pure mime/trust helpers; classifier-signals prompt rendering;
// re-keyed authoritative read (file-form + registered type, NOT the retired
// generic); orphan-guard exit; unregistered-own-type skip; no-candidate exit;
// runtime-unconfigured skip; channel-keyed candidate ownership; run-ALL-matchers;
// package-owned trust; boot-order lazy-register-then-retry; frontmatter-strip;
// strict response parse; threshold gate; assert + blockedByPrecedence; and the
// HONEST RETRY paths (DB read throw, LLM call throw, assert throw all rethrow
// as retryable; a malformed response does NOT).
//
// cinatra#1891 A3: candidate discovery reads the MEANING-SURFACE channel
// (`matcherManifestRegistry.list()`), NOT `objectTypeRegistry.listArtifacts()`
// (which is always empty for matcher packs post-#1785). This suite mocks the
// channel to exercise the matcher LOGIC in isolation; the REAL registration
// path (the discovery proof the brief mandates) is driven end-to-end by the
// integration test in packages/objects (matcher-manifest-channel.test.ts).

const {
  runPgMock,
  registerAllObjectTypesMock,
  matcherListMock,
  resolveMock,
  resolveRuntimeMock,
  runLlmMock,
  listSkillsMock,
  parseFrontmatterMock,
  buildPortsMock,
  assertSemanticTypeMock,
  lazyRegisterMock,
  writeAllowedMock,
  ensureSchemaMock,
} = vi.hoisted(() => ({
  runPgMock: vi.fn(),
  registerAllObjectTypesMock: vi.fn(),
  matcherListMock: vi.fn(),
  resolveMock: vi.fn(),
  resolveRuntimeMock: vi.fn(),
  runLlmMock: vi.fn(),
  listSkillsMock: vi.fn(),
  parseFrontmatterMock: vi.fn(),
  buildPortsMock: vi.fn(),
  assertSemanticTypeMock: vi.fn(),
  lazyRegisterMock: vi.fn(),
  writeAllowedMock: vi.fn(async (): Promise<boolean> => true),
  ensureSchemaMock: vi.fn(),
}));

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: runPgMock,
}));
vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => "postgres://test",
  ensurePostgresSchema: ensureSchemaMock,
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/register-all-object-types", () => ({
  registerAllObjectTypes: registerAllObjectTypesMock,
}));
vi.mock("@cinatra-ai/objects/registry", () => ({
  objectTypeRegistry: {
    resolve: resolveMock,
  },
  matcherManifestRegistry: {
    list: matcherListMock,
  },
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
// CG-4 (cinatra#661): matcher candidates are filtered through the install-active
// write gate. Mock it; default allow, override per test.
vi.mock("../artifact-extension-access", () => ({
  isArtifactExtensionWriteAllowed: writeAllowedMock,
}));

import {
  runArtifactMatch,
  buildArtifactMatcherActorContext,
  MatcherRetryableError,
  __test,
} from "../matcher-runtime";
// The REAL capability authority (dependency-free leaf, resolved via the vitest
// alias — NOT mocked). The matcher's filename resolution is exercised against
// the same ingestible-mime → extension map the provider ingestion rules use.
import {
  extensionForIngestibleMime,
  filenameExtensionMatchesMime,
} from "@cinatra-ai/llm/attachment-capability";

const resolveFilename = (
  artifactId: string,
  mime: string,
  persistedFilename?: string,
) =>
  __test.resolveMatcherAttachmentFilename({
    artifactId,
    mime,
    persistedFilename,
    extensionForMime: extensionForIngestibleMime,
    extensionMatchesMime: filenameExtensionMatchesMime,
  });

const PAYLOAD = {
  orgId: "org-a",
  artifactId: "art-1",
  representationRevisionId: "rep-1",
};
const ACTOR = buildArtifactMatcherActorContext({ orgId: "org-a" });

// The row's OWN declared (structural) type — a registered artifact type.
const OWN_TYPE = "@v/pdf-artifact:artifact";

function stageAuthoritative(
  row:
    | {
        digest: string;
        mime: string;
        storage_key: string;
        origin_kind: string;
        object_type?: string;
        classifier_signals?: unknown;
      }
    | undefined,
) {
  // 1st pg call = authoritative read.
  runPgMock.mockReturnValueOnce([
    {
      rows: row
        ? [{ object_type: OWN_TYPE, classifier_signals: null, ...row }]
        : [],
      rowCount: row ? 1 : 0,
    },
  ]);
  // Subsequent pg calls = the pre-assert `objectStillLive` re-check.
  // Default: object still live.
  runPgMock.mockReturnValue([{ rows: [{ "?column?": 1 }], rowCount: 1 }]);
}

// A MEANING-SURFACE channel entry (cinatra#1891 A3): the shape the matcher
// runtime now discovers candidates from. The channel key IS the owning package
// (provenance), and the threshold is already RESOLVED (default 0.7 here,
// mirroring the bridge's resolve-at-registration).
function matcherEntry(opts: {
  pkg: string;
  matcherSkillIds?: string[];
  matcherSkillId?: string;
  mimeTypes?: string[];
  threshold?: number;
}) {
  const matchers =
    opts.matcherSkillIds ?? (opts.matcherSkillId ? [opts.matcherSkillId] : ["s1"]);
  return {
    packageName: opts.pkg,
    matcherSkillIds: matchers,
    matcherConfidenceThreshold: opts.threshold ?? 0.7,
    fileMimeTypes: opts.mimeTypes ?? ["application/pdf"],
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

// cinatra#1891 DEFECT-3: the matcher attachment MUST carry a filename with a
// provider-recognized extension (OpenAI's `input_file` path 400s on an
// extensionless name — the exact live-walk failure). Drives the REAL capability
// helpers (no mock), so a regression in the ingestible-set → extension mapping
// re-breaks this instead of shipping a silent no-op.
describe("resolveMatcherAttachmentFilename (DEFECT-3 filename synthesis)", () => {
  it("no persisted filename → synthesizes <artifactId><ext> from the authoritative mime", () => {
    expect(resolveFilename("art-uuid", "text/markdown")).toBe("art-uuid.md");
    expect(resolveFilename("art-uuid", "application/pdf")).toBe("art-uuid.pdf");
    expect(resolveFilename("art-uuid", "text/plain; charset=utf-8")).toBe("art-uuid.txt");
  });

  it("persisted filename whose extension MATCHES the mime → used verbatim (a real signal)", () => {
    expect(resolveFilename("art-uuid", "text/markdown", "q3-strategy.md")).toBe("q3-strategy.md");
    expect(resolveFilename("art-uuid", "text/markdown", "q3-strategy.markdown")).toBe("q3-strategy.markdown");
    expect(resolveFilename("art-uuid", "application/pdf", "contract.pdf")).toBe("contract.pdf");
    // No double extension when the name already ends in a matching one.
    expect(resolveFilename("art-uuid", "text/markdown", "notes.md")).not.toContain(".md.md");
  });

  it("persisted extension for a DIFFERENT mime → mime extension appended (codex r2: no .pdf on markdown bytes)", () => {
    // The bug codex caught: a persisted `report.pdf` on text/markdown bytes must
    // NOT reach OpenAI as `.pdf` (markdown parsed as PDF). Append the correct
    // mime extension so the TRAILING extension matches the bytes.
    expect(resolveFilename("art-uuid", "text/markdown", "report.pdf")).toBe("report.pdf.md");
    expect(resolveFilename("art-uuid", "application/json", "data.csv")).toBe("data.csv.json");
  });

  it("persisted filename WITHOUT an extension → mime extension appended (keeps the name)", () => {
    expect(resolveFilename("art-uuid", "text/markdown", "strategy")).toBe("strategy.md");
    expect(resolveFilename("art-uuid", "text/csv", "export")).toBe("export.csv");
  });

  it("unknown / non-ingestible mime → never invents an extension", () => {
    // No persisted name → bare id unchanged (that attachment degrades to the
    // not-readable manifest at the resolver anyway).
    expect(resolveFilename("art-uuid", "application/zip")).toBe("art-uuid");
    expect(resolveFilename("art-uuid", "application/zip", "bundle")).toBe("bundle");
  });

  it("EVERY produced filename's extension MATCHES the authoritative mime (the invariant that fixes DEFECT-3)", () => {
    const cases: Array<[string, string | undefined]> = [
      ["text/markdown", undefined],
      ["text/plain", undefined],
      ["application/pdf", undefined],
      ["text/csv", "raw-name-no-ext"],
      ["application/json", "already.json"],
      ["text/markdown", "wrong-ext.pdf"], // cross-mime — must be corrected
      ["image/png", undefined],
    ];
    for (const [mime, persisted] of cases) {
      const name = resolveFilename("art-uuid", mime, persisted);
      expect(filenameExtensionMatchesMime(name, mime)).toBe(true);
    }
  });
});

describe("classifier-signals prompt renderer (scope 2)", () => {
  it("empty / null signals → empty block", () => {
    expect(__test.renderClassifierSignalsForPrompt(null)).toBe("");
    expect(__test.renderClassifierSignalsForPrompt({})).toBe("");
  });
  it("renders upload metadata, producer produces, and chat context", () => {
    const block = __test.renderClassifierSignalsForPrompt({
      upload: { filename: "q3-plan.md", declaredMime: "text/markdown", parentType: "thread", originKind: "upload" },
      produces: [{ extension: "@acme/marketing-strategy-artifact" }],
      chatContext: {
        messages: [
          { role: "user", content: "here is our marketing strategy for Q3" },
          { role: "assistant", content: "got it" },
        ],
      },
    });
    expect(block).toContain("filename: q3-plan.md");
    expect(block).toContain("declared type: text/markdown");
    expect(block).toContain("attached to: thread");
    expect(block).toContain("producer declared it produces: @acme/marketing-strategy-artifact");
    expect(block).toContain("recent conversation context:");
    expect(block).toContain("user: here is our marketing strategy for Q3");
  });
  it("clamps EACH producer `produces` extension (defensive bound, not just the count)", () => {
    // A hand-edited / legacy jsonb row with a multi-megabyte extension string
    // must not balloon the prompt: the renderer is the DEFENSIVE reader (the
    // write path byte-caps a normal row). Per-string clamp = 200 chars (codex
    // round finding 4).
    const huge = "@acme/" + "x".repeat(5000);
    const block = __test.renderClassifierSignalsForPrompt({
      produces: [{ extension: huge }],
    });
    const line = block
      .split("\n")
      .find((l) => l.startsWith("producer declared it produces:"))!;
    expect(line).toBeDefined();
    // "producer declared it produces: " prefix (31) + at most 200 clamped chars.
    expect(line.length).toBeLessThanOrEqual("producer declared it produces: ".length + 200);
    expect(block.length).toBeLessThan(5000);
  });
  it("parseClassifierSignals tolerates string, object, and junk", () => {
    expect(__test.parseClassifierSignals(null)).toBeNull();
    expect(__test.parseClassifierSignals("not json{")).toBeNull();
    expect(__test.parseClassifierSignals('{"upload":{"filename":"a"}}')).toEqual({
      upload: { filename: "a" },
    });
    expect(__test.parseClassifierSignals({ produces: [{ extension: "@x/y" }] })).toEqual({
      produces: [{ extension: "@x/y" }],
    });
  });
});

describe("runArtifactMatch", () => {
  beforeEach(() => {
    runPgMock.mockReset();
    registerAllObjectTypesMock.mockReset();
    matcherListMock.mockReset().mockReturnValue([]);
    resolveMock.mockReset().mockReturnValue({ isArtifact: {} });
    resolveRuntimeMock.mockReset();
    runLlmMock.mockReset();
    listSkillsMock.mockReset();
    parseFrontmatterMock.mockReset();
    buildPortsMock.mockReset();
    assertSemanticTypeMock.mockReset();
    lazyRegisterMock.mockReset();
    writeAllowedMock.mockReset().mockResolvedValue(true);
    ensureSchemaMock.mockReset();
    buildPortsMock.mockReturnValue({});
    parseFrontmatterMock.mockImplementation((c: string) => ({ body: c }));
  });

  it("orphan guard: authoritative read empty → no LLM, no assert", async () => {
    stageAuthoritative(undefined);
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    expect(matcherListMock).not.toHaveBeenCalled();
    expect(runLlmMock).not.toHaveBeenCalled();
    expect(assertSemanticTypeMock).not.toHaveBeenCalled();
  });

  it("scope 1: authoritative read keys on file-form + NOT the retired generic type", async () => {
    stageAuthoritative({
      digest: "sha", mime: "application/pdf", storage_key: "k", origin_kind: "upload",
    });
    matcherListMock.mockReturnValue([]);
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    // The SQL keys on `data->>'artifactType' = 'file'` and excludes the retired
    // generic — asserted against the query text + values of the first pg call.
    const firstCall = runPgMock.mock.calls[0][0];
    const query = firstCall.queries[0];
    expect(query.text).toContain("(o.data->>'artifactType') = 'file'");
    expect(query.text).toContain("o.type <> $4");
    expect(query.values).toContain("@cinatra-ai/artifact:object");
    expect(query.text).toContain("classifier_signals");
  });

  it("scope 1: own type not a registered artifact type → skip (no candidates)", async () => {
    stageAuthoritative({
      digest: "sha", mime: "application/pdf", storage_key: "k", origin_kind: "upload",
      object_type: "@gone/pkg:artifact",
    });
    // Definer uninstalled after the row was minted → resolve returns null.
    resolveMock.mockReturnValue(null);
    matcherListMock.mockReturnValue([
      matcherEntry({ pkg: "@v/pdf-artifact", matcherSkillId: "s1" }),
    ]);
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    expect(resolveRuntimeMock).not.toHaveBeenCalled();
    expect(assertSemanticTypeMock).not.toHaveBeenCalled();
  });

  it("no MIME-matching candidate → exit, no assert", async () => {
    stageAuthoritative({
      digest: "sha", mime: "text/csv", storage_key: "k", origin_kind: "upload",
    });
    matcherListMock.mockReturnValue([
      matcherEntry({ pkg: "@v/pdf-artifact", matcherSkillId: "s1", mimeTypes: ["application/pdf"] }),
    ]);
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    expect(resolveRuntimeMock).not.toHaveBeenCalled();
    expect(assertSemanticTypeMock).not.toHaveBeenCalled();
  });

  it("runtime unconfigured (null) → skip (no assert, no crash, NO retry)", async () => {
    stageAuthoritative({
      digest: "sha", mime: "application/pdf", storage_key: "k", origin_kind: "upload",
    });
    matcherListMock.mockReturnValue([
      matcherEntry({ pkg: "@v/pdf-artifact", matcherSkillId: "s1" }),
    ]);
    resolveRuntimeMock.mockResolvedValue(null);
    await expect(
      runArtifactMatch(PAYLOAD, { actorContext: ACTOR }),
    ).resolves.toBeUndefined();
    expect(runLlmMock).not.toHaveBeenCalled();
    expect(assertSemanticTypeMock).not.toHaveBeenCalled();
  });

  it("scope 4: candidate ownership is the channel packageName (assertion target)", async () => {
    stageAuthoritative({
      digest: "sha", mime: "application/pdf", storage_key: "k", origin_kind: "upload",
    });
    // The channel key IS the owning package — the matcher asserts against it
    // directly (no `:artifact` string-slice, no `definerOf` lookup). This is the
    // same provenance the presentation resolver's live/threshold policy keys on,
    // so the asserted `extension` and the surfacing policy agree.
    matcherListMock.mockReturnValue([
      matcherEntry({ pkg: "@provenance/owner", matcherSkillId: "s1" }),
    ]);
    resolveRuntimeMock.mockResolvedValue({ provider: "openai", connection: {} });
    listSkillsMock.mockResolvedValue([
      { id: "s1", packageName: "@provenance/owner", packageSlug: "provenance-owner", content: "b" },
    ]);
    parseFrontmatterMock.mockReturnValue({ body: "b" });
    runLlmMock.mockResolvedValue({ text: JSON.stringify({ matches: true, confidence: 0.9 }) });
    assertSemanticTypeMock.mockReturnValue({ inserted: true, blockedByPrecedence: false });
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    expect(assertSemanticTypeMock).toHaveBeenCalledWith(
      expect.objectContaining({ extension: "@provenance/owner", assertedBy: "matcher" }),
    );
  });

  it("scope 5: ALL declared matchers run, not just the first", async () => {
    stageAuthoritative({
      digest: "sha", mime: "application/pdf", storage_key: "k", origin_kind: "upload",
    });
    matcherListMock.mockReturnValue([
      matcherEntry({ pkg: "@v/pdf-artifact", matcherSkillIds: ["s1", "s2", "s3"] }),
    ]);
    resolveRuntimeMock.mockResolvedValue({ provider: "openai", connection: {} });
    listSkillsMock.mockResolvedValue([
      { id: "s1", packageName: "@v/pdf-artifact", packageSlug: "v-pdf-artifact", content: "m1" },
      { id: "s2", packageName: "@v/pdf-artifact", packageSlug: "v-pdf-artifact", content: "m2" },
      { id: "s3", packageName: "@v/pdf-artifact", packageSlug: "v-pdf-artifact", content: "m3" },
    ]);
    parseFrontmatterMock.mockImplementation((c: string) => ({ body: c }));
    runLlmMock.mockResolvedValue({ text: JSON.stringify({ matches: false, confidence: 0.1 }) });
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    // Three declared matchers ⇒ three LLM classification calls.
    expect(runLlmMock).toHaveBeenCalledTimes(3);
    const systems = runLlmMock.mock.calls.map((c) => c[0].system);
    expect(systems).toEqual(["m1", "m2", "m3"]);
  });

  it("scope 2: persisted classifier signals are rendered into the matcher user prompt", async () => {
    stageAuthoritative({
      digest: "sha", mime: "text/markdown", storage_key: "k", origin_kind: "upload",
      object_type: OWN_TYPE,
      classifier_signals: {
        upload: { filename: "strategy.md", originKind: "upload" },
        produces: [{ extension: "@acme/strategy-artifact" }],
        chatContext: { messages: [{ role: "user", content: "our marketing strategy" }] },
      },
    });
    matcherListMock.mockReturnValue([
      matcherEntry({ pkg: "@v/md-artifact", matcherSkillId: "s1", mimeTypes: ["text/markdown"] }),
    ]);
    resolveRuntimeMock.mockResolvedValue({ provider: "openai", connection: {} });
    listSkillsMock.mockResolvedValue([
      { id: "s1", packageName: "@v/md-artifact", packageSlug: "v-md-artifact", content: "b" },
    ]);
    parseFrontmatterMock.mockReturnValue({ body: "b" });
    runLlmMock.mockResolvedValue({ text: JSON.stringify({ matches: false, confidence: 0.1 }) });
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    const user = runLlmMock.mock.calls[0][0].user as string;
    expect(user).toContain("filename: strategy.md");
    expect(user).toContain("producer declared it produces: @acme/strategy-artifact");
    expect(user).toContain("our marketing strategy");
  });

  it("DEFECT-3: the LLM attachment carries a provider-recognized filename (no persisted → synthesized)", async () => {
    // The exact live-walk condition: a text/markdown upload with NO persisted
    // upload filename. Pre-fix the matcher sent no `filename`, the resolver fell
    // back to the bare artifact UUID, and OpenAI 400'd. Assert the attachment
    // handed to the LLM task now carries `art-1.md`.
    stageAuthoritative({
      digest: "sha", mime: "text/markdown", storage_key: "k", origin_kind: "upload",
      object_type: OWN_TYPE,
      classifier_signals: null, // no persisted upload filename
    });
    matcherListMock.mockReturnValue([
      matcherEntry({ pkg: "@v/md-artifact", matcherSkillId: "s1", mimeTypes: ["text/markdown"] }),
    ]);
    resolveRuntimeMock.mockResolvedValue({ provider: "openai", connection: {} });
    listSkillsMock.mockResolvedValue([
      { id: "s1", packageName: "@v/md-artifact", packageSlug: "v-md-artifact", content: "b" },
    ]);
    parseFrontmatterMock.mockReturnValue({ body: "b" });
    runLlmMock.mockResolvedValue({ text: JSON.stringify({ matches: false, confidence: 0.1, rationale: "n" }) });
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    expect(runLlmMock).toHaveBeenCalledTimes(1);
    const attachments = runLlmMock.mock.calls[0][0].attachments as Array<{ filename?: string; mime: string }>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe("art-1.md");
    expect(filenameExtensionMatchesMime(attachments[0].filename!, "text/markdown")).toBe(true);
  });

  it("DEFECT-3: a persisted upload filename with a good extension reaches the LLM attachment verbatim", async () => {
    stageAuthoritative({
      digest: "sha", mime: "text/markdown", storage_key: "k", origin_kind: "upload",
      object_type: OWN_TYPE,
      classifier_signals: { upload: { filename: "marketing-strategy.md", originKind: "upload" } },
    });
    matcherListMock.mockReturnValue([
      matcherEntry({ pkg: "@v/md-artifact", matcherSkillId: "s1", mimeTypes: ["text/markdown"] }),
    ]);
    resolveRuntimeMock.mockResolvedValue({ provider: "openai", connection: {} });
    listSkillsMock.mockResolvedValue([
      { id: "s1", packageName: "@v/md-artifact", packageSlug: "v-md-artifact", content: "b" },
    ]);
    parseFrontmatterMock.mockReturnValue({ body: "b" });
    runLlmMock.mockResolvedValue({ text: JSON.stringify({ matches: false, confidence: 0.1, rationale: "n" }) });
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    const attachments = runLlmMock.mock.calls[0][0].attachments as Array<{ filename?: string }>;
    expect(attachments[0].filename).toBe("marketing-strategy.md");
  });

  it("foreign-package matcher skill is REJECTED (trust anchor)", async () => {
    stageAuthoritative({
      digest: "sha", mime: "application/pdf", storage_key: "k", origin_kind: "upload",
    });
    matcherListMock.mockReturnValue([
      matcherEntry({ pkg: "@v/pdf-artifact", matcherSkillId: "s1" }),
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
    matcherListMock.mockReturnValue([
      matcherEntry({ pkg: "@v/pdf-artifact", matcherSkillId: "s1" }),
    ]);
    resolveRuntimeMock.mockResolvedValue({ provider: "openai", connection: {} });
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

  it("CG-4: an archived-install candidate is dropped → no LLM call, no matcher assert", async () => {
    stageAuthoritative({
      digest: "sha", mime: "application/pdf", storage_key: "k", origin_kind: "upload",
    });
    matcherListMock.mockReturnValue([
      matcherEntry({ pkg: "@v/pdf-artifact", matcherSkillId: "s1" }),
    ]);
    resolveRuntimeMock.mockResolvedValue({ provider: "openai", connection: {} });
    writeAllowedMock.mockResolvedValue(false);
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    expect(runLlmMock).not.toHaveBeenCalled();
    expect(assertSemanticTypeMock).not.toHaveBeenCalled();
  });

  it("malformed / out-of-range LLM response → skip candidate (NO retry)", async () => {
    stageAuthoritative({
      digest: "sha", mime: "application/pdf", storage_key: "k", origin_kind: "upload",
    });
    matcherListMock.mockReturnValue([
      matcherEntry({ pkg: "@v/pdf-artifact", matcherSkillId: "s1" }),
    ]);
    resolveRuntimeMock.mockResolvedValue({ provider: "openai", connection: {} });
    listSkillsMock.mockResolvedValue([
      { id: "s1", packageName: "@v/pdf-artifact", packageSlug: "v-pdf-artifact", content: "b" },
    ]);
    parseFrontmatterMock.mockReturnValue({ body: "b" });
    runLlmMock.mockResolvedValue({
      text: JSON.stringify({ matches: true, confidence: 1.5 }), // out of range
    });
    await expect(
      runArtifactMatch(PAYLOAD, { actorContext: ACTOR }),
    ).resolves.toBeUndefined();
    expect(assertSemanticTypeMock).not.toHaveBeenCalled();
  });

  it("confidence below per-extension threshold → no assert", async () => {
    stageAuthoritative({
      digest: "sha", mime: "application/pdf", storage_key: "k", origin_kind: "upload",
    });
    matcherListMock.mockReturnValue([
      matcherEntry({ pkg: "@v/pdf-artifact", matcherSkillId: "s1", threshold: 0.8 }),
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
    matcherListMock.mockReturnValue([
      matcherEntry({ pkg: "@v/pdf-artifact", matcherSkillId: "s1" }),
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

  // -------------------------------------------------------------------------
  // HONEST RETRY (scope 6): transient failures RETHROW so BullMQ retries; a
  // non-retryable setup throw is swallowed; a malformed response is per-candidate.
  // -------------------------------------------------------------------------
  it("scope 6: DB read throw → MatcherRetryableError rethrown (job retries)", async () => {
    runPgMock.mockImplementationOnce(() => {
      throw new Error("connection reset");
    });
    await expect(
      runArtifactMatch(PAYLOAD, { actorContext: ACTOR }),
    ).rejects.toBeInstanceOf(MatcherRetryableError);
  });

  it("scope 6: cold-worker schema-ensure DB outage → MatcherRetryableError rethrown (job retries)", async () => {
    // `ensurePostgresSchema()` runs inside `readAuthoritative`'s retryable try:
    // a DB-unreachable cold worker throws HERE (before the authoritative query),
    // and that transient failure must retry — NOT fall through to the top-level
    // non-retryable catch and silently complete the job (codex round finding 2).
    ensureSchemaMock.mockImplementationOnce(() => {
      throw new Error("schema bootstrap DDL failed — db unreachable");
    });
    await expect(
      runArtifactMatch(PAYLOAD, { actorContext: ACTOR }),
    ).rejects.toBeInstanceOf(MatcherRetryableError);
  });

  it("scope 6: LLM call throw → MatcherRetryableError rethrown (job retries)", async () => {
    stageAuthoritative({
      digest: "sha", mime: "application/pdf", storage_key: "k", origin_kind: "upload",
    });
    matcherListMock.mockReturnValue([
      matcherEntry({ pkg: "@v/pdf-artifact", matcherSkillId: "s1" }),
    ]);
    resolveRuntimeMock.mockResolvedValue({ provider: "openai", connection: {} });
    listSkillsMock.mockResolvedValue([
      { id: "s1", packageName: "@v/pdf-artifact", packageSlug: "v-pdf-artifact", content: "b" },
    ]);
    parseFrontmatterMock.mockReturnValue({ body: "b" });
    runLlmMock.mockRejectedValue(new Error("provider 503"));
    await expect(
      runArtifactMatch(PAYLOAD, { actorContext: ACTOR }),
    ).rejects.toBeInstanceOf(MatcherRetryableError);
  });

  it("scope 6: resolveConfiguredLlmRuntime throw → MatcherRetryableError rethrown", async () => {
    stageAuthoritative({
      digest: "sha", mime: "application/pdf", storage_key: "k", origin_kind: "upload",
    });
    matcherListMock.mockReturnValue([
      matcherEntry({ pkg: "@v/pdf-artifact", matcherSkillId: "s1" }),
    ]);
    resolveRuntimeMock.mockRejectedValue(new Error("nango down"));
    await expect(
      runArtifactMatch(PAYLOAD, { actorContext: ACTOR }),
    ).rejects.toBeInstanceOf(MatcherRetryableError);
  });

  it("scope 6: assertSemanticType throw → MatcherRetryableError rethrown", async () => {
    stageAuthoritative({
      digest: "sha", mime: "application/pdf", storage_key: "k", origin_kind: "upload",
    });
    matcherListMock.mockReturnValue([
      matcherEntry({ pkg: "@v/pdf-artifact", matcherSkillId: "s1" }),
    ]);
    resolveRuntimeMock.mockResolvedValue({ provider: "openai", connection: {} });
    listSkillsMock.mockResolvedValue([
      { id: "s1", packageName: "@v/pdf-artifact", packageSlug: "v-pdf-artifact", content: "b" },
    ]);
    parseFrontmatterMock.mockReturnValue({ body: "b" });
    runLlmMock.mockResolvedValue({ text: JSON.stringify({ matches: true, confidence: 0.95 }) });
    assertSemanticTypeMock.mockImplementation(() => {
      throw new Error("deadlock detected");
    });
    await expect(
      runArtifactMatch(PAYLOAD, { actorContext: ACTOR }),
    ).rejects.toBeInstanceOf(MatcherRetryableError);
  });

  it("scope 6: a NON-retryable setup throw is swallowed (job NOT failed/retried)", async () => {
    stageAuthoritative({
      digest: "sha", mime: "application/pdf", storage_key: "k", origin_kind: "upload",
    });
    // registerAllObjectTypes throws BEFORE the per-candidate loop — a
    // non-retryable setup error, swallowed by the top-level boundary guard.
    registerAllObjectTypesMock.mockImplementation(() => {
      throw new Error("registry boom");
    });
    await expect(
      runArtifactMatch(PAYLOAD, { actorContext: ACTOR }),
    ).resolves.toBeUndefined();
    expect(assertSemanticTypeMock).not.toHaveBeenCalled();
  });

  it("tombstoned DURING classification → liveness re-check skips the assert", async () => {
    runPgMock.mockReturnValueOnce([
      {
        rows: [
          { digest: "sha", mime: "application/pdf", storage_key: "k", origin_kind: "upload", object_type: OWN_TYPE, classifier_signals: null },
        ],
        rowCount: 1,
      },
    ]);
    runPgMock.mockReturnValue([{ rows: [], rowCount: 0 }]); // re-check: gone
    matcherListMock.mockReturnValue([
      matcherEntry({ pkg: "@v/pdf-artifact", matcherSkillId: "s1" }),
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

  // -------------------------------------------------------------------------
  // REGRESSION (cinatra#1891 walk-2 DEFECT-2): the OpenAI Responses API strict
  // structured-output contract requires `required` to include EVERY key in
  // `properties`; the adapter forwards `outputSchema` verbatim into
  // `text.format.json_schema`, so an under-specified `required` is a
  // deterministic 400 at the real provider — invisible to a mocked LLM boundary.
  // This asserts against the ACTUAL schema object the runtime hands the LLM task
  // (captured off the mock call), so a property added without a matching
  // `required` entry re-breaks this test instead of shipping a silent no-op.
  // -------------------------------------------------------------------------
  it("matcher outputSchema: `required` covers EVERY key in `properties` (strict structured-output contract)", async () => {
    stageAuthoritative({
      digest: "sha", mime: "application/pdf", storage_key: "k", origin_kind: "upload",
    });
    matcherListMock.mockReturnValue([
      matcherEntry({ pkg: "@v/pdf-artifact", matcherSkillId: "s1" }),
    ]);
    resolveRuntimeMock.mockResolvedValue({ provider: "openai", connection: {} });
    listSkillsMock.mockResolvedValue([
      { id: "s1", packageName: "@v/pdf-artifact", packageSlug: "v-pdf-artifact", content: "b" },
    ]);
    parseFrontmatterMock.mockReturnValue({ body: "b" });
    runLlmMock.mockResolvedValue({
      text: JSON.stringify({ matches: false, confidence: 0.1, rationale: "n/a" }),
    });
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });

    expect(runLlmMock).toHaveBeenCalledTimes(1);
    const outputSchema = runLlmMock.mock.calls[0][0].outputSchema as {
      type: string;
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(outputSchema).toBeDefined();
    expect(outputSchema.type).toBe("object");
    const propertyKeys = Object.keys(outputSchema.properties ?? {});
    const requiredKeys = new Set(outputSchema.required ?? []);
    // Every declared property MUST be listed in `required` — the OpenAI strict
    // json_schema rule the walk caught. `rationale` is the one that regressed.
    expect(propertyKeys.length).toBeGreaterThan(0);
    const missingFromRequired = propertyKeys.filter((k) => !requiredKeys.has(k));
    expect(missingFromRequired).toEqual([]);
    expect(requiredKeys.has("rationale")).toBe(true);
  });

  it("actor context is a System principal anchored to the org", () => {
    expect(ACTOR.principalType).toBe("System");
    expect(ACTOR.organizationId).toBe("org-a");
    expect(ACTOR.authSource).toBe("worker");
  });

  it("12 same-MIME candidates ALL reach LLM classification (fits under cap=24)", async () => {
    stageAuthoritative({
      digest: "sha",
      mime: "text/markdown",
      storage_key: "k",
      origin_kind: "upload",
      object_type: "@cinatra-ai/seed-0-artifact:artifact",
    });
    const entries = Array.from({ length: 12 }, (_, i) =>
      matcherEntry({
        pkg: `@cinatra-ai/seed-${i}-artifact`,
        matcherSkillId: `@cinatra-ai/seed-${i}-artifact:seed-${i}-matcher`,
        mimeTypes: ["text/markdown"],
      }),
    );
    matcherListMock.mockReturnValue(entries);
    resolveRuntimeMock.mockResolvedValue({ provider: "openai", connection: {} });
    listSkillsMock.mockResolvedValue(
      entries.map((e) => ({
        id: e.matcherSkillIds[0],
        packageName: e.packageName,
        packageSlug: e.packageName.replace("/", "-"),
        content: "Classify.",
      })),
    );
    runLlmMock.mockResolvedValue({
      text: JSON.stringify({ matches: false, confidence: 0.1 }),
    });
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    expect(runLlmMock).toHaveBeenCalledTimes(12);
  });

  it("25 same-MIME candidates: cap truncates at 24 + cap log fires", async () => {
    stageAuthoritative({
      digest: "sha",
      mime: "text/markdown",
      storage_key: "k",
      origin_kind: "upload",
      object_type: "@cinatra-ai/over-0-artifact:artifact",
    });
    const entries = Array.from({ length: 25 }, (_, i) =>
      matcherEntry({
        pkg: `@cinatra-ai/over-${i}-artifact`,
        matcherSkillId: `@cinatra-ai/over-${i}-artifact:over-${i}-matcher`,
        mimeTypes: ["text/markdown"],
      }),
    );
    matcherListMock.mockReturnValue(entries);
    resolveRuntimeMock.mockResolvedValue({ provider: "openai", connection: {} });
    listSkillsMock.mockResolvedValue(
      entries.map((e) => ({
        id: e.matcherSkillIds[0],
        packageName: e.packageName,
        packageSlug: e.packageName.replace("/", "-"),
        content: "Classify.",
      })),
    );
    runLlmMock.mockResolvedValue({
      text: JSON.stringify({ matches: false, confidence: 0.1 }),
    });
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
      expect(runLlmMock).toHaveBeenCalledTimes(24);
      const sawCapLog = infoSpy.mock.calls.some((args) =>
        String(args[0]).includes("candidate cap (24) reached"),
      );
      expect(sawCapLog).toBe(true);
    } finally {
      infoSpy.mockRestore();
    }
  });
});
