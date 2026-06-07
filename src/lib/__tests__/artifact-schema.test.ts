import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCreateStoreSchemaQueries } from "../drizzle-store";

// The storage-spine DDL must be present and additive, and the ArtifactRef type
// must NEVER pin on `objects.version`.

describe("artifact storage-spine DDL", () => {
  const sql = buildCreateStoreSchemaQueries("cinatra_test")
    .map((q) => q.text)
    .join("\n");

  it("creates artifact_blobs + artifact_refs; DROPs artifact_versions", () => {
    // `artifact_versions` is RETIRED. The DDL now DROPs the table IF EXISTS on
    // live schemas; fresh schemas never create it.
    for (const t of ["artifact_blobs", "artifact_refs"]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS`);
      expect(sql).toContain(`."${t}"`);
    }
    expect(sql).toMatch(/DROP TABLE IF EXISTS[^\n]*"artifact_versions"/);
    expect(sql).not.toMatch(/CREATE TABLE IF NOT EXISTS[^\n]*"artifact_versions"/);
  });

  it("artifact_refs gets a unique pin-key index for ON CONFLICT-driven syncs", () => {
    expect(sql).toContain("artifact_refs_pin_unique_idx");
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS artifact_refs_pin_unique_idx[\s\S]*\(org_id, artifact_id, representation_revision_id, referrer_kind, referrer_id\)/,
    );
  });

  it("dedupe index is ORG-scoped, never a global sha", () => {
    expect(sql).toContain("artifact_blobs_org_sha_size_idx");
    expect(sql).toContain("(org_id, sha256, size_bytes)");
  });

  it("never ALTERs shared chat/run tables for artifacts", () => {
    expect(sql).not.toMatch(/ALTER TABLE[^\n]*chat_threads[^\n]*artifact/i);
    expect(sql).not.toMatch(/ALTER TABLE[^\n]*agent_runs[^\n]*artifact/i);
  });

  it("retention DDL present (audit table; retention in resource.metadata)", () => {
    expect(sql).toContain('."artifact_audit"');
    // The table-level ALTER ADD COLUMN tombstoned_at/retain_until path on
    // artifact_versions is retired because the table is itself DROPped.
    // Retention lives in resource.metadata jsonb, set by tombstoneArtifact's
    // GREATEST UPDATE and consumed by runResourceBlobGc's eligibility predicate.
    expect(sql).not.toMatch(/ALTER TABLE[^\n]*artifact_versions[^\n]*tombstoned_at/);
    expect(sql).toContain("artifact_audit_artifact_idx");
  });

  it("runResourceBlobGc predicate requires representation+ownership+ref-pin+retain", () => {
    const ret = readFileSync(
      path.join(__dirname, "../artifacts/artifact-retention.ts"),
      "utf8",
    );
    // The resource-level GC predicate must require:
    //  (a) at least one representation parent;
    //  (b) every representation parent's object is tombstoned;
    //  (c) no live artifact_refs pin;
    //  (d) retain_until elapsed (or null).
    expect(ret).toMatch(/EXISTS[\s\S]*representation/);
    expect(ret).toMatch(/NOT EXISTS[\s\S]*o\.deleted_at IS NULL/);
    expect(ret).toMatch(/NOT EXISTS[\s\S]*artifact_refs/);
    expect(ret).toMatch(/retain_until[\s\S]*now\(\)/);
    // tombstone must NOT delete blobs (resource-level GC owns physical
    // delete) and must audit before the destructive UPDATE.
    expect(ret).not.toMatch(/deleteBlob[\s\S]{0,400}export function tombstoneArtifact/);
    const tomb = ret.slice(ret.indexOf("export function tombstoneArtifact"));
    expect(tomb.indexOf("writeArtifactAudit")).toBeGreaterThan(-1);
    expect(tomb.indexOf("writeArtifactAudit")).toBeLessThan(
      tomb.indexOf("UPDATE"),
    );
    // destructive batches are transactional
    expect(ret).toMatch(/transaction:\s*true/);
  });

  it("provider-file cache DDL present (additive, expiry-keyed; representation rekey)", () => {
    // Column `version_id` is now `representation_revision_id`; the unique index
    // is keyed on the new column name. The DDL also adds an idempotent ALTER
    // block to rename on live schemas; assert both shapes are present in the
    // generated DDL.
    expect(sql).toContain('."artifact_provider_cache"');
    expect(sql).toContain("artifact_provider_cache_key_idx");
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX[^\n]*\(org_id, representation_revision_id, digest, provider\)/,
    );
    expect(sql).toContain("artifact_provider_cache_expiry_idx");
    // Artifact table CREATE statements should not declare a `version_id`
    // column. The idempotent ALTER DO block is the only place the legacy name
    // appears for live-schema migration.
    expect(sql).not.toMatch(/CREATE TABLE[^\n]*"artifact_provider_cache"[\s\S]*?version_id\s+text/);
    expect(sql).not.toMatch(/CREATE TABLE[^\n]*"artifact_audit"[\s\S]*?version_id\s+text/);
    expect(sql).not.toMatch(/CREATE TABLE[^\n]*"artifact_refs"[\s\S]*?version_id\s+text/);
  });

  it("cache store: expiry-aware miss, no bytes, injected deleteRemote", () => {
    const cache = readFileSync(
      path.join(__dirname, "../artifacts/provider-file-cache.ts"),
      "utf8",
    );
    // a hit past expiry is a MISS (re-upload), enforced in SQL
    expect(cache).toMatch(/expires_at IS NULL OR expires_at > now\(\)/);
    // refs only — never bytes/base64 in the cache store
    expect(cache).not.toMatch(/base64|Buffer|Uint8Array|bytes\[\]/);
    // GC never imports a provider SDK — deleteRemote is injected
    expect(cache).toMatch(/deleteRemote:\s*\(providerFileId: string\)\s*=>\s*Promise/);
    // upsert is transactional
    expect(cache).toMatch(/transaction:\s*true/);
  });

  it("evictExpiredProviderFiles DELETE WHERE has a race-guard predicate", () => {
    const cache = readFileSync(
      path.join(__dirname, "../artifacts/provider-file-cache.ts"),
      "utf8",
    );
    // The DELETE inside `evictExpiredProviderFiles` MUST recheck id +
    // org_id + provider + provider_file_id + expires_at <= now(). A
    // concurrent `ON CONFLICT DO UPDATE` cache refresh that preserves
    // the same `id` but rewrites `provider_file_id` + `expires_at`
    // would orphan the freshly-uploaded provider file if the DELETE
    // matched on `id` alone. Static guard against accidental regression.
    expect(cache).toMatch(
      /DELETE FROM[\s\S]*?artifact_provider_cache[\s\S]*?WHERE\s+id\s*=\s*\$1[\s\S]*?AND\s+org_id\s*=\s*\$2[\s\S]*?AND\s+provider\s*=\s*\$3[\s\S]*?AND\s+provider_file_id\s*=\s*\$4[\s\S]*?AND\s+expires_at\s+IS\s+NOT\s+NULL\s+AND\s+expires_at\s*<=\s*now\(\)/,
    );
    // Return shape MUST carry remoteDeleteFailures so the caller can aggregate
    // and WARN when failures are systemic.
    expect(cache).toMatch(
      /Promise<\{\s*reaped:\s*number;\s*remoteDeleteFailures:\s*number\s*\}>/,
    );
  });

  it("representation table has classifier_signals JSONB column (nullable, no default)", () => {
    // Fresh-schema DDL: the column appears inline in CREATE TABLE.
    expect(sql).toMatch(
      /CREATE TABLE IF NOT EXISTS "[^"]+"\."representation"[\s\S]*?classifier_signals\s+jsonb[\s\S]*?CONSTRAINT representation_form_chk/,
    );
    // Live-schema ALTER: idempotent ADD COLUMN IF NOT EXISTS picks up the
    // column on schemas created before the column existed. Existing rows stay
    // NULL because there is no backfill.
    expect(sql).toMatch(
      /ALTER TABLE "[^"]+"\."representation" ADD COLUMN IF NOT EXISTS classifier_signals jsonb/,
    );
    // NO DEFAULT — back-compat invariant. Existing and new no-signal rows BOTH
    // read NULL.
    expect(sql).not.toMatch(/classifier_signals\s+jsonb\s+DEFAULT/i);
    // The append-only trigger remains BEFORE UPDATE OR DELETE — ADD COLUMN does
    // NOT trip it.
    expect(sql).toMatch(
      /CREATE TRIGGER trg_representation_append_only BEFORE UPDATE OR DELETE/,
    );
  });

  it("ArtifactRef pins representationRevisionId/digest — never objects.version", () => {
    // `versionId` is now `representationRevisionId` to align with the semantic
    // Representation contract.
    const src = readFileSync(
      path.join(__dirname, "../../../packages/artifacts/src/artifact-version.ts"),
      "utf8",
    );
    // Isolate the ArtifactRef type body and assert it pins
    // representationRevisionId+digest and has NO mutable
    // `version`/`rowVersion` counter field. (The file's prose
    // intentionally *mentions* objects.version to explain the rule —
    // so assert on the type shape, not a naive whole-file substring.)
    const refBody = src.slice(
      src.indexOf("export type ArtifactRef"),
      src.indexOf("export type ArtifactVersion"),
    );
    expect(refBody).toMatch(/representationRevisionId:\s*string/);
    expect(refBody).toMatch(/digest:\s*string/);
    expect(refBody).not.toMatch(/^\s*(version|rowVersion):/m);
  });

  it("producer splice ordering + validated provenance (artifact-creation.ts)", () => {
    const src = readFileSync(
      path.join(__dirname, "../artifacts/artifact-creation.ts"),
      "utf8",
    );
    // Producer plan resolved + org-validated BEFORE Tx2.
    expect(src).toMatch(/resolveProducerAssertionPlan\(\{[\s\S]*?createdByRunId:\s*input\.createdByRunId/);
    // The representation INSERT MUST persist the VALIDATED run id
    // (`persistedRunId`) — NEVER the raw caller-supplied
    // `input.createdByRunId` (that would persist a cross-tenant
    // provenance pointer). Isolate the representation INSERT values.
    const repIdx = src.indexOf('INSERT INTO "${schema}"."representation"');
    const repBlock = src.slice(repIdx, repIdx + 800);
    expect(repBlock).toMatch(/persistedRunId/);
    expect(repBlock).not.toMatch(/input\.createdByRunId\s*\?\?\s*null/);
    // Splice ordering: `...producerOps` MUST appear AFTER the
    // artifact_audit INSERT and BEFORE the floor-rebalance INSERT, so
    // the floor's NOT-EXISTS sees the producer's agent-eligible row
    // and skips the default.
    const auditPos = src.indexOf('INSERT INTO "${schema}"."artifact_audit"');
    const splicePos = src.indexOf("...producerOps");
    const floorPos = src.indexOf(
      'INSERT INTO "${schema}"."semantic_assertion"',
    );
    expect(auditPos).toBeGreaterThan(-1);
    expect(splicePos).toBeGreaterThan(auditPos);
    expect(floorPos).toBeGreaterThan(splicePos);
    // parseResult invoked at the documented offset (lock+objects+
    // representation+audit = 4, then 2 ops per producer).
    expect(src).toMatch(/PRODUCER_OPS_OFFSET\s*=\s*4/);
    expect(src).toMatch(/parseResult\([\s\S]{0,80}?PRODUCER_OPS_OFFSET \+ i \* 2/);
    // The producer-outcome parse MUST be POST-COMMIT (after Tx2 + its catch),
    // wrapped in its own try/catch so a parse/offset throw is NOT conflated with
    // a Tx2 failure (false failed-upload -> duplicate artifact on retry).
    const tx2CatchPos = src.indexOf("} catch (err) {", floorPos);
    const postCommitParsePos = src.indexOf(
      "post-commit producer-outcome",
    ) >= 0
      ? src.indexOf("post-commit producer-outcome")
      : src.indexOf("POST-COMMIT producer-outcome");
    expect(postCommitParsePos).toBeGreaterThan(tx2CatchPos);
    // The parse loop is guarded by its own try/catch (observability
    // only — never throws past creation).
    const parseBlock = src.slice(postCommitParsePos, postCommitParsePos + 1600);
    expect(parseBlock).toMatch(/try\s*\{[\s\S]*parseResult[\s\S]*\}\s*catch/);
  });
});
