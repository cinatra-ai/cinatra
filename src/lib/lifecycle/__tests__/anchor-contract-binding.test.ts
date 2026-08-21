/**
 * THE ANCHOR CONTRACT'S EXECUTABLE HALF (cinatra#2826, epic #2784 S9m).
 *
 * The acceptance gate hashes what `scripts/audit/chat-hitl-anchor-contract.json`
 * RECORDS. That alone would only prove the file agrees with itself: rename an
 * anchor in the code, leave the file alone, and the digest still matches while
 * every suite quietly asserts a selector the cards no longer emit.
 *
 * This is the other half of the binding. It compares the recorded DOM
 * expectations with the EXECUTABLE ones — the carriage contract's owner anchors
 * and ruled root declarations, and the render-observed host-parity ratchet — so
 * the two can only move together:
 *
 *   · code moved, file did not  → this test fails;
 *   · file moved, digest did not → the acceptance gate fails;
 *   · design pin moved          → the acceptance gate fails (the pin is a digest
 *                                 input, read from the manifest itself).
 *
 * It also pins the two documents' design pin to ONE value, so the anchor
 * contract cannot be ratified against a drawing the program does not claim.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LIFECYCLE_CARD_KINDS,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import {
  carriageExpectations,
  hostParityExpectations,
  lifecycleAnchorExpectations,
} from "@/lib/lifecycle/lifecycle-host-parity-ratchet";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const read = (rel: string) => JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf8"));

const ANCHOR_CONTRACT = "scripts/audit/chat-hitl-anchor-contract.json";
const ACCEPTANCE_MANIFEST = "scripts/audit/chat-hitl-acceptance-manifest.json";

describe("the recorded anchor contract matches the executable expectations", () => {
  it("records the carriage anchors the contract really asserts", () => {
    expect(read(ANCHOR_CONTRACT).domExpectations.carriage).toEqual(carriageExpectations());
  });

  it("records the host parity the ratchet really holds", () => {
    expect(read(ANCHOR_CONTRACT).domExpectations.hostParity).toEqual(hostParityExpectations());
  });

  it("records both halves and nothing else — an unrecorded expectation is unbound", () => {
    expect(read(ANCHOR_CONTRACT).domExpectations).toEqual(lifecycleAnchorExpectations());
  });

  it("covers every declared kind, so a fifth kind cannot arrive unbound", () => {
    const dom = read(ANCHOR_CONTRACT).domExpectations;
    expect(Object.keys(dom.carriage).sort()).toEqual([...LIFECYCLE_CARD_KINDS].sort());
    expect(Object.keys(dom.hostParity).sort()).toEqual([...LIFECYCLE_CARD_KINDS].sort());
  });

  it("is ratified against the SAME design pin the acceptance manifest declares", () => {
    expect(read(ANCHOR_CONTRACT).specCommit).toBe(read(ACCEPTANCE_MANIFEST).specCommit);
  });

  it("carries a sha256 digest — the alarm is a value, not a promise", () => {
    expect(read(ANCHOR_CONTRACT).digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
