/**
 * email-test-delivery passthrough seam shapers (#1625).
 *
 * The perform_test_send ApiNode cannot pass native id arrays through its body
 * (wayflowcore stringifies json_body templates) nor extract the gate renderer's
 * nested `{lastSendResult, gateCycle}` contract from the primitive's flat return
 * (`.title` jq extraction). Both gaps are bridged by ./test-delivery-seam, which
 * the /api/agents/passthrough route wires in under the `result_shape` flag +
 * `tool === email_test_delivery_run_send` guard. The CERTIFIED send primitive
 * (packages/agents handlers.ts) stays byte-identical.
 *
 *   pnpm exec vitest run src/__tests__/test-delivery-passthrough-seam.test.ts
 */
import { describe, it, expect } from "vitest";
import {
  shapeTestDeliverySendInput,
  shapeTestDeliverySendResult,
} from "../app/api/agents/passthrough/test-delivery-seam";

describe("email-test-delivery passthrough seam — input (envelope) shaper", () => {
  it("parses the JSON-string envelope and PRESERVES native id arrays", () => {
    const envelope = {
      action: "send",
      recipientEmail: "qa@example.test",
      selectionMode: "specific_initial",
      specificInitialDraftIds: ["aaaa1625-0001", "bbbb1625-0002"],
      specificFollowUpDraftIds: ["cccc1625-0003"],
    };
    const out = shapeTestDeliverySendInput({ envelopeJson: JSON.stringify(envelope) });
    expect(out).toEqual({
      recipientEmail: "qa@example.test",
      selectionMode: "specific_initial",
      specificInitialDraftIds: ["aaaa1625-0001", "bbbb1625-0002"],
      specificFollowUpDraftIds: ["cccc1625-0003"],
    });
    // real arrays, not a stringified repr
    expect(Array.isArray(out.specificInitialDraftIds)).toBe(true);
    // `action` is NOT projected (it drives branching, not the send handler)
    expect("action" in out).toBe(false);
  });

  it("random_initial envelope with no ids projects only recipient + mode", () => {
    const out = shapeTestDeliverySendInput({
      envelopeJson: JSON.stringify({
        action: "send",
        recipientEmail: "qa@example.test",
        selectionMode: "random_initial",
      }),
    });
    expect(out).toEqual({ recipientEmail: "qa@example.test", selectionMode: "random_initial" });
    // absent id fields => handler's validateIds(undefined) => []
    expect("specificInitialDraftIds" in out).toBe(false);
  });

  it("empty / absent envelopeJson projects nothing (handler surfaces invalid_recipient)", () => {
    expect(shapeTestDeliverySendInput({ envelopeJson: "" })).toEqual({});
    expect(shapeTestDeliverySendInput({})).toEqual({});
    expect(shapeTestDeliverySendInput({ envelopeJson: "   " })).toEqual({});
  });

  it("unparseable / non-object envelope projects nothing (never throws)", () => {
    expect(shapeTestDeliverySendInput({ envelopeJson: "{not json" })).toEqual({});
    expect(shapeTestDeliverySendInput({ envelopeJson: "[1,2,3]" })).toEqual({});
    expect(shapeTestDeliverySendInput({ envelopeJson: "\"a string\"" })).toEqual({});
  });

  it("projects malformed fields VERBATIM so the handler's own guards reject them", () => {
    const out = shapeTestDeliverySendInput({
      envelopeJson: JSON.stringify({ recipientEmail: "x@y.z", specificInitialDraftIds: "not-an-array" }),
    });
    // passed through unchanged — validateIds (handler) is the authority
    expect(out.specificInitialDraftIds).toBe("not-an-array");
  });
});

describe("email-test-delivery passthrough seam — output (result) shaper", () => {
  const input = {
    recipientEmail: "qa@example.test",
    selectionMode: "specific_initial",
    specificInitialDraftIds: ["aaaa1625-0001"],
    specificFollowUpDraftIds: [],
  };

  it("reshapes a SUCCESS ledger result into the renderer contract", () => {
    const result = {
      ok: true,
      sentTo: "qa@example.test",
      sentCount: 1,
      message: "Test email sent to qa@example.test.",
      deliveredDraftIds: ["aaaa1625-0001"],
      seq: 2,
    };
    expect(shapeTestDeliverySendResult(input, result)).toEqual({
      lastSendResult: { ok: true, message: "Test email sent to qa@example.test.", sentTo: "qa@example.test" },
      gateCycle: 2,
      recipientEmail: "qa@example.test",
      selectionMode: "specific_initial",
      specificInitialDraftIds: ["aaaa1625-0001"],
      specificFollowUpDraftIds: [],
    });
  });

  it("reshapes a FAILURE-as-data ledger result (no sentTo)", () => {
    const result = { ok: false, seq: 1, reason: "no_drafts_selected", message: "No test emails were selected to send." };
    const shaped = shapeTestDeliverySendResult(input, result);
    expect(shaped?.lastSendResult).toEqual({ ok: false, message: "No test emails were selected to send." });
    expect((shaped?.lastSendResult as Record<string, unknown>).sentTo).toBeUndefined();
    expect(shaped?.gateCycle).toBe(1);
  });

  it("returns null (UNSHAPED) for an unexpected {error} fault", () => {
    expect(shapeTestDeliverySendResult(input, { error: "Test delivery send failed: boom" })).toBeNull();
  });

  it("returns null for a malformed result missing ok / seq / message", () => {
    expect(shapeTestDeliverySendResult(input, { ok: true, message: "x" })).toBeNull(); // no seq
    expect(shapeTestDeliverySendResult(input, { ok: true, seq: 1 })).toBeNull(); // no message
    expect(shapeTestDeliverySendResult(input, { seq: 1, message: "x" })).toBeNull(); // no ok
    expect(shapeTestDeliverySendResult(input, { ok: true, seq: 1.5, message: "x" })).toBeNull(); // non-integer seq
    expect(shapeTestDeliverySendResult(input, null)).toBeNull();
    expect(shapeTestDeliverySendResult(input, [1, 2])).toBeNull();
  });

  it("never manufactures gateCycle:0 or an empty message", () => {
    // a result that is 'ok' but with a NON-string message is malformed -> null,
    // NOT a shaped {message:""}.
    expect(shapeTestDeliverySendResult(input, { ok: true, seq: 3, message: 42 })).toBeNull();
  });

  it("sticky-form defaults echo the user's submitted selections", () => {
    const shaped = shapeTestDeliverySendResult(
      { recipientEmail: "a@b.c", selectionMode: "random_initial", specificInitialDraftIds: [], specificFollowUpDraftIds: [] },
      { ok: false, seq: 5, message: "Enter a valid recipient email address for the test send." },
    );
    expect(shaped?.recipientEmail).toBe("a@b.c");
    expect(shaped?.selectionMode).toBe("random_initial");
  });

  it("defaults sticky fields safely when the input lacks them", () => {
    const shaped = shapeTestDeliverySendResult({}, { ok: true, seq: 1, message: "ok" });
    expect(shaped?.recipientEmail).toBe("");
    expect(shaped?.selectionMode).toBe("random_initial");
    expect(shaped?.specificInitialDraftIds).toEqual([]);
    expect(shaped?.specificFollowUpDraftIds).toEqual([]);
  });
});
