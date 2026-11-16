// cinatra#4150 part 7b: THE WRITER READS NOTHING FOR A KIND IT CANNOT WRITE. The publish moment feeds the run outbox, and
// the publish card is an interrupt kind this writer adds no part for. The writer's turn lookup is synchronous, so a writer
// that read the store first would hold the publish road for as long as a slow lookup takes, for nothing. It must refuse
// the kind before the read. An injectable kind still reads the run's turn once (a guard, green at the base).
// Red at the 7a-3b tip: the writer reads the turn for the publish card, then refuses it.
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-refs";

const findAssistantTurnForAgentRun = vi.fn();
const updateAssistantTurn = vi.fn();

vi.mock("@/lib/assistant-thread-store", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  findAssistantTurnForAgentRun: (...a: unknown[]) => findAssistantTurnForAgentRun(...a),
  updateAssistantTurn: (...a: unknown[]) => updateAssistantTurn(...a),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  findAssistantTurnForAgentRun.mockReturnValue(null);
});

describe("the run outbox's writer and the store", () => {
  it("reads no turn for the publish card, so a slow store never holds the publish moment", async () => {
    findAssistantTurnForAgentRun.mockImplementation(() => {
      throw new Error("the store must not be read for a kind the writer cannot write");
    });
    const { lifecycleRunOutbox } = await import("../lifecycle-run-outbox");
    await lifecycleRunOutbox.onMomentOpened({
      runId: "run-1",
      orgId: "org-1",
      moment: "publish",
      cardKind: "publish_decision",
      cardRef: "dec-1",
    });
    expect(findAssistantTurnForAgentRun).not.toHaveBeenCalled();
    expect(updateAssistantTurn).not.toHaveBeenCalled();
  });

  it("still reads the run's turn once for a kind it can write", async () => {
    const { lifecycleRunOutbox } = await import("../lifecycle-run-outbox");
    await lifecycleRunOutbox.onMomentOpened({
      runId: "run-1",
      orgId: "org-1",
      moment: "review",
      cardKind: "artifact_review_gate",
      cardRef: "ref-1",
    });
    expect(findAssistantTurnForAgentRun).toHaveBeenCalledTimes(1);
    expect(findAssistantTurnForAgentRun).toHaveBeenCalledWith("run-1");
  });
});
