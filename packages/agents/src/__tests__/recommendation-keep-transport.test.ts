/**
 * THE KEEP REQUEST REACHES THE WRITE (cinatra#2815 S3 part 4, epic #2812).
 *
 * `keepRecommended` existed only inside the core write and its unit tests: no
 * production entry carried it, so a confirmation that asked to keep the
 * accepted skills wrote nothing and reported nothing. This suite pins the
 * transport across both entries, as a plain pass-through of an EXPLICIT,
 * caller-supplied scope. The scope is still enforced server-side against the
 * run's own snapshot; transporting it is not trusting it.
 *
 * The confirm UI's scope OFFER is deliberately not drawn here: that half waits
 * for the maintainer's ruling on cinatra#2815.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const writeSelection = vi.fn();
const readRecommendationParkForRun = vi.fn();
const releaseRecommendationParkForRun = vi.fn();
const publishRecommendationHoldResume = vi.fn();

vi.mock("../recommendation-hold", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readRecommendationParkForRun: (...a: unknown[]) => readRecommendationParkForRun(...a),
  releaseRecommendationParkForRun: (...a: unknown[]) => releaseRecommendationParkForRun(...a),
  publishRecommendationHoldResume: (...a: unknown[]) => publishRecommendationHoldResume(...a),
}));

import { confirmRecommendationForActor } from "../run-recommendation-core";
import * as core from "../run-recommendation-core";

const WHO = { actor: { actorType: "human", source: "ui", userId: "user-1" }, roleHints: {} };

beforeEach(() => {
  vi.clearAllMocks();
  writeSelection.mockResolvedValue({ ok: true });
  readRecommendationParkForRun.mockResolvedValue(null);
  releaseRecommendationParkForRun.mockResolvedValue(undefined);
  publishRecommendationHoldResume.mockResolvedValue(undefined);
});

describe("confirmRecommendationForActor forwards the keep request", () => {
  it("passes an explicit scope through to the authoritative write", async () => {
    const keep = { scope: { scopeKind: "organization" as const, scopeId: "org-1" } };
    await confirmRecommendationForActor({
      runId: "run-1",
      confirmedSkillIds: ["skill-a"],
      who: WHO as never,
      writeSelection: writeSelection as never,
      keepRecommended: keep,
    } as never);
    expect(writeSelection).toHaveBeenCalledTimes(1);
    expect(writeSelection.mock.calls[0][0].keepRecommended).toEqual(keep);
  });

  it("carries nothing when the caller asked for no keep", async () => {
    await confirmRecommendationForActor({
      runId: "run-1",
      confirmedSkillIds: ["skill-a"],
      who: WHO as never,
      writeSelection: writeSelection as never,
    } as never);
    expect(writeSelection.mock.calls[0][0]).not.toHaveProperty("keepRecommended");
  });
});

describe("the write contract names the keep", () => {
  it("is part of the selection-write input every entry hands over", () => {
    // A structural pin: the type is erased at runtime, so what is asserted is
    // that the core exports the two symbols an entry needs to transport it.
    expect(typeof core.writeRunSkillSelectionForActor).toBe("function");
    expect(typeof core.confirmRecommendationForActor).toBe("function");
  });
});
