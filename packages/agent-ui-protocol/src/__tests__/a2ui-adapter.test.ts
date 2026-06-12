import { afterAll, describe, expect, it } from "vitest";
import {
  A2UiAdapter,
  __disconnectSharedA2UiPublisher,
  A2UI_MID_RUN_TRANSLATOR_KINDS,
} from "../a2ui-adapter";
import type { A2UiMessage } from "../a2ui-messages";


// Test resolver mirroring the manifest-declared bindings the host builds at
// runtime (cinatra#151 Stage 5 — the adapter takes an INJECTED resolver; the
// static dispatch table is retired). IDs here are test fixtures of the
// extension-owned data contract.
const TEST_MID_RUN_BINDINGS: Record<string, string> = {
  "@cinatra-ai/email-recipient-selection-agent:output": "recipients-output",
  "@cinatra-ai/email-drafting-agent:output": "drafts-output",
  "@cinatra-ai/email-follow-up-agent:output": "followups-output",
  "@cinatra-ai/email-delivery-agent:output": "send-output",
};
const testMidRunResolver = (xRenderer: string) => {
  const kind = TEST_MID_RUN_BINDINGS[xRenderer];
  return kind ? A2UI_MID_RUN_TRANSLATOR_KINDS[kind] : undefined;
};

afterAll(async () => { await __disconnectSharedA2UiPublisher(); });

describe("A2UiAdapter", () => {
  function makeAdapter(messages: A2UiMessage[]) {
    const publish = async (m: A2UiMessage) => { messages.push(m); };
    return new A2UiAdapter("run-123", "thread-456", publish);
  }

  it("onRunStarted emits createSurface with surfaceId === runId and catalogId === 'cinatra-default'", async () => {
    const messages: A2UiMessage[] = [];
    makeAdapter(messages).onRunStarted();
    await Promise.resolve(); // drain microtasks
    expect(messages).toHaveLength(1);
    const msg = messages[0] as { version: string; createSurface: { surfaceId: string; catalogId: string; sendDataModel?: boolean } };
    expect(msg.version).toBe("v0.9");
    expect(msg.createSurface).toBeDefined();
    expect(msg.createSurface.surfaceId).toBe("run-123");
    expect(msg.createSurface.catalogId).toBe("cinatra-default");
  });

  it("text/tool/resume methods do not call publish", async () => {
    const messages: A2UiMessage[] = [];
    const adapter = makeAdapter(messages);
    adapter.onTextDelta("msg-1", "hello");
    adapter.onToolCallStart("tc-1", "my_tool", {});
    adapter.onToolCallEnd("tc-1", "my_tool", { result: "ok" });
    adapter.onResume();
    await Promise.resolve(); // drain microtasks
    expect(messages).toHaveLength(0);
  });

  it("onInterrupt is a no-op when xRenderer is not the grouped renderer id", async () => {
    const messages: A2UiMessage[] = [];
    const adapter = new A2UiAdapter("run-1", "tpl-1", async (m) => { messages.push(m); });
    adapter.onInterrupt({}, "@cinatra/test:other-renderer", {}, "rt-1");
    await new Promise((r) => setTimeout(r, 0));
    expect(messages).toHaveLength(0);
  });

  it("onInterrupt emits createSurface + updateComponents + updateDataModel when xRenderer === grouped-setup-form", async () => {
    const messages: A2UiMessage[] = [];
    const adapter = new A2UiAdapter("run-1", "tpl-1", async (m) => { messages.push(m); });
    const schema = {
      type: "object",
      properties: { website: { type: "string", title: "Website" } },
      required: ["website"],
    };
    adapter.onInterrupt(schema, "@cinatra-ai/agent-builder:grouped-setup-form", {}, "rt-1");
    await new Promise((r) => setTimeout(r, 0)); // flush the void-catch promises

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ version: "v0.9", createSurface: { surfaceId: "run-1:hitl:rt-1", catalogId: "cinatra-default" } });
    expect(messages[1]).toMatchObject({ version: "v0.9", updateComponents: { surfaceId: "run-1:hitl:rt-1" } });
    expect(messages[2]).toMatchObject({ version: "v0.9", updateDataModel: { surfaceId: "run-1:hitl:rt-1", path: "/" } });
  });

  it("HITL surfaceId is ${runId}:hitl:${reviewTaskId} (distinct from the root run surface)", async () => {
    const messages: A2UiMessage[] = [];
    const adapter = new A2UiAdapter("run-42", "tpl-1", async (m) => { messages.push(m); });
    adapter.onInterrupt(
      { type: "object", properties: {}, required: [] },
      "@cinatra-ai/agent-builder:grouped-setup-form",
      {},
      "rt-xyz",
    );
    await new Promise((r) => setTimeout(r, 0));
    for (const msg of messages) {
      if ("createSurface" in msg) expect(msg.createSurface.surfaceId).toBe("run-42:hitl:rt-xyz");
      if ("updateComponents" in msg) expect(msg.updateComponents.surfaceId).toBe("run-42:hitl:rt-xyz");
      if ("updateDataModel" in msg) expect(msg.updateDataModel.surfaceId).toBe("run-42:hitl:rt-xyz");
    }
  });

  it("onRunFinished emits deleteSurface with surfaceId === runId", async () => {
    const messages: A2UiMessage[] = [];
    makeAdapter(messages).onRunFinished("completed");
    await Promise.resolve();
    expect(messages).toHaveLength(1);
    const msg = messages[0] as { version: string; deleteSurface: { surfaceId: string } };
    expect(msg.version).toBe("v0.9");
    expect(msg.deleteSurface).toBeDefined();
    expect(msg.deleteSurface.surfaceId).toBe("run-123");
  });

  it("onStateSnapshot(null) emits nothing", async () => {
    const messages: A2UiMessage[] = [];
    makeAdapter(messages).onStateSnapshot(null);
    await Promise.resolve();
    expect(messages).toHaveLength(0);
  });

  it("onStateSnapshot(tool_call_summary) emits nothing", async () => {
    const messages: A2UiMessage[] = [];
    makeAdapter(messages).onStateSnapshot({ type: "tool_call_summary" });
    await Promise.resolve();
    expect(messages).toHaveLength(0);
  });

  it("onStateSnapshot(card_list hint) emits updateComponents as first message", async () => {
    const messages: A2UiMessage[] = [];
    makeAdapter(messages).onStateSnapshot({
      type: "card_list",
      items: [{ title: "Card A" }],
      title: "Test Cards",
    });
    await Promise.resolve();
    expect(messages.length).toBeGreaterThan(0);
    const first = messages[0] as { updateComponents?: { surfaceId: string } };
    expect(first.updateComponents).toBeDefined();
    expect(first.updateComponents?.surfaceId).toBe("run-123");
  });

  it("onStateSnapshot(contacts_table hint) emits updateComponents + updateDataModel", async () => {
    const messages: A2UiMessage[] = [];
    makeAdapter(messages).onStateSnapshot({
      type: "contacts_table",
      columns: ["name", "email"],
      rows: [{ name: "Alice", email: "alice@test.com" }],
    });
    await Promise.resolve();
    expect(messages).toHaveLength(2);
    const first = messages[0] as { updateComponents?: { surfaceId: string } };
    expect(first.updateComponents?.surfaceId).toBe("run-123");
  });

  // ---------------------------------------------------------------------------
  // Coverage for :output xRenderer dispatch.
  // These cases ensure the 3 :output IDs stay in the dispatch table.
  // ---------------------------------------------------------------------------

  it("dispatches to recipients translator when xRenderer === '@cinatra-ai/email-recipient-selection-agent:output'", async () => {
    const messages: A2UiMessage[] = [];
    const adapter = new A2UiAdapter("run-1", "tpl-1", async (m) => { messages.push(m); }, testMidRunResolver);
    adapter.onInterrupt(
      { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] },
      "@cinatra-ai/email-recipient-selection-agent:output",
      { campaignId: "c1", recipients: [] },
      "lg-run-1",
    );
    await new Promise((r) => setTimeout(r, 0));
    // Should emit 3 A2UI messages (createSurface + updateComponents + updateDataModel)
    expect(messages).toHaveLength(3);
    const m0 = messages[0] as { createSurface?: { surfaceId: string } };
    expect(m0.createSurface?.surfaceId).toBe("run-1:hitl:lg-run-1");
  });

  it("dispatches to drafts translator when xRenderer === '@cinatra-ai/email-drafting-agent:output'", async () => {
    const messages: A2UiMessage[] = [];
    const adapter = new A2UiAdapter("run-1", "tpl-1", async (m) => { messages.push(m); }, testMidRunResolver);
    adapter.onInterrupt(
      { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] },
      "@cinatra-ai/email-drafting-agent:output",
      { campaignId: "c1", drafts: [] },
      "lg-run-1",
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(messages).toHaveLength(3);
    const m0 = messages[0] as { createSurface?: { surfaceId: string } };
    expect(m0.createSurface?.surfaceId).toBe("run-1:hitl:lg-run-1");
  });

  it("dispatches to send translator when xRenderer === '@cinatra-ai/email-delivery-agent:output'", async () => {
    const messages: A2UiMessage[] = [];
    const adapter = new A2UiAdapter("run-1", "tpl-1", async (m) => { messages.push(m); }, testMidRunResolver);
    adapter.onInterrupt(
      { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] },
      "@cinatra-ai/email-delivery-agent:output",
      { campaignId: "c1", recipientCount: 0, draftCount: 0 },
      "lg-run-1",
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(messages).toHaveLength(3);
    const m0 = messages[0] as { createSurface?: { surfaceId: string } };
    expect(m0.createSurface?.surfaceId).toBe("run-1:hitl:lg-run-1");
  });

  it("regression: grouped-setup-form still dispatches correctly (no regression from dispatch-table refactor)", async () => {
    const messages: A2UiMessage[] = [];
    const adapter = new A2UiAdapter("run-1", "tpl-1", async (m) => { messages.push(m); });
    const schema = {
      type: "object",
      properties: { website: { type: "string", title: "Website" } },
      required: ["website"],
    };
    adapter.onInterrupt(schema, "@cinatra-ai/agent-builder:grouped-setup-form", {}, "rt-1");
    await new Promise((r) => setTimeout(r, 0));
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ version: "v0.9", createSurface: { surfaceId: "run-1:hitl:rt-1", catalogId: "cinatra-default" } });
    expect(messages[1]).toMatchObject({ version: "v0.9", updateComponents: { surfaceId: "run-1:hitl:rt-1" } });
    expect(messages[2]).toMatchObject({ version: "v0.9", updateDataModel: { surfaceId: "run-1:hitl:rt-1", path: "/" } });
  });

  // ---------------------------------------------------------------------------
  // Coverage for the presentation-first dispatch branch.
  // values.presentation must be handled before mid-run renderer translators.
  // ---------------------------------------------------------------------------

  it("onInterrupt with values.presentation (card_list) emits createSurface + updateComponents + updateDataModel IN ORDER", async () => {
    const messages: A2UiMessage[] = [];
    const adapter = new A2UiAdapter("run-1", "tpl-1", async (m) => { messages.push(m); });
    const hint = {
      type: "card_list",
      title: "Review drafts",
      items: [{ title: "Draft A", description: "Body A" }],
    };
    adapter.onInterrupt(
      { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] },
      "@cinatra-ai/email-drafting-agent:output",
      { presentation: hint },
      "lg-run-1",
    );
    // Two microtask flushes: the branch is an async IIFE that awaits
    // createSurface before publishing the translator messages, so the
    // test-side publisher queue needs more than one tick to drain.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(messages).toHaveLength(3);
    // ORDER IS LOAD-BEARING: createSurface MUST be index 0, not "somewhere".
    expect(messages[0]).toMatchObject({
      version: "v0.9",
      createSurface: { surfaceId: "run-1:hitl:lg-run-1", catalogId: "cinatra-default" },
    });
    const m1 = messages[1] as { updateComponents?: { surfaceId: string } };
    const m2 = messages[2] as { updateDataModel?: { surfaceId: string; path?: string } };
    expect(m1.updateComponents?.surfaceId).toBe("run-1:hitl:lg-run-1");
    expect(m2.updateDataModel?.surfaceId).toBe("run-1:hitl:lg-run-1");
    // Generic dispatcher roots data model at "/" (see a2ui-translator.ts:625-643).
    expect(m2.updateDataModel?.path).toBe("/");
  });

  it("values.presentation wins over MID_RUN_TRANSLATORS when xRenderer also matches", async () => {
    const messages: A2UiMessage[] = [];
    const adapter = new A2UiAdapter("run-1", "tpl-1", async (m) => { messages.push(m); });
    const hint = { type: "card_list", title: "t", items: [{ title: "x" }] };
    adapter.onInterrupt(
      { type: "object", properties: {}, required: [] },
      // This xRenderer IS in MID_RUN_TRANSLATORS — presentation branch must still win.
      "@cinatra-ai/email-drafting-agent:output",
      { presentation: hint, campaignId: "cmp-1", drafts: [] },
      "lg-run-1",
    );
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(messages).toHaveLength(3);
    // The generic card_list dispatcher emits updateDataModel.value shaped
    // { items: [...] }. The hardcoded drafts translator (translateDraftsOutputToA2Ui)
    // emits updateDataModel.value shaped { drafts: [...] }. The shape of
    // updateDataModel.value uniquely identifies which code path fired — the
    // generic dispatcher must win.
    const m2 = messages[2] as { updateDataModel?: { surfaceId: string; value?: unknown } };
    expect(m2.updateDataModel?.value).toMatchObject({ items: expect.any(Array) });
    expect(m2.updateDataModel?.value).not.toHaveProperty("drafts");
  });

  it("absent values.presentation falls through to MID_RUN_TRANSLATORS (regression guard)", async () => {
    const messages: A2UiMessage[] = [];
    const adapter = new A2UiAdapter("run-1", "tpl-1", async (m) => { messages.push(m); }, testMidRunResolver);
    adapter.onInterrupt(
      { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] },
      "@cinatra-ai/email-recipient-selection-agent:output",
      { campaignId: "c1", recipients: [] }, // no presentation key
      "lg-run-2",
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(messages).toHaveLength(3);
    const m0 = messages[0] as { createSurface?: { surfaceId: string } };
    expect(m0.createSurface?.surfaceId).toBe("run-1:hitl:lg-run-2");
  });

  it("malformed values.presentation (null/string/array/object-without-type) falls through to MID_RUN_TRANSLATORS", async () => {
    // null case
    const messagesNull: A2UiMessage[] = [];
    const a1 = new A2UiAdapter("run-1", "tpl-1", async (m) => { messagesNull.push(m); }, testMidRunResolver);
    a1.onInterrupt(
      { type: "object", properties: {}, required: [] },
      "@cinatra-ai/email-recipient-selection-agent:output",
      { presentation: null, campaignId: "c1", recipients: [] },
      "lg-run-3",
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(messagesNull).toHaveLength(3);
    const a1m0 = messagesNull[0] as { createSurface?: { surfaceId: string } };
    expect(a1m0.createSurface?.surfaceId).toBe("run-1:hitl:lg-run-3");

    // string case
    const messagesStr: A2UiMessage[] = [];
    const a2 = new A2UiAdapter("run-1", "tpl-1", async (m) => { messagesStr.push(m); }, testMidRunResolver);
    a2.onInterrupt(
      { type: "object", properties: {}, required: [] },
      "@cinatra-ai/email-recipient-selection-agent:output",
      { presentation: "not an object", campaignId: "c1", recipients: [] },
      "lg-run-4",
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(messagesStr).toHaveLength(3);
    const a2m0 = messagesStr[0] as { createSurface?: { surfaceId: string } };
    expect(a2m0.createSurface?.surfaceId).toBe("run-1:hitl:lg-run-4");

    // array case — `typeof [] === "object"` is true, so a naive check would
    // accept it. The tightened guard must reject arrays explicitly.
    const messagesArr: A2UiMessage[] = [];
    const a3 = new A2UiAdapter("run-1", "tpl-1", async (m) => { messagesArr.push(m); }, testMidRunResolver);
    a3.onInterrupt(
      { type: "object", properties: {}, required: [] },
      "@cinatra-ai/email-recipient-selection-agent:output",
      { presentation: [1, 2, 3], campaignId: "c1", recipients: [] },
      "lg-run-5",
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(messagesArr).toHaveLength(3);
    const a3m0 = messagesArr[0] as { createSurface?: { surfaceId: string } };
    expect(a3m0.createSurface?.surfaceId).toBe("run-1:hitl:lg-run-5");

    // object-without-string-type case — a generic object that lacks the
    // discriminator field MUST be rejected by the guard (translator would
    // return null messages if it got in, but we prefer to never dispatch).
    const messagesNoType: A2UiMessage[] = [];
    const a4 = new A2UiAdapter("run-1", "tpl-1", async (m) => { messagesNoType.push(m); }, testMidRunResolver);
    a4.onInterrupt(
      { type: "object", properties: {}, required: [] },
      "@cinatra-ai/email-recipient-selection-agent:output",
      { presentation: { foo: "bar" }, campaignId: "c1", recipients: [] },
      "lg-run-6",
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(messagesNoType).toHaveLength(3);
    const a4m0 = messagesNoType[0] as { createSurface?: { surfaceId: string } };
    expect(a4m0.createSurface?.surfaceId).toBe("run-1:hitl:lg-run-6");
  });
});
