/**
 * cinatra#4264 slice B1a, T2: the verified filing node of a revision, on a
 * real Postgres.
 *
 * Run R1 files A/1 and run R2 appends A/2, both through the image node
 * `file_image` (the ledger rows those writes leave: `materialize_tool`,
 * finalized, `verified_step_id` = the node). Then:
 *   - (A, 2) -> R2 and (A, 1) -> R1: the exact revision, never "the latest";
 *   - a refiled successor A/3 of a repaired repair over A/2 -> R2 (the walk);
 *   - two exact verified rows for one revision -> null;
 *   - two repaired rows naming one successor -> null;
 *   - a revision with unverified rows only -> null;
 *   - a candidate run of another template, or a reader of another org -> null.
 *
 * Each run builds its own throwaway schema from the real bootstrap leaf of the
 * ledger, a minimal `agent_runs` and `lifecycle_repair`, and drops it after.
 *
 * DB-gated: runs only with a real SUPABASE_DB_URL. With
 * X4264_REGENERATE_REALDB=1 a missing database throws instead of skipping.
 *
 * Red at main: the reader module and the `verified_step_id` column do not exist.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { artifactMaterializationLedgerSchemaQueries } from "@/lib/artifact-claim-schema";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";
import { readVerifiedFilingNode, type ProvenanceDb } from "@/lib/artifacts/regenerate-provenance";

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
if (process.env.X4264_REGENERATE_REALDB === "1" && !HAS_DB) {
  throw new Error("the #4264 B1a DB tier needs a live Postgres in SUPABASE_DB_URL; refusing to skip");
}
const describeDb = HAS_DB ? describe : describe.skip;

const SCHEMA = `x4264_prov_${process.pid}_${Date.now()}`;
const qi = (name: string) => `"${name.replaceAll('"', '""')}"`;
let client: Client;
let db: ProvenanceDb;
let seq = 0;

async function ledger(row: {
  runId: string;
  artifactId: string;
  revisionId: string;
  nodeId?: string;
  verified?: string | null;
  phase?: string;
  orgId?: string;
}) {
  seq += 1;
  await client.query(
    `INSERT INTO ${qi(SCHEMA)}."artifact_materializations"
       (id, org_id, run_id, output_id, node_id, path, extension, content_hash, artifact_id,
        representation_revision_id, phase, verified_step_id)
     VALUES ($1, $2, $3, $4, $5, 'materialize_tool', '@scope/pack', $6, $7, $8, $9, $10)`,
    [
      `m-${seq}`,
      row.orgId ?? "org-1",
      row.runId,
      `${row.nodeId ?? "file_image"}:${seq}`,
      row.nodeId ?? "file_image",
      `hash-${seq}`,
      row.artifactId,
      row.revisionId,
      row.phase ?? "finalized",
      row.verified === undefined ? (row.nodeId ?? "file_image") : row.verified,
    ],
  );
}

async function repair(id: string, base: [string, string], successor: [string, string], status = "repaired") {
  await client.query(
    `INSERT INTO ${qi(SCHEMA)}."lifecycle_repair"
       (id, org_id, status, base_artifact_id, base_representation_revision_id,
        successor_artifact_id, successor_representation_revision_id)
     VALUES ($1, 'org-1', $2, $3, $4, $5, $6)`,
    [id, status, base[0], base[1], successor[0], successor[1]],
  );
}

const read = (artifactId: string, revisionId: string, over: { orgId?: string; templateId?: string } = {}) =>
  readVerifiedFilingNode(
    {
      orgId: over.orgId ?? "org-1",
      artifactId,
      representationRevisionId: revisionId,
      templateId: over.templateId ?? "tmpl-1",
    },
    db,
  );

describeDb("readVerifiedFilingNode (cinatra#4264 B1a, T2)", () => {
  beforeAll(async () => {
    client = new Client({ connectionString: DB_URL });
    await client.connect();
    await client.query(`CREATE SCHEMA ${qi(SCHEMA)}`);
    await client.query(`CREATE TABLE ${qi(SCHEMA)}."agent_runs" (id text PRIMARY KEY, org_id text, template_id text NOT NULL)`);
    await client.query(
      `CREATE TABLE ${qi(SCHEMA)}."lifecycle_repair" (id text PRIMARY KEY, org_id text NOT NULL, status text NOT NULL,
         base_artifact_id text NOT NULL, base_representation_revision_id text NOT NULL,
         successor_artifact_id text, successor_representation_revision_id text)`,
    );
    for (const q of artifactMaterializationLedgerSchemaQueries(SCHEMA)) await client.query(q.text);
    db = { query: (text, values) => client.query(text, values), schema: SCHEMA };

    await client.query(
      `INSERT INTO ${qi(SCHEMA)}."agent_runs" VALUES
         ('R1', 'org-1', 'tmpl-1'), ('R2', 'org-1', 'tmpl-1'), ('R3', 'org-1', 'tmpl-1'),
         ('R4', 'org-1', 'tmpl-1'), ('RX', 'org-1', 'tmpl-other')`,
    );
    // R1 files A/1; R2 appends A/2 (same node, the image road both times).
    await ledger({ runId: "R1", artifactId: "A", revisionId: "A1" });
    await ledger({ runId: "R2", artifactId: "A", revisionId: "A2" });
    // A repair over A/2 refiled its successor as A/3.
    await repair("lr-1", ["A", "A2"], ["A", "A3"]);
    // Two verified writers claim one revision.
    await ledger({ runId: "R3", artifactId: "B", revisionId: "B1" });
    await ledger({ runId: "R4", artifactId: "B", revisionId: "B1" });
    // Two repaired rows name one successor.
    await ledger({ runId: "R1", artifactId: "C", revisionId: "C1" });
    await repair("lr-2", ["C", "C1"], ["C", "C2"]);
    await repair("lr-3", ["C", "C1"], ["C", "C2"]);
    // Unverified rows only, and an unfinalized verified one.
    await ledger({ runId: "R1", artifactId: "D", revisionId: "D1", verified: null });
    await ledger({ runId: "R1", artifactId: "D", revisionId: "D1", phase: "claimed" });
    // A candidate run of another template.
    await ledger({ runId: "RX", artifactId: "E", revisionId: "E1" });
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${qi(SCHEMA)} CASCADE`).catch(() => undefined);
    await client.end();
  });

  it("resolves the exact revision, never the latest", async () => {
    expect(await read("A", "A2")).toEqual({ runId: "R2", nodeId: "file_image" });
    expect(await read("A", "A1")).toEqual({ runId: "R1", nodeId: "file_image" });
  });

  it("walks a refiled successor back to the revision its repair was based on", async () => {
    expect(await read("A", "A3")).toEqual({ runId: "R2", nodeId: "file_image" });
  });

  it("answers null for any ambiguity or missing proof", async () => {
    expect(await read("B", "B1")).toBeNull();
    expect(await read("C", "C2")).toBeNull();
    expect(await read("D", "D1")).toBeNull();
    expect(await read("E", "E1")).toBeNull();
    expect(await read("A", "A2", { orgId: "org-2" })).toBeNull();
    expect(await read("A", "A2", { templateId: "tmpl-other" })).toBeNull();
    expect(await read("Z", "Z1")).toBeNull();
  });
});
