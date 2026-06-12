// Field-renderer binding RESOLUTION PARITY (cinatra#151 Stage 5).
//
// The hand map in register-default-renderers.ts was replaced by
// manifest-driven bindings (each agent's `cinatra.fieldRenderers` -> the
// generated src/lib/generated/agent-bindings.ts -> the host kind table).
// This suite pins that EVERY string the retired hand map + its predicate
// aliases accepted still resolves to the SAME component at the SAME
// priority — canonical ids, screen-specific compat ids, legacy-scope ids,
// and the bare unscoped aliases (stored interrupts / resume payloads).
// The table below is the FROZEN pre-cutover behavior (transcribed from the
// hand map at main 7074205); a regression here means stored/in-flight runs
// would resolve differently.

import { describe, it, expect, beforeAll } from "vitest";
import type { ComponentType } from "react";
import { fieldRendererRegistry } from "../field-renderer-registry";
import {
  ensureDefaultFieldRenderersRegistered,
  knownFieldRendererKinds,
  registerFieldRendererBindings,
} from "../register-default-renderers";
import {
  KNOWN_FIELD_RENDERER_KINDS,
  KNOWN_A2UI_TRANSLATOR_KINDS,
} from "../../../../scripts/extensions/agent-binding-kinds.mjs";
import {
  GENERATED_FIELD_RENDERER_BINDINGS,
} from "@/lib/generated/agent-bindings";
import { GmailSenderFieldRenderer } from "../gmail-sender-renderer";
import { ListPickerRenderer } from "../list-picker-renderer";
import { ContextSelectorRenderer } from "../context-selector-renderer";
import { ListCuratorScrapeSchemaRenderer } from "../list-curator-scrape-schema-renderer";
import { ListCuratorFinalListRenderer } from "../list-curator-final-list-renderer";
import { BlogLinkedinDraftReviewRenderer } from "../blog-linkedin-draft-review-renderer";
import { BlogWordpressDraftConfirmRenderer } from "../blog-wordpress-draft-confirm-renderer";
import { FollowUpCadenceFieldRenderer } from "../follow-up-cadence-renderer";
import { CampaignRecipientsReviewRenderer } from "../campaign-recipients-review-renderer";
import { EmailDraftsReviewRenderer } from "../email-drafts-review-renderer";
import { AiReviewPanelRenderer } from "../ai-review-panel-renderer";
import { ReviewerAgentOutputRenderer } from "../reviewer-agent-output-renderer";
import { AuditorReviewRenderer } from "../auditor-review-renderer";
import { SendConfirmationRenderer } from "../send-confirmation-renderer";
import { CtaRenderer } from "../cta-renderer";
import { SchemaFieldRenderer } from "../schema-field-renderer";
import { GroupedSetupFormRenderer } from "../grouped-setup-form-renderer";
import {
  TriggerConfigureFormRenderer,
  TriggerConfirmSummaryRenderer,
} from "../trigger-agent-renderers";
import { SkillRecommenderRenderer } from "../skill-recommender-agent-renderers";
import { EmailTestDeliveryFormRenderer } from "../email-test-delivery-form-renderer";
import { classifyMidRunHitl, hasMidRunHitlBinding } from "../orchestrator-mid-run-hitl";

// Gmail context: the gmail-sender condition is context-gated (gmail
// connected + aliases present) — the gating itself is pinned separately
// below.
const GMAIL_CONTEXT = {
  connectedApps: ["gmail"],
  gmailAliases: [{ sendAsEmail: "a@b.c" }],
};
const EMPTY_CONTEXT = { connectedApps: [] as string[] };

function resolveWith(xRenderer: string, context: Record<string, unknown> = EMPTY_CONTEXT) {
  return fieldRendererRegistry.resolve(
    "field",
    { "x-renderer": xRenderer },
    context as never,
  );
}

beforeAll(() => {
  ensureDefaultFieldRenderersRegistered();
});

// ---------------------------------------------------------------------------
// THE FROZEN PRE-CUTOVER RESOLUTION TABLE (hand map @ main 7074205).
// [accepted string, component, priority, context]
// ---------------------------------------------------------------------------
const PARITY_TABLE: ReadonlyArray<
  [string, ComponentType<never>, number, Record<string, unknown>?]
> = [
  ["@cinatra-ai/email-outreach-agent:gmail-sender", GmailSenderFieldRenderer as never, 100, GMAIL_CONTEXT],
  ["gmail-sender", GmailSenderFieldRenderer as never, 100, GMAIL_CONTEXT],
  ["@cinatra-ai/email-outreach-agent:list-picker", ListPickerRenderer as never, 90],
  ["list-picker", ListPickerRenderer as never, 90],
  ["@cinatra-ai/context-selection-agent:context-selector", ContextSelectorRenderer as never, 90],
  ["context-selector", ContextSelectorRenderer as never, 90],
  ["@cinatra-ai/list-curator-agent:scrape-schema-review", ListCuratorScrapeSchemaRenderer as never, 90],
  ["@cinatra-ai/list-curator-agent:final-list-review", ListCuratorFinalListRenderer as never, 90],
  ["@cinatra-ai/blog-linkedin-publish-agent:draft-review", BlogLinkedinDraftReviewRenderer as never, 90],
  ["@cinatra-ai/blog-wordpress-publish-agent:draft-confirm", BlogWordpressDraftConfirmRenderer as never, 90],
  ["@cinatra-ai/email-follow-up-agent:follow-up-cadence", FollowUpCadenceFieldRenderer as never, 90],
  ["@cinatra-ai/email-drafting-agent:follow-up-cadence", FollowUpCadenceFieldRenderer as never, 90],
  ["follow-up-cadence", FollowUpCadenceFieldRenderer as never, 90],
  ["@cinatra-ai/email-outreach-agent:setup-form", GroupedSetupFormRenderer as never, 60],
  ["@cinatra-ai/email-recipient-selection-agent:output", CampaignRecipientsReviewRenderer as never, 80],
  ["@cinatra-ai/email-recipient-selection-agent:campaign-recipients-review", CampaignRecipientsReviewRenderer as never, 80],
  ["campaign-recipients-review", CampaignRecipientsReviewRenderer as never, 80],
  ["@cinatra-ai/email-drafting-agent:output", EmailDraftsReviewRenderer as never, 80],
  ["@cinatra-ai/email-drafting-agent:email-drafts-review", EmailDraftsReviewRenderer as never, 80],
  ["email-drafts-review", EmailDraftsReviewRenderer as never, 80],
  ["@cinatra-ai/email-follow-up-agent:output", EmailDraftsReviewRenderer as never, 80],
  ["@cinatra-ai/reviewer-agent:contacts-output", CampaignRecipientsReviewRenderer as never, 80],
  ["@cinatra-ai/reviewer-agent:drafts-output", EmailDraftsReviewRenderer as never, 80],
  ["@cinatra-ai/reviewer-agent:followups-output", EmailDraftsReviewRenderer as never, 80],
  ["@cinatra-ai/reviewer-agent:output", ReviewerAgentOutputRenderer as never, 80],
  ["@cinatra/email-reviewer-agent:output", ReviewerAgentOutputRenderer as never, 80],
  ["@cinatra/email-reviewer-agent:ai-review-panel", AiReviewPanelRenderer as never, 80],
  ["@cinatra-ai/email-delivery-agent:output", SendConfirmationRenderer as never, 80],
  ["@cinatra-ai/email-delivery-agent:send-confirmation", SendConfirmationRenderer as never, 80],
  ["send-confirmation", SendConfirmationRenderer as never, 80],
  ["@cinatra-ai/email-test-delivery-agent:input", EmailTestDeliveryFormRenderer as never, 80],
  ["@cinatra-ai/email-outreach-agent:cta", CtaRenderer as never, 90],
  ["cta", CtaRenderer as never, 90],
  ["@cinatra-ai/agent-builder:schema-field-fallback", SchemaFieldRenderer as never, 1],
  ["@cinatra-ai/agent-builder:grouped-setup-form", GroupedSetupFormRenderer as never, 50],
  ["@cinatra-ai/auditor-agent:review", AuditorReviewRenderer as never, 80],
  ["@cinatra-ai/trigger-agent:configure", TriggerConfigureFormRenderer as never, 60],
  ["@cinatra-ai/trigger-agent:confirm", TriggerConfirmSummaryRenderer as never, 60],
];

describe("resolution parity with the retired hand map", () => {
  it.each(PARITY_TABLE)(
    "%s resolves to the pre-cutover component at the pre-cutover priority",
    (xRenderer, component, priority, context) => {
      const entry = resolveWith(xRenderer, context ?? EMPTY_CONTEXT);
      expect(entry, xRenderer).toBeTruthy();
      // For params-wrapped kinds the registered renderer is a wrapper —
      // compare the resolved COMPONENT IDENTITY through the wrapper's
      // displayName marker instead when wrapped.
      const resolved = entry!.renderer as ComponentType & { displayName?: string };
      if (resolved.displayName?.startsWith("WithBindingParams(")) {
        expect(resolved.displayName).toBe(
          `WithBindingParams(${(component as ComponentType & { displayName?: string; name?: string }).displayName ?? (component as { name?: string }).name})`,
        );
      } else {
        expect(resolved, xRenderer).toBe(component);
      }
      expect(entry!.priority, xRenderer).toBe(priority);
    },
  );

  it("skill-recommend resolves to the params-wrapped SkillRecommenderRenderer", () => {
    const entry = resolveWith("@cinatra-ai/skill-recommender-agent:recommend");
    expect(entry).toBeTruthy();
    expect(entry!.priority).toBe(60);
    const resolved = entry!.renderer as ComponentType & { displayName?: string };
    expect(resolved.displayName).toBe("WithBindingParams(SkillRecommenderRenderer)");
    void SkillRecommenderRenderer;
  });

  it("gmail-sender keeps its CONTEXT GATING (no gmail connection => no match)", () => {
    expect(
      resolveWith("@cinatra-ai/email-outreach-agent:gmail-sender", EMPTY_CONTEXT)?.renderer ?? null,
    ).not.toBe(GmailSenderFieldRenderer);
  });

  it("gmail-sender keeps the field-name whitelist heuristic (no x-renderer needed)", () => {
    const entry = fieldRendererRegistry.resolve(
      "senderEmail",
      { type: "string" },
      GMAIL_CONTEXT as never,
    );
    expect(entry?.renderer).toBe(GmailSenderFieldRenderer);
  });

  it("an unknown namespaced id resolves to NO custom entry (schema-fallback path)", () => {
    expect(resolveWith("@cinatra-ai/unknown-agent:whatever")).toBeNull();
  });
});

describe("mid-run HITL classification parity", () => {
  it.each([
    "@cinatra-ai/blog-linkedin-publish-agent:draft-review",
    "@cinatra-ai/blog-wordpress-publish-agent:draft-confirm",
    "@cinatra-ai/auditor-agent:review",
    "@cinatra-ai/context-selection-agent:context-selector",
  ])("manifest-flagged strict id %s classifies as mid-run", (id) => {
    expect(hasMidRunHitlBinding(id)).toBe(true);
    expect(classifyMidRunHitl(id)).toBe(true);
  });

  it("non-flagged ids do NOT carry the strict classification", () => {
    expect(hasMidRunHitlBinding("@cinatra-ai/email-outreach-agent:cta")).toBe(false);
    expect(hasMidRunHitlBinding("@cinatra-ai/trigger-agent:configure")).toBe(false);
  });

  it("suffix fallbacks are preserved (endsWith :output et al.)", () => {
    expect(classifyMidRunHitl("@cinatra-ai/anything:output")).toBe(true);
    expect(classifyMidRunHitl("@cinatra-ai/anything:setup-form")).toBe(true);
    expect(classifyMidRunHitl("@cinatra-ai/anything:unrelated")).toBe(false);
  });
});

describe("kind vocabulary cannot drift", () => {
  it("host kind table keys == shared validator vocabulary", () => {
    expect([...knownFieldRendererKinds()]).toEqual([...KNOWN_FIELD_RENDERER_KINDS]);
  });

  it("every generated binding kind is a known kind (fail-closed generation held)", () => {
    for (const b of GENERATED_FIELD_RENDERER_BINDINGS) {
      expect(KNOWN_FIELD_RENDERER_KINDS, b.id).toContain(b.kind);
    }
  });

  it("every generated a2uiTranslator kind is a known translator kind", () => {
    for (const b of GENERATED_FIELD_RENDERER_BINDINGS) {
      if (b.a2uiTranslator !== undefined) {
        expect(KNOWN_A2UI_TRANSLATOR_KINDS, b.id).toContain(b.a2uiTranslator);
      }
    }
  });

  it("the a2ui translator parity: the four email :output gates carry their kinds", () => {
    const byId = new Map(GENERATED_FIELD_RENDERER_BINDINGS.map((b) => [b.id, b]));
    expect(byId.get("@cinatra-ai/email-recipient-selection-agent:output")?.a2uiTranslator).toBe("recipients-output");
    expect(byId.get("@cinatra-ai/email-drafting-agent:output")?.a2uiTranslator).toBe("drafts-output");
    expect(byId.get("@cinatra-ai/email-follow-up-agent:output")?.a2uiTranslator).toBe("followups-output");
    expect(byId.get("@cinatra-ai/email-delivery-agent:output")?.a2uiTranslator).toBe("send-output");
  });
});

describe("registerFieldRendererBindings (runtime path)", () => {
  it("registers a runtime binding idempotently and skips unknown kinds with a warning", () => {
    registerFieldRendererBindings([
      { id: "@cinatra-ai/future-agent:thing", kind: "cta", priority: 70 },
      { id: "@cinatra-ai/future-agent:unknown", kind: "no-such-kind", priority: 70 },
    ]);
    expect(resolveWith("@cinatra-ai/future-agent:thing")?.renderer).toBe(CtaRenderer);
    expect(resolveWith("@cinatra-ai/future-agent:unknown")).toBeNull();
    // replace-by-id idempotency
    registerFieldRendererBindings([
      { id: "@cinatra-ai/future-agent:thing", kind: "cta", priority: 70 },
    ]);
    expect(
      fieldRendererRegistry.list().filter((e) => e.id === "@cinatra-ai/future-agent:thing"),
    ).toHaveLength(1);
  });
});
