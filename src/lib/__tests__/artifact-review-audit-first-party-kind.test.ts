// DDL parity for the `renderer_kind` vocabulary of `artifact_review_audit`
// (cinatra#2931 W4).
//
// W4 gave the review card the host's own renderer for declared text forms, and
// records a target it rendered that way as `first-party` — never as a floor,
// because the floor gate counts floor rows and a draft the reviewer read in full
// is not a review that fell through.
//
// `renderer_kind` carries a CHECK. Before this slice it admitted exactly
// `build-map`, `runtime`, `floor`. The decision core writes the provenance it
// RE-RESOLVES at submit time straight into that column inside the same
// transaction as the gate CAS, so a value the CHECK refuses does not degrade the
// audit row: it rolls the whole decision back. A markdown draft would have
// rendered under review and then been impossible to approve, reject or comment
// on. The vocabulary therefore has to be widened in BOTH homes — the fresh-install
// bootstrap DDL and the operator-upgrade migration — or the two disagree and a
// deployed instance keeps the failure the fresh install does not have.
//
// This suite pins the shape without a database. The behavioural proof — a real
// commit of a `first-party` audit row against real DDL — runs in
// `packages/agents/src/__tests__/artifact-review-gate-store.integration.test.ts`.
import { describe, expect, it } from "vitest";

import {
  artifactReviewGateSchemaQueries,
  artifactReviewFormProvenanceSchemaQueries,
} from "@/lib/artifacts/artifact-review-gate-schema";
import { artifactReviewAuditFirstPartyKindDdlSql } from "../../../migrations/core/core__0097_artifact-review-audit-first-party-renderer-kind.mjs";

const bootstrapCreate = artifactReviewGateSchemaQueries("cinatra")
  .map((q) => q.text)
  .join("\n");
const bootstrapWiden = artifactReviewFormProvenanceSchemaQueries("cinatra")
  .map((q) => q.text)
  .join("\n");

/** The four kinds `ReviewRendererProvenance` can carry after W4. */
const KINDS = ["build-map", "runtime", "first-party", "floor"] as const;

describe("artifact_review_audit.renderer_kind — the W4 vocabulary, in both homes", () => {
  it("the fresh-install CREATE TABLE admits every kind the decision core can write", () => {
    const check = /renderer_kind\s+text NOT NULL CHECK \(renderer_kind IN \(([^)]*)\)\)/.exec(
      bootstrapCreate,
    );
    expect(check).not.toBeNull();
    for (const kind of KINDS) expect(check![1]).toContain(`'${kind}'`);
  });

  const BOTH: Array<[string, string]> = [
    ["fresh-install bootstrap widen", bootstrapWiden],
    ["operator-upgrade migration", artifactReviewAuditFirstPartyKindDdlSql],
  ];

  it.each(BOTH)("%s widens the EXISTING constraint idempotently", (_name, sql) => {
    // Postgres names a column CHECK `<table>_<column>_check` deterministically,
    // which is what makes the drop-then-add idiom idempotent: a no-op on an
    // already-widened schema, a widen on a deployed one.
    expect(sql).toMatch(
      /ALTER TABLE[^\n]*artifact_review_audit[^\n]*DROP CONSTRAINT IF EXISTS artifact_review_audit_renderer_kind_check/,
    );
    expect(sql).toMatch(/ADD CONSTRAINT artifact_review_audit_renderer_kind_check/);
  });

  it.each(BOTH)("%s admits exactly the four kinds — no more, no fewer", (_name, sql) => {
    const add = /ADD CONSTRAINT artifact_review_audit_renderer_kind_check\s*\n?\s*CHECK \(renderer_kind IN \(([^)]*)\)\)/.exec(
      sql,
    );
    expect(add).not.toBeNull();
    const admitted = add![1]
      .split(",")
      .map((s) => s.trim().replace(/'/g, ""))
      .sort();
    expect(admitted).toEqual([...KINDS].sort());
  });

  it.each(BOTH)("%s never drops an EXISTING audit row", (_name, sql) => {
    // The widen is strictly additive: every value the old CHECK admitted is
    // still admitted, so no committed audit row can become invalid.
    expect(sql).not.toMatch(/\bDELETE\b|\bDROP TABLE\b|\bTRUNCATE\b/i);
  });
});
