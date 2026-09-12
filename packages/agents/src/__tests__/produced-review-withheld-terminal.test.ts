import { describe, it, expect } from "vitest";

// cinatra#3007 — the withheld terminal write, as a value.
//
// A run parked at its review moment carries the terminal transition it did not
// make, so the decision can make it later. Two properties have to hold for that
// carrier, and both are pure, so they are pinned here rather than against a
// database:
//
//   ROUND TRIP — what is attached is what is read back, and stripping it restores
//     the payload the executor would have written outright. A released run's row
//     must be indistinguishable from one today's immediate write produces;
//     anything else would leak a park marker into a finished run's evidence.
//
//   REFUSAL — a payload with no marker yields NOTHING. That is the whole guard
//     keeping the release path off the template-declared gate's park, which is
//     released by its own resume delivery and must never be released twice.

import {
  attachWithheldTerminal,
  readWithheldTerminal,
  stripWithheldTerminal,
  WITHHELD_TERMINAL_KEY,
} from "../run-produced-review-hold";

const PAYLOAD = [
  {
    kind: "wayflow_response",
    a2aTaskId: "task-1",
    output: { title: "The draft" },
    output_data: { title: "The draft" },
    history: [{ role: "agent" }],
  },
];

describe("cinatra#3007 — the withheld terminal write round-trips", () => {
  it("attaches onto the response record, reads back, and strips to the original", () => {
    const withheld = { status: "completed" as const };
    const parked = attachWithheldTerminal(PAYLOAD, withheld);

    // The array's SHAPE is unchanged — one entry, same kind — so every existing
    // consumer of stepResults reads it exactly as before.
    expect(parked).toHaveLength(1);
    expect((parked[0] as Record<string, unknown>).kind).toBe("wayflow_response");
    expect((parked[0] as Record<string, unknown>).output_data).toEqual({ title: "The draft" });

    expect(readWithheldTerminal(parked)).toEqual(withheld);
    expect(stripWithheldTerminal(parked)).toEqual(PAYLOAD);
    // ...and the input was not mutated.
    expect(PAYLOAD[0]).not.toHaveProperty(WITHHELD_TERMINAL_KEY);
  });

  it("carries a withheld FAILURE with its reason, and the derivation capture", () => {
    const withheld = {
      status: "failed" as const,
      error: "draft: contentFrom did not resolve to a string",
    };
    expect(readWithheldTerminal(attachWithheldTerminal(PAYLOAD, withheld))).toEqual(withheld);

    const capture = {
      orgId: "org-1",
      templateId: "tpl-1",
      packageVersion: "1.0.0",
      createdBy: "user-1",
      content: "the body",
      contentIsJson: false,
      contentHash: "abc",
    };
    const roundTripped = readWithheldTerminal(
      attachWithheldTerminal(PAYLOAD, { status: "completed", derivationOutbox: capture }),
    );
    expect(roundTripped?.derivationOutbox).toEqual(capture);
  });

  it("carries the write even when there is no record to ride on, and strips cleanly", () => {
    const parked = attachWithheldTerminal([], { status: "completed" });
    expect(readWithheldTerminal(parked)).toEqual({ status: "completed" });
    // The marker-only entry existed for the marker; stripping leaves nothing, so
    // the terminal write records no step results — as that path does today.
    expect(stripWithheldTerminal(parked)).toEqual([]);
  });

  it("REFUSES a payload that carries no withheld write — a declared gate's park", () => {
    expect(readWithheldTerminal(PAYLOAD)).toBeNull();
    expect(readWithheldTerminal(null)).toBeNull();
    expect(readWithheldTerminal(undefined)).toBeNull();
    expect(readWithheldTerminal("not an array")).toBeNull();
    expect(readWithheldTerminal([{ kind: "wayflow_response" }])).toBeNull();
    // A marker that is not a withheld write is not one either.
    expect(readWithheldTerminal([{ [WITHHELD_TERMINAL_KEY]: { status: "queued" } }])).toBeNull();
    expect(readWithheldTerminal([{ [WITHHELD_TERMINAL_KEY]: "completed" }])).toBeNull();
  });

  it("stripping a payload that never carried a marker changes nothing", () => {
    expect(stripWithheldTerminal(PAYLOAD)).toEqual(PAYLOAD);
    expect(stripWithheldTerminal(null)).toEqual([]);
  });
});
