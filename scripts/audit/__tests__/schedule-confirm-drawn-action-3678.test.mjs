// THE SCHEDULE CARD'S RECORDED CONFIRM IS THE DRAWN ONE (cinatra#3678).
//
// Design: design@06230d4e `specs/app-lifecycle-cards.html` §VI draws
// `data-action="confirm-schedule -> scheduled"` on the Confirm floor (:842) and
// on the expired floor (:978). Every contract that names the schedule card's
// decision control names THAT selector, and the value the card shipped before
// this change, `confirm-schedule-proposal`, survives in none of them — not as a
// second member, not as an alias.
//
// The four pending S9d records that counted the retired value are records of
// what was counted on a screen; they are re-taken by the walk, never rewritten.
// This suite pins the contracts, not those records.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CARD_KINDS } from "../../ci/lib/capture-record-contract.mjs";
import {
  KIND_REQUIRED_ACTIONS,
  captureRequirementsFor,
} from "../lib/chat-hitl-capture-recorder.mjs";
import { loadAnchorContract } from "../lib/anchor-contract.mjs";
import { CHAT_THREAD_CARRIAGE_CONTRACT } from "@/lib/lifecycle/held-turn-card-contract";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const DRAWN = '[data-action="confirm-schedule -> scheduled"]';
const RETIRED = '[data-action="confirm-schedule-proposal"]';
const KIND = "trigger_schedule_proposal";

describe("cinatra#3678 — every contract names the drawn Confirm", () => {
  it("the canonical capture contract owes the drawn selector, and only it", () => {
    expect(CARD_KINDS[KIND].decisionControls).toEqual([DRAWN]);
    expect(KIND_REQUIRED_ACTIONS[KIND]).toEqual([DRAWN]);
  });

  it("a pending capture owes the drawn Confirm inside the card root; a decided one owes its absence", () => {
    for (const host of ["chat_thread", "run_card"]) {
      const pending = captureRequirementsFor(host, KIND, "pending");
      expect(pending, host).toContainEqual(
        expect.objectContaining({ selector: DRAWN, scope: "root", expect: "present" }),
      );
      const decided = captureRequirementsFor(host, KIND, "decided");
      expect(decided, host).toContainEqual(
        expect.objectContaining({ selector: DRAWN, scope: "root", expect: "absent" }),
      );
      for (const spec of [...pending, ...decided]) expect(spec.selector, host).not.toBe(RETIRED);
    }
  });

  it("the one-card gate's carriage row names the drawn selector, and only it", () => {
    const row = CHAT_THREAD_CARRIAGE_CONTRACT.find((r) => r.kind === KIND);
    expect(row?.decisionControls).toEqual([DRAWN]);
  });

  it("the anchor contract no longer records the Confirm as unresolved at the pin", () => {
    const contract = loadAnchorContract();
    expect(contract.anchorsUnresolvedAtPin).not.toContain(RETIRED);
    expect(contract.anchorsUnresolvedAtPin).not.toContain(DRAWN);
  });

  it("the conformance test-id contract requires the drawn literal of the shipped card", () => {
    const testids = JSON.parse(
      readFileSync(join(REPO_ROOT, "tests/e2e/design/conformance/testid-contract.json"), "utf8"),
    );
    const literals = JSON.stringify(testids);
    expect(literals).toContain('data-action=\\"confirm-schedule -> scheduled\\"');
    expect(literals).not.toContain("confirm-schedule-proposal");
  });
});
