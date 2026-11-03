// ---------------------------------------------------------------------------
// THE LINE FIRST, THEN THE ROW (cinatra#3062, design §V).
//
// "The row is drawn in the assistant's turn, after the assistant has started the
// run: the assistant says it dispatched the agent and that the run paused for a
// decision on the recommended skills … and that same turn carries the chip-row
// beneath the line". The drawing `recommendation-row-paused` draws the line
// first and the row in the slot beneath it.
//
// WHY THE TRACE HAS THEM THE OTHER WAY ROUND. The start's tool result reaches the
// turn before the model says the platform's sentence back (the reply rule tells
// it to say that sentence and nothing else), so the ordered trace carries the
// run's own part first and the line after it. Drawn in trace order, the row
// stood above the line that introduces it.
//
// SO ONLY THE DRAW ORDER CHANGES, and only for that one line. For every run-start
// part, the first LATER text part that carries the platform's own start sentence
// for THAT run is drawn just before the run's slot. Nothing is rewritten, no part
// is dropped or duplicated, each part keeps its own index (its key and its
// `data-transcript-slot` mark), and a turn whose line already stands above the
// run's part in the trace (even with a second copy after it), or that carries
// no such line, is drawn exactly as before.
// ---------------------------------------------------------------------------
import { textCarriesRunStartSentence } from "@cinatra-ai/agents/run-status";

import type { AssistantMessagePart } from "./assistant-parts";
import { isRunStartToolName } from "./run-start-tool-names";

/** The order to draw `parts` in: a permutation of their indexes. */
export function drawOrderWithRunStartLinesFirst(
  parts: readonly AssistantMessagePart[],
): number[] {
  const order: number[] = [];
  const moved = new Set<number>();
  parts.forEach((part, index) => {
    if (moved.has(index)) return;
    if (part.kind === "tool_call" && isRunStartToolName(part.name) && part.runId) {
      const runId = part.runId;
      const carries = (candidate: AssistantMessagePart) =>
        candidate.kind === "text" && textCarriesRunStartSentence(candidate.content, runId);
      // A line the trace already carries above the run stays where it is, and
      // a later copy of it is not moved up beside it.
      const alreadyAbove = parts.some((candidate, at) => at < index && carries(candidate));
      const line = alreadyAbove ? -1 : parts.findIndex(
        (candidate, at) =>
          at > index && !moved.has(at) && carries(candidate),
      );
      if (line !== -1) {
        order.push(line);
        moved.add(line);
      }
    }
    order.push(index);
  });
  return order;
}
