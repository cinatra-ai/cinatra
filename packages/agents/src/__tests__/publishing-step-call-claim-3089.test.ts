// cinatra#3089: a declared publishing step's tool call is performed at most once per released decision. The store claims
// the decision with ONE insert into the durable consumption ledger (artifact_review_action_consumptions) under the key
// `publish-decision:<decision id>`, conflict-free on that key, so only one caller's insert returns a row. Over a double of
// the database; the decision's own row is never written.
// red-first-expect: claimPublishDecisionConsumption is not a function
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableColumns } from "drizzle-orm";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  tables: [] as unknown[],
  values: [] as Array<Record<string, unknown>>,
  targets: [] as unknown[],
  updates: 0,
  inserted: [] as unknown[],
}));

vi.mock("../db", () => ({
  db: {
    insert: (table: unknown) => {
      h.tables.push(table);
      return {
        values: (v: Record<string, unknown>) => {
          h.values.push(v);
          return {
            onConflictDoNothing: (opts: { target?: unknown }) => {
              h.targets.push(opts?.target);
              return { returning: async () => h.inserted };
            },
          };
        },
      };
    },
    update: () => {
      h.updates += 1;
      throw new Error("the decision row is never written by a claim");
    },
  },
}));

import { artifactReviewActionConsumptions } from "../schema";

const claim = async (input: Record<string, unknown>): Promise<boolean> => {
  const store = (await import("../publish-decision-store")) as unknown as {
    claimPublishDecisionConsumption: (i: Record<string, unknown>) => Promise<boolean>;
  };
  return store.claimPublishDecisionConsumption(input);
};

const INPUT = {
  decisionId: "decision-1",
  orgId: "org-1",
  runId: "run-1",
  stepId: "send_campaign",
  toolIdentity: { road: "passthrough_publishing_step", tool: "email_outreach_send_initial_start" },
  executedSourceSha256: "a".repeat(64),
};

beforeEach(() => {
  h.tables.length = 0;
  h.values.length = 0;
  h.targets.length = 0;
  h.updates = 0;
  h.inserted = [];
});

describe("claimPublishDecisionConsumption", () => {
  it("inserts one row into the consumption ledger under the decision's prefixed key, in the run's organisation", async () => {
    h.inserted = [{ gateId: "publish-decision:decision-1" }];
    expect(await claim(INPUT)).toBe(true);
    expect(h.tables).toEqual([artifactReviewActionConsumptions]);
    expect(h.values).toEqual([
      {
        gateId: "publish-decision:decision-1",
        runId: "run-1",
        orgId: "org-1",
        stepId: "send_campaign",
        toolIdentity: INPUT.toolIdentity,
        executedSourceSha256: INPUT.executedSourceSha256,
      },
    ]);
    // Conflict-free on the ledger's key: of two callers only one insert returns a row.
    expect(h.targets).toEqual([getTableColumns(artifactReviewActionConsumptions).gateId]);
    expect(h.updates).toBe(0);
  });

  it("is not won when the decision was claimed before: the insert returns no row", async () => {
    h.inserted = [];
    expect(await claim(INPUT)).toBe(false);
  });

  it("records an empty source hash for a call that carried no verified executed source", async () => {
    h.inserted = [{ gateId: "publish-decision:decision-1" }];
    expect(await claim({ ...INPUT, executedSourceSha256: null })).toBe(true);
    expect(h.values[0]?.executedSourceSha256).toBe("");
  });

  it.each([
    ["decisionId", ""],
    ["orgId", ""],
    ["orgId", null],
    ["runId", "  "],
    ["stepId", undefined],
  ])("refuses a claim whose %s is %j before any write", async (field, value) => {
    await expect(claim({ ...INPUT, [field]: value })).rejects.toThrow(/must be a non-empty string/);
    expect(h.values).toHaveLength(0);
  });
});
