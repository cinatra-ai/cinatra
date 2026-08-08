/**
 * Shared HITL gate-submit payload builders (cinatra#853).
 *
 * These pure helpers are the consolidated home of the resume-payload logic
 * previously duplicated between agentic-run-panel.tsx and
 * orchestrator-stepper-panel.tsx. Every branch is pinned here so a future
 * edit to one surface cannot silently diverge the other again.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/hitl-gate-submit.test.ts
 */
import { describe, it, expect } from "vitest";
import type { LlmAttachmentRef } from "@cinatra-ai/llm";

import {
  applyAttachmentEnvelopeUserResponseOnly,
  buildChatGateSubmitPayload,
  isAlreadyResolvedError,
  isGroupedSetupRenderer,
  isSetupGateTaskId,
  liftRendererApprovalNote,
  withContextSelectorEnvelope,
  wrapPrimitiveSetupPayload,
  setupFieldRendererValue,
} from "../hitl-gate-submit";
import { GROUPED_SETUP_FORM_RENDERER_ID } from "../agent-builder-ids";

const NOW = "2026-01-02T03:04:05.000Z";

const ATTACHMENT: LlmAttachmentRef = {
  artifactId: "art-1",
  representationRevisionId: "rev-1",
  digest: "sha256:abc",
  mime: "text/plain",
  originKind: "upload",
  filename: "notes.txt",
  size: 12,
};

describe("gate classification", () => {
  it("isSetupGateTaskId matches only the setup- prefix", () => {
    expect(isSetupGateTaskId("setup-run-123")).toBe(true);
    expect(isSetupGateTaskId("rt-456")).toBe(false);
    expect(isSetupGateTaskId("my-setup-run")).toBe(false);
  });

  it("isGroupedSetupRenderer matches the base id and its ':' variants", () => {
    expect(isGroupedSetupRenderer(GROUPED_SETUP_FORM_RENDERER_ID)).toBe(true);
    expect(isGroupedSetupRenderer(`${GROUPED_SETUP_FORM_RENDERER_ID}:output`)).toBe(true);
    expect(isGroupedSetupRenderer("@cinatra-ai/other:setup-form")).toBe(false);
  });

  it("isGroupedSetupRenderer includes ':setup-form' suffixes only when opted in (orchestrator semantics)", () => {
    expect(
      isGroupedSetupRenderer("@cinatra-ai/email-outreach-agent:setup-form", {
        includeSetupFormSuffix: true,
      }),
    ).toBe(true);
    expect(
      isGroupedSetupRenderer("@cinatra-ai/email-outreach-agent:setup-form"),
    ).toBe(false);
    // The base grouped-setup id must NOT be treated as a `:setup-form`
    // suffix match (its own last segment merely CONTAINS "setup-form").
    expect(
      isGroupedSetupRenderer(GROUPED_SETUP_FORM_RENDERER_ID, {
        includeSetupFormSuffix: true,
      }),
    ).toBe(true);
  });

  it("isAlreadyResolvedError is case-insensitive substring match", () => {
    expect(isAlreadyResolvedError("Review task rt-1 already resolved")).toBe(true);
    expect(isAlreadyResolvedError("ALREADY RESOLVED")).toBe(true);
    expect(isAlreadyResolvedError("Could not continue this run.")).toBe(false);
  });
});

describe("wrapPrimitiveSetupPayload", () => {
  it("wraps primitives (incl. arrays and null) under fieldName", () => {
    expect(wrapPrimitiveSetupPayload("postTitle", "My title")).toEqual({
      payload: { postTitle: "My title" },
      payloadFieldName: "postTitle",
    });
    expect(wrapPrimitiveSetupPayload("count", 3)).toEqual({
      payload: { count: 3 },
      payloadFieldName: "count",
    });
    expect(wrapPrimitiveSetupPayload("flag", false)).toEqual({
      payload: { flag: false },
      payloadFieldName: "flag",
    });
    expect(wrapPrimitiveSetupPayload("urls", ["a", "b"])).toEqual({
      payload: { urls: ["a", "b"] },
      payloadFieldName: "urls",
    });
    expect(wrapPrimitiveSetupPayload("x", null)).toEqual({
      payload: { x: null },
      payloadFieldName: "x",
    });
  });

  it("passes objects through unchanged (grouped forms key off inputSchema.properties)", () => {
    const obj = { a: 1 };
    expect(wrapPrimitiveSetupPayload("field", obj)).toEqual({
      payload: obj,
      payloadFieldName: undefined,
    });
  });

  it("passes everything through when no fieldName was carried on the interrupt", () => {
    expect(wrapPrimitiveSetupPayload(undefined, "bare")).toEqual({
      payload: "bare",
      payloadFieldName: undefined,
    });
  });

  // cinatra#2484 — an object-TYPED setup input emits a real object whose keys
  // are the object's OWN sub-properties (`{title, summary, outline}` for
  // `idea`). Without the opt-in that object would take the grouped branch and
  // its sub-keys would be checked against inputSchema.properties — where
  // `title`/`summary`/`outline` are not declared — and rejected as unknown keys.
  it("wraps an OBJECT under fieldName when the interrupt's field is object-typed", () => {
    const idea = { title: "Human purpose", outline: ["a", "b"] };
    expect(
      wrapPrimitiveSetupPayload("idea", idea, { objectTypedField: true }),
    ).toEqual({
      payload: { idea },
      payloadFieldName: "idea",
    });
  });

  // codex round 1: a value cannot be told apart from an envelope by shape, so
  // the wrap under the flag is UNCONDITIONAL. An object input whose declared
  // sub-properties happen to include one named after the input itself produces
  // exactly the `{idea: …}` shape a "looks already wrapped" shortcut would
  // mistake for an envelope — and would then store the SUB-value at
  // inputParams.idea, one level too shallow.
  it("wraps unconditionally — a sub-property named after the field is NOT an envelope", () => {
    const collides = { idea: "the sub-property happens to be called idea", title: "t" };
    expect(
      wrapPrimitiveSetupPayload("idea", collides, { objectTypedField: true }),
    ).toEqual({ payload: { idea: collides }, payloadFieldName: "idea" });

    const singleKeyCollision = { idea: { nested: true } };
    expect(
      wrapPrimitiveSetupPayload("idea", singleKeyCollision, { objectTypedField: true }),
    ).toEqual({ payload: { idea: singleKeyCollision }, payloadFieldName: "idea" });
  });

  it("leaves every other renderer's multi-key object on the grouped branch (opt-in only)", () => {
    const obj = { a: 1, b: 2 };
    // No flag → byte-identical to the pre-#2484 behaviour asserted above.
    expect(wrapPrimitiveSetupPayload("field", obj)).toEqual({
      payload: obj,
      payloadFieldName: undefined,
    });
    expect(wrapPrimitiveSetupPayload("field", obj, { objectTypedField: false })).toEqual({
      payload: obj,
      payloadFieldName: undefined,
    });
  });

  it("keeps ARRAY values on the primitive branch even when the flag is set", () => {
    expect(
      wrapPrimitiveSetupPayload("urls", ["a"], { objectTypedField: true }),
    ).toEqual({ payload: { urls: ["a"] }, payloadFieldName: "urls" });
  });
});

describe("withContextSelectorEnvelope (#817)", () => {
  const values = {
    slotMeta: { slotId: "slot-1", resolutionMode: "manual" },
    selectedRefs: [{ objectType: "doc", objectId: "d1" }],
  };

  it("synthesizes the envelope when the renderer emitted no userResponse", () => {
    const out = withContextSelectorEnvelope(
      "@cinatra-ai/x:context-selector",
      values,
      { approved: true },
    );
    expect(JSON.parse(out.userResponse as string)).toEqual({
      slotId: "slot-1",
      resolutionMode: "manual",
      selectedRefs: [{ objectType: "doc", objectId: "d1" }],
    });
    expect(out.approved).toBe(true);
  });

  it("PRESERVES a renderer-authored userResponse (real toggle)", () => {
    const payload = { userResponse: '{"slotId":"slot-1","selectedRefs":[]}' };
    const out = withContextSelectorEnvelope(
      "@cinatra-ai/x:context-selector",
      values,
      payload,
    );
    expect(out).toBe(payload); // unchanged, same reference
  });

  it("defaults selectedRefs to [] when the interrupt carried none", () => {
    const out = withContextSelectorEnvelope(
      "@cinatra-ai/x:context-selector",
      { slotMeta: { slotId: "slot-2" } },
      {},
    );
    expect(JSON.parse(out.userResponse as string).selectedRefs).toEqual([]);
  });

  it("no-ops without a trusted slotMeta.slotId or on other renderers", () => {
    const payload = {};
    expect(
      withContextSelectorEnvelope("@cinatra-ai/x:context-selector", {}, payload),
    ).toBe(payload);
    expect(
      withContextSelectorEnvelope("@cinatra-ai/x:output", values, payload),
    ).toBe(payload);
  });
});

describe("liftRendererApprovalNote", () => {
  it(":list-picker lifts the selected list with defaults + snapshotAt", () => {
    const lift = liftRendererApprovalNote(
      "@cinatra-ai/x:list-picker",
      { listId: "l1", listName: "My list", memberCount: 5 },
      NOW,
    );
    expect(JSON.parse(lift!.approvalNote)).toEqual({
      type: "list",
      listId: "l1",
      listName: "My list",
      memberCount: 5,
      snapshotAt: NOW,
    });
    const empty = liftRendererApprovalNote("@cinatra-ai/x:list-picker", {}, NOW);
    expect(JSON.parse(empty!.approvalNote)).toEqual({
      type: "list",
      listId: "",
      listName: "",
      memberCount: 0,
      snapshotAt: NOW,
    });
  });

  it(":setup-form lifts the three sender fields (undefined keys dropped by JSON)", () => {
    const lift = liftRendererApprovalNote(
      "@cinatra-ai/x:setup-form",
      { offeringCompanyWebsite: "https://x.io", callToAction: "Book", senderName: "Ada" },
      NOW,
    );
    expect(JSON.parse(lift!.approvalNote)).toEqual({
      offeringCompanyWebsite: "https://x.io",
      callToAction: "Book",
      senderName: "Ada",
    });
    const sparse = liftRendererApprovalNote("@cinatra-ai/x:setup-form", {}, NOW);
    expect(JSON.parse(sparse!.approvalNote)).toEqual({});
  });

  it(":scrape-schema-review lifts instructions/outputSchema/seedUrls with defaults", () => {
    const lift = liftRendererApprovalNote("@cinatra-ai/x:scrape-schema-review", {}, NOW);
    expect(JSON.parse(lift!.approvalNote)).toEqual({
      type: "scrape-schema",
      instructions: "",
      outputSchema: { type: "object", properties: {} },
      seedUrls: [],
      snapshotAt: NOW,
    });
  });

  it(":final-list-review lifts listName/memberRefs/memberCount with defaults", () => {
    const lift = liftRendererApprovalNote(
      "@cinatra-ai/x:final-list-review",
      { listName: "Leads", memberRefs: [{ objectType: "person", objectId: "p1" }], memberCount: 1 },
      NOW,
    );
    expect(JSON.parse(lift!.approvalNote)).toEqual({
      type: "final-list",
      listName: "Leads",
      memberRefs: [{ objectType: "person", objectId: "p1" }],
      memberCount: 1,
      snapshotAt: NOW,
    });
  });

  it("returns null for renderers without a lift", () => {
    expect(liftRendererApprovalNote("@cinatra-ai/x:output", { a: 1 }, NOW)).toBeNull();
    expect(liftRendererApprovalNote(GROUPED_SETUP_FORM_RENDERER_ID, {}, NOW)).toBeNull();
  });
});

describe("buildChatGateSubmitPayload", () => {
  it("setup single-field: wraps the value under fieldName over the buffer, no WayFlow metadata", () => {
    const { payload, payloadFieldName } = buildChatGateSubmitPayload({
      reviewTaskId: "setup-run-1",
      fieldName: "postTitle",
      value: "Hello",
      buffered: { keep: 1 },
      pendingAttachments: [],
      now: NOW,
    });
    expect(payload).toEqual({ keep: 1, postTitle: "Hello" });
    expect(payloadFieldName).toBe("postTitle");
    expect(payload.approved).toBeUndefined();
    expect(payload.userResponse).toBeUndefined();
  });

  it("setup single-field: unwraps an object value that already carries the fieldName key", () => {
    const { payload } = buildChatGateSubmitPayload({
      reviewTaskId: "setup-run-1",
      fieldName: "postTitle",
      value: { postTitle: "From form" },
      buffered: {},
      pendingAttachments: [],
      now: NOW,
    });
    expect(payload).toEqual({ postTitle: "From form" });
  });

  it("grouped setup: merges the field object OVER the buffer, no WayFlow metadata", () => {
    const { payload, payloadFieldName } = buildChatGateSubmitPayload({
      reviewTaskId: "setup-run-1",
      value: { a: 1, b: 2 },
      buffered: { a: 0, c: 3 },
      pendingAttachments: [],
      now: NOW,
    });
    expect(payload).toEqual({ a: 1, b: 2, c: 3 });
    expect(payloadFieldName).toBeUndefined();
    expect(payload.approved).toBeUndefined();
  });

  it("grouped setup: a primitive value contributes nothing beyond the buffer", () => {
    const { payload } = buildChatGateSubmitPayload({
      reviewTaskId: "setup-run-1",
      value: "yes",
      buffered: { a: 1 },
      pendingAttachments: [],
      now: NOW,
    });
    expect(payload).toEqual({ a: 1 });
  });

  it("mid-run object: WayFlow metadata + userResponse is the JSON of the object", () => {
    const { payload, payloadFieldName } = buildChatGateSubmitPayload({
      reviewTaskId: "rt-9",
      value: { recipients: ["a@b.c"] },
      buffered: { campaignId: "c1" },
      pendingAttachments: [],
      now: NOW,
    });
    expect(payloadFieldName).toBeUndefined();
    expect(payload.campaignId).toBe("c1");
    expect(payload.recipients).toEqual(["a@b.c"]);
    expect(payload.approved).toBe(true);
    expect(payload.approvedAt).toBe(NOW);
    // No attachments → byte-identical legacy text (back-compat invariant).
    expect(payload.userResponse).toBe(JSON.stringify({ recipients: ["a@b.c"] }));
  });

  it("mid-run primitive: userResponse is the JSON of the primitive", () => {
    const { payload } = buildChatGateSubmitPayload({
      reviewTaskId: "rt-9",
      value: "looks good",
      buffered: {},
      pendingAttachments: [],
      now: NOW,
    });
    expect(payload.userResponse).toBe(JSON.stringify("looks good"));
    expect(payload.approved).toBe(true);
  });

  it("mid-run empty object: falls back to {approved:true} as the resume text", () => {
    const { payload } = buildChatGateSubmitPayload({
      reviewTaskId: "rt-9",
      value: {},
      buffered: {},
      pendingAttachments: [],
      now: NOW,
    });
    expect(payload.userResponse).toBe(JSON.stringify({ approved: true }));
  });

  it("mid-run with attachments: wraps the legacy text in the user_envelope", () => {
    const { payload } = buildChatGateSubmitPayload({
      reviewTaskId: "rt-9",
      value: { note: "hi" },
      buffered: {},
      pendingAttachments: [ATTACHMENT],
      now: NOW,
    });
    const envelope = JSON.parse(payload.userResponse as string) as {
      text: string;
      attachments: unknown[];
    };
    // Legacy text is preserved BYTE-IDENTICAL inside the envelope.
    expect(envelope.text).toBe(JSON.stringify({ note: "hi" }));
    expect(envelope.attachments).toHaveLength(1);
  });

  it("setup gates never wrap attachments (the setup-loop server ignores userResponse)", () => {
    const { payload } = buildChatGateSubmitPayload({
      reviewTaskId: "setup-run-1",
      fieldName: "postTitle",
      value: "Hello",
      buffered: {},
      pendingAttachments: [ATTACHMENT],
      now: NOW,
    });
    expect(payload.userResponse).toBeUndefined();
  });
});

describe("applyAttachmentEnvelopeUserResponseOnly", () => {
  it("no attachments → identical payload reference", () => {
    const payload = { approved: true };
    expect(applyAttachmentEnvelopeUserResponseOnly(payload, [])).toBe(payload);
  });

  it("wraps a renderer-authored userResponse", () => {
    const out = applyAttachmentEnvelopeUserResponseOnly(
      { userResponse: '{"campaignId":"c1"}' },
      [ATTACHMENT],
    );
    const envelope = JSON.parse(out.userResponse as string) as { text: string };
    expect(envelope.text).toBe('{"campaignId":"c1"}');
  });

  it("falls back to the server default text when none was buffered — and does NOT consult approvalNote (pre-existing divergence from the orchestrator's pickLegacyResumeText)", () => {
    const out = applyAttachmentEnvelopeUserResponseOnly(
      { approvalNote: "should not be used" },
      [ATTACHMENT],
    );
    const envelope = JSON.parse(out.userResponse as string) as { text: string };
    expect(envelope.text).toBe("[Approved by operator]");
  });
});

/**
 * cinatra#2484 (codex round 2) — the per-field panels hand EVERY field the whole
 * `currentValues` envelope under the placeholder `fieldName="hitl-field"`, so
 * the renderer cannot recover its own slot. For an object-typed field that is a
 * correctness bug (sub-fields seed from unrelated run inputs that merely share a
 * name), and no renderer-side heuristic fixes it. The caller resolves it.
 */
describe("setupFieldRendererValue (cinatra#2484)", () => {
  const ENVELOPE = {
    title: "an unrelated run input",
    idea: { title: "the real sub-value" },
    tone: "informative",
  };

  it("unwraps the field's own value for an OBJECT-typed field", () => {
    expect(
      setupFieldRendererValue(ENVELOPE, "idea", { type: "object" }),
    ).toEqual({ title: "the real sub-value" });
  });

  it("passes the envelope THROUGH for non-object fields — no behaviour change", () => {
    // Unwrapping for every type would start pre-filling string/number/array
    // gates from previously-submitted values, which the per-field surface
    // deliberately avoids.
    expect(setupFieldRendererValue(ENVELOPE, "tone", { type: "string" })).toBe(ENVELOPE);
    expect(setupFieldRendererValue(ENVELOPE, "tone", { type: "array" })).toBe(ENVELOPE);
    expect(setupFieldRendererValue(ENVELOPE, "tone", undefined)).toBe(ENVELOPE);
  });

  it("passes the envelope through when there is no fieldName (grouped gate)", () => {
    expect(setupFieldRendererValue(ENVELOPE, undefined, { type: "object" })).toBe(ENVELOPE);
  });

  it("yields undefined for an object field with nothing stored yet", () => {
    expect(setupFieldRendererValue({}, "idea", { type: "object" })).toBeUndefined();
  });
});
