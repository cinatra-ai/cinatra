/**
 * cinatra#3091 wave 3 — THE PROMOTED REVISION CARRIES THE ARTIFACT-WRITER
 * WITNESS, so the bytes it names can actually be served.
 *
 * MEASURED ON THE LIVE SURFACE BEFORE THIS TEST EXISTED. A png uploaded through
 * the product's own Upload control and confirmed as `@cinatra-ai/screenshot-
 * artifact:screenshot` through the library's own §VI.1 picker was promoted: the
 * row was retyped and the road appended revision 2 sharing the base revision's
 * resource. The artifact page then drew the promoted revision's byte URL —
 * `/api/artifacts/{id}/versions/{promoted}/preview` — and got 404. `/content`
 * for the same revision: 404. The BASE revision of the same row: 200. The page
 * painted a header over an empty plate, which is the one thing issue #3091 item
 * 7 forbids ("No display in the set paints blank").
 *
 * THE CAUSE, and why it belongs to this road. `artifact-writer-witness.ts`
 * states the host's invariant in its own words: "every host writer that mints a
 * blob-backed representation emits the witness, and every claimed-row read path
 * (serve, context candidacy, selection finalization) tests for it through
 * `artifactWriterWitnessExistsSql` — so a writer and a reader can never drift
 * apart into 'authored bytes that no read path will admit'." The typed promotion
 * road is such a writer: its append mints a blob-backed `representation` on a
 * PACK-TYPED row, which is exactly the row class the serve arm admits only on
 * the witness. It emitted no witness, so the drift the module exists to prevent
 * is what the surface measured.
 *
 * RED BEFORE THE FIX: `buildPromotionAppendQueries` did not exist — the append's
 * transaction was composed inline and carried the advisory lock and the
 * representation INSERT only, with nothing writing `artifact_audit`.
 */
import { describe, expect, it } from "vitest";

import {
  ARTIFACT_WRITER_WITNESS_ACTION,
  buildArtifactWriterWitnessOpIfAbsent,
} from "../artifact-writer-witness";
import { buildPromotionAppendQueries } from "../typed-promotion-store";

const SCHEMA = "cinatra_test";

const FACTS = {
  orgId: "org-1",
  artifactId: "art-1",
  representationRevisionId: "rep_abc123",
  sharedResourceId: "res-1",
  form: "file" as const,
  createdBy: "user-1",
  toType: "@cinatra-ai/screenshot-artifact:screenshot",
  mime: "image/png",
};

describe("the promotion append writes the witness in its own transaction", () => {
  it("composes the lock, the representation append and the witness — in that order", () => {
    const queries = buildPromotionAppendQueries(SCHEMA, FACTS);
    expect(queries).toHaveLength(3);
    expect(queries[0]!.text).toContain("pg_advisory_xact_lock");
    expect(queries[1]!.text).toContain(`"${SCHEMA}"."representation"`);
    expect(queries[2]!.text).toContain(`"${SCHEMA}"."artifact_audit"`);
  });

  it("the witness vouches for the SAME representation the append mints", () => {
    const queries = buildPromotionAppendQueries(SCHEMA, FACTS);
    // The representation INSERT's first bound value is the revision id.
    expect(queries[1]!.values[0]).toBe(FACTS.representationRevisionId);
    // The witness carries that exact id — a witness for another revision is no
    // witness at all.
    expect(queries[2]!.values).toContain(FACTS.representationRevisionId);
    expect(queries[2]!.text).toContain(`'${ARTIFACT_WRITER_WITNESS_ACTION}'`);
  });

  it("is the SHARED witness definition, never a second spelling of it", () => {
    const queries = buildPromotionAppendQueries(SCHEMA, FACTS);
    const shared = buildArtifactWriterWitnessOpIfAbsent(SCHEMA, {
      orgId: FACTS.orgId,
      artifactId: FACTS.artifactId,
      representationRevisionId: FACTS.representationRevisionId,
      actor: FACTS.createdBy,
      detail: { road: "typed-promotion", toType: FACTS.toType, mime: FACTS.mime },
    });
    expect(queries[2]!.text).toBe(shared.text);
    expect(queries[2]!.values).toEqual(shared.values);
  });

  it("the witness converges — a re-run of an interrupted promotion writes no second row", () => {
    // The representation append is `ON CONFLICT (id) DO NOTHING`, so the road's
    // own converging branch re-runs this transaction against a row that is
    // already there. The witness must converge the same way, or the repair of an
    // interrupted promotion stacks duplicate `create` rows on one revision.
    const op = buildArtifactWriterWitnessOpIfAbsent(SCHEMA, {
      orgId: FACTS.orgId,
      artifactId: FACTS.artifactId,
      representationRevisionId: FACTS.representationRevisionId,
    });
    expect(op.text).toContain("WHERE NOT EXISTS");
    expect(op.text).toContain(`action = '${ARTIFACT_WRITER_WITNESS_ACTION}'`);
  });

  it("repairs a promotion that landed before the witness did", () => {
    // The pre-fix rows are retyped, appended and unservable. The converging
    // re-run reaches this same transaction, the representation INSERT does
    // nothing, and the witness — absent — is written. That is the repair.
    const queries = buildPromotionAppendQueries(SCHEMA, FACTS);
    expect(queries[1]!.text).toContain("ON CONFLICT (id) DO NOTHING");
    expect(queries[2]!.text).toContain("NOT EXISTS");
  });
});
