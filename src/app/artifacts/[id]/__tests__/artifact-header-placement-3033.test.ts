/**
 * cinatra#3033 (CELL5, the header) — app-artifact-review §XI.12: "The mono line
 * names the placement, featured — the only placement the type declares."
 *
 * For an artifact whose own data names its post and the placement `featured`,
 * the summary the page hands the header carries that placement, and the header's
 * meta line carries exactly one more cell, `featured`, immediately after the
 * MIME cell. For every artifact whose data names no placement the line keeps its
 * existing cells exactly.
 *
 * The summary half reads through the exported detail reader over a mocked
 * object row (the harness of `artifact-object-authz-1428.test.ts`, its mocks
 * copied here); the header half is the pure model.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";

import { buildArtifactDetailHeader } from "../artifact-detail-header";

const listObjectsByFilter = vi.fn();
const getObjectById = vi.fn();
vi.mock("@/lib/objects-store", () => ({
  listObjectsByFilter: (...a: unknown[]) => listObjectsByFilter(...a),
  getObjectById: (...a: unknown[]) => getObjectById(...a),
}));
vi.mock("@/lib/artifacts/artifact-retention", () => ({
  tombstoneArtifact: vi.fn(),
}));
vi.mock("@/lib/artifacts/artifact-creation", () => ({
  createSemanticArtifact: vi.fn(),
}));
vi.mock("@/lib/artifacts/semantic-assertion-store", () => ({
  listEligibleAssertions: vi.fn().mockReturnValue([]),
  listEligibleAssertionsForArtifacts: vi.fn().mockReturnValue(new Map()),
  primaryExtensionFor: vi.fn().mockReturnValue(null),
  listActiveAssertions: vi.fn(),
  getAssertionByIdForReplay: vi.fn(),
  listArtifactIdsForExtension: vi.fn(),
}));
vi.mock("@/lib/artifacts/representation-store", () => ({
  listRepresentations: vi.fn(),
  getLatestRepresentation: vi.fn(),
  getRepresentationByIdForReplay: vi.fn(),
}));
vi.mock("@/lib/objects/effective-identity", () => ({
  resolveArtifactEffectiveIdentities: vi.fn().mockReturnValue(new Map()),
  resolveArtifactEffectiveIdentity: vi.fn().mockReturnValue({
    identity: { kind: "no-primary" },
    eligibleExtensions: [],
  }),
}));
vi.mock("@/lib/objects/presentation-identity", () => ({
  resolveArtifactPresentationIdentities: vi.fn().mockReturnValue(new Map()),
  resolveArtifactPresentationIdentity: vi.fn().mockReturnValue({
    identity: { kind: "no-primary" },
    tier: "claim-backed",
    suggestions: [],
  }),
}));
vi.mock("@/lib/register-all-object-types", () => ({
  registerAllObjectTypes: vi.fn(),
}));

const MOCKED_MODULES = [
  "@/lib/objects-store",
  "@/lib/artifacts/artifact-retention",
  "@/lib/artifacts/artifact-creation",
  "@/lib/artifacts/semantic-assertion-store",
  "@/lib/artifacts/representation-store",
  "@/lib/objects/effective-identity",
  "@/lib/objects/presentation-identity",
  "@/lib/register-all-object-types",
];

const BLOG_IMAGE_TYPE = "@cinatra-ai/blog-image-artifact:blog-image";
const BLOG_IMAGE_PACK = "@cinatra-ai/blog-image-artifact";
const POST_ID = "3f1b6c2e-0d7a-4e5b-9c11-2a4d6e8f0b13";

function imageRow(data: Record<string, unknown>) {
  return {
    id: "img-1",
    type: BLOG_IMAGE_TYPE,
    data: {
      artifactType: "file",
      title: "featured.png",
      mime: "image/png",
      size: 1,
      originKind: "agent",
      latestRepresentationRevisionId: "rev_9ac3d1e2",
      ...data,
    },
    createdAt: "2026-09-02T17:00:00.000Z",
    updatedAt: "2026-09-02T17:52:00.000Z",
    orgId: "org-1",
    ownerLevel: "team",
    ownerId: "team_1",
    visibility: "private",
    projectId: null,
  };
}

describe("the summary carries the placement the image's own data names (cinatra#3033)", () => {
  beforeEach(() => {
    getObjectById.mockReset();
    objectTypeRegistry.register(
      {
        type: BLOG_IMAGE_TYPE,
        category: "content",
        isArtifact: { accepts: { file: { mimeTypes: ["image/png"] } } },
      } as never,
      BLOG_IMAGE_PACK,
    );
  });
  afterEach(() => {
    objectTypeRegistry.removeByPackage(BLOG_IMAGE_PACK);
    vi.resetModules();
  });
  afterAll(() => {
    for (const m of MOCKED_MODULES) vi.doUnmock(m);
    vi.resetModules();
  });

  it("projects placement featured for a row whose data names its post and that placement", async () => {
    getObjectById.mockReturnValue(imageRow({ post: POST_ID, placement: "featured" }));
    const { readArtifactForDetail } = await import("@/lib/artifacts/artifact-service");
    const read = readArtifactForDetail({ artifactId: "img-1", orgId: null });
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    expect(read.artifact.placement).toBe("featured");
  });

  it("projects no placement for a row whose data names none", async () => {
    getObjectById.mockReturnValue(imageRow({}));
    const { readArtifactForDetail } = await import("@/lib/artifacts/artifact-service");
    const read = readArtifactForDetail({ artifactId: "img-1", orgId: null });
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    expect(read.artifact.placement).toBeUndefined();
    expect("placement" in read.artifact).toBe(false);
  });
});

const NOW = new Date("2026-09-02T18:00:00.000Z");

function summary(over: Partial<ArtifactSummary> = {}): ArtifactSummary {
  return {
    artifactId: "img-1",
    latestRepresentationRevisionId: "rev_9ac3d1e2",
    objectType: BLOG_IMAGE_TYPE,
    artifactType: "file",
    title: "featured.png",
    mime: "image/png",
    size: 1,
    originKind: "agent",
    createdAt: "2026-09-02T17:00:00.000Z",
    updatedAt: "2026-09-02T17:52:00.000Z",
    ownerLevel: "team",
    visibility: "private",
    ownerId: "team_1",
    organizationId: "org-1",
    projectId: null,
    eligibleExtensions: [],
    primaryExtension: BLOG_IMAGE_PACK,
    effectiveIdentity: { kind: "extension", extension: BLOG_IMAGE_PACK },
    presentationIdentity: { kind: "extension", extension: BLOG_IMAGE_PACK },
    presentationSuggestions: [],
    sourceUrl: null,
    ...over,
  } as ArtifactSummary;
}

const SIX_CELLS = [
  BLOG_IMAGE_TYPE,
  "revision rev_9ac3…",
  "Team",
  "Private",
  "image/png",
  "updated 8 minutes ago",
];

describe("the header's mono line names the placement after the MIME cell (cinatra#3033)", () => {
  it("draws seven cells, the one after the MIME cell exactly `featured`", () => {
    const model = buildArtifactDetailHeader({
      artifact: summary({ placement: "featured" }),
      mime: "image/png",
      revisionId: "rev_9ac3d1e2",
      now: NOW,
    });
    expect(model.metaCells).toHaveLength(7);
    const mimeAt = model.metaCells.indexOf("image/png");
    expect(model.metaCells[mimeAt + 1]).toBe("featured");
    expect(model.metaCells).toEqual([
      BLOG_IMAGE_TYPE,
      "revision rev_9ac3…",
      "Team",
      "Private",
      "image/png",
      "featured",
      "updated 8 minutes ago",
    ]);
  });

  it("keeps the same six cells for the same summary without a placement", () => {
    const model = buildArtifactDetailHeader({
      artifact: summary(),
      mime: "image/png",
      revisionId: "rev_9ac3d1e2",
      now: NOW,
    });
    expect(model.metaCells).toEqual(SIX_CELLS);
  });
});
