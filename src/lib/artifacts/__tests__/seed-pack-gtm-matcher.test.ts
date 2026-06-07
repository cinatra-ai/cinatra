/**
 * Target-aware GTM pack matcher integration test.
 *
 * Mocks `runResolvedDeterministicLlmTask` with a TARGET-AWARE responder:
 * the mock matches IFF the user prompt contains the target package name
 * because the runtime constructs the user prompt with the candidate extension
 * package name literally. Asserts:
 *   - A `draft` (matcher) assertion lands on the target extension.
 *   - NO `draft` lands on the OTHER GTM-pack extensions even though their
 *     MIME also matches (text/markdown / text/plain / application/pdf are
 *     uniform across the pack).
 *
 *   npx vitest run src/lib/artifacts/__tests__/seed-pack-gtm-matcher.test.ts
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

import { marketingIcpArtifactManifest } from "../../../../extensions/cinatra-ai/marketing-icp-artifact/src/index";
import { marketingStrategyArtifactManifest } from "../../../../extensions/cinatra-ai/marketing-strategy-artifact/src/index";
import { brandVoiceArtifactManifest } from "../../../../extensions/cinatra-ai/brand-voice-artifact/src/index";
import { productPortfolioArtifactManifest } from "../../../../extensions/cinatra-ai/product-portfolio-artifact/src/index";
import { salesPlaybookArtifactManifest } from "../../../../extensions/cinatra-ai/sales-playbook-artifact/src/index";
import { competitiveAnalysisArtifactManifest } from "../../../../extensions/cinatra-ai/competitive-analysis-artifact/src/index";

const PAYLOAD = {
  orgId: "org-a",
  artifactId: "art-1",
  representationRevisionId: "rep-1",
};
const ACTOR = buildArtifactMatcherActorContext({ orgId: "org-a" });

type PackDef = {
  pkgName: string;
  manifest: typeof marketingIcpArtifactManifest;
};
const PACK_DEFS: PackDef[] = [
  { pkgName: "@cinatra-ai/marketing-icp-artifact", manifest: marketingIcpArtifactManifest },
  { pkgName: "@cinatra-ai/marketing-strategy-artifact", manifest: marketingStrategyArtifactManifest },
  { pkgName: "@cinatra-ai/brand-voice-artifact", manifest: brandVoiceArtifactManifest },
  { pkgName: "@cinatra-ai/product-portfolio-artifact", manifest: productPortfolioArtifactManifest },
  { pkgName: "@cinatra-ai/sales-playbook-artifact", manifest: salesPlaybookArtifactManifest },
  { pkgName: "@cinatra-ai/competitive-analysis-artifact", manifest: competitiveAnalysisArtifactManifest },
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

describe("GTM pack — target-aware matcher integration", () => {
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

  // All 6 GTM extensions accept text/markdown + text/plain + application/pdf,
  // so a single text/markdown upload triggers ALL 6 candidates — the test
  // proves only the target lands a draft.

  it("text/markdown upload + target=marketing-icp → 6 LLM calls, 1 assert (ICP only)", async () => {
    stageAuthoritative("text/markdown");
    registerAllAsArtifactDefs();
    registerAllAsSkills();
    targetAwareLlmMock("@cinatra-ai/marketing-icp-artifact");
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    // Candidate cap admits all 6 GTM candidates, so each run performs 6 LLM calls.
    expect(runLlmMock).toHaveBeenCalledTimes(6);
    expect(assertSemanticTypeMock).toHaveBeenCalledTimes(1);
    expect(assertSemanticTypeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        extension: "@cinatra-ai/marketing-icp-artifact",
        assertedBy: "matcher",
      }),
    );
  });

  it("application/pdf upload + target=sales-playbook → all 6 candidates, 1 assert (sales-playbook)", async () => {
    stageAuthoritative("application/pdf");
    registerAllAsArtifactDefs();
    registerAllAsSkills();
    targetAwareLlmMock("@cinatra-ai/sales-playbook-artifact");
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    expect(runLlmMock).toHaveBeenCalledTimes(6);
    expect(assertSemanticTypeMock).toHaveBeenCalledTimes(1);
    expect(assertSemanticTypeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        extension: "@cinatra-ai/sales-playbook-artifact",
      }),
    );
  });

  // Floor invariant: no candidate matches → no draft.
  it("text/plain upload + ALL candidates return matches:false → NO draft asserts", async () => {
    stageAuthoritative("text/plain");
    registerAllAsArtifactDefs();
    registerAllAsSkills();
    runLlmMock.mockResolvedValue({
      text: JSON.stringify({ matches: false, confidence: 0.1 }),
    });
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    expect(runLlmMock).toHaveBeenCalledTimes(6);
    expect(assertSemanticTypeMock).not.toHaveBeenCalled();
  });

  // Threshold gate: confidence below 0.7 → no draft.
  it("text/markdown upload + target=brand-voice but confidence 0.5 < 0.7 → NO draft asserts", async () => {
    stageAuthoritative("text/markdown");
    registerAllAsArtifactDefs();
    registerAllAsSkills();
    runLlmMock.mockResolvedValue({
      text: JSON.stringify({ matches: true, confidence: 0.5 }),
    });
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    expect(assertSemanticTypeMock).not.toHaveBeenCalled();
  });

  // Regression coverage: two candidates BOTH clearing the threshold both land
  // drafts because exclusive matcher groups are not enforced here. This is
  // intentional: the floor invariant still holds because matcher assertions are
  // draft, not eligible; user confirmation resolves draft→eligible to a single
  // primary.
  it("two candidates BOTH passing → both draft (floor preserved by draft-not-eligible)", async () => {
    stageAuthoritative("text/markdown");
    registerAllAsArtifactDefs();
    registerAllAsSkills();
    runLlmMock.mockImplementation(async (input: { user: string }) => {
      // Both ICP and marketing-strategy clear the threshold.
      const targets = [
        "@cinatra-ai/marketing-icp-artifact",
        "@cinatra-ai/marketing-strategy-artifact",
      ];
      const matches = targets.some((t) => input.user.includes(t));
      return {
        text: JSON.stringify({
          matches,
          confidence: matches ? 0.85 : 0.1,
        }),
      };
    });
    await runArtifactMatch(PAYLOAD, { actorContext: ACTOR });
    // Both targets land matcher drafts because exclusivity is not enforced here.
    expect(assertSemanticTypeMock).toHaveBeenCalledTimes(2);
    const calls = assertSemanticTypeMock.mock.calls.map((c) => c[0].extension);
    expect(new Set(calls)).toEqual(
      new Set([
        "@cinatra-ai/marketing-icp-artifact",
        "@cinatra-ai/marketing-strategy-artifact",
      ]),
    );
    // Every assert is `assertedBy:"matcher"` — which the assertion store
    // maps to state `draft`. Floor invariant holds.
    for (const call of assertSemanticTypeMock.mock.calls) {
      expect(call[0].assertedBy).toBe("matcher");
    }
  });
});
