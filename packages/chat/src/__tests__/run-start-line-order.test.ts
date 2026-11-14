/**
 * THE LINE FIRST, THEN THE ROW (cinatra#3062, design §V): the draw order of a
 * turn's ordered parts puts the platform's start sentence for a run above that
 * run's own slot, and changes nothing else.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run src/__tests__/run-start-line-order.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  correctRunStartSentenceForScheduleWait,
  textCarriesRunStartSentence,
} from "@cinatra-ai/agents/run-status";

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

  it("does not read a clause-less sentence quoted inside prose as the platform's line", () => {
    const quoted = `I dispatched it. ${line(RUN_A, "")} Anything else?`;
    expect(textCarriesRunStartSentence(quoted, RUN_A)).toBe(false);
    // The same characters on a line of their own are the platform's line.
    expect(textCarriesRunStartSentence(`I dispatched it.\n${line(RUN_A, "")}\nAnything else?`, RUN_A)).toBe(true);
  });

  it("reads a clause-less line that ends in CRLF as standing alone on its line", () => {
    expect(textCarriesRunStartSentence(`I dispatched it.\r\n${line(RUN_A, "")}\r\nAnything else?`, RUN_A)).toBe(true);
    expect(textCarriesRunStartSentence(`${line(RUN_A, "")}\r\n`, RUN_A)).toBe(true);
  });

  it("takes the same complete sentences as the platform's as the start-sentence correction does", () => {
    const inputs = [
      line(RUN_A),
      line(RUN_A, ""),
      `Sure. ${line(RUN_A)}`,
      `I dispatched it. ${line(RUN_A, "")} Anything else?`,
      `I dispatched it.\n${line(RUN_A, "")}\nAnything else?`,
      `I dispatched it.\r\n${line(RUN_A, "")}\r\nAnything else?`,
      line(RUN_B),
      "The run paused for a decision on the recommended skills.",
    ];
    for (const input of inputs) {
      const rewritten = correctRunStartSentenceForScheduleWait({ text: input, runId: RUN_A }) !== input;
      expect(textCarriesRunStartSentence(input, RUN_A), input).toBe(rewritten);
    }
  });

  it("reads the line while it is still arriving: the head, then each prefix of the minted clause", () => {
    const clause = " The run paused for a decision on the recommended skills.";
    for (let end = 0; end <= clause.length; end += 1) {
      const state = line(RUN_A, clause.slice(0, end));
      expect(textCarriesRunStartSentence(state, RUN_A), JSON.stringify(state)).toBe(true);
    }
  });

  it("leaves a line still arriving to the corrections, which rewrite only a finished sentence", () => {
    const arriving = line(RUN_A, " The run");
    expect(correctRunStartSentenceForScheduleWait({ text: arriving, runId: RUN_A })).toBe(arriving);
  });

  it("reads a rest that starts with tabs as a line still arriving", () => {
    expect(textCarriesRunStartSentence(line(RUN_A, "\t\tThe run"), RUN_A)).toBe(true);
  });

  it("does not read a rest that holds a carriage return as a line still arriving", () => {
    expect(textCarriesRunStartSentence(line(RUN_A, " The run\r"), RUN_A)).toBe(false);
  });

  it("after other words on its line: the bare head is not the line, the head with a clause prefix is", () => {
    expect(textCarriesRunStartSentence(`Sure. ${line(RUN_A, "")}`, RUN_A)).toBe(false);
    expect(textCarriesRunStartSentence(`Sure. ${line(RUN_A, " The")}`, RUN_A)).toBe(true);
  });

  it("reads a prefix of a minted clause other than the parked one as a line still arriving", () => {
    expect(textCarriesRunStartSentence(line(RUN_A, " The run is queued and will"), RUN_A)).toBe(true);
  });

  it("does not read a head whose words leave every minted clause, or go on past the prefix", () => {
    expect(textCarriesRunStartSentence(line(RUN_A, " The run is paused for your decision"), RUN_A)).toBe(false);
    expect(textCarriesRunStartSentence(`${line(RUN_A, " The run")}\nAnything else?`, RUN_A)).toBe(false);
    expect(textCarriesRunStartSentence(line(RUN_B, " The run"), RUN_A)).toBe(false);
  });
});

describe("drawOrderWithRunStartLinesFirst", () => {
  it("draws the dispatch line above the run's slot (the 3062-walk1 trace)", () => {
    expect(drawOrderWithRunStartLinesFirst([run(RUN_A), text(line(RUN_A))])).toEqual([1, 0]);
  });

  it("keeps the line above the run in every state of a streamed line (the head, a prefix of the clause, the whole line)", () => {
    for (const clause of ["", " The run", " The run paused for a decision", " The run paused for a decision on the recommended skills."]) {
      expect(drawOrderWithRunStartLinesFirst([run(RUN_A), text(line(RUN_A, clause))]), clause).toEqual([1, 0]);
    }
  });

  it("KNOWN: a line after other words on its line moves while it streams in; the finished line stands above", () => {
    expect(drawOrderWithRunStartLinesFirst([run(RUN_A), text(`Sure. ${line(RUN_A, "")}`)])).toEqual([0, 1]);
    expect(drawOrderWithRunStartLinesFirst([run(RUN_A), text(`Sure. ${line(RUN_A, " The")}`)])).toEqual([1, 0]);
    expect(drawOrderWithRunStartLinesFirst([run(RUN_A), text(`Sure. ${line(RUN_A)}`)])).toEqual([1, 0]);
  });

  it("KNOWN: a paraphrased line stands above while its words begin a minted clause, and drops beneath once they leave it", () => {
    expect(drawOrderWithRunStartLinesFirst([run(RUN_A), text(line(RUN_A, " The run is"))])).toEqual([1, 0]);
    expect(drawOrderWithRunStartLinesFirst([run(RUN_A), text(line(RUN_A, " The run is p"))])).toEqual([0, 1]);
  });

  it("KNOWN: a head quoted inside prose that ends the text in a clause prefix is drawn as the platform's line", () => {
    expect(drawOrderWithRunStartLinesFirst([run(RUN_A), text(`I wrote ${line(RUN_A, " The")}`)])).toEqual([1, 0]);
  });

  it("does the same for the widget's own start tool", () => {
    expect(
      drawOrderWithRunStartLinesFirst([run(RUN_A, "agent_named_start"), text(line(RUN_A))]),
    ).toEqual([1, 0]);
  });

  it("leaves a turn whose line already stands above the run exactly as it is", () => {
    expect(drawOrderWithRunStartLinesFirst([text(line(RUN_A)), run(RUN_A)])).toEqual([0, 1]);
  });

  it("leaves a turn whose line stands above the run as it is, even with a second copy after the run", () => {
    expect(drawOrderWithRunStartLinesFirst([text(line(RUN_A)), run(RUN_A), text(line(RUN_A))])).toEqual([0, 1, 2]);
  });

  it("does not move a text that only quotes the clause-less sentence inside prose", () => {
    expect(
      drawOrderWithRunStartLinesFirst([run(RUN_A), text(`I dispatched it. ${line(RUN_A, "")} Anything else?`)]),
    ).toEqual([0, 1]);
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
