// The PURE durable-turn → transcript-message projection (cinatra#2823, epic
// #2784 S9j), exported from `assistant-thread-store.ts` — see the section header
// there for why it is a section of that file and not a module of its own.
//
// No database, no DOM: these are pure functions driven directly. The end-to-end
// proof that this projection agrees with the real sink and the real chat view is
// the Postgres contract tier
// (`src/lib/assistant-runtime/__tests__/durable-lifecycle-reload-contract.integration.test.ts`).
// What is pinned here is the TRIAGE — the half a reader has to be able to check
// without standing up a database.

import { describe, expect, it } from "vitest";

import {
  carriesLifecycleRenderState,
  isDurableAssistantTurnContent,
  projectDurableAssistantTurn,
  toolCallIdsOf,
} from "../assistant-thread-store";

const REVIEW_VIEW = { viewType: "artifact_review_gate", schemaVersion: 1, ref: "gate-1" };

function durable(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: "assistant-turn-v1",
    role: "assistant",
    content: "here it is",
    parts: [{ type: "text", text: "here it is" }],
    ...over,
  };
}

describe("the format gate", () => {
  it("recognizes only the sink's durable object", () => {
    expect(isDurableAssistantTurnContent(durable())).toBe(true);
    // A legacy-mirror row's content is a whole UiMessage, not this format.
    expect(isDurableAssistantTurnContent({ id: "m1", role: "assistant", content: "hi" })).toBe(false);
    expect(isDurableAssistantTurnContent(null)).toBe(false);
    expect(isDurableAssistantTurnContent("assistant-turn-v1")).toBe(false);
    expect(isDurableAssistantTurnContent([durable()])).toBe(false);
  });

  it("projects null for anything that is not the format", () => {
    expect(projectDurableAssistantTurn("t1", { id: "m1", role: "assistant" })).toBeNull();
    expect(projectDurableAssistantTurn("t1", undefined)).toBeNull();
  });
});

describe("the ordered part trace", () => {
  it("maps text, and completes a tool_call from its tool_result in place", () => {
    const projected = projectDurableAssistantTurn(
      "turn-1",
      durable({
        parts: [
          { type: "text", text: "A" },
          { type: "tool_call", id: "c1", name: "objects_list", serverLabel: "cinatra" },
          { type: "tool_result", id: "c1", name: "objects_list", resultLabel: "0 found", result: "[]" },
          { type: "text", text: "B" },
        ],
      }),
    );
    expect(projected).toEqual({
      id: "turn-1",
      role: "assistant",
      content: "here it is",
      parts: [
        { kind: "text", content: "A" },
        {
          kind: "tool_call",
          id: "c1",
          name: "objects_list",
          status: "completed",
          serverLabel: "cinatra",
          resultLabel: "0 found",
        },
        { kind: "text", content: "B" },
      ],
    });
  });

  it("reads a call with NO result as failed — the stream ended before it returned", () => {
    const projected = projectDurableAssistantTurn(
      "turn-1",
      durable({ parts: [{ type: "tool_call", id: "c1", name: "objects_list" }] }),
    );
    expect(projected!.parts).toEqual([
      { kind: "tool_call", id: "c1", name: "objects_list", status: "failed" },
    ]);
  });

  it("dedupes a repeated tool_call by id, as the live applier does", () => {
    const projected = projectDurableAssistantTurn(
      "turn-1",
      durable({
        parts: [
          { type: "tool_call", id: "c1", name: "objects_list" },
          { type: "tool_call", id: "c1", name: "objects_list" },
        ],
      }),
    );
    expect(projected!.parts).toHaveLength(1);
  });

  it("drops a tool_result with no matching call, and an unknown part type", () => {
    const projected = projectDurableAssistantTurn(
      "turn-1",
      durable({
        parts: [
          { type: "tool_result", id: "orphan", resultLabel: "ok" },
          { type: "some_future_part", payload: 1 },
          { type: "text", text: "A" },
        ],
      }),
    );
    expect(projected!.parts).toEqual([{ kind: "text", content: "A" }]);
  });

  it("collects citations onto the message", () => {
    const projected = projectDurableAssistantTurn(
      "turn-1",
      durable({
        parts: [
          { type: "citations", citations: [{ index: 1, title: "A", url: "https://a.example" }] },
        ],
      }),
    );
    expect(projected!.citations).toEqual([{ index: 1, title: "A", url: "https://a.example" }]);
  });
});

describe("the DATA_PART triage — the reducer's rule, on persisted state", () => {
  it("CARRIES a renderable view through", () => {
    const projected = projectDurableAssistantTurn("turn-1", durable({ dataParts: [REVIEW_VIEW] }));
    expect(projected!.dataParts).toEqual([REVIEW_VIEW]);
  });

  it("CONSUMES an agent_run pin onto its tool call rather than carrying it", () => {
    const projected = projectDurableAssistantTurn(
      "turn-1",
      durable({
        parts: [{ type: "tool_call", id: "c1", name: "agent_run" }],
        dataParts: [{ kind: "agent_run", toolCallId: "c1", runId: "run-A" }],
      }),
    );
    expect(projected!.dataParts).toBeUndefined();
    expect(projected!.parts![0].runId).toBe("run-A");
  });

  it("no-ops an agent_run pin for an unknown toolCallId", () => {
    const projected = projectDurableAssistantTurn(
      "turn-1",
      durable({
        parts: [{ type: "tool_call", id: "c1", name: "agent_run" }],
        dataParts: [{ kind: "agent_run", toolCallId: "nope", runId: "run-A" }],
      }),
    );
    expect(projected!.parts![0].runId).toBeUndefined();
    expect(projected!.dataParts).toBeUndefined();
  });

  it("classifies by viewType FIRST, so a view carrying a legacy `kind` still draws", () => {
    // The reducer's stated precedence. If the two sides disagreed, a card would
    // change identity between the live render and the reload.
    const smuggled = { ...REVIEW_VIEW, kind: "agent_run", toolCallId: "c1", runId: "run-A" };
    const projected = projectDurableAssistantTurn(
      "turn-1",
      durable({
        parts: [{ type: "tool_call", id: "c1", name: "agent_run" }],
        dataParts: [smuggled],
      }),
    );
    expect(projected!.dataParts).toEqual([smuggled]);
    expect(projected!.parts![0].runId).toBeUndefined();
  });

  it("never turns a citations payload into a renderable view", () => {
    const projected = projectDurableAssistantTurn(
      "turn-1",
      durable({ dataParts: [{ kind: "citations", citations: [] }] }),
    );
    expect(projected!.dataParts).toBeUndefined();
  });

  it("ignores a non-object dataParts entry rather than throwing", () => {
    const projected = projectDurableAssistantTurn(
      "turn-1",
      durable({ dataParts: ["nope", null, 7, REVIEW_VIEW] }),
    );
    expect(projected!.dataParts).toEqual([REVIEW_VIEW]);
  });
});

describe("field presence and emptiness", () => {
  it("omits every key it has nothing for", () => {
    const projected = projectDurableAssistantTurn("turn-1", durable({ parts: [] }));
    expect(projected).toEqual({ id: "turn-1", role: "assistant", content: "here it is" });
  });

  it("projects null for a turn with no text, no parts and no views", () => {
    expect(projectDurableAssistantTurn("turn-1", durable({ content: "", parts: [] }))).toBeNull();
  });
});

describe("carriesLifecycleRenderState — the fold-in's narrowing predicate", () => {
  it("is TRUE for a renderable view and for a pinned run", () => {
    expect(carriesLifecycleRenderState({ id: "t", role: "assistant", content: "", dataParts: [REVIEW_VIEW] })).toBe(true);
    expect(
      carriesLifecycleRenderState({
        id: "t",
        role: "assistant",
        content: "",
        parts: [{ kind: "tool_call", id: "c1", name: "agent_run", runId: "run-A" }],
      }),
    ).toBe(true);
  });

  it("is FALSE for an ordinary turn — which is what keeps the fold-in inert", () => {
    expect(
      carriesLifecycleRenderState({
        id: "t",
        role: "assistant",
        content: "hi",
        parts: [
          { kind: "text", content: "hi" },
          { kind: "tool_call", id: "c1", name: "objects_list", status: "completed" },
        ],
      }),
    ).toBe(false);
  });
});

describe("toolCallIdsOf — the only key the two writers share", () => {
  it("reads the ids off either representation's render trace", () => {
    expect(
      Array.from(
        toolCallIdsOf({
          parts: [
            { kind: "tool_call", id: "c1", name: "x" },
            { kind: "text", content: "hi" },
            { kind: "tool_call", id: "c2", name: "y" },
          ],
        }),
      ),
    ).toEqual(["c1", "c2"]);
  });

  it("is empty for a message with no trace, and never throws on junk", () => {
    expect(toolCallIdsOf({ content: "hi" }).size).toBe(0);
    expect(toolCallIdsOf(null).size).toBe(0);
    expect(toolCallIdsOf({ parts: [null, 7, { kind: "tool_call" }] }).size).toBe(0);
  });
});
