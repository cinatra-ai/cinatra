/**
 * cinatra#1868 — a RUN-MATERIALIZED claim-backed host type gets its eligible
 * BINDING assertion IN the creation transaction, so it is pinnable without
 * depending on an incidental external reconciliation trigger. REAL-DB
 * integration proof (no mocks on the DB / storage path).
 *
 * ROOT (issue #1868): `createSemanticArtifact` writes the `objects` row DIRECTLY
 * (not via `upsertObjectAndEnqueue`), so it never rode the
 * `binding_reconcile_enqueue` CTE — a run-materialized row of a claim-backed host
 * type (artifact-safe disposition, NO `isArtifact` descriptor ⇒ ABSENT from
 * `listArtifacts()`) was minted with NO binding assertion. The triple-coherence
 * gate admits such a type ONLY via an eligible binding, so the row was
 * effectively unpinnable. The fix composes `buildBindingReconcileQueries`'
 * `winnerCte` into Tx2 (the ratified A4 in-Tx binding-write-path builder).
 *
 * Proves, against real DDL + constraints:
 *   1. driving a claim-backed host type through the REAL writer mints an eligible
 *      BINDING (correct extension / claim id / generation) with NO separate
 *      reconcile call — the binding exists the instant creation commits;
 *   2. the full pin path (snapshot → finalizeContextSelectionPin) then ADMITS it
 *      (strictly more than the coherence helper: pinnable disposition + a matching
 *      content snapshot);
 *   3. a NON-claimed registered pack-typed row (isArtifact, no claim) gets NO
 *      binding — behavior bit-for-bit unchanged.
 *
 * ISOLATION (the #1430 / #923 integration pattern): fresh schema per file from
 * the CANONICAL `buildCreateStoreSchemaQueries` DDL; the blob root is a temp dir;
 * every app module is dynamically imported in `beforeAll` AFTER the env is set
 * (postgresSchema is a module-load const). The heavy app-boot registrar is no-op'd
 * so this suite's directly-registered types survive the coherence gate's warm.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { z } from "zod";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";

vi.mock("@/lib/database", async () => {
  const cfg = await import("@/lib/postgres-config");
  return {
    readChatThreadForClassifier: () => null,
    readMetadataValueFromDatabase: (_key: string, fallback: unknown) => fallback,
    writeMetadataValueToDatabase: () => {},
    getPostgresConnectionString: cfg.getPostgresConnectionString,
    postgresSchema: cfg.postgresSchema,
    ensurePostgresSchema: () => {},
  };
});
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
// The coherence gate warms the registry via `ensureArtifactTypesRegistered`,
// which runs the heavy app-boot registrar. No-op it: this suite registers the
// exact types it needs directly, and the warm must not clobber them.
vi.mock("@/lib/register-all-object-types", () => ({
  registerAllObjectTypes: () => {},
}));

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");
const TEST_SCHEMA = "cinatra_test_run_materialized_binding_1868";
const ORG = "org-1868";

// A CLAIM-BACKED HOST type: artifact-safe projection disposition, NO isArtifact
// descriptor ⇒ absent from listArtifacts() (the exact affected set of #1868).
const HOST_TYPE = "@cinatra-ai/email:body";
const HOST_EXT = "@cinatra-ai/email";
// A NON-claimed registered PACK type: isArtifact present ⇒ the bare-type branch
// covers it, no binding is ever owed (the unchanged-behavior control).
const PACK_TYPE = "@cinatra-ai/pdf-artifact:document";
const PACK_EXT = "@cinatra-ai/pdf-artifact";

let uniq = 0;
const nextId = (p: string) => `${p}-${Date.now()}-${uniq++}`;

async function* bytes(s: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(s);
}

let runPostgresQueriesSync: typeof import("@/lib/postgres-sync").runPostgresQueriesSync;
let getPostgresConnectionString: typeof import("@/lib/postgres-config").getPostgresConnectionString;
let creationMod: typeof import("@/lib/artifacts/artifact-creation");
let bindingMod: typeof import("@/lib/objects/binding-write-path");
let snapshotMod: typeof import("@/lib/artifacts/object-content-snapshot");
let finalizeMod: typeof import("@/lib/artifacts/context-selection-finalize");

const S = () => TEST_SCHEMA;

function sql(text: string, values: unknown[] = []) {
  return runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  })[0];
}

/** Directly seed an ACTIVE dedicated claim over `type` (org scope). */
function seedDedicatedClaim(input: {
  id: string;
  type: string;
  ext: string;
  dispositions: unknown;
}) {
  sql(
    `INSERT INTO "${S()}"."artifact_type_claims"
       (id, scope, object_type_id, claim_kind, extension_package, extension_version, status, generation, dispositions)
     VALUES ($1, $2, $3, 'dedicated', $4, '1.0.0', 'active', 1, $5::jsonb)`,
    [input.id, `org:${ORG}`, input.type, input.ext, JSON.stringify(input.dispositions)],
  );
}

function activeBindingCount(artifactId: string): number {
  const r = sql(
    `SELECT count(*)::int AS n FROM "${S()}"."semantic_assertion"
       WHERE org_id=$1 AND artifact_id=$2 AND assertion_basis='binding' AND eligibility<>'archived'`,
    [ORG, artifactId],
  );
  return Number(r.rows[0].n);
}

beforeAll(async () => {
  if (!HAS_REAL_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  process.env.CINATRA_ARTIFACT_DATA_ROOT = mkdtempSync(path.join(tmpdir(), "cin-1868-"));

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
  creationMod = await import("@/lib/artifacts/artifact-creation");
  bindingMod = await import("@/lib/objects/binding-write-path");
  snapshotMod = await import("@/lib/artifacts/object-content-snapshot");
  finalizeMod = await import("@/lib/artifacts/context-selection-finalize");

  objectTypeRegistry._clearForTests();
  // CLAIM-BACKED HOST type: artifact-safe disposition, NO isArtifact ⇒ absent
  // from listArtifacts() (registered host-side; the pack claim adds the
  // disposition). It is a writable artifact target via the artifact-safe
  // projection, but only the binding branch can pin it.
  objectTypeRegistry.register(
    {
      type: HOST_TYPE,
      category: "report",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent", "user", "import"], mutableBy: ["agent", "user"] },
      renderers: { listRow: null, card: null, detail: null },
      dispositions: { projection: "artifact-safe" },
    } as never,
    HOST_EXT,
  );
  // NON-claimed PACK type: isArtifact present ⇒ appears in listArtifacts().
  objectTypeRegistry.register(
    {
      type: PACK_TYPE,
      category: "report",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent", "user", "import"], mutableBy: ["agent", "user"] },
      renderers: { listRow: null, card: null, detail: null },
      isArtifact: { accepts: { file: { mimeTypes: ["text/plain"] } } },
      dispositions: { projection: "artifact-safe" },
    } as never,
    PACK_EXT,
  );
});

afterAll(async () => {
  if (!HAS_REAL_DB) return;
  objectTypeRegistry._clearForTests();
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
  await client.end().catch(() => {});
  const root = process.env.CINATRA_ARTIFACT_DATA_ROOT;
  if (root) rmSync(root, { recursive: true, force: true });
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_REAL_DB)("cinatra#1868 — run-materialized claim-backed binding in-Tx (real DB + disk)", () => {
  it("the host type is a claim-backed target ABSENT from listArtifacts() (the affected set)", () => {
    const artifactTypes = objectTypeRegistry.listArtifacts().map((d) => d.type);
    expect(artifactTypes).not.toContain(HOST_TYPE); // no isArtifact ⇒ bare-type branch cannot admit it.
    expect(artifactTypes).toContain(PACK_TYPE); // isArtifact ⇒ bare-type branch covers the control.
  });

  it("a run-materialized claim-backed row gains an eligible BINDING assertion IN the creation Tx (no separate reconcile)", async () => {
    const claimId = nextId("claim");
    seedDedicatedClaim({
      id: claimId,
      type: HOST_TYPE,
      ext: HOST_EXT,
      dispositions: { projection: "artifact-safe", pinnable: true, snapshotPolicy: "content" },
    });

    const created = await creationMod.createSemanticArtifact({
      orgId: ORG,
      createdBy: null,
      ownerLevel: "organization",
      ownerId: ORG,
      title: "run-materialized email body",
      objectType: HOST_TYPE,
      declaredMime: "text/plain",
      originKind: "agent_generated",
      skipFallbackClassification: true,
      createdByRunId: nextId("run"),
      stream: bytes("cinatra#1868 materialized body"),
    });

    // The binding exists the instant creation commits — NO reconcile call here.
    const binding = bindingMod.readActiveBinding(ORG, created.artifactId);
    expect(binding).not.toBeNull();
    expect(binding!.extension).toBe(HOST_EXT);
    expect(binding!.bindingClaimId).toBe(claimId);
    expect(binding!.bindingGeneration).toBe(1);
    expect(activeBindingCount(created.artifactId)).toBe(1);
  });

  it("the full pin path (snapshot → finalizeContextSelectionPin) then ADMITS the claim-backed row", async () => {
    const claimId = nextId("claim-pin");
    const TYPE = "@cinatra-ai/email:body-pin";
    // A per-test claim-backed type so the active-claim partial-unique index never
    // collides with the sibling test's claim.
    objectTypeRegistry.register(
      {
        type: TYPE,
        category: "report",
        schema: z.record(z.string(), z.unknown()),
        lifecycle: { sources: ["agent", "user", "import"], mutableBy: ["agent", "user"] },
        renderers: { listRow: null, card: null, detail: null },
        dispositions: { projection: "artifact-safe" },
      } as never,
      HOST_EXT,
    );
    seedDedicatedClaim({
      id: claimId,
      type: TYPE,
      ext: HOST_EXT,
      dispositions: { projection: "artifact-safe", pinnable: true, snapshotPolicy: "content" },
    });

    const created = await creationMod.createSemanticArtifact({
      orgId: ORG,
      createdBy: null,
      ownerLevel: "organization",
      ownerId: ORG,
      title: "pinnable email body",
      objectType: TYPE,
      declaredMime: "text/plain",
      originKind: "agent_generated",
      skipFallbackClassification: true,
      createdByRunId: nextId("run"),
      stream: bytes("cinatra#1868 pinnable body"),
    });
    const binding = bindingMod.readActiveBinding(ORG, created.artifactId);
    expect(binding).not.toBeNull();

    // Content snapshot (pinnable + content disposition) → the pinnable rep.
    const snap = await snapshotMod.captureObjectContentSnapshot({
      orgId: ORG,
      objectId: created.artifactId,
    });
    expect(snap).not.toBeNull();

    // The full pin path admits the claim-backed row via the binding branch.
    const referrerId = nextId("ref");
    const fin = finalizeMod.finalizeContextSelectionPin({
      selection: {
        orgId: ORG,
        parentRunId: nextId("run-pin"),
        parentPackageName: "@cinatra-ai/agent",
        slotId: "slot-1868",
        artifactId: created.artifactId,
        representationRevisionId: snap!.representationRevisionId,
        semanticAssertionId: binding!.id,
        extension: binding!.extension,
        sourceScope: "organization",
        selectedBy: "autonomous",
        selectionMode: "autonomous",
      },
      referrerKind: "agent_run",
      referrerId,
      digest: snap!.contentDigest,
      mime: "application/json",
      originKind: "snapshot",
    });
    expect(fin.selectionWritten).toBe(true);
    expect(fin.pinWritten).toBe(true);
  });

  it("a NON-claimed registered pack-typed row gets NO binding — behavior unchanged", async () => {
    const created = await creationMod.createSemanticArtifact({
      orgId: ORG,
      createdBy: null,
      ownerLevel: "organization",
      ownerId: ORG,
      title: "uploaded pack doc",
      objectType: PACK_TYPE,
      declaredMime: "text/plain",
      originKind: "upload",
      skipFallbackClassification: true,
      stream: bytes("cinatra#1868 non-claimed control body"),
    });
    // No claim over PACK_TYPE ⇒ the winner CTE is empty ⇒ no binding minted.
    expect(activeBindingCount(created.artifactId)).toBe(0);
  });
});
