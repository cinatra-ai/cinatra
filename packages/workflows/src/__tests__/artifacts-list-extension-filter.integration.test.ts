/**
 * artifacts_list extensionPackageName filter (query-level).
 * Tests the listArtifactIdsForExtension reader (the pre-limit filter source).
 * Lives in the workflows integration suite — the repo's DB+@/ integration infra
 * (the sync pg + semantic_assertion table are created by buildCreateStoreSchemaQueries).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import { listArtifactIdsForExtension } from "@/lib/artifacts/semantic-assertion-store";

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const ORG = "test-org-port04";
const EXT_A = "@cinatra-ai/blog-post-artifact";
const EXT_B = "@cinatra-ai/blog-image-artifact";
const artA = "art-port04-a";
const artB = "art-port04-b";

async function seedAssertion(c: Client, artifactId: string, extension: string, eligibility: string) {
  await c.query(
    `INSERT INTO "${SCHEMA}"."semantic_assertion" (id, org_id, artifact_id, extension, asserted_by, eligibility)
     VALUES ($1,$2,$3,$4,'user',$5)`,
    [randomUUID(), ORG, artifactId, extension, eligibility],
  );
}

beforeAll(async () => {
  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await c.connect();
  for (const q of buildCreateStoreSchemaQueries(SCHEMA)) await c.query(q.text);
  await c.query(`DELETE FROM "${SCHEMA}"."semantic_assertion" WHERE org_id = $1`, [ORG]);
  await seedAssertion(c, artA, EXT_A, "eligible");
  await seedAssertion(c, artB, EXT_B, "eligible");
  // artB also has an ARCHIVED (non-eligible) assertion for EXT_A — must NOT match.
  await seedAssertion(c, artB, EXT_A, "archived");
  await c.end();
}, 60_000);

describe("listArtifactIdsForExtension (PORT-04)", () => {
  it("returns only artifacts with an ELIGIBLE assertion for the extension", () => {
    const a = listArtifactIdsForExtension(ORG, EXT_A);
    expect(a.has(artA)).toBe(true);
    expect(a.has(artB)).toBe(false); // artB's EXT_A assertion is archived → excluded
  });

  it("filters by the named extension (different extension → different set)", () => {
    const b = listArtifactIdsForExtension(ORG, EXT_B);
    expect(b.has(artB)).toBe(true);
    expect(b.has(artA)).toBe(false);
  });

  it("an unknown extension returns the empty set (filter-applies → no matches)", () => {
    expect(listArtifactIdsForExtension(ORG, "@cinatra-ai/nonexistent").size).toBe(0);
  });
});
