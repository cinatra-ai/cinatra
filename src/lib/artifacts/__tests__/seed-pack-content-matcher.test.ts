/**
 * Target-aware content-pack matcher integration test.
 *
 * Mocks `runResolvedDeterministicLlmTask` with a TARGET-AWARE responder:
 * the mock matches IFF the user prompt contains the target package name,
 * returns `{matches:false, confidence:0.1}` otherwise. Asserts:
 *   - A `draft` (matcher) assertion lands on the target extension.
 *   - NO `draft` lands on the OTHER content-pack extensions whose MIME
 *     happens to match the staged resource.
 *
 * The pack manifests are mocked into `objectTypeRegistry.listArtifacts()`
 * directly (we are NOT exercising the bridge here — that's the role of
 * `register-artifact-extensions.ts` tests). The point is the matcher
 * runtime's per-candidate dispatch + threshold gate + target identification.
 *
 *   npx vitest run src/lib/artifacts/__tests__/seed-pack-content-matcher.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/lib/postgres-sync", () => ({ runPostgresQueriesSync: runPgMock }));
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
} from "../matcher-runtime";

// Content pack manifests under test.
import { blogPostArtifactManifest } from "../../../../extensions/cinatra-ai/blog-post-artifact/src/index";
import { blogIdeaArtifactManifest } from "../../../../extensions/cinatra-ai/blog-idea-artifact/src/index";
import { slideDeckArtifactManifest } from "../../../../extensions/cinatra-ai/slide-deck-artifact/src/index";
import { screenshotArtifactManifest } from "../../../../extensions/cinatra-ai/screenshot-artifact/src/index";

const PAYLOAD = {
  orgId: "org-a",
  artifactId: "art-1",
  representationRevisionId: "rep-1",
};
const ACTOR = buildArtifactMatcherActorContext({ orgId: "org-a" });

type PackDef = {
  pkgName: string;
  manifest: typeof blogPostArtifactManifest;
};
const PACK_DEFS: PackDef[] = [
  { pkgName: "@cinatra-ai/blog-post-artifact", manifest: blogPostArtifactManifest },
  { pkgName: "@cinatra-ai/blog-idea-artifact", manifest: blogIdeaArtifactManifest },
  { pkgName: "@cinatra-ai/slide-deck-artifact", manifest: slideDeckArtifactManifest },
  { pkgName: "@cinatra-ai/screenshot-artifact", manifest: screenshotArtifactManifest },
];

function stageAuthoritative(mime: string) {
  runPgMock.mockReturnValueOnce([
    {
      rows: [
        { digest: "sha", mime, storage_key: "k", origin_kind: "upload" },
      ],
      rowCount: 1,
    },
  ]);
  // objectStillLive re-check default: live.
  runPgMock.mockReturnValue([{ rows: [{ "?column?": 1 }], rowCount: 1 }]);
}

function registerAllAsArtifactDefs() {
  listArtifactsMock.mockReturnValue(
    PACK_DEFS.map((p) => ({
      type: `${p.pkgName}:artifact`,
      isArtifact: p.manifest,
    })),
  );
}

function registerAllAsSkills() {
  listSkillsMock.mockResolvedValue(
    PACK_DEFS.map((p) => ({
      id: p.manifest.skills!.matchers![0],
      packageName: p.pkgName,
      packageSlug: p.pkgName.replace("/", "-").replace("@", ""),
      content: `Classifier prompt body for ${p.pkgName}.`,
    })),
  );
}

function targetAwareLlmMock(targetPkg: string) {
  // The runtime's user prompt is:
  //   `Classify the attached artifact. Decide whether it is a "${cand.extPackageName}" work product. ...`
  // We match on the targetPkg substring in the user prompt to return matches:true,
  // matches:false otherwise.
  runLlmMock.mockImplementation(async (input: { user: string }) => {
    if (input.user.includes(targetPkg)) {
      return {
        text: JSON.stringify({
          matches: true,
          confidence: 0.85,
          rationale: `target ${targetPkg} matched`,
        }),
      };
    }
    return {
      text: JSON.stringify({
        matches: false,
        confidence: 0.1,
        rationale: "not target",
      }),
    };
  });
}

describe("Content pack — target-aware matcher integration", () => {
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
    resolveRuntimeMock.mockResolvedValue({ provider: "openai", connection: {} });
    assertSemanticTypeMock.mockReturnValue({ inserted: true });
  });

  // For each pack member, a target-aware case: when only one matcher signals
  // a match, exactly ONE draft assertion lands on that extension.

  it("text/markdown upload + target=blog-post-artifact → blog-post draft asserted, blog-idea NOT asserted", async () => {
    stageAuthoritative("text/markdown");
    registerAllAsArtifactDefs();
    registerAllAsSkills();
    targetAwareLlmMock("@cinatra-ai/blog-post-artifact");
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    // text/markdown matches blog-post + blog-idea (NOT slide-deck or screenshot).
    expect(runLlmMock).toHaveBeenCalledTimes(2);
    // Only the target asserts.
    expect(assertSemanticTypeMock).toHaveBeenCalledTimes(1);
    expect(assertSemanticTypeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        extension: "@cinatra-ai/blog-post-artifact",
        assertedBy: "matcher",
      }),
    );
  });

  it("text/plain upload + target=blog-idea-artifact → only blog-idea draft asserts (no blog-post since MIME mismatch)", async () => {
    stageAuthoritative("text/plain");
    registerAllAsArtifactDefs();
    registerAllAsSkills();
    targetAwareLlmMock("@cinatra-ai/blog-idea-artifact");
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    // text/plain matches blog-idea ONLY (blog-post is markdown-only).
    expect(runLlmMock).toHaveBeenCalledTimes(1);
    expect(assertSemanticTypeMock).toHaveBeenCalledTimes(1);
    expect(assertSemanticTypeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        extension: "@cinatra-ai/blog-idea-artifact",
      }),
    );
  });

  it("application/pdf upload + target=slide-deck-artifact → only slide-deck draft asserts", async () => {
    stageAuthoritative("application/pdf");
    registerAllAsArtifactDefs();
    registerAllAsSkills();
    targetAwareLlmMock("@cinatra-ai/slide-deck-artifact");
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    // application/pdf matches slide-deck ONLY in this pack.
    expect(runLlmMock).toHaveBeenCalledTimes(1);
    expect(assertSemanticTypeMock).toHaveBeenCalledTimes(1);
    expect(assertSemanticTypeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        extension: "@cinatra-ai/slide-deck-artifact",
      }),
    );
  });

  it("image/png upload + target=screenshot-artifact → only screenshot draft asserts", async () => {
    stageAuthoritative("image/png");
    registerAllAsArtifactDefs();
    registerAllAsSkills();
    targetAwareLlmMock("@cinatra-ai/screenshot-artifact");
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    expect(runLlmMock).toHaveBeenCalledTimes(1);
    expect(assertSemanticTypeMock).toHaveBeenCalledTimes(1);
    expect(assertSemanticTypeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        extension: "@cinatra-ai/screenshot-artifact",
      }),
    );
  });

  // Target-aware mock returning false for ALL candidates → no draft assertions
  // even though MIME matches. Floor invariant preserved.
  it("text/markdown upload + ALL candidates return matches:false → NO draft asserts (floor preserved)", async () => {
    stageAuthoritative("text/markdown");
    registerAllAsArtifactDefs();
    registerAllAsSkills();
    runLlmMock.mockResolvedValue({
      text: JSON.stringify({ matches: false, confidence: 0.1 }),
    });
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    // blog-post + blog-idea both classified (text/markdown matches both),
    // both return no-match — no assert lands.
    expect(runLlmMock).toHaveBeenCalledTimes(2);
    expect(assertSemanticTypeMock).not.toHaveBeenCalled();
  });

  // Below-threshold confidence does not assert.
  it("text/markdown upload + target=blog-post but confidence 0.5 < threshold 0.7 → NO draft asserts", async () => {
    stageAuthoritative("text/markdown");
    registerAllAsArtifactDefs();
    registerAllAsSkills();
    runLlmMock.mockResolvedValue({
      text: JSON.stringify({ matches: true, confidence: 0.5 }),
    });
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    expect(assertSemanticTypeMock).not.toHaveBeenCalled();
  });
});
