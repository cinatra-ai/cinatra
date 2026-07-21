import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// INTEGRATION PROOF (cinatra#1891 A3) — the meaning-matcher discovers REAL
// candidates through the REAL registration path.
//
// This is the discovery proof the brief mandates: it drives the ACTUAL
// `registerArtifactExtensions` bridge over a faithful fixture universe (a
// matcher-only pack that declares `skills.matchers` + `accepts.file` and NO
// objectTypes — exactly the shape the 13 bundled matcher packs have post-#1785),
// then runs the ACTUAL matcher runtime candidate loop and the ACTUAL
// presentation resolver against the REAL channel singleton the bridge populated.
// NOTHING about the candidate source or the channel is hand-mocked — only the
// leaf side-effects (LLM, DB reads, skills catalog, assertion store) are faked.
//
// The mocked unit suite (matcher-runtime.test.ts) proves the matcher LOGIC in
// isolation; THIS file proves the wiring the unit suite could not — the exact
// gap that let the feature no-op in prod while 11730 tests passed.
// ===========================================================================

// The bridge is `import "server-only"` (fs); neutralise the RSC guard for node.
vi.mock("server-only", () => ({}));

// `vi.mock` factories are hoisted above these declarations, so the mock fns
// they close over must be created via `vi.hoisted` (vitest only exempts names
// literally prefixed with `mock`; these are `…Mock`-suffixed) — mirrors the
// sibling matcher-runtime.test.ts.
const {
  runPgMock,
  resolveRuntimeMock,
  runLlmMock,
  listSkillsMock,
  parseFrontmatterMock,
  buildPortsMock,
  assertSemanticTypeMock,
  lazyRegisterMock,
  writeAllowedMock,
} = vi.hoisted(() => ({
  runPgMock: vi.fn(),
  resolveRuntimeMock: vi.fn(),
  runLlmMock: vi.fn(),
  listSkillsMock: vi.fn(),
  parseFrontmatterMock: vi.fn(),
  buildPortsMock: vi.fn(),
  assertSemanticTypeMock: vi.fn(),
  lazyRegisterMock: vi.fn(),
  writeAllowedMock: vi.fn(async (): Promise<boolean> => true),
}));
vi.mock("@/lib/postgres-sync", () => ({ runPostgresQueriesSync: runPgMock }));
// The matcher runtime reads pg config from `@/lib/database`; the presentation
// host reads it from `@/lib/postgres-config` + `@/lib/postgres-schema-init`.
vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => "postgres://test",
  ensurePostgresSchema: vi.fn(),
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));

// `registerAllObjectTypes` runs at the top of `runArtifactMatch`; no-op it so the
// registry + channel contain EXACTLY the fixture packs this test registered
// through the real bridge (no real-tree bleed).
vi.mock("@/lib/register-all-object-types", () => ({
  registerAllObjectTypes: vi.fn(),
}));

// Leaf side-effects the runtime reaches AFTER candidate discovery — faked so the
// test is hermetic (mock fns hoisted above). Candidate DISCOVERY (the thing
// under proof) is NOT mocked.
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
vi.mock("../artifact-extension-access", () => ({
  isArtifactExtensionWriteAllowed: writeAllowedMock,
}));

// REAL singletons + REAL bridge + REAL runtime + REAL presentation resolver.
import { registerArtifactExtensions } from "@cinatra-ai/objects/register-artifact-extensions";
import { objectTypeRegistry, matcherManifestRegistry } from "@cinatra-ai/objects/registry";
import {
  runArtifactMatch,
  buildArtifactMatcherActorContext,
  MatcherRetryableError,
} from "../matcher-runtime";
import { resolveArtifactPresentationIdentity } from "@/lib/objects/presentation-identity";

const STRATEGY_PKG = "@fixture/strategy-artifact";
const STRATEGY_MATCHER = "@fixture/strategy-artifact:strategy-matcher";
const TEXT_TYPE = "@fixture/text-artifact:doc";
const ORG = "org-int";

/** Write the faithful fixture universe into `root` and drive the REAL bridge:
 *   - strategy-artifact: MATCHER-ONLY (skills.matchers + accepts.file, NO
 *     objectTypes) — the exact post-#1785 shape that used to be invisible;
 *   - text-artifact: a structural pack owning `@fixture/text-artifact:doc`, the
 *     uploaded row's OWN type (so the runtime's registered-own-type guard passes).
 */
function driveRealBridge(root: string, opts: { threshold?: number } = {}): void {
  mkdirSync(path.join(root, "strategy-artifact"), { recursive: true });
  writeFileSync(
    path.join(root, "strategy-artifact", "package.json"),
    JSON.stringify({
      name: STRATEGY_PKG,
      version: "0.0.1",
      cinatra: {
        kind: "artifact",
        artifact: {
          accepts: { file: { mimeTypes: ["text/markdown"] } },
          skills: { matchers: [STRATEGY_MATCHER] },
          ...(opts.threshold !== undefined
            ? { matcherConfidenceThreshold: opts.threshold }
            : {}),
        },
      },
    }),
  );
  mkdirSync(path.join(root, "text-artifact"), { recursive: true });
  writeFileSync(
    path.join(root, "text-artifact", "package.json"),
    JSON.stringify({
      name: "@fixture/text-artifact",
      version: "0.0.1",
      cinatra: {
        kind: "artifact",
        artifact: {
          accepts: { file: { mimeTypes: ["text/markdown"] } },
          objectTypes: [
            { type: TEXT_TYPE, claim: "dedicated", schema: { type: "object" } },
          ],
        },
      },
    }),
  );
  registerArtifactExtensions(root);
}

function stageUpload(): void {
  // 1st pg call = the authoritative read (a text/markdown upload of the
  // structural text type). Subsequent calls = the pre-assert liveness re-check.
  runPgMock.mockReturnValueOnce([
    {
      rows: [
        {
          object_type: TEXT_TYPE,
          mime: "text/markdown",
          digest: "sha",
          storage_key: "k",
          origin_kind: "upload",
          classifier_signals: null,
        },
      ],
      rowCount: 1,
    },
  ]);
  runPgMock.mockReturnValue([{ rows: [{ "?column?": 1 }], rowCount: 1 }]);
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "matcher-integration-"));
  objectTypeRegistry._clearForTests();
  matcherManifestRegistry._clearForTests();
  runPgMock.mockReset();
  resolveRuntimeMock.mockReset();
  runLlmMock.mockReset();
  listSkillsMock.mockReset();
  parseFrontmatterMock.mockReset().mockImplementation((c: string) => ({ body: c }));
  buildPortsMock.mockReset().mockReturnValue({});
  assertSemanticTypeMock.mockReset();
  lazyRegisterMock.mockReset().mockResolvedValue(0);
  writeAllowedMock.mockReset().mockResolvedValue(true);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  objectTypeRegistry._clearForTests();
  matcherManifestRegistry._clearForTests();
});

describe("real bridge → meaning-surface channel", () => {
  it("(a) a matcher-only pack (no objectTypes) registers a channel entry — and mints NO object type", () => {
    driveRealBridge(root, { threshold: 0.8 });
    const entry = matcherManifestRegistry.get(STRATEGY_PKG);
    expect(entry).not.toBeNull();
    expect(entry!.matcherSkillIds).toEqual([STRATEGY_MATCHER]);
    expect(entry!.matcherConfidenceThreshold).toBe(0.8);
    expect(entry!.fileMimeTypes).toEqual(["text/markdown"]);
    // It minted NO object type (the umbrella stays retired).
    expect(objectTypeRegistry.resolve(`${STRATEGY_PKG}:artifact`)).toBeNull();
    expect(
      objectTypeRegistry.list().some((d) => d.type.startsWith(STRATEGY_PKG)),
    ).toBe(false);
  });

  it("a matcher-only pack with no declared threshold resolves to the pack default", () => {
    driveRealBridge(root); // no matcherConfidenceThreshold declared
    expect(matcherManifestRegistry.get(STRATEGY_PKG)!.matcherConfidenceThreshold).toBe(0.7);
  });

  it("a rescan that DROPS the matchers reconciles the channel entry away", () => {
    driveRealBridge(root);
    expect(matcherManifestRegistry.get(STRATEGY_PKG)).not.toBeNull();
    // Rewrite the pack with no matchers and re-run the real bridge.
    writeFileSync(
      path.join(root, "strategy-artifact", "package.json"),
      JSON.stringify({
        name: STRATEGY_PKG,
        version: "0.0.2",
        cinatra: {
          kind: "artifact",
          artifact: { accepts: { file: { mimeTypes: ["text/markdown"] } } },
        },
      }),
    );
    registerArtifactExtensions(root);
    expect(matcherManifestRegistry.get(STRATEGY_PKG)).toBeNull();
  });
});

describe("real bridge → REAL matcher runtime candidate discovery", () => {
  it("(b) the runtime discovers the bridge-registered candidate and asserts the matcher draft against the pack", async () => {
    driveRealBridge(root, { threshold: 0.7 });
    stageUpload();
    resolveRuntimeMock.mockResolvedValue({ provider: "openai", connection: {} });
    // The pack-owned matcher skill is in the catalog (trust anchor passes).
    listSkillsMock.mockResolvedValue([
      { id: STRATEGY_MATCHER, packageName: STRATEGY_PKG, packageSlug: "fixture-strategy-artifact", content: "Classify." },
    ]);
    runLlmMock.mockResolvedValue({ text: JSON.stringify({ matches: true, confidence: 0.95 }) });
    assertSemanticTypeMock.mockReturnValue({ inserted: true, blockedByPrecedence: false });

    await runArtifactMatch(
      { orgId: ORG, artifactId: "art-int", representationRevisionId: "rep-1" },
      { actorContext: buildArtifactMatcherActorContext({ orgId: ORG }) },
    );

    // The REAL candidate loop found the REAL channel entry → classified → asserted
    // against the pack that declared the matcher (provenance = the channel key).
    expect(runLlmMock).toHaveBeenCalledTimes(1);
    expect(assertSemanticTypeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG,
        artifactId: "art-int",
        extension: STRATEGY_PKG,
        assertedBy: "matcher",
        confidence: 0.95,
      }),
    );
  });

  it("threshold-per-definer holds: a sub-threshold classification does NOT assert", async () => {
    driveRealBridge(root, { threshold: 0.9 });
    stageUpload();
    resolveRuntimeMock.mockResolvedValue({ provider: "openai", connection: {} });
    listSkillsMock.mockResolvedValue([
      { id: STRATEGY_MATCHER, packageName: STRATEGY_PKG, packageSlug: "fixture-strategy-artifact", content: "Classify." },
    ]);
    runLlmMock.mockResolvedValue({ text: JSON.stringify({ matches: true, confidence: 0.85 }) });
    await runArtifactMatch(
      { orgId: ORG, artifactId: "art-int", representationRevisionId: "rep-1" },
      { actorContext: buildArtifactMatcherActorContext({ orgId: ORG }) },
    );
    expect(assertSemanticTypeMock).not.toHaveBeenCalled(); // 0.85 < 0.9
  });

  it("retry path still holds: an LLM throw over the real candidate rethrows retryable", async () => {
    driveRealBridge(root, { threshold: 0.7 });
    stageUpload();
    resolveRuntimeMock.mockResolvedValue({ provider: "openai", connection: {} });
    listSkillsMock.mockResolvedValue([
      { id: STRATEGY_MATCHER, packageName: STRATEGY_PKG, packageSlug: "fixture-strategy-artifact", content: "Classify." },
    ]);
    runLlmMock.mockRejectedValue(new Error("provider 503"));
    await expect(
      runArtifactMatch(
        { orgId: ORG, artifactId: "art-int", representationRevisionId: "rep-1" },
        { actorContext: buildArtifactMatcherActorContext({ orgId: ORG }) },
      ),
    ).rejects.toBeInstanceOf(MatcherRetryableError);
  });
});

describe("real bridge → REAL presentation resolver", () => {
  it("(c) a matcher draft asserted against the pack auto-surfaces through the real resolver at ≥ threshold", () => {
    driveRealBridge(root, { threshold: 0.7 });
    // The batched active-assertion read returns a matcher DRAFT for the pack; the
    // org-scoped install-status read returns no rows ⇒ ungoverned ⇒ live.
    runPgMock.mockImplementation((input: { queries: Array<{ text: string }> }) => {
      const text = input.queries[0]?.text ?? "";
      if (text.includes("semantic_assertion")) {
        return [
          {
            rows: [
              {
                artifact_id: "art-int",
                extension: STRATEGY_PKG,
                asserted_by: "matcher",
                eligibility: "draft",
                assertion_basis: "classic",
                confidence: 0.85,
                asserted_at: "2026-07-21T00:00:00.000Z",
              },
            ],
            rowCount: 1,
          },
        ];
      }
      if (text.includes("installed_extension")) return [{ rows: [], rowCount: 0 }];
      throw new Error(`unexpected query: ${text}`);
    });

    const out = resolveArtifactPresentationIdentity({
      orgId: ORG,
      artifactId: "art-int",
      baseType: TEXT_TYPE,
    });
    // Threshold (0.7) resolved from the SAME channel entry the matcher asserted
    // against — the draft (0.85) auto-surfaces.
    expect(out.identity).toEqual({ kind: "extension", extension: STRATEGY_PKG });
    expect(out.tier).toBe("matcher");
  });
});

// Anti-vacuity over the LIVE extensions tree: every bundled matcher-declaring
// pack must land a real channel entry (a missing entry means the bridge wiring
// or an allowlist drifted from the real manifests). Skips loudly when the tree
// is absent (bare package checkout).
describe("real bridge → live extensions tree (anti-vacuity)", () => {
  const EXT_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "extensions");

  it("populates the channel for the bundled matcher packs", () => {
    if (!existsSync(EXT_ROOT)) {
      console.warn("[matcher-candidate-source.integration] extensions/ absent — live-tree channel pin skipped");
      return;
    }
    objectTypeRegistry._clearForTests();
    matcherManifestRegistry._clearForTests();
    registerArtifactExtensions(EXT_ROOT);
    const channelPkgs = new Set(matcherManifestRegistry.list().map((e) => e.packageName));
    // The marketing-strategy pack is the canonical A3 walk target — it MUST be a
    // real candidate now (it registers no object type, so it was invisible).
    expect(channelPkgs.has("@cinatra-ai/marketing-strategy-artifact")).toBe(true);
    // Every channel entry carries a non-empty matcher set + file MIME set + a
    // numeric resolved threshold (the invariant the runtime + host rely on).
    for (const entry of matcherManifestRegistry.list()) {
      expect(entry.matcherSkillIds.length).toBeGreaterThan(0);
      expect(entry.fileMimeTypes.length).toBeGreaterThan(0);
      expect(typeof entry.matcherConfidenceThreshold).toBe("number");
    }
  });
});
