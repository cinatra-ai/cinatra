/**
 * THE LINE FIRST, THEN THE ROW (cinatra#3062, design §V): the draw order of a
 * turn's ordered parts puts the platform's start sentence for a run above that
 * run's own slot, and changes nothing else.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run src/__tests__/run-start-line-order.test.ts
 */
import { describe, expect, it } from "vitest";

import { textCarriesRunStartSentence } from "@cinatra-ai/agents/run-status";

import type { AssistantMessagePart } from "../assistant-parts";
import { drawOrderWithRunStartLinesFirst } from "../run-start-line-order";

const RUN_A = "762a2aae-9028-4dcb-86be-ac4e0fa08027";
const RUN_B = "6ec9055b-db10-408f-aabb-695020f99c20";
const PKG = "@cinatra-ai/lint-policy-agent";

const line = (runId: string, clause = " The run paused for a decision on the recommended skills.") =>
  `Dispatched \`${PKG}\` (runId: \`${runId}\`, status: \`pending_input\`).${clause}`;

const run = (runId: string, name = "agent_run"): AssistantMessagePart =>
  ({ kind: "tool_call", id: `call-${runId}`, name, status: "completed", runId }) as AssistantMessagePart;
const text = (content: string): AssistantMessagePart => ({ kind: "text", content });

describe("textCarriesRunStartSentence", () => {
  it("reads the platform's own sentence for the named run, with or without a clause", () => {
    expect(textCarriesRunStartSentence(line(RUN_A), RUN_A)).toBe(true);
    expect(textCarriesRunStartSentence(line(RUN_A, ""), RUN_A)).toBe(true);
    expect(textCarriesRunStartSentence(`Sure. ${line(RUN_A)}`, RUN_A)).toBe(true);
  });

  it("does not read another run's sentence, prose, or an empty run id", () => {
    expect(textCarriesRunStartSentence(line(RUN_B), RUN_A)).toBe(false);
    expect(textCarriesRunStartSentence("The run paused for a decision on the recommended skills.", RUN_A)).toBe(false);
    expect(textCarriesRunStartSentence(line(RUN_A), "")).toBe(false);
  });
});

describe("drawOrderWithRunStartLinesFirst", () => {
  it("draws the dispatch line above the run's slot (the 3062-walk1 trace)", () => {
    expect(drawOrderWithRunStartLinesFirst([run(RUN_A), text(line(RUN_A))])).toEqual([1, 0]);
  });

  it("does the same for the widget's own start tool", () => {
    expect(
      drawOrderWithRunStartLinesFirst([run(RUN_A, "agent_named_start"), text(line(RUN_A))]),
    ).toEqual([1, 0]);
  });

  it("leaves a turn whose line already stands above the run exactly as it is", () => {
    expect(drawOrderWithRunStartLinesFirst([text(line(RUN_A)), run(RUN_A)])).toEqual([0, 1]);
  });

  it("leaves a turn with no platform line, or a text that is not this run's, as it is", () => {
    expect(drawOrderWithRunStartLinesFirst([run(RUN_A), text("Here is your run.")])).toEqual([0, 1]);
    expect(drawOrderWithRunStartLinesFirst([run(RUN_A), text(line(RUN_B))])).toEqual([0, 1]);
    expect(
      drawOrderWithRunStartLinesFirst([text("lead-in"), run(RUN_A, "web_search"), text(line(RUN_A))]),
    ).toEqual([0, 1, 2]);
  });

  it("moves only the first matching line, and every index appears once", () => {
    const parts = [text("lead-in"), run(RUN_A), text("between"), text(line(RUN_A)), text(line(RUN_A))];
    const order = drawOrderWithRunStartLinesFirst(parts);
    expect(order).toEqual([0, 3, 1, 2, 4]);
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it("pairs each run with its own line in a turn that starts two runs", () => {
    const parts = [run(RUN_A), run(RUN_B), text(`${line(RUN_A)}\n\n${line(RUN_B)}`), text(line(RUN_B))];
    // The first text carries both sentences: it goes above the first run; the
    // second run takes the next text that carries its own sentence.
    expect(drawOrderWithRunStartLinesFirst(parts)).toEqual([2, 0, 3, 1]);
  });
});
