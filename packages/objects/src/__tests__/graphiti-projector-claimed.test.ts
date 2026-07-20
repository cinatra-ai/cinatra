// Claimed-row faceted projection (cinatra#1427 AC-3; epic #1785 type-driven
// cutover) + projection-policy stale-epoch fencing (AC-4) in the projector /
// outbox worker.
//
// AC-3: a row whose objects.type is a DISPOSITION-GOVERNED type leaves the
// raw-data projection path — the episode body is the artifact-safe faceted shape
// (base type + registering extension + effective identity + a capped,
// whitelist-only excerpt), NEVER a spread of row.data. The disposition now comes
// from the type-driven registry resolver (epic #1785), not a DB claim winner;
// identity from the effective-identity service (mocked here — the host reads
// have their own suites).
//
// AC-4 (worker half): an outbox item STAMPED with an epoch older than the
// group's current projection-policy epoch is discarded terminally (settled
// 'done'), never projected.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/postgres-sync", () => ({ runPostgresQueriesSync: vi.fn() }));
vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "cinatra",
}));
vi.mock("../graphiti-client", () => ({
  addEpisode: vi.fn(),
  deleteEpisode: vi.fn(),
  identityHashToUuid: (h: string) => h,
}));
vi.mock("@/lib/objects/artifact-claim-store", () => ({
  readArtifactTypeClaimsForOrg: vi.fn(() => []),
}));
vi.mock("@/lib/objects/effective-identity", () => ({
  resolveArtifactEffectiveIdentity: vi.fn(() => ({
    identity: { kind: "no-primary" },
    eligibleExtensions: [],
  })),
}));

import { z } from "zod";

import {
  projectObjectToGraphiti,
  processProjectionOutbox,
  projectClaimedRowFaceted,
  deriveClaimedRowExcerpt,
  CLAIMED_ROW_EXCERPT_FIELDS,
} from "../graphiti-projector";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { addEpisode } from "../graphiti-client";
import { resolveArtifactEffectiveIdentity } from "@/lib/objects/effective-identity";
import { objectTypeRegistry } from "../registry";
import type { TypeProjectionDisposition } from "../types";

const runPg = runPostgresQueriesSync as unknown as ReturnType<typeof vi.fn>;
const addEp = addEpisode as unknown as ReturnType<typeof vi.fn>;
const resolveIdentity = resolveArtifactEffectiveIdentity as unknown as ReturnType<typeof vi.fn>;

const CLAIMED_TYPE = "@cinatra-ai/email:message";
const EMAIL_EXT = "@cinatra-ai/email-artifact";

// Register CLAIMED_TYPE as a disposition-GOVERNED type in the type-driven
// registry (the authority the retirement replaced the DB claim with). `pkg` is
// the registering (single-definer) extension the faceted body names.
function registerClaimed(
  projection: TypeProjectionDisposition,
  pkg: string | null = EMAIL_EXT,
  type = CLAIMED_TYPE,
) {
  objectTypeRegistry.register(
    {
      type,
      category: "report",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent"], mutableBy: ["agent"] },
      renderers: { listRow: null, card: null, detail: null },
      dispositions: { projection },
    },
    pkg ?? undefined,
  );
}

function claimedRow(over: Record<string, unknown> = {}) {
  return {
    id: "obj-claimed",
    type: CLAIMED_TYPE,
    data: { subject: "Quarterly update", body: "hello world", title: "Q3" },
    version: 1,
    org_id: "org-1",
    run_id: null,
    agent_id: null,
    graphiti_episode_uuid: null,
    graphiti_projected_version: null,
    source: "route",
    created_at: "2026-01-01T00:00:00Z",
    // Canonical scope columns (post-#1428, always populated). A faceted claimed
    // row now nests under a scope-derived lane exactly like memory (#1436): an
    // org-visible row lands the ambient org lane, so these fixtures keep
    // projecting (the faceted-body assertions are lane-agnostic). Lane
    // derivation itself is exercised in graphiti-projector-artifact-lanes.test.ts.
    owner_level: "organization",
    owner_id: "org-1",
    visibility: "organization",
    project_id: null,
    projected_group_id: null,
    ...over,
  };
}

beforeEach(() => {
  objectTypeRegistry._clearForTests();
  runPg.mockReset();
  addEp.mockReset();
  resolveIdentity.mockReset();
  resolveIdentity.mockReturnValue({
    identity: { kind: "no-primary" },
    eligibleExtensions: [],
  });
});

// ---------------------------------------------------------------------------
// Pure faceting helpers.
// ---------------------------------------------------------------------------

describe("deriveClaimedRowExcerpt — whitelist + cap", () => {
  it("picks the first non-empty whitelisted STRING field in priority order", () => {
    expect(deriveClaimedRowExcerpt({ summary: "S", subject: "SUB" })).toBe("S");
    expect(deriveClaimedRowExcerpt({ subject: "SUB", body: "B" })).toBe("SUB");
    expect(deriveClaimedRowExcerpt({ title: "T" })).toBe("T");
  });

  it("ignores non-whitelisted fields (bytes / storage keys never leak)", () => {
    expect(deriveClaimedRowExcerpt({ bytesBase64: "AAAA", storageKey: "s3://x" })).toBeUndefined();
    expect(CLAIMED_ROW_EXCERPT_FIELDS).not.toContain("bytesBase64");
    expect(CLAIMED_ROW_EXCERPT_FIELDS).not.toContain("storageKey");
  });

  it("caps the excerpt at 2000 chars", () => {
    const long = "x".repeat(5000);
    expect(deriveClaimedRowExcerpt({ subject: long })!.length).toBe(2000);
  });

  it("ignores non-string values", () => {
    expect(deriveClaimedRowExcerpt({ subject: 42 as unknown as string, body: "B" })).toBe("B");
  });
});

describe("projectClaimedRowFaceted — whitelist-only shape", () => {
  it("emits only faceted metadata; never spreads row.data (no bytes/storage keys)", () => {
    const body = projectClaimedRowFaceted(
      { subject: "Hi", bytesBase64: "AAAA", storageKey: "s3://secret", title: "T", name: "N" },
      {
        baseType: CLAIMED_TYPE,
        claimingExtension: EMAIL_EXT,
        claimKind: "dedicated",
        claimGeneration: 2,
        effectiveExtension: EMAIL_EXT,
        eligibleExtensions: [EMAIL_EXT],
      },
    );
    expect(body).toEqual({
      baseType: CLAIMED_TYPE,
      claimedBy: EMAIL_EXT,
      claimKind: "dedicated",
      claimGeneration: 2,
      primaryExtension: EMAIL_EXT,
      eligibleExtensions: [EMAIL_EXT],
      title: "T",
      excerpt: "Hi",
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("bytesBase64");
    expect(serialized).not.toContain("storageKey");
    expect(serialized).not.toContain("s3://secret");
  });

  it("primaryExtension falls back to the claiming extension when identity is not an extension", () => {
    const body = projectClaimedRowFaceted(
      { title: "T" },
      {
        baseType: CLAIMED_TYPE,
        claimingExtension: EMAIL_EXT,
        claimKind: "dedicated",
        claimGeneration: 1,
        effectiveExtension: null,
        eligibleExtensions: [],
      },
    );
    expect(body.primaryExtension).toBe(EMAIL_EXT);
  });
});

// ---------------------------------------------------------------------------
// projectObjectToGraphiti — claimed rows leave the raw path.
// ---------------------------------------------------------------------------

describe("projectObjectToGraphiti — governed typed row (AC-3, type-driven)", () => {
  it("projects the FACETED shape (identity from the effective-identity service), never raw bytes", async () => {
    registerClaimed("artifact-safe");
    resolveIdentity.mockReturnValue({
      identity: { kind: "extension", extension: EMAIL_EXT },
      eligibleExtensions: [EMAIL_EXT],
    });
    // readCanonicalRow returns the claimed row; every write mock returns ok.
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    runPg.mockReturnValueOnce([
      { rows: [claimedRow({ data: { subject: "Quarterly update", body: "hi", title: "Q3", rawBlob: "AAAABBBB", storageKey: "s3://bucket/secret" } })] },
    ]);

    const result = await projectObjectToGraphiti({ objectId: "obj-claimed", objectVersion: 1, orgId: "org-1" });

    expect(result.skipped).toBeUndefined();
    // The identity service was consulted (no re-derivation).
    expect(resolveIdentity).toHaveBeenCalledWith({ orgId: "org-1", artifactId: "obj-claimed", baseType: CLAIMED_TYPE });
    expect(addEp).toHaveBeenCalledTimes(1);

    const body = JSON.parse(addEp.mock.calls[0][0].episode_body);
    expect(body.baseType).toBe(CLAIMED_TYPE);
    // claimedBy is the type's REGISTERING (single-definer) extension from the
    // registry (no DB claim winner under the type-driven model).
    expect(body.claimedBy).toBe(EMAIL_EXT);
    expect(body.claimKind).toBe("dedicated");
    expect(body.primaryExtension).toBe(EMAIL_EXT);
    expect(body.excerpt).toBe("Quarterly update");
    // The raw-data fields are absent — no bytes / storage keys reach Graphiti.
    expect(body.rawBlob).toBeUndefined();
    expect(body.storageKey).toBeUndefined();
    expect(addEp.mock.calls[0][0].episode_body).not.toContain("s3://bucket/secret");
  });

  it("a host-registered type (no package provenance) names its NAMESPACE package as claimedBy", async () => {
    // Registered without a package arg — the faceted body falls back to the id's
    // namespace-defining package.
    registerClaimed("artifact-safe", null);
    resolveIdentity.mockReturnValue({
      identity: { kind: "extension", extension: "@cinatra-ai/email" },
      eligibleExtensions: ["@cinatra-ai/email"],
    });
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    runPg.mockReturnValueOnce([{ rows: [claimedRow()] }]);

    await projectObjectToGraphiti({ objectId: "obj-claimed", objectVersion: 1, orgId: "org-1" });
    const body = JSON.parse(addEp.mock.calls[0][0].episode_body);
    expect(body.claimedBy).toBe("@cinatra-ai/email");
  });

  it("disposition projection='none' → terminal skip (no episode, outbox settles)", async () => {
    registerClaimed("none");
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    runPg.mockReturnValueOnce([{ rows: [claimedRow()] }]);

    const result = await projectObjectToGraphiti({ objectId: "obj-claimed", objectVersion: 1, orgId: "org-1" });

    expect(result.skipped).toBe(true);
    expect(result.episodeUuid).toBeNull();
    expect(addEp).not.toHaveBeenCalled();
    // No effective-identity read for a never-projected type.
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it("disposition projection='raw' → explicit raw opt-in keeps the raw-data body", async () => {
    registerClaimed("raw");
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    runPg.mockReturnValueOnce([{ rows: [claimedRow({ data: { subject: "S", customField: "kept" } })] }]);

    await projectObjectToGraphiti({ objectId: "obj-claimed", objectVersion: 1, orgId: "org-1" });

    expect(addEp).toHaveBeenCalledTimes(1);
    const body = JSON.parse(addEp.mock.calls[0][0].episode_body);
    // Raw path: the row.data fields are present verbatim (opt-in).
    expect(body.customField).toBe("kept");
    expect(body.baseType).toBeUndefined(); // not faceted
  });

  it("an invalid declared projection fails CLOSED to the faceted (metadata-only) shape, never up to raw", async () => {
    registerClaimed("totally-invalid" as unknown as TypeProjectionDisposition);
    resolveIdentity.mockReturnValue({
      identity: { kind: "extension", extension: EMAIL_EXT },
      eligibleExtensions: [],
    });
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    runPg.mockReturnValueOnce([{ rows: [claimedRow({ data: { subject: "S", secretBytes: "AAAA" } })] }]);

    await projectObjectToGraphiti({ objectId: "obj-claimed", objectVersion: 1, orgId: "org-1" });

    const body = JSON.parse(addEp.mock.calls[0][0].episode_body);
    expect(body.baseType).toBe(CLAIMED_TYPE); // faceted, not raw
    expect(body.secretBytes).toBeUndefined();
  });

  it("an UNGOVERNED type (no declared disposition) keeps the existing (raw / generic) path, identity service untouched", async () => {
    // Registered, but declares NO disposition — ungoverned, keeps the raw path.
    objectTypeRegistry.register({
      type: CLAIMED_TYPE,
      category: "report",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent"], mutableBy: ["agent"] },
      renderers: { listRow: null, card: null, detail: null },
    });
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    runPg.mockReturnValueOnce([{ rows: [claimedRow({ data: { subject: "S", customField: "kept" } })] }]);

    await projectObjectToGraphiti({ objectId: "obj-claimed", objectVersion: 1, orgId: "org-1" });

    expect(resolveIdentity).not.toHaveBeenCalled();
    const body = JSON.parse(addEp.mock.calls[0][0].episode_body);
    expect(body.customField).toBe("kept"); // raw path (ungoverned data row)
  });

  it("generic artifact rows are never treated as governed (own artifact-safe branch)", async () => {
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]); // semantic_assertion read + markProjected
    runPg.mockReturnValueOnce([{ rows: [claimedRow({ type: "@cinatra-ai/artifact:object", data: {} })] }]); // readCanonicalRow

    await projectObjectToGraphiti({ objectId: "obj-claimed", objectVersion: 1, orgId: "org-1" });
    // The generic type has its own projectArtifactSafe branch; the identity
    // service is not consulted via the governed-row path.
    expect(resolveIdentity).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// processProjectionOutbox — stale-epoch fencing (AC-4 worker half).
// ---------------------------------------------------------------------------

describe("processProjectionOutbox — stale-epoch fencing", () => {
  const stampedRow = (epoch: number | null) => ({
    id: "ob-1",
    object_id: "obj-x",
    object_version: 1,
    org_id: "org-1",
    operation: "upsert",
    payload_hash: null,
    attempts: 0,
    projection_epoch: epoch,
  });

  it("discards an outbox item whose stamped epoch is older than the group's current epoch", async () => {
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]); // default (discard write etc.)
    runPg.mockReturnValueOnce([{ rows: [] }]); // recovery of stuck 'processing'
    runPg.mockReturnValueOnce([{ rows: [stampedRow(1)] }]); // claim batch
    runPg.mockReturnValueOnce([{ rows: [{ group_id: "cinatra-org-org-1", epoch: 2 }] }]); // readProjectionEpochs

    const result = await processProjectionOutbox({ batchSize: 20, maxAttempts: 5 });

    expect(addEp).not.toHaveBeenCalled();
    expect(result.processed).toBe(1);
    const discard = runPg.mock.calls.find((c) => /stale-epoch item discarded/i.test(c[0]?.queries?.[0]?.text ?? ""));
    expect(discard).toBeDefined();
  });

  it("a NULL-epoch (ordinary write-path) item is never fenced — no policy epoch read", async () => {
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    runPg.mockReturnValueOnce([{ rows: [] }]); // recovery
    runPg.mockReturnValueOnce([{ rows: [] }]); // claim batch: empty (no stamped rows)

    await processProjectionOutbox({ batchSize: 20, maxAttempts: 5 });
    // No graphiti_projection_policy read issued when nothing is stamped.
    const policyRead = runPg.mock.calls.find((c) =>
      /graphiti_projection_policy/i.test(c[0]?.queries?.[0]?.text ?? ""),
    );
    expect(policyRead).toBeUndefined();
  });
});
