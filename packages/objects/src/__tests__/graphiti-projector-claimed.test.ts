// Claimed-row faceted projection (cinatra#1427 AC-3) + projection-policy
// stale-epoch fencing (AC-4) in the projector / outbox worker.
//
// AC-3: a row whose objects.type carries a WINNING artifact-type claim leaves
// the raw-data projection path — the episode body is the artifact-safe faceted
// shape (base type + claiming extension + effective identity + a capped,
// whitelist-only excerpt), NEVER a spread of row.data. The claim winner comes
// from the pure claims leaf; identity from the effective-identity service —
// both mocked here (the host reads have their own suites).
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
    identity: { kind: "default-artifact", selectable: false, assertionId: null },
    eligibleExtensions: [],
  })),
}));

import {
  projectObjectToGraphiti,
  processProjectionOutbox,
  projectClaimedRowFaceted,
  deriveClaimedRowExcerpt,
  CLAIMED_ROW_EXCERPT_FIELDS,
} from "../graphiti-projector";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { addEpisode } from "../graphiti-client";
import { readArtifactTypeClaimsForOrg } from "@/lib/objects/artifact-claim-store";
import { resolveArtifactEffectiveIdentity } from "@/lib/objects/effective-identity";

const runPg = runPostgresQueriesSync as unknown as ReturnType<typeof vi.fn>;
const addEp = addEpisode as unknown as ReturnType<typeof vi.fn>;
const readClaims = readArtifactTypeClaimsForOrg as unknown as ReturnType<typeof vi.fn>;
const resolveIdentity = resolveArtifactEffectiveIdentity as unknown as ReturnType<typeof vi.fn>;

const CLAIMED_TYPE = "@cinatra-ai/email:message";
const EMAIL_EXT = "@cinatra-ai/email-artifact";

function claim(over: Record<string, unknown> = {}) {
  return {
    id: "claim-1",
    scope: "platform",
    objectTypeId: CLAIMED_TYPE,
    claimKind: "dedicated",
    status: "active",
    extensionPackage: EMAIL_EXT,
    extensionVersion: "1.0.0",
    generation: 1,
    dispositions: null,
    installId: null,
    createdAt: null,
    updatedAt: null,
    ...over,
  };
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
    ...over,
  };
}

beforeEach(() => {
  runPg.mockReset();
  addEp.mockReset();
  readClaims.mockReset();
  resolveIdentity.mockReset();
  readClaims.mockReturnValue([]);
  resolveIdentity.mockReturnValue({
    identity: { kind: "default-artifact", selectable: false, assertionId: null },
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
        identityBasis: "binding",
        selectable: true,
        eligibleExtensions: [EMAIL_EXT],
      },
    );
    expect(body).toEqual({
      baseType: CLAIMED_TYPE,
      claimedBy: EMAIL_EXT,
      claimKind: "dedicated",
      claimGeneration: 2,
      primaryExtension: EMAIL_EXT,
      identityBasis: "binding",
      selectable: true,
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
        identityBasis: "catalog",
        selectable: false,
        eligibleExtensions: [],
      },
    );
    expect(body.primaryExtension).toBe(EMAIL_EXT);
    expect(body.selectable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// projectObjectToGraphiti — claimed rows leave the raw path.
// ---------------------------------------------------------------------------

describe("projectObjectToGraphiti — claimed typed row (AC-3)", () => {
  it("projects the FACETED shape (identity from the effective-identity service), never raw bytes", async () => {
    readClaims.mockReturnValue([claim()]);
    resolveIdentity.mockReturnValue({
      identity: { kind: "extension", extension: EMAIL_EXT, basis: "binding", selectable: true, assertionId: "sa-1" },
      eligibleExtensions: [EMAIL_EXT],
    });
    // readCanonicalRow returns the claimed row; every write mock returns ok.
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    runPg.mockReturnValueOnce([
      { rows: [claimedRow({ data: { subject: "Quarterly update", body: "hi", title: "Q3", rawBlob: "AAAABBBB", storageKey: "s3://bucket/secret" } })] },
    ]);

    const result = await projectObjectToGraphiti({ objectId: "obj-claimed", objectVersion: 1, orgId: "org-1" });

    expect(result.skipped).toBeUndefined();
    // The claim registry + identity service were consulted (no re-derivation).
    expect(readClaims).toHaveBeenCalledWith("org-1");
    expect(resolveIdentity).toHaveBeenCalledWith({ orgId: "org-1", artifactId: "obj-claimed", baseType: CLAIMED_TYPE });
    expect(addEp).toHaveBeenCalledTimes(1);

    const body = JSON.parse(addEp.mock.calls[0][0].episode_body);
    expect(body.baseType).toBe(CLAIMED_TYPE);
    expect(body.claimedBy).toBe(EMAIL_EXT);
    expect(body.primaryExtension).toBe(EMAIL_EXT);
    expect(body.identityBasis).toBe("binding");
    expect(body.selectable).toBe(true);
    expect(body.excerpt).toBe("Quarterly update");
    // The raw-data fields are absent — no bytes / storage keys reach Graphiti.
    expect(body.rawBlob).toBeUndefined();
    expect(body.storageKey).toBeUndefined();
    expect(addEp.mock.calls[0][0].episode_body).not.toContain("s3://bucket/secret");
  });

  it("disposition projection='none' → terminal skip (no episode, outbox settles)", async () => {
    readClaims.mockReturnValue([claim({ dispositions: { projection: "none" } })]);
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
    readClaims.mockReturnValue([claim({ dispositions: { projection: "raw" } })]);
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    runPg.mockReturnValueOnce([{ rows: [claimedRow({ data: { subject: "S", customField: "kept" } })] }]);

    await projectObjectToGraphiti({ objectId: "obj-claimed", objectVersion: 1, orgId: "org-1" });

    expect(addEp).toHaveBeenCalledTimes(1);
    const body = JSON.parse(addEp.mock.calls[0][0].episode_body);
    // Raw path: the row.data fields are present verbatim (opt-in).
    expect(body.customField).toBe("kept");
    expect(body.baseType).toBeUndefined(); // not faceted
  });

  it("invalid dispositions fail CLOSED to the faceted (metadata-only) shape, never up to raw", async () => {
    readClaims.mockReturnValue([claim({ dispositions: { projection: "totally-invalid" } })]);
    resolveIdentity.mockReturnValue({
      identity: { kind: "extension", extension: EMAIL_EXT, basis: "catalog", selectable: false, assertionId: null },
      eligibleExtensions: [],
    });
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    runPg.mockReturnValueOnce([{ rows: [claimedRow({ data: { subject: "S", secretBytes: "AAAA" } })] }]);

    await projectObjectToGraphiti({ objectId: "obj-claimed", objectVersion: 1, orgId: "org-1" });

    const body = JSON.parse(addEp.mock.calls[0][0].episode_body);
    expect(body.baseType).toBe(CLAIMED_TYPE); // faceted, not raw
    expect(body.secretBytes).toBeUndefined();
  });

  it("no winning claim → keeps the existing (raw / generic) path, identity service untouched", async () => {
    readClaims.mockReturnValue([]); // no claim for this type
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    runPg.mockReturnValueOnce([{ rows: [claimedRow({ data: { subject: "S", customField: "kept" } })] }]);

    await projectObjectToGraphiti({ objectId: "obj-claimed", objectVersion: 1, orgId: "org-1" });

    expect(resolveIdentity).not.toHaveBeenCalled();
    const body = JSON.parse(addEp.mock.calls[0][0].episode_body);
    expect(body.customField).toBe("kept"); // raw path (unclaimed non-artifact row)
  });

  it("generic artifact rows are never treated as claimed (claim registry not consulted)", async () => {
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]); // semantic_assertion read + markProjected
    runPg.mockReturnValueOnce([{ rows: [claimedRow({ type: "@cinatra-ai/artifact:object", data: {} })] }]); // readCanonicalRow

    await projectObjectToGraphiti({ objectId: "obj-claimed", objectVersion: 1, orgId: "org-1" });
    expect(readClaims).not.toHaveBeenCalled();
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
