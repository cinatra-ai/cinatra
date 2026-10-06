import { describe, expect, it } from "vitest";
import { runStartedByFromFrame } from "../run-started-by";
const signed = { delegation: "agent_run" as const, runId: "starter", userId: "owner", orgId: "org", platformRole: "member" as const, oboCeiling: [] };
describe("verified starter provenance", () => {
  it("records either verified source and their matching composition", () => {
    expect(runStartedByFromFrame({ verifiedRunScopeId: "starter" })).toBe("starter");
    expect(runStartedByFromFrame({ delegatedActor: signed })).toBe("starter");
    expect(runStartedByFromFrame({ delegatedActor: signed, verifiedRunScopeId: "starter" })).toBe("starter");
  });
  it("does not mistake chats, widgets or ambient headers for a starter run", () => {
    expect(runStartedByFromFrame(undefined)).toBeNull();
    expect(runStartedByFromFrame({ runId: "header" })).toBeNull();
    expect(runStartedByFromFrame({ delegatedActor: { delegation: "chat", userId: "human", orgId: "org", platformRole: "member" } })).toBeNull();
  });
  it("refuses conflicting verified identities before a child can be created", () => {
    expect(() => runStartedByFromFrame({ delegatedActor: signed, verifiedRunScopeId: "other" })).toThrow(/disagree/);
  });
  it.each(["", " ", " padded"]) ("refuses invalid verified id %j", id => {
    expect(() => runStartedByFromFrame({ verifiedRunScopeId: id })).toThrow(/invalid/);
  });
});
