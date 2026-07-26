/**
 * cinatra#2044 S6 (L-B) — REAL-DB proof of the PINNED capture store against real
 * DDL + constraints. Mirrors the S5 capture suite's isolation: a FRESH schema per
 * file from `buildCreateStoreSchemaQueries`, a temp blob root, every app module
 * dynamically imported in beforeAll AFTER the env is set. Guarded by
 * `describe.skipIf(!HAS_REAL_DB)`.
 *
 *   B1  a captured record lands the picture: the capture `objects` row + the
 *       resource/blob/representation triple, and reads back with its geometry.
 *   B3  a DEGRADED record lands the objects row with the named reason and NO
 *       representation — the gate states the gap instead of hiding it.
 *   PIN a re-drive returns the ORIGINAL capture (never a second row, never an
 *       overwrite) — the immutability #2044 requires of an old gate.
 *   ISO a capture bound to a DIFFERENT pinned revision is never returned for
 *       this one.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { vi } from "vitest";

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
const TEST_SCHEMA = "cinatra_test_preview_capture_2044";
const ORG = "org-preview-2044";

let runPostgresQueriesSync: typeof import("@/lib/postgres-sync").runPostgresQueriesSync;
let getPostgresConnectionString: typeof import("@/lib/postgres-config").getPostgresConnectionString;
let store: typeof import("@/lib/artifacts/cms-preview-capture-store");
let view: typeof import("@/lib/artifacts/cms-preview-capture-view");

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

// A tiny but real PNG (1x1) so the blob store sees genuine image bytes.
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

function capturedData(over: Record<string, unknown> = {}) {
  return {
    role: "current" as const,
    status: "captured" as const,
    degradedReason: null,
    boundArtifactId: "art-2044",
    boundSnapshotRevisionId: "rev-2044",
    sourceOrigin: "https://blog.example.com",
    postId: 42,
    capturedAt: "2026-07-26T10:00:00.000Z",
    geometry: {
      regions: [{ region: "content", postId: "42", x: 0, y: 180, width: 640, height: 360 }],
      contentHeight: 1800,
      viewport: { width: 1280, height: 900 },
    },
    sanitization: { scripts: 1, frames: 0, eventHandlers: 2, navigations: 0, unsafeUrls: 0 },
    network: { blockedRequests: 4, allowedRequests: 9 },
    captureDigest: "b".repeat(64),
    title: "Hello Post",
    ...over,
  };
}

beforeAll(async () => {
  if (!HAS_REAL_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  process.env.CINATRA_ARTIFACT_DATA_ROOT = mkdtempSync(path.join(tmpdir(), "cin-2044-"));

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
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized =
    true;

  ({ runPostgresQueriesSync } = await import("@/lib/postgres-sync"));
  ({ getPostgresConnectionString } = await import("@/lib/postgres-config"));
  store = await import("@/lib/artifacts/cms-preview-capture-store");
  view = await import("@/lib/artifacts/cms-preview-capture-view");
});

afterAll(async () => {
  if (!HAS_REAL_DB) return;
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
  await client.end().catch(() => {});
  const root = process.env.CINATRA_ARTIFACT_DATA_ROOT;
  if (root) rmSync(root, { recursive: true, force: true });
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean })
    .__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_REAL_DB)("cinatra#2044 L-B pinned capture store (real DB + disk)", () => {
  it("B1: a captured record lands the picture and reads back with its geometry", async () => {
    const written = await store.writePinnedPreviewCapture({
      orgId: ORG,
      createdBy: "user-1",
      producerRunId: "run-1",
      screenshot: PNG,
      data: capturedData(),
    });

    expect(written.representationRevisionId).not.toBeNull();
    expect(
      count("objects", "id=$1 AND org_id=$2 AND type=$3", [
        written.captureArtifactId,
        ORG,
        store.CMS_PREVIEW_CAPTURE_OBJECT_TYPE,
      ]),
    ).toBe(1);
    expect(
      count("representation", "id=$1 AND artifact_id=$2 AND org_id=$3", [
        written.representationRevisionId,
        written.captureArtifactId,
        ORG,
      ]),
    ).toBe(1);
    expect(count("artifact_blobs", "org_id=$1 AND mime_detected=$2", [ORG, "image/png"])).toBe(1);

    const read = store.readPinnedPreviewCaptures({
      orgId: ORG,
      boundArtifactId: "art-2044",
      boundSnapshotRevisionId: "rev-2044",
    });
    expect(read).toHaveLength(1);
    expect(read[0].data.status).toBe("captured");
    expect(read[0].data.geometry?.regions[0].region).toBe("content");

    // The surface model the review page consumes.
    const [v] = view.buildPinnedCaptureViews(read);
    expect(v.imageUrl).toBe(
      view.pinnedCaptureImageUrl(written.captureArtifactId, read[0].representationRevisionId!),
    );
    expect(v.regions).toEqual([
      { region: "content", leftPct: 0, topPct: 10, widthPct: 50, heightPct: 20 },
    ]);
  });

  it("PIN: a re-drive returns the ORIGINAL capture — never a second row, never an overwrite", async () => {
    const first = store.readPinnedPreviewCaptures({
      orgId: ORG,
      boundArtifactId: "art-2044",
      boundSnapshotRevisionId: "rev-2044",
    })[0];

    const again = await store.writePinnedPreviewCapture({
      orgId: ORG,
      screenshot: PNG,
      // A LATER capture of the same target — e.g. after the site theme changed.
      data: capturedData({ capturedAt: "2026-08-01T00:00:00.000Z", captureDigest: "c".repeat(64) }),
    });

    expect(again.captureArtifactId).toBe(first.captureArtifactId);
    expect(again.data.capturedAt).toBe("2026-07-26T10:00:00.000Z");
    expect(again.data.captureDigest).toBe("b".repeat(64));
    expect(
      store.readPinnedPreviewCaptures({
        orgId: ORG,
        boundArtifactId: "art-2044",
        boundSnapshotRevisionId: "rev-2044",
      }),
    ).toHaveLength(1);
  });

  it("B3: a DEGRADED record lands with its named reason and NO representation", async () => {
    const degraded = await store.writePinnedPreviewCapture({
      orgId: ORG,
      data: capturedData({
        boundSnapshotRevisionId: "rev-degraded",
        status: "degraded",
        degradedReason: "preview-unreachable",
        geometry: null,
        sanitization: null,
        network: null,
        captureDigest: null,
      }),
    });

    expect(degraded.representationRevisionId).toBeNull();
    expect(
      count("representation", "artifact_id=$1", [degraded.captureArtifactId]),
    ).toBe(0);

    const [v] = view.buildPinnedCaptureViews(
      store.readPinnedPreviewCaptures({
        orgId: ORG,
        boundArtifactId: "art-2044",
        boundSnapshotRevisionId: "rev-degraded",
      }),
    );
    expect(v).toMatchObject({
      status: "degraded",
      imageUrl: null,
      degradedReason: "preview-unreachable",
    });
  });

  it("ISO: a capture bound to another pinned revision is never returned for this one", () => {
    const read = store.readPinnedPreviewCaptures({
      orgId: ORG,
      boundArtifactId: "art-2044",
      boundSnapshotRevisionId: "rev-2044",
    });
    expect(read.every((c) => c.data.boundSnapshotRevisionId === "rev-2044")).toBe(true);
    // And another org can never see it.
    expect(
      store.readPinnedPreviewCaptures({
        orgId: "org-other",
        boundArtifactId: "art-2044",
        boundSnapshotRevisionId: "rev-2044",
      }),
    ).toHaveLength(0);
  });

  it("the capture id is DETERMINISTIC per (target, role) — the PK is the pin", () => {
    const a = store.previewCaptureArtifactId("art-x", "rev-y", "current");
    expect(store.previewCaptureArtifactId("art-x", "rev-y", "current")).toBe(a);
    expect(store.previewCaptureArtifactId("art-x", "rev-y", "before")).not.toBe(a);
    expect(store.previewCaptureArtifactId("art-x", "rev-z", "current")).not.toBe(a);
  });
});
