// Bootstrap DDL shape for `run_recommendation_offered_set` (cinatra#2906).
//
// The table records what a recommendation card ACTUALLY offered, so a confirm
// pins the revision the reader saw rather than one a fresh scoring pass would
// resolve at press time. Its shape is load-bearing in four places, and this
// suite pins each without needing a database:
//
//   · the key is (hold_id, skill_id) — the offer belongs to a HOLD, because one
//     run can be parked, decided and parked again, and each hold offered its own
//     set;
//   · `skill_revision_id` is NOT NULL — an offer with no pin is not an offer;
//   · `recommended` and `offered_rank` are recorded, because the efficacy split
//     must be measured against what was offered, not against a later scoring;
//   · no foreign key, matching the three siblings in this family.
//
// ONE HOME, deliberately. Unlike `run_recommendation_skips` (whose marker write
// is a release gate, so a missing table would make every skip refuse), this
// table's absence costs only the fix: with no recorded offer the confirm keeps
// its pre-#2906 behaviour. The idempotent bootstrap therefore carries it onto
// existing deployments at the next boot and no numbered migration is required.
import { describe, expect, it } from "vitest";

import {
  RUN_RECOMMENDATION_OFFERED_SET_HOLD_INDEX,
  RUN_RECOMMENDATION_OFFERED_SET_RUN_INDEX,
  RUN_RECOMMENDATION_OFFERED_SET_TABLE,
  runRecommendationOfferedSetSchemaQueries,
} from "@/lib/artifacts/artifact-review-gate-schema";

const sql = runRecommendationOfferedSetSchemaQueries("cinatra")
  .map((q) => q.text)
  .join("\n");

describe("run_recommendation_offered_set — the bootstrap DDL", () => {
  it("creates the table idempotently, qualified with the app schema", () => {
    expect(sql).toMatch(
      new RegExp(`CREATE TABLE IF NOT EXISTS[^(]*${RUN_RECOMMENDATION_OFFERED_SET_TABLE}`),
    );
    expect(runRecommendationOfferedSetSchemaQueries("cinatra")[0]!.text).toContain(
      `"cinatra"."${RUN_RECOMMENDATION_OFFERED_SET_TABLE}"`,
    );
  });

  it("binds the offer to the HOLD, one row per offered skill", () => {
    expect(sql).toMatch(/hold_id\s+text NOT NULL/);
    expect(sql).toMatch(/skill_id\s+text NOT NULL/);
    expect(sql).toMatch(
      /CONSTRAINT run_recommendation_offered_set_uniq UNIQUE \(hold_id, skill_id\)/,
    );
  });

  it("records the PIN the confirm honours, and never a nullable one", () => {
    // An offer with no pinned revision is not an offer: the whole point of the
    // row is that the confirm has a revision it can use without re-resolving.
    expect(sql).toMatch(/skill_revision_id text NOT NULL/);
  });

  it("records what the efficacy split must be measured against", () => {
    expect(sql).toMatch(/recommended\s+boolean NOT NULL/);
    expect(sql).toMatch(/offered_rank\s+integer NOT NULL/);
    expect(sql).toMatch(/offered_at\s+timestamptz NOT NULL DEFAULT now\(\)/);
  });

  it("carries NO foreign key, matching the family", () => {
    // run_selected_skill_revisions / run_rejected_recommendations /
    // run_recommendation_skips all carry a bare run_id.
    expect(sql).not.toMatch(/REFERENCES/i);
  });

  it("indexes both lookups it serves", () => {
    expect(sql).toMatch(
      new RegExp(
        `CREATE INDEX IF NOT EXISTS ${RUN_RECOMMENDATION_OFFERED_SET_HOLD_INDEX}[\\s\\S]*\\(hold_id\\)`,
      ),
    );
    expect(sql).toMatch(
      new RegExp(
        `CREATE INDEX IF NOT EXISTS ${RUN_RECOMMENDATION_OFFERED_SET_RUN_INDEX}[\\s\\S]*\\(run_id\\)`,
      ),
    );
  });
});
