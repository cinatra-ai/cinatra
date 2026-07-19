/**
 * Email + Legal pack target-aware matcher integration test.
 *
 *   npx vitest run src/lib/artifacts/__tests__/seed-pack-email-legal-matcher.test.ts
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
// CG-4 (cinatra#661): matcher candidates pass through the install-active write
// gate; these seed packs are bundled (ungoverned) → allow all.
vi.mock("../artifact-extension-access", () => ({
  isArtifactExtensionWriteAllowed: async () => true,
}));

import {
  runArtifactMatch,
  buildArtifactMatcherActorContext,
} from "../matcher-runtime";

import { contractArtifactManifest } from "../../../../extensions/cinatra-ai/contract-artifact/src/index";

// email-body-artifact was RETIRED from the dev-extension set (cinatra#1454), so
// its markdown/plain matcher-based seed artifact no longer exists to import. This
// integration test exercises the matcher RUNTIME's multi-candidate arbitration
// (a markdown upload matches two candidates; text/plain narrows to one; pdf to
// the other) with fully mocked I/O — it needs two candidate manifests with the
// right MIME overlap, not a specific installed extension. This synthetic
// markdown+plain fixture stands in for the second candidate, preserving the exact
// arbitration coverage without depending on a retired extension.
const markdownPlainArtifactManifest: typeof contractArtifactManifest = {
  accepts: { file: { mimeTypes: ["text/markdown", "text/plain"] } },
  skills: {
    matchers: ["@cinatra-ai/fixture-markdown-plain-artifact:markdown-plain-matcher"],
  },
  matcherConfidenceThreshold: 0.7,
};
const MARKDOWN_PLAIN_PKG = "@cinatra-ai/fixture-markdown-plain-artifact";

const PAYLOAD = {
  orgId: "org-a",
  artifactId: "art-1",
  representationRevisionId: "rep-1",
};
const ACTOR = buildArtifactMatcherActorContext({ orgId: "org-a" });

type PackDef = {
  pkgName: string;
  manifest: typeof contractArtifactManifest;
};
const PACK_DEFS: PackDef[] = [
  { pkgName: MARKDOWN_PLAIN_PKG, manifest: markdownPlainArtifactManifest },
  { pkgName: "@cinatra-ai/contract-artifact", manifest: contractArtifactManifest },
];

function stageAuthoritative(mime: string) {
  runPgMock.mockReturnValueOnce([
    {
      rows: [{ digest: "sha", mime, storage_key: "k", origin_kind: "upload" }],
      rowCount: 1,
    },
  ]);
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

describe("Email+Legal pack — target-aware matcher integration", () => {
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

  it("text/markdown upload + target=markdown-plain → both classified, only markdown-plain asserts", async () => {
    stageAuthoritative("text/markdown");
    registerAllAsArtifactDefs();
    registerAllAsSkills();
    targetAwareLlmMock(MARKDOWN_PLAIN_PKG);
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    // text/markdown matches BOTH the markdown+plain fixture + contract.
    expect(runLlmMock).toHaveBeenCalledTimes(2);
    expect(assertSemanticTypeMock).toHaveBeenCalledTimes(1);
    expect(assertSemanticTypeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        extension: MARKDOWN_PLAIN_PKG,
        assertedBy: "matcher",
      }),
    );
  });

  it("text/plain upload + target=markdown-plain → only markdown-plain classified (contract excludes text/plain)", async () => {
    stageAuthoritative("text/plain");
    registerAllAsArtifactDefs();
    registerAllAsSkills();
    targetAwareLlmMock(MARKDOWN_PLAIN_PKG);
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    expect(runLlmMock).toHaveBeenCalledTimes(1);
    expect(assertSemanticTypeMock).toHaveBeenCalledTimes(1);
  });

  it("application/pdf upload + target=contract → only contract classified (markdown-plain excludes pdf)", async () => {
    stageAuthoritative("application/pdf");
    registerAllAsArtifactDefs();
    registerAllAsSkills();
    targetAwareLlmMock("@cinatra-ai/contract-artifact");
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    expect(runLlmMock).toHaveBeenCalledTimes(1);
    expect(assertSemanticTypeMock).toHaveBeenCalledTimes(1);
    expect(assertSemanticTypeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        extension: "@cinatra-ai/contract-artifact",
      }),
    );
  });

  it("text/markdown upload + ALL candidates return matches:false → NO draft asserts (floor preserved)", async () => {
    stageAuthoritative("text/markdown");
    registerAllAsArtifactDefs();
    registerAllAsSkills();
    runLlmMock.mockResolvedValue({
      text: JSON.stringify({ matches: false, confidence: 0.1 }),
    });
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    expect(runLlmMock).toHaveBeenCalledTimes(2);
    expect(assertSemanticTypeMock).not.toHaveBeenCalled();
  });

  it("threshold gate: matches:true, confidence:0.5 < 0.7 → NO draft asserts", async () => {
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
