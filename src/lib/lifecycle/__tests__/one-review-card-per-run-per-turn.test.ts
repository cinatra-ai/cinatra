// ONE REVIEW CARD PER GATE PER TURN (cinatra#2997 × cinatra#2930, epic #2926 W3).
//
// THE RULE, in the words the placeholder change stated it in: "from this change
// on, the run's own turn already carries that gate in the run card's slot, so W3
// must not inject an `artifact_review_gate` part into a turn that carries the run
// card for the same run."
//
// WHY IT IS A RULE AND NOT A PREFERENCE. cinatra#2997 made the inline run card
// the review screen's own placeholder: while the run works the card shows a
// spinner over the empty review frame, and when the output opens a review gate
// the SAME slot shows the gate in place (`data-run-review-slot`,
// `useRunReviewSlot`, and the seed route's `reviewGate`). The card asks for the
// slot itself, from run state, on every surface it is mounted on. So a turn that
// draws the run card for a run ALREADY draws that run's gate. An injected
// `artifact_review_gate` part beside it would be the same gate a second time, in
// the same turn — two cards, two sets of decision controls, one question.
//
// AND WHY THE RULE IS KEYED ON THE RUN CARD RATHER THAN ON THE KIND. The gate's
// injected delivery is not retired: a turn that does NOT draw the run card draws
// nothing else either, and the injected part is the only thing that puts the
// question in front of the reader. That is the case this file pins beside the
// suppression, because a blanket "never inject the review gate" would silently
// take the card away from every run started outside the turn it is read in.
//
// THE STRUCTURAL PREDICATE IS THE PROJECTION'S OWN. `projectDurableAssistantTurn`
// pins a run onto a `tool_call` part only when the `agent_run` pointer's
// `toolCallId` names a call THIS trace has ("unknown toolCallId — the reducer
// no-ops too"), and the chat mounts `<InlineAgentRunCard runId={...}/>` off that
// pinned part. So "does this turn draw the run card" is exactly "is the
// dispatching call in this turn's parts", and the check reads it that way rather
// than inventing a second rule the renderer does not follow.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { projectDurableAssistantTurn } from "@/lib/assistant-thread-store";
import {
  injectionForTurn,
  turnCarriesRunCardFor,
} from "../lifecycle-run-outbox";

const RUN_ID = "run-2997";
const DISPATCH_CALL = "call-agent-run-1";
const GATE_REF = "gate-ref-1";

/** The ordinary case: this turn dispatched the run, so it draws the run card. */
function turnThatDrawsTheRunCard(): Record<string, unknown> {
  return {
    format: "assistant-turn-v1",
    role: "assistant",
    content: "",
    parts: [{ type: "tool_call", id: DISPATCH_CALL, name: "agent_run" }],
    dataParts: [{ kind: "agent_run", toolCallId: DISPATCH_CALL, runId: RUN_ID }],
    dataPartSlots: [DISPATCH_CALL],
  };
}

/**
 * A run STARTED ELSEWHERE, read in this turn. The pointer is here — it is how
 * the outbox found the turn at all — but the call that dispatched the run is
 * not in this trace, so the projection pins no run id on any part and the chat
 * mounts no run card. Nothing in this turn shows the gate until the part is
 * injected.
 */
function turnWithoutTheRunCard(): Record<string, unknown> {
  return {
    format: "assistant-turn-v1",
    role: "assistant",
    content: "",
    parts: [{ type: "tool_call", id: "call-something-else", name: "web_search" }],
    dataParts: [
      { kind: "agent_run", toolCallId: "call-in-an-earlier-turn", runId: RUN_ID },
    ],
    dataPartSlots: [null],
  };
}

/** Every fixture, with what the projection + the renderer really do with it. */
const CASES: ReadonlyArray<[string, Record<string, unknown>, boolean]> = [
  ["dispatched-here", turnThatDrawsTheRunCard(), true],
  ["started-elsewhere", turnWithoutTheRunCard(), false],
];

describe("the predicate: does this turn draw the run card for this run", () => {
  it("is true for the turn that dispatched the run", () => {
    expect(turnCarriesRunCardFor(turnThatDrawsTheRunCard(), RUN_ID)).toBe(true);
  });

  it("is false when the dispatching call is not in this trace", () => {
    expect(turnCarriesRunCardFor(turnWithoutTheRunCard(), RUN_ID)).toBe(false);
  });

  it("is false for a DIFFERENT run dispatched in the same turn", () => {
    expect(turnCarriesRunCardFor(turnThatDrawsTheRunCard(), "some-other-run")).toBe(false);
  });

  it("is true for the client transcript's own shape, where the run id is pinned on the call", () => {
    // What the chat saves: the run id lives ON the tool_call part, and
    // `<InlineAgentRunCard/>` mounts straight off it.
    const clientTurn = {
      parts: [{ kind: "tool_call", id: DISPATCH_CALL, name: "agent_run", runId: RUN_ID }],
    };
    expect(turnCarriesRunCardFor(clientTurn, RUN_ID)).toBe(true);
  });

  it("reads the projection AND the renderer's own condition, not a guess", () => {
    // Belt and braces against drift. `mountsTheRunCard` is
    // `chat-messages-view.tsx`'s mount test copied character for character —
    // `part.kind === "tool_call" && part.name === "agent_run" && part.runId` —
    // applied to what `projectDurableAssistantTurn` really produces. Every
    // fixture in this file is checked against it, so the predicate and the
    // pixels cannot drift apart quietly.
    for (const [label, content, expected] of CASES) {
      const projected = projectDurableAssistantTurn(`turn-${label}`, content);
      const drawn =
        projected !== null &&
        (projected.parts ?? []).some(
          (p) => p.kind === "tool_call" && p.name === "agent_run" && p.runId === RUN_ID,
        );
      expect(drawn, `${label}: the projection+renderer say ${expected}`).toBe(expected);
      expect(turnCarriesRunCardFor(content, RUN_ID), `${label}: the predicate`).toBe(expected);
    }
  });

  it("is true for a run the WIDGET's own start dispatched, in both shapes", () => {
    // cinatra#2935, lifecycle-b W5d: `agent_named_start` reaches the same
    // primitive and produces the same run, and the transcript mounts its card
    // through the same closed set of names. A predicate that recognised only
    // `agent_run` would answer "this turn draws no card" for such a run and the
    // writer would inject a second review gate beside the one the card carries.
    const durable = {
      ...turnThatDrawsTheRunCard(),
      parts: [{ type: "tool_call", id: DISPATCH_CALL, name: "agent_named_start" }],
    };
    expect(turnCarriesRunCardFor(durable, RUN_ID)).toBe(true);

    const client = {
      parts: [
        { kind: "tool_call", id: DISPATCH_CALL, name: "agent_named_start", runId: RUN_ID },
      ],
    };
    expect(turnCarriesRunCardFor(client, RUN_ID)).toBe(true);

    // The negative control beside it: a name OUTSIDE the closed set still draws
    // nothing, so the widening is an addition and not an open door.
    expect(
      turnCarriesRunCardFor(
        {
          parts: [
            { kind: "tool_call", id: DISPATCH_CALL, name: "agent_run_get", runId: RUN_ID },
          ],
        },
        RUN_ID,
      ),
    ).toBe(false);
  });

  it("is FALSE when the pointer lands on a call that is not an agent_run", () => {
    // The projection pins the run id onto whatever call the pointer names; the
    // renderer mounts only on a call NAMED `agent_run`. A pointer at a
    // `web_search` call therefore draws nothing, and suppressing the injected
    // gate for it would leave the reader with no card at all.
    expect(
      turnCarriesRunCardFor(
        {
          format: "assistant-turn-v1",
          parts: [{ type: "tool_call", id: DISPATCH_CALL, name: "web_search" }],
          dataParts: [{ kind: "agent_run", toolCallId: DISPATCH_CALL, runId: RUN_ID }],
        },
        RUN_ID,
      ),
    ).toBe(false);
  });

  it("is FALSE when a DUPLICATE call id hides a non-agent call the projection kept", () => {
    // "Deduped by id, as the live applier dedupes: a retried call is one call" —
    // the FIRST wins, and it is a `web_search`. A predicate that answered from
    // the second, discarded part would suppress a card nothing draws.
    expect(
      turnCarriesRunCardFor(
        {
          format: "assistant-turn-v1",
          parts: [
            { type: "tool_call", id: DISPATCH_CALL, name: "web_search" },
            { type: "tool_call", id: DISPATCH_CALL, name: "agent_run" },
          ],
          dataParts: [{ kind: "agent_run", toolCallId: DISPATCH_CALL, runId: RUN_ID }],
        },
        RUN_ID,
      ),
    ).toBe(false);
  });

  it("is FALSE for a run whose pointer was OVERWRITTEN by a later one on the same call", () => {
    // `target.runId = runId` assigns, so the LAST pointer naming a call is the
    // run the card is mounted for. The earlier run has no card in this turn.
    const content = {
      format: "assistant-turn-v1",
      role: "assistant",
      content: "",
      parts: [{ type: "tool_call", id: DISPATCH_CALL, name: "agent_run" }],
      dataParts: [
        { kind: "agent_run", toolCallId: DISPATCH_CALL, runId: RUN_ID },
        { kind: "agent_run", toolCallId: DISPATCH_CALL, runId: "run-that-won" },
      ],
    };
    expect(turnCarriesRunCardFor(content, RUN_ID)).toBe(false);
    expect(turnCarriesRunCardFor(content, "run-that-won")).toBe(true);
    // …and the projection agrees, which is the whole reason for the ordering.
    const projected = projectDurableAssistantTurn("turn-overwritten", content)!;
    expect(
      (projected.parts ?? []).find((p) => p.id === DISPATCH_CALL)!.runId,
    ).toBe("run-that-won");
  });

  it("is FALSE for a client part that carries the run id but is not a call", () => {
    // The renderer reads `part.kind === "tool_call"` first. A citation, a text
    // part or any other object that happens to carry `name`/`runId` mounts
    // nothing.
    expect(
      turnCarriesRunCardFor(
        { parts: [{ kind: "citations", name: "agent_run", runId: RUN_ID }] },
        RUN_ID,
      ),
    ).toBe(false);
  });

  it("is FALSE for content the projection would REFUSE outright", () => {
    // `projectDurableAssistantTurn` admits only the sink's `assistant-turn-v1`
    // object; anything else returns null and draws nothing. A row that merely
    // happens to carry the durable part shapes must not be replayed as if it
    // were one.
    const notDurable = {
      parts: [{ type: "tool_call", id: DISPATCH_CALL, name: "agent_run" }],
      dataParts: [{ kind: "agent_run", toolCallId: DISPATCH_CALL, runId: RUN_ID }],
    };
    expect(projectDurableAssistantTurn("turn-not-durable", notDurable)).toBeNull();
    expect(turnCarriesRunCardFor(notDurable, RUN_ID)).toBe(false);
  });

  it("is FALSE for a CLIENT-shaped call inside a DURABLE row, which the projection ignores", () => {
    // Inside an `assistant-turn-v1` object the projection reads `raw.type` and
    // ignores a `kind`-shaped entry entirely, so this row draws no run card.
    // Reading the two shapes as one would suppress the only card the reader has.
    const durableWithClientPart = {
      format: "assistant-turn-v1",
      role: "assistant",
      content: "",
      parts: [{ kind: "tool_call", id: DISPATCH_CALL, name: "agent_run", runId: RUN_ID }],
    };
    const projected = projectDurableAssistantTurn("turn-mixed", durableWithClientPart);
    expect(
      (projected?.parts ?? []).some(
        (p) => p.kind === "tool_call" && p.name === "agent_run" && p.runId === RUN_ID,
      ),
    ).toBe(false);
    expect(turnCarriesRunCardFor(durableWithClientPart, RUN_ID)).toBe(false);
  });

  it("is FALSE for an EMPTY run id, which the renderer would not mount", () => {
    // The mount condition ends `&& part.runId` — an empty string is falsy, so
    // no card is drawn for it on either shape.
    expect(
      turnCarriesRunCardFor(
        { parts: [{ kind: "tool_call", id: DISPATCH_CALL, name: "agent_run", runId: "" }] },
        "",
      ),
    ).toBe(false);
    expect(
      turnCarriesRunCardFor(
        {
          format: "assistant-turn-v1",
          parts: [{ type: "tool_call", id: DISPATCH_CALL, name: "agent_run" }],
          dataParts: [{ kind: "agent_run", toolCallId: DISPATCH_CALL, runId: "" }],
        },
        "",
      ),
    ).toBe(false);
  });

  it("ignores a renderable VIEW that also carries kind: agent_run", () => {
    // `viewType` classification wins over any structural `kind` beside it — the
    // projection's rule, restated here so a payload cannot be read both ways.
    expect(
      turnCarriesRunCardFor(
        {
          format: "assistant-turn-v1",
          parts: [{ type: "tool_call", id: DISPATCH_CALL, name: "agent_run" }],
          dataParts: [
            {
              viewType: "artifact_review_gate",
              schemaVersion: 1,
              ref: "r",
              kind: "agent_run",
              toolCallId: DISPATCH_CALL,
              runId: RUN_ID,
            },
          ],
        },
        RUN_ID,
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE OTHER COPY REALLY EXISTS — a source-level tripwire
// ---------------------------------------------------------------------------
//
// The suppression above is only correct while the run card actually draws the
// gate. That mount is cinatra#2997's and is proven by its own suites against the
// rendered panel; what this tier owes is that the suppression can never OUTLIVE
// it. So the wiring is read from the shipped source: if the inline run card
// stops handing the panel the run's review slot, or the panel stops marking the
// slot it draws it in, this goes red — and the rule that leans on it is the
// first thing the reader is sent to.
describe("the mount the suppression leans on", () => {
  const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
  const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

  it("the chat's inline run card still hands the panel the run's review slot", () => {
    const src = read("packages/chat/src/inline-agent-run-card.tsx");
    expect(src).toMatch(/initialReviewGate=\{/);
    expect(src).toMatch(/readReviewSlot=\{/);
  });

  it("the panel still draws that slot, and names it", () => {
    const src = read("packages/agents/src/agentic-run-panel.tsx");
    expect(src).toContain("useRunReviewSlot");
    expect(src).toContain("data-run-review-slot");
  });

  // …AND IT DRAWS IT ON EVERY HOST (cinatra#3051).
  //
  // "The run card shows the gate" was true on three hosts and false on the
  // fourth. The panel withheld the completed-run review whenever the ambient
  // host was the site widget — a containment against mounting a card that would
  // have resolved and decided with the frame's ambient cookie — and the
  // suppression above, which asks only "does this turn draw the run card",
  // agreed to stay silent on the same turn. Neither rule was wrong on its own;
  // together they meant a run started inside a third-party application showed
  // its review nowhere, and the reader was left with the run's terminal notice.
  //
  // SO THE PREMISE IS PINNED WHERE IT CAN BREAK. The slot's ref must not be
  // conditional on WHICH host is in scope: the host travels DOWN to the card
  // instead, so the card that draws inside a widget frame is a `site_widget`
  // card asking with that host's own credential. Comments are stripped before
  // the reading, so prose about the widget cannot satisfy or fail it.
  it("does not decide the slot's ref by host — the host travels to the card", () => {
    const src = read("packages/agents/src/agentic-run-panel.tsx");
    const from = src.indexOf("const markedReviewGate");
    const to = src.indexOf("const recommendationCardNode");
    expect(from, "the panel's review-slot decision moved").toBeGreaterThan(-1);
    expect(to, "the panel's card mounts moved").toBeGreaterThan(from);
    const decision = src
      .slice(from, to)
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    // The decision names no host. A run that has finished draws its review, and
    // that is the whole of it.
    expect(decision).not.toContain("site_widget");
    expect(decision).not.toContain("chat_thread");
    // And the mount hands the ambient host down rather than shadowing it.
    expect(src).toContain('host={reviewCardOnWidget ? "site_widget" : "run_card"}');
  });
});

describe("the review gate, in a turn that already draws the run card", () => {
  it("is NOT injected — the run card's own slot is the one card", () => {
    const injection = injectionForTurn(
      { runId: RUN_ID, cardKind: "artifact_review_gate", cardRef: GATE_REF },
      { id: "turn-1", content: turnThatDrawsTheRunCard() },
    );
    expect(injection).toBeNull();
  });

  it("leaves the turn's parts exactly as they were — no gate part anywhere", () => {
    const content = turnThatDrawsTheRunCard();
    const injection = injectionForTurn(
      { runId: RUN_ID, cardKind: "artifact_review_gate", cardRef: GATE_REF },
      { id: "turn-1", content },
    );
    expect(injection).toBeNull();
    const projected = projectDurableAssistantTurn("turn-1", content)!;
    const views = [
      ...(projected.dataParts ?? []),
      ...(projected.parts ?? []).flatMap((p) => (p.views ?? []) as Record<string, unknown>[]),
    ];
    expect(views.filter((v) => v.viewType === "artifact_review_gate")).toEqual([]);
  });

  it("does not suppress the OTHER injected kinds — the rule is the gate's alone", () => {
    for (const [cardKind, cardRef] of [
      ["trigger_schedule_proposal", "sched-ref-1"],
      ["verification_summary", "verif-ref-1"],
    ] as const) {
      const injection = injectionForTurn(
        { runId: RUN_ID, cardKind, cardRef },
        { id: "turn-1", content: turnThatDrawsTheRunCard() },
      );
      expect(injection, `${cardKind} must still be injected`).not.toBeNull();
      expect(injection!.content.dataParts).toEqual([
        { kind: "agent_run", toolCallId: DISPATCH_CALL, runId: RUN_ID },
        { viewType: cardKind, schemaVersion: 1, ref: cardRef },
      ]);
    }
  });

  it("does not suppress the gate of a DIFFERENT run that this turn does not draw a card for", () => {
    // The turn draws RUN_ID's card. A second run whose own pointer is here but
    // whose dispatch is not keeps its injected gate.
    const content = {
      ...turnThatDrawsTheRunCard(),
      dataParts: [
        { kind: "agent_run", toolCallId: DISPATCH_CALL, runId: RUN_ID },
        { kind: "agent_run", toolCallId: "call-in-an-earlier-turn", runId: "run-elsewhere" },
      ],
      dataPartSlots: [DISPATCH_CALL, null],
    };
    const injection = injectionForTurn(
      { runId: "run-elsewhere", cardKind: "artifact_review_gate", cardRef: "gate-ref-2" },
      { id: "turn-1", content },
    );
    expect(injection).not.toBeNull();
    expect(injection!.content.dataParts).toContainEqual({
      viewType: "artifact_review_gate",
      schemaVersion: 1,
      ref: "gate-ref-2",
    });
  });
});

describe("the review gate, in a turn that draws no run card for the run", () => {
  it("IS injected — otherwise the person is left with a silent wait", () => {
    const injection = injectionForTurn(
      { runId: RUN_ID, cardKind: "artifact_review_gate", cardRef: GATE_REF },
      { id: "turn-1", content: turnWithoutTheRunCard() },
    );
    expect(injection).not.toBeNull();
    expect(injection!.content.dataParts).toEqual([
      { kind: "agent_run", toolCallId: "call-in-an-earlier-turn", runId: RUN_ID },
      { viewType: "artifact_review_gate", schemaVersion: 1, ref: GATE_REF },
    ]);
    expect(injection!.content.dataPartProvenance).toEqual([null, "platform_injected"]);
  });

  it("comes back after a reload, at turn level, because its slot names no call here", () => {
    const injection = injectionForTurn(
      { runId: RUN_ID, cardKind: "artifact_review_gate", cardRef: GATE_REF },
      { id: "turn-1", content: turnWithoutTheRunCard() },
    )!;
    const projected = projectDurableAssistantTurn("turn-1", injection.content)!;
    expect(projected.dataParts ?? []).toEqual([
      { viewType: "artifact_review_gate", schemaVersion: 1, ref: GATE_REF },
    ]);
  });
});
