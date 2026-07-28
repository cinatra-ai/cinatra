/**
 * cinatra#2139 — PURE unit proofs of the artifact-writer PROVENANCE WITNESS: the
 * one definition every host artifact writer emits and every claimed-row read gate
 * tests.
 *
 * WHY THIS FILE EXISTS. The witness is only useful if the WRITE side and the READ
 * side describe the same row. Before the shared module, three writers hand-rolled
 * the INSERT (one of them didn't emit it at all) and one reader hand-rolled the
 * EXISTS — a drift the type system cannot see, because both sides are strings.
 * These tests pin the two halves to each other and to the schema quoting rule.
 *
 * The row's EXISTENCE is the signal. Its `detail` payload is never authorization
 * input, which is exactly why the predicate below never reads it.
 */
import { describe, expect, it } from "vitest";

import {
  ARTIFACT_WRITER_WITNESS_ACTION,
  artifactWriterWitnessExistsSql,
  buildArtifactWriterWitnessOp,
} from "../artifact-writer-witness";

const SCHEMA = "cinatra_test";

describe("cinatra#2139 — the writer-provenance witness INSERT", () => {
  it("writes an append-only artifact_audit row keyed to the exact representation", () => {
    const op = buildArtifactWriterWitnessOp(SCHEMA, {
      orgId: "org-1",
      artifactId: "art-1",
      representationRevisionId: "rev-1",
      actor: "user-1",
      detail: { mime: "text/markdown", size: 12 },
    });
    expect(op.text).toContain(`INSERT INTO "${SCHEMA}"."artifact_audit"`);
    expect(op.text).toContain("representation_revision_id");
    // The action is a LITERAL, never a bound parameter: a writer cannot vary it.
    expect(op.text).toContain(`'${ARTIFACT_WRITER_WITNESS_ACTION}'`);
    expect(op.values).toEqual([
      "org-1",
      "art-1",
      "rev-1",
      "user-1",
      JSON.stringify({ mime: "text/markdown", size: 12 }),
    ]);
  });

  it("is an INSERT only — never an UPDATE/DELETE/upsert (the table is append-only)", () => {
    const op = buildArtifactWriterWitnessOp(SCHEMA, {
      orgId: "o",
      artifactId: "a",
      representationRevisionId: "r",
    });
    expect(op.text).not.toMatch(/ON CONFLICT|UPDATE|DELETE/i);
  });

  it("tolerates an absent actor and an absent detail (a witness needs neither)", () => {
    const op = buildArtifactWriterWitnessOp(SCHEMA, {
      orgId: "o",
      artifactId: "a",
      representationRevisionId: "r",
    });
    expect(op.values[3]).toBeNull();
    expect(op.values[4]).toBe("{}");
  });
});

describe("cinatra#2139 — the witness PREDICATE", () => {
  it("matches the INSERT: same table, same action literal, same three keys", () => {
    const insert = buildArtifactWriterWitnessOp(SCHEMA, {
      orgId: "o",
      artifactId: "a",
      representationRevisionId: "r",
    });
    const predicate = artifactWriterWitnessExistsSql(SCHEMA, {
      orgId: "rep.org_id",
      artifactId: "rep.artifact_id",
      representationRevisionId: "rep.id",
    });
    expect(insert.text).toContain(`"${SCHEMA}"."artifact_audit"`);
    expect(predicate).toContain(`"${SCHEMA}"."artifact_audit"`);
    expect(predicate).toContain(`aud.action = '${ARTIFACT_WRITER_WITNESS_ACTION}'`);
    expect(predicate).toContain("aud.org_id = rep.org_id");
    expect(predicate).toContain("aud.artifact_id = rep.artifact_id");
    expect(predicate).toContain("aud.representation_revision_id = rep.id");
  });

  it("is org- AND artifact- AND representation-scoped — never representation alone", () => {
    // A representation-only predicate would admit any org's audit row that
    // happened to carry the id. All three keys are required together.
    const predicate = artifactWriterWitnessExistsSql(SCHEMA, {
      orgId: "$1",
      artifactId: "$2",
      representationRevisionId: "$3",
    });
    expect(predicate.startsWith("EXISTS (")).toBe(true);
    for (const key of ["aud.org_id = $1", "aud.artifact_id = $2", "aud.representation_revision_id = $3"]) {
      expect(predicate).toContain(key);
    }
  });

  it("never reads the audit row's detail payload (existence is the signal)", () => {
    const predicate = artifactWriterWitnessExistsSql(SCHEMA, {
      orgId: "a",
      artifactId: "b",
      representationRevisionId: "c",
    });
    expect(predicate).not.toContain("detail");
  });

  it("carries the caller's ALREADY-ESCAPED schema identifier through unchanged", () => {
    // Every call site passes postgresSchema.replaceAll('"','""'); the builder must
    // not double-escape it.
    const escaped = 'we""ird';
    expect(artifactWriterWitnessExistsSql(escaped, {
      orgId: "a",
      artifactId: "b",
      representationRevisionId: "c",
    })).toContain(`"${escaped}"."artifact_audit"`);
    expect(
      buildArtifactWriterWitnessOp(escaped, {
        orgId: "o",
        artifactId: "a",
        representationRevisionId: "r",
      }).text,
    ).toContain(`"${escaped}"."artifact_audit"`);
  });
});
