/**
 * cinatra#1428 — deletion unification SOURCE-FIXTURE test (like
 * legacy-writer-emits-history): locks the SQL/composition shape of the
 * artifact tombstone so a future refactor cannot quietly reintroduce the raw
 * `UPDATE objects SET deleted_at` that bypassed object history, the outbox
 * delete projection, and undo eligibility.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RETENTION = readFileSync(
  join(__dirname, "..", "artifact-retention.ts"),
  "utf8",
);
const STORE = readFileSync(
  join(__dirname, "..", "..", "objects-store.ts"),
  "utf8",
);

describe("artifact tombstone rides the canonical object soft-delete (cinatra#1428)", () => {
  it("imports the canonical soft-delete builder from the objects store", () => {
    expect(RETENTION).toMatch(
      /import\s*\{[\s\S]*?buildSoftDeleteObjectQuery[\s\S]*?\}\s*from\s*"@\/lib\/objects-store"/,
    );
  });

  it("no raw objects soft-delete UPDATE remains in the retention path", () => {
    // The pre-#1428 shape: UPDATE "…"."objects" SET deleted_at = now()
    // executed directly by artifact-retention. The ONLY objects UPDATE now
    // comes through the shared builder.
    expect(RETENTION).not.toMatch(
      /UPDATE "\$\{schema\}"\."objects"[\s\S]{0,120}SET deleted_at = now\(\)/,
    );
  });

  it("soft-delete + retention pinning + provider-cache invalidation commit in ONE transaction", () => {
    const tombstoneSection = RETENTION.slice(
      RETENTION.indexOf("export function tombstoneArtifact("),
      RETENTION.indexOf("export async function runResourceBlobGc("),
    );
    // One runPostgresQueriesSync({ transaction: true }) whose query list
    // starts with the canonical statement and carries both companions.
    expect(tombstoneSection).toMatch(/transaction:\s*true/);
    expect(tombstoneSection).toMatch(/softDelete\.query/);
    expect(tombstoneSection).toMatch(/retain_until/);
    expect(tombstoneSection).toMatch(/artifact_provider_cache/);
    // Exactly one transactional call in the tombstone body.
    const calls = tombstoneSection.match(/runPostgresQueriesSync\(/g) ?? [];
    expect(calls.length).toBe(1);
  });

  it("surfaces the change_set id for Undo (parity with objects_delete)", () => {
    expect(RETENTION).toMatch(/readSoftDeleteChangeSetId\(/);
    expect(RETENTION).toMatch(/changeSetId: readSoftDeleteChangeSetId\(softDeleteResult\)/);
  });

  it("the shared builder emits outbox 'delete' + object_change_event + restorable change_set", () => {
    const builderSection = STORE.slice(
      STORE.indexOf("export function buildSoftDeleteObjectQuery("),
      STORE.indexOf("export function upsertObjectAndEnqueue("),
    );
    expect(builderSection).toMatch(/graphiti_projection_outbox/);
    expect(builderSection).toMatch(/'delete', NULL, 'pending', 0/);
    expect(builderSection).toMatch(/INSERT INTO "\$\{schema\}"\."object_change_event"/);
    expect(builderSection).toMatch(/'soft-delete'/);
    expect(builderSection).toMatch(/'reversible-internal',\s*true,/);
  });

  it("actor attribution is parameterized (artifact deletes attribute the deleting principal)", () => {
    const builderSection = STORE.slice(
      STORE.indexOf("export function buildSoftDeleteObjectQuery("),
      STORE.indexOf("export function upsertObjectAndEnqueue("),
    );
    expect(builderSection).toMatch(/\$7, \$8/);
    expect(builderSection).toMatch(/input\.actorId \?\? null/);
    expect(builderSection).toMatch(/input\.actorKind \?\? "system"/);
  });
});
