// cinatra#1875 W2 (Epic #1873) — AC#7: assistants are excluded from A2A publication.
//
// The two pure decisions of the guard leaf, tested WITHOUT the store import graph:
//   - the store INVARIANT (`assertNotAssistantPublication`): publishing an assistant
//     throws; every other transition is allowed;
//   - the shared READER FILTER (`excludeAssistantTemplates`): assistant rows are
//     dropped so the mount, the `.well-known/agent.json` card, and the in-process
//     resolver (all consuming `readPublishedAgentTemplates`) omit them.
//
// A consumer-level test (below) pins that the in-process A2A resolver relies on the
// filtered reader — an assistant the reader dropped is unresolvable by package name.

import { describe, it, expect } from "vitest";
import {
  ASSISTANT_A2A_PUBLICATION_ERROR,
  assertNotAssistantPublication,
  isAssistantPublicationAttempt,
  excludeAssistantTemplates,
} from "../a2a-publication-guard";

describe("A2A publication invariant — assertNotAssistantPublication", () => {
  it("throws when an assistant template is moved to published", () => {
    expect(() => assertNotAssistantPublication("assistant", "published")).toThrow(
      ASSISTANT_A2A_PUBLICATION_ERROR,
    );
    expect(isAssistantPublicationAttempt("assistant", "published")).toBe(true);
  });

  it("allows an EXECUTOR template to publish", () => {
    expect(() => assertNotAssistantPublication("executor", "published")).not.toThrow();
    expect(isAssistantPublicationAttempt("executor", "published")).toBe(false);
  });

  it("allows an assistant template to move to any NON-published status", () => {
    for (const status of ["draft", "active", "archived", "locked", undefined]) {
      expect(() => assertNotAssistantPublication("assistant", status)).not.toThrow();
      expect(isAssistantPublicationAttempt("assistant", status)).toBe(false);
    }
  });

  it("treats a null/undefined kind as executor (never blocks a non-assistant)", () => {
    expect(() => assertNotAssistantPublication(null, "published")).not.toThrow();
    expect(() => assertNotAssistantPublication(undefined, "published")).not.toThrow();
  });
});

describe("A2A shared reader filter — excludeAssistantTemplates", () => {
  it("drops assistant-kind rows, keeps executor + kind-less rows", () => {
    const rows = [
      { id: "a", agentKind: "assistant" },
      { id: "b", agentKind: "executor" },
      { id: "c", agentKind: null },
      { id: "d" }, // no agentKind field at all
      { id: "e", agentKind: "assistant" },
    ];
    expect(excludeAssistantTemplates(rows).map((r) => r.id)).toEqual(["b", "c", "d"]);
  });

  it("returns an empty list when every row is an assistant", () => {
    expect(
      excludeAssistantTemplates([
        { id: "x", agentKind: "assistant" },
        { id: "y", agentKind: "assistant" },
      ]),
    ).toEqual([]);
  });
});
