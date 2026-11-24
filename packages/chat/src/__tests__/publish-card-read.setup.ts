// THE PUBLISH CARD'S READ, answered once for the whole chat suite (cinatra#4150).
//
// The conversation hosts mount the publish card beside the hitl screen card, and the card reads its own state through
// a session server action. In this suite that read answers the reading of a run with no open publish decision, so
// the real card draws nothing and every suite that does not test the card draws what it drew before the mount.
// A suite that tests the card mocks the same module in its own file; that mock replaces this one.
import { vi } from "vitest";

vi.mock("../../../agents/src/publish-decision-card-actions", () => ({
  getPublishDecisionCardStateAction: async () => ({ state: "none" }),
  decidePublishDecisionCardAction: async () => "failed",
}));
