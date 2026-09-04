import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// THE RETIREMENT, asserted (cinatra#3029, item 0.17: "the response-text
// derivation and the 'not captured' advisory retire").
//
// A retirement is a claim about what the product NO LONGER DOES, and the honest
// way to hold it is to read the source that used to do it. A spy that is never
// called only proves one path; this proves the channel is gone.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

const PICKUP = "src/lib/artifacts/unbound-output-derivation.ts";
const CAPTURE = "packages/agents/src/execution.ts";
const OUTBOX = "packages/agents/src/run-terminal-derivation-outbox.ts";

describe("the response-text derivation retires", () => {
  it("the pickup no longer emits the 'Agent output not captured' advisory", () => {
    const src = read(PICKUP);
    expect(src).not.toContain("Agent output not captured");
    expect(src).not.toContain("was not saved");
    // The channel itself is gone, not merely unused on one branch.
    expect(src).not.toMatch(/@\/lib\/notifications/);
    expect(src).not.toContain("createNotificationForRecipient");
  });

  it("the pickup no longer types the run's final response text against `produces`", () => {
    const src = read(PICKUP);
    // The retired core's decision vocabulary is gone: the classifier tiebreak,
    // its confidence threshold, and the single reserved sentinel id.
    expect(src).not.toContain("classifyObject");
    expect(src).not.toContain("CLASSIFIER_CONFIDENCE_THRESHOLD");
    expect(src).not.toContain("cinatra:run-final-output");
    // `no_produces` survives only as a value older rows carry.
    expect(src).toContain("RETIRED as a reachable outcome");
  });

  it("the terminal capture no longer captures the final response text", () => {
    const src = read(CAPTURE);
    // The capture's payload is the item family, not `finalText`.
    expect(src).toContain("selectEndNodeOutputPickupItems");
    expect(src).toContain("items: defaultRoadSelection.items");
    expect(src).not.toMatch(/content:\s*finalText/);
    expect(src).not.toMatch(/contentIsJson:\s*finalOutputIsJson/);
  });

  it("the outbox row writes NULL into the retired response-text columns", () => {
    const src = read(OUTBOX);
    expect(src).toContain("content: null");
    expect(src).toContain("contentHash: null");
    expect(src).toContain("items: outbox.items");
  });

  it("a bound output no longer switches the road off for the WHOLE agent", () => {
    const src = read(PICKUP);
    // The retired core returned early on `ctx.hasBindings` — "bound ⇒ done,
    // without a second materialization" — which is exactly how a partially
    // bound agent lost its unbound work.
    expect(src).not.toMatch(/if\s*\(\s*ctx\.hasBindings\s*\)/);
  });
});
