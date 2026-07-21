/**
 * cinatra#1890 (epic #1883 A2) — classifier-signals persistence ROUND-TRIP,
 * REAL-DB integration proof. This is the server half of the end-to-end seam the
 * client now drives: a chat-thread handle flowing into an upload composes chat
 * context into `representation.classifier_signals` and persists it.
 *
 * The only stub is the tenant-safe chat reader (`readChatThreadForClassifier`,
 * separately tenant-tested) — every write hits the real DDL + constraints. The
 * harness mirrors the #926 blob-store integration suite: fresh per-file schema
 * from the canonical DDL, temp blob root, dynamic imports after the env is set.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";

const SEEDED_THREAD = {
  threadId: "thread-a2-1890",
  messages: [
    { role: "user" as const, content: "here is the quarterly revenue export" },
    { role: "assistant" as const, content: "thanks — I'll file it" },
  ],
};

// Stub ONLY the chat reader (returns the seeded thread for the seeded id/actor);
// the metadata helpers fall back to the env-set blob root.
vi.mock("@/lib/database", () => ({
  readChatThreadForClassifier: (args: { threadId: string }) =>
    args.threadId === SEEDED_THREAD.threadId ? SEEDED_THREAD : null,
  readMetadataValueFromDatabase: (_key: string, fallback: unknown) => fallback,
  writeMetadataValueToDatabase: () => {},
}));

const TEST_SCHEMA = "cinatra_test_classifier_signals_1890";
const FIXTURE_OBJECT_TYPE = "@cinatra-ai/test-fixture-artifact:doc";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");
const ORG = "org-a2-1890";
const ACTOR = "user-a2-1890";

async function* bytes(s: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(s);
}

describe.skipIf(!HAS_REAL_DB)("cinatra#1890 classifier-signals persistence (real DB)", () => {
  let client: Client;
  let artifactRoot: string;
  let priorSchemaEnv: string | undefined;
  let priorRootEnv: string | undefined;

  beforeAll(async () => {
    priorSchemaEnv = process.env.SUPABASE_SCHEMA;
    priorRootEnv = process.env.CINATRA_ARTIFACT_DATA_ROOT;
    process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
    artifactRoot = mkdtempSync(path.join(tmpdir(), "cin-1890-int-"));
    process.env.CINATRA_ARTIFACT_DATA_ROOT = artifactRoot;

    client = new Client({ connectionString: DB_URL });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);

    const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
    for (const q of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
      const head = q.text.trim().slice(0, 6).toUpperCase();
      if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") {
        continue;
      }
      try {
        await client.query(q.text, (q as { values?: unknown[] }).values as never[]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("does not exist")) throw err;
      }
    }
    (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

    const { objectTypeRegistry } = await import("@cinatra-ai/objects/registry");
    const { z } = await import("zod");
    objectTypeRegistry.register({
      type: FIXTURE_OBJECT_TYPE,
      category: "report",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent", "user", "import"], mutableBy: ["agent", "user"] },
      renderers: { listRow: null, card: null, detail: null },
      isArtifact: { accepts: { file: { mimeTypes: ["text/plain"] } } },
      dispositions: { projection: "artifact-safe" },
    });
  });

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
    await client?.end().catch(() => {});
    rmSync(artifactRoot, { recursive: true, force: true });
    delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
    if (priorSchemaEnv === undefined) delete process.env.SUPABASE_SCHEMA;
    else process.env.SUPABASE_SCHEMA = priorSchemaEnv;
    if (priorRootEnv === undefined) delete process.env.CINATRA_ARTIFACT_DATA_ROOT;
    else process.env.CINATRA_ARTIFACT_DATA_ROOT = priorRootEnv;
  });

  async function readSignals(representationRevisionId: string): Promise<Record<string, unknown> | null> {
    const row = await client.query(
      `SELECT classifier_signals FROM "${TEST_SCHEMA}"."representation" WHERE id = $1`,
      [representationRevisionId],
    );
    return (row.rows[0]?.classifier_signals as Record<string, unknown> | null) ?? null;
  }

  it("persists chat context + upload signals when a thread handle is supplied", async () => {
    const { createSemanticArtifact } = await import("@/lib/artifacts/artifact-creation");
    const res = await createSemanticArtifact({
      orgId: ORG,
      createdBy: ACTOR,
      ownerLevel: "organization",
      ownerId: ORG,
      title: "quarterly-revenue.txt",
      objectType: FIXTURE_OBJECT_TYPE,
      declaredMime: "text/plain",
      originKind: "upload",
      skipFallbackClassification: true,
      chatContextSource: { threadId: SEEDED_THREAD.threadId },
      stream: bytes("revenue rows"),
    });

    const signals = await readSignals(res.representationRevisionId);
    expect(signals).not.toBeNull();
    // Chat context captured from the seeded thread.
    const chatContext = signals?.chatContext as
      | { threadId: string; messages: Array<{ role: string; content: string }> }
      | undefined;
    expect(chatContext?.threadId).toBe(SEEDED_THREAD.threadId);
    expect(chatContext?.messages).toHaveLength(2);
    expect(chatContext?.messages?.[0]?.content).toContain("quarterly revenue");
    // Upload-side signals composed from authoritative values.
    const upload = signals?.upload as { originKind?: string; declaredMime?: string } | undefined;
    expect(upload?.originKind).toBe("upload");
    expect(upload?.declaredMime).toBe("text/plain");
  });

  it("persists upload signals but NO chatContext when no thread handle is supplied", async () => {
    const { createSemanticArtifact } = await import("@/lib/artifacts/artifact-creation");
    const res = await createSemanticArtifact({
      orgId: ORG,
      createdBy: ACTOR,
      ownerLevel: "organization",
      ownerId: ORG,
      title: "no-thread.txt",
      objectType: FIXTURE_OBJECT_TYPE,
      declaredMime: "text/plain",
      originKind: "upload",
      skipFallbackClassification: true,
      stream: bytes("orphan bytes"),
    });
    const signals = await readSignals(res.representationRevisionId);
    expect(signals).not.toBeNull();
    expect(signals?.chatContext).toBeUndefined();
    expect((signals?.upload as { originKind?: string })?.originKind).toBe("upload");
    // cinatra#1891 scope 3: a plain upload has NO producing run, so the composed
    // signals carry no `produces` (the producer-plan reorder must not fabricate
    // one). The positive produces path is exercised by the agent-emit
    // materializer + the matcher prompt-render unit test.
    expect(signals?.produces).toBeUndefined();
  });
});
