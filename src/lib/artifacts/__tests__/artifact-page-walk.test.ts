/**
 * cinatra#3031 (epic #3023 W7) — the LISTING PAGE's walk, under the canonical
 * `object.read` post-filter.
 *
 * Plan (C) enabler 0.26: "the listing gains a filter by type and a cursor in
 * place of its flat cap." A cursor that reports the end of the listing while
 * readable rows are still below it is worse than the flat cap it replaces: the
 * caller has no way of ever reaching them.
 *
 * The store is mocked (no DB) so the SQL limit and the JS authorization filter
 * can be driven against each other, which is where the false end lives: the
 * per-type limit is applied in SQL and the kernel decision afterwards in JS.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const listObjectsByFilter = vi.fn();
const getObjectById = vi.fn();

vi.mock("@/lib/objects-store", () => ({
  listObjectsByFilter: (...a: unknown[]) => listObjectsByFilter(...a),
  getObjectById: (...a: unknown[]) => getObjectById(...a),
}));
vi.mock("../artifact-retention", () => ({ tombstoneArtifact: vi.fn() }));
vi.mock("../artifact-creation", () => ({ createSemanticArtifact: vi.fn() }));
vi.mock("../semantic-assertion-store", () => ({
  listEligibleAssertions: vi.fn().mockReturnValue([]),
  listEligibleAssertionsForArtifacts: vi.fn().mockReturnValue(new Map()),
  primaryExtensionFor: vi.fn().mockReturnValue("@cinatra-ai/default-artifact"),
  listActiveAssertions: vi.fn(),
  getAssertionByIdForReplay: vi.fn(),
  listArtifactIdsForExtension: vi.fn(),
}));
vi.mock("../representation-store", () => ({
  listRepresentations: vi.fn(),
  getLatestRepresentation: vi.fn(),
  getRepresentationByIdForReplay: vi.fn(),
}));
vi.mock("@/lib/objects/effective-identity", () => ({
  resolveArtifactEffectiveIdentities: vi.fn().mockReturnValue(new Map()),
  resolveArtifactEffectiveIdentity: vi.fn().mockReturnValue({
    identity: { kind: "default-artifact", selectable: false, assertionId: null },
    eligibleExtensions: [],
  }),
}));
// Presentation identity is a SECOND identity pass, and the live one opens a
// Postgres session: it calls `ensurePostgresSchema()` before its batched read.
// This is a unit suite — it must never reach a database — so the resolver is
// mocked beside the effective-identity mock above. The empty map and the base
// identity are what a row with no active assertion resolves to on the live
// path, which is what every row in this suite is (cinatra#3254).
vi.mock("@/lib/objects/presentation-identity", () => ({
  resolveArtifactPresentationIdentities: vi.fn().mockReturnValue(new Map()),
  resolveArtifactPresentationIdentity: vi.fn().mockReturnValue({
    identity: { kind: "default-artifact", selectable: false, assertionId: null },
    tier: "claim-backed",
    suggestions: [],
  }),
}));
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: vi.fn() }));

import type { ActorContext } from "@/lib/authz/actor-context";

const ORG = "org-A";
const ARTIFACT_TYPE = "@cinatra-ai/artifact:object";

type Row = ReturnType<typeof row>;

function row(id: string, createdAt: string, orgId = ORG) {
  return {
    id,
    type: ARTIFACT_TYPE,
    data: { artifactType: "file", title: id, mime: "x/y", size: 1, originKind: "upload" },
    createdAt,
    updatedAt: createdAt,
    orgId,
    ownerLevel: "organization",
    ownerId: orgId,
    visibility: "org",
    projectId: null,
  };
}

function member(): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "u1",
    organizationId: ORG,
    orgRole: "member",
    platformRole: "member",
    authSource: "ui",
    policyVersion: "test",
  } as ActorContext;
}

/** A store that honours `limit` and the `(created_at, id)` keyset, as SQL does. */
function serve(all: readonly Row[]) {
  const ordered = [...all].sort((a, b) =>
    a.createdAt === b.createdAt
      ? a.id < b.id
        ? 1
        : -1
      : a.createdAt < b.createdAt
        ? 1
        : -1,
  );
  listObjectsByFilter.mockImplementation((filter: { limit?: number; before?: { createdAt: string; id: string } }) => {
    let rows = ordered;
    if (filter.before) {
      const b = filter.before;
      rows = rows.filter((r) =>
        r.createdAt === b.createdAt ? r.id < b.id : r.createdAt < b.createdAt,
      );
    }
    return typeof filter.limit === "number" ? rows.slice(0, filter.limit) : rows;
  });
}

describe("the listing page walks past rows the kernel denies (cinatra#3031)", () => {
  beforeEach(() => {
    listObjectsByFilter.mockReset();
    getObjectById.mockReset();
  });

  it("a first scan whose rows are ALL denied is not the end of the listing", async () => {
    const { listArtifactsPage } = await import("../artifact-service");
    // Four newer rows belong to another organisation (the kernel denies each);
    // the readable one is the OLDEST, below the first scan's window.
    serve([
      row("d1", "2026-01-05T00:00:00Z", "org-B"),
      row("d2", "2026-01-04T00:00:00Z", "org-B"),
      row("d3", "2026-01-03T00:00:00Z", "org-B"),
      row("d4", "2026-01-02T00:00:00Z", "org-B"),
      row("keep", "2026-01-01T00:00:00Z"),
    ]);
    const page = listArtifactsPage({ orgId: ORG, actor: member(), limit: 2 });
    expect(page.artifacts.map((a) => a.artifactId)).toEqual(["keep"]);
    // Nothing is left below it, so the listing IS exhausted here.
    expect(page.nextCursor).toBeNull();
  });

  it("every readable row is reached exactly once across the pages", async () => {
    const { listArtifactsPage } = await import("../artifact-service");
    serve([
      row("d1", "2026-01-09T00:00:00Z", "org-B"),
      row("k1", "2026-01-08T00:00:00Z"),
      row("d2", "2026-01-07T00:00:00Z", "org-B"),
      row("k2", "2026-01-06T00:00:00Z"),
      row("d3", "2026-01-05T00:00:00Z", "org-B"),
      row("k3", "2026-01-04T00:00:00Z"),
    ]);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i += 1) {
      const page: { artifacts: { artifactId: string }[]; nextCursor: string | null } =
        listArtifactsPage({ orgId: ORG, actor: member(), limit: 2, cursor });
      seen.push(...page.artifacts.map((a) => a.artifactId));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(["k1", "k2", "k3"]);
    expect(cursor).toBeNull();
  });

  it("refuses a cursor whose timestamp is not one — rather than handing it to the store", async () => {
    const { listArtifactsPage, ArtifactCursorRefusal, decodeArtifactCursor } = await import(
      "../artifact-service"
    );
    serve([row("k1", "2026-01-01T00:00:00Z")]);
    const forged = Buffer.from(JSON.stringify({ c: "not-a-date", i: "x" }), "utf8").toString(
      "base64url",
    );
    expect(decodeArtifactCursor(forged)).toBeNull();
    expect(() => listArtifactsPage({ orgId: ORG, actor: member(), cursor: forged })).toThrow(
      ArtifactCursorRefusal,
    );
  });
});
