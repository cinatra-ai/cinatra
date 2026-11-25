// The lent review press's pre-spend decision (cinatra#3080; pre-review 1 of
// #4571, finding 1), with its ports in hand. It asks the review entry's own
// right for each control and the review entry's own Regenerate tests, and the
// right first.
//
// The decision lives in the lent action module itself (no module of its own, so
// the locked route graphs gain nothing). Importing that module needs the same
// load seams its own suite (`lent-action-mcp.test.ts`) stubs; nothing below uses
// them.

import { describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lent-review-press-preflight";

vi.mock("@cinatra-ai/mcp-server", () => ({
  mcpRequestContextStorage: { getStore: () => undefined },
}));
vi.mock("@cinatra-ai/agents/review-task-actions", () => ({
  approveReviewTaskInternal: vi.fn(),
}));
vi.mock(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/actions",
  () => ({ submitReviewDecisionAction: vi.fn() }),
);
vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  enforceReviewRunAccess: vi.fn(),
  readGatePinnedTargets: vi.fn(),
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  readLatestDurableHitlGateArtifact: vi.fn(),
}));
vi.mock("@cinatra-ai/agents/db", () => ({ agentBuilderPool: { query: vi.fn() } }));

import { floorActionRunAccessOp } from "@/lib/artifacts/review-surface-model";
import {
  LENT_REVIEW_NOT_PERMITTED,
  lentReviewPressAccessOp,
  lentReviewPressRefusal,
  type LentReviewPressPorts,
} from "../lent-action-mcp";

function ports(over: Partial<LentReviewPressPorts> & { rights?: string[]; asked?: string[] } = {}) {
  const rights = new Set(over.rights ?? ["approveHitl", "respondToHitl"]);
  const asked = over.asked ?? [];
  return {
    authorize: async (op: string) => {
      asked.push(op);
      return rights.has(op);
    },
    fenceActive: () => true,
    isAutoReviewTaskId: (id: string) => id.startsWith("lifecycle-review:"),
    isBatchAutoReviewTaskId: (id: string) => id.startsWith("lifecycle-review:batch:"),
    messages: { notOnThisReview: "NOT-ON-THIS-REVIEW", multiTarget: "MULTI-TARGET" },
    ...over,
  } as LentReviewPressPorts;
}

const AUTO = "lifecycle-review:evt_1";

describe("lentReviewPressRefusal", () => {
  it("asks the same right the review entry asks for each control", () => {
    expect(lentReviewPressAccessOp("comment")).toBe(floorActionRunAccessOp("comment"));
    expect(lentReviewPressAccessOp("regenerate")).toBe(floorActionRunAccessOp("regenerate"));
    expect(lentReviewPressAccessOp("approve")).toBe(floorActionRunAccessOp("continue"));
  });

  it("refuses a control whose right the actor lacks, and asks the right before any gate fact", async () => {
    const asked: string[] = [];
    let fenceRead = false;
    const out = await lentReviewPressRefusal(
      { control: "regenerate", reviewTaskId: "lifecycle-review:batch:x", pinnedTargetCount: 2 },
      ports({ rights: ["respondToHitl"], asked, fenceActive: () => ((fenceRead = true), true) }),
    );
    expect(out).toEqual({ kind: "not-permitted", message: LENT_REVIEW_NOT_PERMITTED });
    expect(asked).toEqual(["approveHitl"]);
    expect(fenceRead).toBe(false);
  });

  it("refuses an ineligible Regenerate with the entry's sentences", async () => {
    const fenceOff = ports({ fenceActive: () => false });
    expect(await lentReviewPressRefusal({ control: "regenerate", reviewTaskId: AUTO, pinnedTargetCount: 1 }, fenceOff))
      .toEqual({ kind: "error", message: "NOT-ON-THIS-REVIEW" });
    expect(await lentReviewPressRefusal({ control: "regenerate", reviewTaskId: "wayflow-task-7", pinnedTargetCount: 1 }, ports()))
      .toEqual({ kind: "error", message: "NOT-ON-THIS-REVIEW" });
    expect(await lentReviewPressRefusal({ control: "regenerate", reviewTaskId: "lifecycle-review:batch:p", pinnedTargetCount: 1 }, ports()))
      .toEqual({ kind: "error", message: "NOT-ON-THIS-REVIEW" });
    expect(await lentReviewPressRefusal({ control: "regenerate", reviewTaskId: AUTO, pinnedTargetCount: 2 }, ports()))
      .toEqual({ kind: "error", message: "MULTI-TARGET" });
  });

  it("admits an eligible Regenerate, and Comment and Continue on any gate the actor may decide", async () => {
    expect(await lentReviewPressRefusal({ control: "regenerate", reviewTaskId: AUTO, pinnedTargetCount: 1 }, ports())).toBeNull();
    expect(await lentReviewPressRefusal({ control: "approve", reviewTaskId: "lifecycle-review:batch:p", pinnedTargetCount: 3 }, ports())).toBeNull();
    expect(await lentReviewPressRefusal({ control: "comment", reviewTaskId: "wayflow-task-7", pinnedTargetCount: 2 }, ports({ rights: ["respondToHitl"] }))).toBeNull();
  });
});
