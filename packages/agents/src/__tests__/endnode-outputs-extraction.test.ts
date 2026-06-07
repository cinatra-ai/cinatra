/**
 * Hermetic tests for the EndNode-outputs sentinel extraction + stripping
 * helpers exported from `execution.ts`.
 *
 * WayFlow's `_patched_run_task` (docker/wayflow/agent_loader.py) appends a
 * synthetic A2A DataPart message on `FinishedStatus` carrying the EndNode
 * declared output values under `__cinatra_endnode_outputs__`. The
 * dispatcher (`handleWayflowTaskState`) consumes those values into
 * `stepResults[0].output_data` and strips the sentinel from the persisted
 * history. These tests lock the helper contract in isolation; the
 * full-dispatcher integration is exercised by the existing
 * `handle-wayflow-task-state.test.ts` fixtures.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/endnode-outputs-extraction.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  CINATRA_ENDNODE_OUTPUTS_SENTINEL,
  extractCinatraEndNodeOutputs,
  stripCinatraEndNodeOutputMessages,
} from "../execution";

type Msg = { role?: string; parts?: readonly unknown[] };

function sentinelMessage(outputs: Record<string, unknown>, id = "cinatra-endnode-outputs-1"): Msg {
  return {
    role: "agent",
    parts: [
      {
        kind: "data",
        data: { [CINATRA_ENDNODE_OUTPUTS_SENTINEL]: outputs },
      } as unknown,
    ],
  };
}

function textMessage(text: string, role: string = "agent"): Msg {
  return {
    role,
    parts: [{ kind: "text", text } as unknown],
  };
}

describe("extractCinatraEndNodeOutputs", () => {
  it("returns null for undefined / empty history", () => {
    expect(extractCinatraEndNodeOutputs(undefined)).toBeNull();
    expect(extractCinatraEndNodeOutputs([])).toBeNull();
  });

  it("returns null when history has no sentinel DataPart", () => {
    const history: Msg[] = [textMessage("Hello"), textMessage("Goodbye", "user")];
    expect(extractCinatraEndNodeOutputs(history)).toBeNull();
  });

  it("returns the EndNode outputs object when sentinel present", () => {
    const outputs = { transcript: "[Speaker 1]: Hello world.", kind: "audio" };
    const history: Msg[] = [textMessage("LLM output"), sentinelMessage(outputs)];
    expect(extractCinatraEndNodeOutputs(history)).toEqual(outputs);
  });

  it("works regardless of sentinel message position (start / middle / end)", () => {
    const outputs = { transcript: "x" };
    expect(
      extractCinatraEndNodeOutputs([sentinelMessage(outputs), textMessage("after")]),
    ).toEqual(outputs);
    expect(
      extractCinatraEndNodeOutputs([
        textMessage("before"),
        sentinelMessage(outputs),
        textMessage("after"),
      ]),
    ).toEqual(outputs);
    expect(
      extractCinatraEndNodeOutputs([textMessage("before"), sentinelMessage(outputs)]),
    ).toEqual(outputs);
  });

  it("returns the LAST sentinel when multiple are present (defensive — should not occur in practice)", () => {
    const first = { transcript: "first" };
    const last = { transcript: "last" };
    const history: Msg[] = [sentinelMessage(first), sentinelMessage(last)];
    expect(extractCinatraEndNodeOutputs(history)).toEqual(last);
  });

  it("ignores DataParts that lack the sentinel key", () => {
    const history: Msg[] = [
      {
        role: "agent",
        parts: [{ kind: "data", data: { tool_request: { name: "x" } } } as unknown],
      },
    ];
    expect(extractCinatraEndNodeOutputs(history)).toBeNull();
  });

  it("ignores sentinel values that aren't plain objects (array / scalar / null)", () => {
    const histArray: Msg[] = [
      {
        role: "agent",
        parts: [
          { kind: "data", data: { [CINATRA_ENDNODE_OUTPUTS_SENTINEL]: ["not", "object"] } } as unknown,
        ],
      },
    ];
    const histScalar: Msg[] = [
      {
        role: "agent",
        parts: [
          { kind: "data", data: { [CINATRA_ENDNODE_OUTPUTS_SENTINEL]: "not object" } } as unknown,
        ],
      },
    ];
    const histNull: Msg[] = [
      {
        role: "agent",
        parts: [
          { kind: "data", data: { [CINATRA_ENDNODE_OUTPUTS_SENTINEL]: null } } as unknown,
        ],
      },
    ];
    expect(extractCinatraEndNodeOutputs(histArray)).toBeNull();
    expect(extractCinatraEndNodeOutputs(histScalar)).toBeNull();
    expect(extractCinatraEndNodeOutputs(histNull)).toBeNull();
  });

  it("tolerates malformed history shapes (missing parts, non-array parts, missing data) without throwing", () => {
    const history: Msg[] = [
      { role: "agent" }, // no parts
      { role: "agent", parts: undefined },
      { role: "agent", parts: [{ kind: "data" } as unknown] }, // data field missing
      { role: "agent", parts: [{ kind: "data", data: null } as unknown] },
    ];
    expect(() => extractCinatraEndNodeOutputs(history)).not.toThrow();
    expect(extractCinatraEndNodeOutputs(history)).toBeNull();
  });
});

describe("stripCinatraEndNodeOutputMessages", () => {
  it("returns the same history when no sentinel is present", () => {
    const history: Msg[] = [textMessage("Hello"), textMessage("Hi", "user")];
    expect(stripCinatraEndNodeOutputMessages(history)).toEqual(history);
  });

  it("returns undefined when input is undefined (preserves nullability for callers)", () => {
    expect(stripCinatraEndNodeOutputMessages(undefined)).toBeUndefined();
  });

  it("drops the sentinel message and preserves all others in original order", () => {
    const outputs = { transcript: "x" };
    const before = textMessage("first");
    const after = textMessage("second");
    const history: Msg[] = [before, sentinelMessage(outputs), after];
    expect(stripCinatraEndNodeOutputMessages(history)).toEqual([before, after]);
  });

  it("drops a message that contains a sentinel even when other parts are present", () => {
    // Defensive — Python writes a sentinel-only message but tolerate a
    // mixed message shape too. The whole message must be dropped because
    // the sentinel DataPart would otherwise leak into chat UI.
    const mixed: Msg = {
      role: "agent",
      parts: [
        { kind: "text", text: "should be dropped" } as unknown,
        {
          kind: "data",
          data: { [CINATRA_ENDNODE_OUTPUTS_SENTINEL]: { transcript: "x" } },
        } as unknown,
      ],
    };
    expect(stripCinatraEndNodeOutputMessages([textMessage("keep"), mixed])).toEqual([
      textMessage("keep"),
    ]);
  });

  it("preserves non-sentinel DataParts (tool_request / tool_result messages stay)", () => {
    const toolReq: Msg = {
      role: "agent",
      parts: [
        { kind: "data", data: { name: "search", arguments: {} } } as unknown,
      ],
    };
    expect(stripCinatraEndNodeOutputMessages([toolReq])).toEqual([toolReq]);
  });
});
