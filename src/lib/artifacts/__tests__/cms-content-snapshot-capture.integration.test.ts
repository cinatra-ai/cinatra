/**
 * cinatra#2043 (epic #2037 S5) - REAL-DB proof of the CMS capture writer against
 * real DDL + constraints. Mirrors the object-content-snapshot integration suite's
 * isolation: a FRESH schema per file from the canonical
 * `buildCreateStoreSchemaQueries` DDL, a temp blob root, every app module
 * dynamically imported in beforeAll AFTER the env is set. Guarded by
 * `describe.skipIf(!HAS_REAL_DB)`.
 *
 *   L1  capture (fence ON) lands the ONE-tx triple ATOMICALLY: the snapshot
 *       rows (resource + artifact_blobs + representation) + the produced event
 *       + the cms_snapshot_targets apply-binding row.
 *   FENCE-OFF  capture with the caller-level fence off writes the real artifact +
 *       apply binding but NO produced event.
 *   ROLLBACK  a failure anywhere in the composed op list rolls back EVERYTHING
 *       (nothing partial) - the S0 same-tx atomicity guarantee.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";

vi.mock("@/lib/database", async () => {
  const cfg = await import("@/lib/postgres-config");
  return {
    readMetadataValueFromDatabase: (_key: string, fallback: unknown) => fallback,
    writeMetadataValueToDatabase: () => {},
    getPostgresConnectionString: cfg.getPostgresConnectionString,
    postgresSchema: cfg.postgresSchema,
    ensurePostgresSchema: () => {},
  };
});
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");
const TEST_SCHEMA = "cinatra_test_cms_capture_2043";
const ORG = "org-cms-2043";

let uniq = 0;
const nextId = (p: string) => `${p}-${Date.now()}-${uniq++}`;

let runPostgresQueriesSync: typeof import("@/lib/postgres-sync").runPostgresQueriesSync;
let getPostgresConnectionString: typeof import("@/lib/postgres-config").getPostgresConnectionString;
let captureMod: typeof import("@/lib/artifacts/cms-content-snapshot-capture");
let producedEventMod: typeof import("@/lib/lifecycle/lifecycle-produced-event");

const S = () => TEST_SCHEMA;

function sql(text: string, values: unknown[] = []) {
  return runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  })[0];
}
function count(table: string, where: string, values: unknown[]): number {
  const r = sql(`SELECT count(*)::int AS n FROM "${S()}"."${table}" WHERE ${where}`, values);
  return Number((r.rows?.[0] as { n: number }).n);
}

const pointer = {
  url: "https://example.com/wp/?p=42",
  connectorId: "wordpress-mcp-connector",
  externalId: "42",
  state: "linked" as const,
  title: "Hello Post",
};

beforeAll(async () => {
  if (!HAS_REAL_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  process.env.CINATRA_ARTIFACT_DATA_ROOT = mkdtempSync(path.join(tmpdir(), "cin-2043-"));

  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
  await client.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    const head = qy.text.trim().slice(0, 6).toUpperCase();
    if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") continue;
    try {
      await client.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("does not exist")) throw err;
    }
  }
  await client.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

  ({ runPostgresQueriesSync } = await import("@/lib/postgres-sync"));
  ({ getPostgresConnectionString } = await import("@/lib/postgres-config"));
  captureMod = await import("@/lib/artifacts/cms-content-snapshot-capture");
  producedEventMod = await import("@/lib/lifecycle/lifecycle-produced-event");
});

afterAll(async () => {
  if (!HAS_REAL_DB) return;
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
  await client.end().catch(() => {});
  const root = process.env.CINATRA_ARTIFACT_DATA_ROOT;
  if (root) rmSync(root, { recursive: true, force: true });
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_REAL_DB)("cinatra#2043 CMS capture writer (real DB + disk)", () => {
  it("L1: capture (fence ON) lands the one-tx triple atomically - snapshot rows + produced event + apply-binding row", async () => {
    const operationId = nextId("op");
    const runId = nextId("run");
    const res = await captureMod.captureCmsContentSnapshot({
      orgId: ORG,
      pointer,
      resolved: { mime: "text/html", text: "<h1>Original</h1><p>body</p>" },
      capturedAt: new Date().toISOString(),
      scopeManifest: { paths: ["title", "body"] },
      connectorInstance: "wordpress-mcp-connector:inst-1",
      resourceType: "post",
      cmsResourceId: "42",
      baseRemoteRevisionRef: "etag-1",
      operationId,
      producerRunId: runId,
      producerAgentId: "agent-1",
      emitProducedEvent: true,
    });

    // The snapshot's objects row (the artifact identity the gate pins / classifies).
    expect(count("objects", "id=$1 AND org_id=$2 AND type=$3", [res.artifactId, ORG, "@cinatra-ai/objects:cms-content-snapshot"])).toBe(1);
    // The snapshot rows.
    expect(count("resource", "id=$1 AND org_id=$2", [res.resourceId, ORG])).toBe(1);
    expect(
      count("representation", "id=$1 AND org_id=$2 AND artifact_id=$3", [
        res.snapshotRevisionId,
        ORG,
        res.artifactId,
      ]),
    ).toBe(1);
    expect(count("artifact_blobs", "org_id=$1 AND size_bytes=$2", [ORG, res.sizeBytes])).toBe(1);

    // The produced event, same tx, deterministic id, enumerated emitter, external_publish.
    const expectedEventId = producedEventMod.producedEventId(res.artifactId, res.snapshotRevisionId);
    expect(res.producedEventId).toBe(expectedEventId);
    const ev = sql(
      `SELECT emitter, destination_class, status, org_id FROM "${S()}"."artifact_produced_outbox" WHERE event_id=$1`,
      [expectedEventId],
    );
    expect((ev.rows ?? []).length).toBe(1);
    const evRow = ev.rows[0] as { emitter: string; destination_class: string; status: string; org_id: string };
    expect(evRow.emitter).toBe("object_cms_snapshot_capture");
    expect(evRow.destination_class).toBe("external_publish");
    expect(evRow.status).toBe("pending");
    expect(evRow.org_id).toBe(ORG);

    // The apply-binding row with the stored scope manifest.
    const tgt = sql(
      `SELECT scope_manifest, connector_instance, resource_type, resource_id, base_remote_revision_ref, snapshot_revision_id
         FROM "${S()}"."cms_snapshot_targets" WHERE operation_id=$1`,
      [operationId],
    );
    expect((tgt.rows ?? []).length).toBe(1);
    const tgtRow = tgt.rows[0] as {
      scope_manifest: { paths: string[] };
      connector_instance: string;
      resource_type: string;
      resource_id: string;
      base_remote_revision_ref: string;
      snapshot_revision_id: string;
    };
    expect(tgtRow.scope_manifest).toEqual({ paths: ["title", "body"] });
    expect(tgtRow.connector_instance).toBe("wordpress-mcp-connector:inst-1");
    expect(tgtRow.resource_type).toBe("post");
    expect(tgtRow.resource_id).toBe("42");
    expect(tgtRow.base_remote_revision_ref).toBe("etag-1");
    expect(tgtRow.snapshot_revision_id).toBe(res.snapshotRevisionId);
  });

  it("FENCE-OFF: capture with the caller-level fence off writes the artifact + apply binding but NO produced event", async () => {
    const operationId = nextId("op");
    const res = await captureMod.captureCmsContentSnapshot({
      orgId: ORG,
      pointer,
      resolved: { mime: "text/html", text: "<h1>Fenced off</h1>" },
      capturedAt: new Date().toISOString(),
      scopeManifest: { paths: ["title"] },
      connectorInstance: "wordpress-mcp-connector:inst-1",
      resourceType: "post",
      operationId,
      emitProducedEvent: false,
    });
    expect(res.producedEventId).toBeNull();
    // Representation + apply-binding present.
    expect(
      count("representation", "id=$1 AND artifact_id=$2", [res.snapshotRevisionId, res.artifactId]),
    ).toBe(1);
    expect(count("cms_snapshot_targets", "operation_id=$1", [operationId])).toBe(1);
    // No outbox row for this artifact.
    const expectedEventId = producedEventMod.producedEventId(res.artifactId, res.snapshotRevisionId);
    expect(count("artifact_produced_outbox", "event_id=$1", [expectedEventId])).toBe(0);
  });

  it("idempotent on operation_id: a re-capture of the same operation leaves exactly one apply-binding row", async () => {
    const operationId = nextId("op");
    const base = {
      orgId: ORG,
      pointer,
      resolved: { mime: "text/html", text: "<h1>Idem</h1>" },
      capturedAt: new Date().toISOString(),
      scopeManifest: { paths: ["title"] },
      connectorInstance: "wordpress-mcp-connector:inst-1",
      resourceType: "post",
      operationId,
      emitProducedEvent: true,
    };
    const first = await captureMod.captureCmsContentSnapshot(base);
    const second = await captureMod.captureCmsContentSnapshot(base);
    // Exactly one binding, and the re-drive returns the SAME canonical artifact
    // (the pre-read fast path - no orphan second artifact / produced event).
    expect(count("cms_snapshot_targets", "operation_id=$1", [operationId])).toBe(1);
    expect(second.artifactId).toBe(first.artifactId);
    expect(second.snapshotRevisionId).toBe(first.snapshotRevisionId);
    expect(second.snapshotTargetId).toBe(first.snapshotTargetId);
    // Exactly one representation + one produced event for the canonical artifact.
    expect(count("representation", "artifact_id=$1", [first.artifactId])).toBe(1);
    const evId = producedEventMod.producedEventId(first.artifactId, first.snapshotRevisionId);
    expect(count("artifact_produced_outbox", "event_id=$1", [evId])).toBe(1);
  });

  it("ROLLBACK: a failure anywhere in the composed op list rolls back EVERYTHING - nothing partial", () => {
    const artifactId = nextId("art");
    const representationRevisionId = nextId("rev");
    const operationId = nextId("op");
    const facts = {
      orgId: ORG,
      artifactId,
      representationRevisionId,
      resourceId: nextId("res"),
      blobId: nextId("blob"),
      snapshotTargetId: nextId("tgt"),
      substanceKey: `blob:${nextId("sha")}`,
      storageKey: `orgs/${ORG}/sha256/de/${nextId("k")}.bin`,
      sha256: nextId("sha"),
      mimeDetected: "text/html",
      declaredMime: "application/vnd.cinatra.cms-fields+json",
      sizeBytes: 10,
      createdBy: null,
      producerRunId: nextId("run"),
      producerAgentId: null,
      connectorInstance: "wordpress-mcp-connector:inst-1",
      resourceType: "post",
      cmsResourceId: null,
      baseRemoteRevisionRef: null,
      operationId,
      scopeManifest: { paths: ["title"] },
      objectData: { title: "Rollback probe" },
      emitProducedEvent: true,
    };
    const queries = captureMod.buildCmsSnapshotCaptureQueries(S(), facts);
    // Append a deliberately-failing op to the SAME transaction list.
    const poisoned = [...queries, { text: "SELECT 1/0", values: [] }];
    expect(() =>
      runPostgresQueriesSync({
        connectionString: getPostgresConnectionString(),
        transaction: true,
        queries: poisoned,
      }),
    ).toThrow();
    // Nothing partial: no objects row, no representation, no outbox event, no apply-binding row.
    expect(count("objects", "id=$1", [artifactId])).toBe(0);
    expect(count("representation", "id=$1", [representationRevisionId])).toBe(0);
    expect(count("cms_snapshot_targets", "operation_id=$1", [operationId])).toBe(0);
    const expectedEventId = producedEventMod.producedEventId(artifactId, representationRevisionId);
    expect(count("artifact_produced_outbox", "event_id=$1", [expectedEventId])).toBe(0);
    expect(count("resource", "id=$1", [facts.resourceId])).toBe(0);
  });
});
