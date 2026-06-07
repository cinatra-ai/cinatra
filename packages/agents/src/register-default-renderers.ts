import {
  fieldRendererRegistry,
  type FieldRendererEntry,
} from "./field-renderer-registry";
import {
  GmailSenderFieldRenderer,
  isGmailSenderField,
} from "./gmail-sender-renderer";
import {
  ListPickerRenderer,
  isListPickerField,
} from "./list-picker-renderer";
import {
  ContextSelectorRenderer,
  isContextSelectorField,
  CONTEXT_SELECTOR_RENDERER_ID,
} from "./context-selector-renderer";
import {
  ListCuratorScrapeSchemaRenderer,
  isListCuratorScrapeSchemaField,
} from "./list-curator-scrape-schema-renderer";
import {
  ListCuratorFinalListRenderer,
  isListCuratorFinalListField,
} from "./list-curator-final-list-renderer";
import {
  BlogLinkedinDraftReviewRenderer,
  isBlogLinkedinDraftReviewField,
} from "./blog-linkedin-draft-review-renderer";
import {
  BlogWordpressDraftConfirmRenderer,
  isBlogWordpressDraftConfirmField,
} from "./blog-wordpress-draft-confirm-renderer";
import {
  FollowUpCadenceFieldRenderer,
  isFollowUpCadenceField,
} from "./follow-up-cadence-renderer";
import {
  CampaignRecipientsReviewRenderer,
  isCampaignRecipientsReviewField,
} from "./campaign-recipients-review-renderer";
import {
  EmailDraftsReviewRenderer,
  isEmailDraftsReviewField,
} from "./email-drafts-review-renderer";
import {
  AiReviewPanelRenderer,
  isAiReviewPanelField,
} from "./ai-review-panel-renderer";
import { ReviewerAgentOutputRenderer } from "./reviewer-agent-output-renderer";
import { AuditorReviewRenderer } from "./auditor-review-renderer";
import {
  SendConfirmationRenderer,
  isSendConfirmationField,
} from "./send-confirmation-renderer";
import { CtaRenderer, isCtaField } from "./cta-renderer";
import {
  PersonalSkillRenderer,
  isPersonalSkillField,
} from "./personal-skill-renderer";
import {
  SkillSelectorRenderer,
  isSkillSelectorField,
} from "./skill-selector-renderer";
import { SchemaFieldRenderer } from "./schema-field-renderer";
import {
  GroupedSetupFormRenderer,
  isGroupedSetupFormField,
  GROUPED_SETUP_FORM_RENDERER_ID,
} from "./grouped-setup-form-renderer";
import {
  TriggerConfigureFormRenderer,
  TriggerConfirmSummaryRenderer,
} from "./trigger-agent-renderers";
import { SkillRecommenderRenderer } from "./skill-recommender-agent-renderers";
import { EmailTestDeliveryFormRenderer } from "./email-test-delivery-form-renderer";

const gmailSenderEntry: FieldRendererEntry = {
  id: "@cinatra-ai/email-outreach-agent:gmail-sender",
  priority: 100,
  condition: isGmailSenderField,
  renderer: GmailSenderFieldRenderer,
};

// List-based recipient selection. The legacy contact-source-selector (the
// "segment by source" picker) was retired with the lists_* MCP family; the
// list-picker is the sole recipient-source renderer now.
const listPickerEntry: FieldRendererEntry = {
  id: "@cinatra-ai/email-outreach-agent:list-picker",
  priority: 90,
  condition: isListPickerField,
  renderer: ListPickerRenderer,
};

// ContextSelector HITL renderer. Mounts when an
// agent OAS field's `x-renderer` equals
// `@cinatra-ai/context-selection-agent:context-selector` or the bare
// `context-selector` alias. Presentational only — the parent surface
// pre-populates `value.candidates` from the `context_resolve` MCP
// primitive; the renderer manages the user's selection on top.
const contextSelectorEntry: FieldRendererEntry = {
  id: CONTEXT_SELECTOR_RENDERER_ID,
  priority: 90,
  condition: isContextSelectorField,
  renderer: ContextSelectorRenderer,
};

// HITL Gate 1 — scrape-schema-review for @cinatra-ai/list-curator-agent.
// Same priority (90) as the list-picker — strict-equality on the
// x-renderer key ensures the two list-curator entries never collide with the
// list-picker or with each other.
const listCuratorScrapeSchemaEntry: FieldRendererEntry = {
  id: "@cinatra-ai/list-curator-agent:scrape-schema-review",
  priority: 90,
  condition: isListCuratorScrapeSchemaField,
  renderer: ListCuratorScrapeSchemaRenderer,
};

// HITL Gate 2 — final-list-review for @cinatra-ai/list-curator-agent.
const listCuratorFinalListEntry: FieldRendererEntry = {
  id: "@cinatra-ai/list-curator-agent:final-list-review",
  priority: 90,
  condition: isListCuratorFinalListField,
  renderer: ListCuratorFinalListRenderer,
};

// HITL gate for @cinatra-ai/blog-linkedin-publish-agent —
// operator reviews/edits the generated LinkedIn draft before publish.
const blogLinkedinDraftReviewEntry: FieldRendererEntry = {
  id: "@cinatra-ai/blog-linkedin-publish-agent:draft-review",
  priority: 90,
  condition: isBlogLinkedinDraftReviewField,
  renderer: BlogLinkedinDraftReviewRenderer,
};

// HITL gate for @cinatra-ai/blog-wordpress-publish-agent —
// operator confirms or rejects the created WordPress draft.
const blogWordpressDraftConfirmEntry: FieldRendererEntry = {
  id: "@cinatra-ai/blog-wordpress-publish-agent:draft-confirm",
  priority: 90,
  condition: isBlogWordpressDraftConfirmField,
  renderer: BlogWordpressDraftConfirmRenderer,
};

// Follow-up cadence renderer.
// The isFollowUpCadenceField predicate matches both current and compatibility
// x-renderer values so in-flight interrupt payloads still resolve via the
// predicate-level compat in follow-up-cadence-renderer.tsx. The compatibility
// registry ID is intentionally NOT re-registered here — registry membership
// tracks current canonical IDs only.
const followUpCadenceEntry: FieldRendererEntry = {
  id: "@cinatra-ai/email-follow-up-agent:follow-up-cadence",   // Current canonical follow-up cadence renderer.
  priority: 90,
  condition: isFollowUpCadenceField,
  renderer: FollowUpCadenceFieldRenderer,
};

// Grouped setup form renderer. Priority 50 — below every custom
// renderer (80-100) so specialized per-field renderers (gmail-sender, cta,
// list-picker, etc.) still win on their own xRenderer matches,
// but above the schema-field-fallback (priority 1). Matched via strict
// equality on x-renderer === "@cinatra-ai/agent-builder:grouped-setup-form".
const groupedSetupFormEntry: FieldRendererEntry = {
  id: GROUPED_SETUP_FORM_RENDERER_ID,
  priority: 50,
  condition: isGroupedSetupFormField,
  renderer: GroupedSetupFormRenderer,
};

/**
 * Idempotent. Safe to call multiple times — the registry's register() replaces
 * by id, so repeated calls are no-ops. The module-scope flag was removed because
 * it would survive hot-reloads and permanently suppress re-registration after
 * the registry's entries are cleared.
 */
export function ensureDefaultFieldRenderersRegistered(): void {
  fieldRendererRegistry.register(gmailSenderEntry);
  fieldRendererRegistry.register(listPickerEntry);              // list-based recipient selection
  fieldRendererRegistry.register(contextSelectorEntry);         // ContextSelector HITL renderer
  fieldRendererRegistry.register(listCuratorScrapeSchemaEntry); // Gate 1 — scrape-schema-review
  fieldRendererRegistry.register(listCuratorFinalListEntry);    // Gate 2 — final-list-review
  fieldRendererRegistry.register(blogLinkedinDraftReviewEntry); // LinkedIn draft review
  fieldRendererRegistry.register(blogWordpressDraftConfirmEntry); // WordPress draft confirmation
  fieldRendererRegistry.register(followUpCadenceEntry);         // follow-up cadence
  fieldRendererRegistry.register(groupedSetupFormEntry);        // grouped setup form

  // WayFlow-gated setup form: same GroupedSetupFormRenderer component but with
  // a different renderer ID so isMidRunHitl in orchestrator-stepper-panel can
  // distinguish it from the pre-flight grouped-setup-form.
  fieldRendererRegistry.register({
    id: "@cinatra-ai/email-outreach-agent:setup-form",
    priority: 60,
    condition: (_fieldName, schema) =>
      (schema as { "x-renderer"?: string })["x-renderer"] === "@cinatra-ai/email-outreach-agent:setup-form",
    renderer: GroupedSetupFormRenderer,
  });

  fieldRendererRegistry.register({
    id: "@cinatra-ai/email-recipient-selection-agent:output",   // agent output renderer
    priority: 80,
    condition: isCampaignRecipientsReviewField,
    renderer: CampaignRecipientsReviewRenderer,
  });

  fieldRendererRegistry.register({
    id: "@cinatra-ai/email-drafting-agent:output",       // agent output renderer
    priority: 80,
    condition: isEmailDraftsReviewField,
    renderer: EmailDraftsReviewRenderer,
  });

  // Follow-up output reuses EmailDraftsReviewRenderer.
  // Follow-up drafts share the StageDraft shape (id/subject/body/recipient/meta)
  // with initial drafts, so the existing drafts-review UI covers both stages
  // with no renderer fork required. Separate registry ID so the xRenderer
  // dispatch in AgenticRunPanel can still distinguish the two gates by name
  // (useful for logging / future divergence) without duplicating component code.
  //
  // Inline strict-equality condition — NOT isEmailDraftsReviewField — because
  // email-drafts:output (registered just above, priority 80) also uses
  // isEmailDraftsReviewField which includes "@cinatra-ai/email-follow-up-agent:output"
  // in its match list. If both entries share the same condition, registry.resolve()
  // returns the email-drafts:output entry (registered first, same priority), so
  // the email-followups:output id never resolves to this entry. The inline
  // condition targets exactly this id, making resolve() unambiguous.
  fieldRendererRegistry.register({
    id: "@cinatra-ai/email-follow-up-agent:output",    // follow-up agent output renderer
    priority: 80,
    // Strict equality — cannot share isEmailDraftsReviewField because .resolve picks
    // the first matching entry by priority and would conflate both ids.
    condition: (_fieldName, schema) =>
      (schema as { "x-renderer"?: string })["x-renderer"]
        === "@cinatra-ai/email-follow-up-agent:output",
    renderer: EmailDraftsReviewRenderer,
  });

  // Static per-content renderer IDs. WayFlow does not surface
  // DFE-provided inputs to INTERRUPT values, so LLM-driven dispatch cannot
  // read contentType from props.value. Each leaf agent hard-codes its
  // content-specific ID; the existing bespoke renderers handle data fetching
  // via context.runId as they always did.
  fieldRendererRegistry.register({
    id: "@cinatra-ai/reviewer-agent:contacts-output",
    priority: 80,
    condition: (_fieldName, schema) =>
      (schema as { "x-renderer"?: string })["x-renderer"] === "@cinatra-ai/reviewer-agent:contacts-output",
    renderer: CampaignRecipientsReviewRenderer,
  });
  fieldRendererRegistry.register({
    id: "@cinatra-ai/reviewer-agent:drafts-output",
    priority: 80,
    condition: (_fieldName, schema) =>
      (schema as { "x-renderer"?: string })["x-renderer"] === "@cinatra-ai/reviewer-agent:drafts-output",
    renderer: EmailDraftsReviewRenderer,
  });
  fieldRendererRegistry.register({
    id: "@cinatra-ai/reviewer-agent:followups-output",
    priority: 80,
    condition: (_fieldName, schema) =>
      (schema as { "x-renderer"?: string })["x-renderer"] === "@cinatra-ai/reviewer-agent:followups-output",
    renderer: EmailDraftsReviewRenderer,
  });

  // Generic dispatcher for compatibility aliases and for use when WayFlow
  // surfaces DFE inputs in INTERRUPT values).
  fieldRendererRegistry.register({
    id: "@cinatra-ai/reviewer-agent:output",
    priority: 80,
    condition: (_fieldName, schema) =>
      (schema as { "x-renderer"?: string })["x-renderer"] === "@cinatra-ai/reviewer-agent:output",
    renderer: ReviewerAgentOutputRenderer,
  });

  fieldRendererRegistry.register({
    id: "@cinatra/email-reviewer-agent:output",   // compatibility alias for in-flight runs
    priority: 80,
    condition: (_fieldName, schema) =>
      (schema as { "x-renderer"?: string })["x-renderer"] === "@cinatra/email-reviewer-agent:output",
    renderer: ReviewerAgentOutputRenderer,
  });

  fieldRendererRegistry.register({
    id: "@cinatra/email-reviewer-agent:ai-review-panel",
    priority: 80,
    condition: isAiReviewPanelField,
    renderer: AiReviewPanelRenderer,
  });

  fieldRendererRegistry.register({
    id: "@cinatra-ai/email-delivery-agent:output",       // agent output renderer
    priority: 80,
    condition: isSendConfirmationField,
    renderer: SendConfirmationRenderer,
  });

  // HITL renderer for the
  // @cinatra-ai/email-test-delivery-agent flow's InputMessageNode. Strict-equality
  // condition; renderer owns its own form/banner state and POSTs to
  // /api/test-delivery/send for the in-HITL Send button.
  fieldRendererRegistry.register({
    id: "@cinatra-ai/email-test-delivery-agent:input",
    priority: 80,
    condition: (_fieldName, schema) =>
      (schema as { "x-renderer"?: string })["x-renderer"] ===
      "@cinatra-ai/email-test-delivery-agent:input",
    renderer: EmailTestDeliveryFormRenderer,
  });

  fieldRendererRegistry.register({
    id: "@cinatra-ai/email-outreach-agent:cta",
    priority: 90,
    condition: isCtaField,
    renderer: CtaRenderer,
  });

  fieldRendererRegistry.register({
    id: "@cinatra-ai/agent-builder:personal-skill",
    priority: 90,
    condition: isPersonalSkillField,
    renderer: PersonalSkillRenderer,
  });

  fieldRendererRegistry.register({
    id: "@cinatra-ai/agent-builder:skill-selector",
    priority: 95,
    condition: isSkillSelectorField,
    renderer: SkillSelectorRenderer,
  });

  // Fallback renderer for plain JSON Schema fields emitted as
  // setup-field INTERRUPTs. Resolves only when the emitted xRenderer equals
  // the literal "@cinatra-ai/agent-builder:schema-field-fallback" — custom
  // renderers (priority 80-100) always win when their condition matches.
  fieldRendererRegistry.register({
    id: "@cinatra-ai/agent-builder:schema-field-fallback",
    priority: 1,
    condition: (_fieldName, schema) =>
      (schema as { "x-renderer"?: string })["x-renderer"]
        === "@cinatra-ai/agent-builder:schema-field-fallback",
    renderer: SchemaFieldRenderer,
  });

  // Auditor-agent HITL review renderer.
  fieldRendererRegistry.register({
    id: "@cinatra-ai/auditor-agent:review",
    priority: 80,
    condition: (_fieldName, schema) =>
      (schema as { "x-renderer"?: string })["x-renderer"] ===
      "@cinatra-ai/auditor-agent:review",
    renderer: AuditorReviewRenderer,
  });

  // Trigger-agent HITL renderers.
  // configure: reuses TriggerScreenClient inside the trigger-agent's run.
  // confirm:   read-only summary + explicit Confirm button before persist.
  fieldRendererRegistry.register({
    id: "@cinatra-ai/trigger-agent:configure",
    priority: 60,
    condition: (_fieldName, schema) =>
      (schema as { "x-renderer"?: string })["x-renderer"] ===
      "@cinatra-ai/trigger-agent:configure",
    renderer: TriggerConfigureFormRenderer,
  });
  fieldRendererRegistry.register({
    id: "@cinatra-ai/trigger-agent:confirm",
    priority: 60,
    condition: (_fieldName, schema) =>
      (schema as { "x-renderer"?: string })["x-renderer"] ===
      "@cinatra-ai/trigger-agent:confirm",
    renderer: TriggerConfirmSummaryRenderer,
  });

  // Skill-recommender-agent HITL renderer.
  // Shows HitlSkillChips for @cinatra-ai/email-drafting-agent + Continue button.
  fieldRendererRegistry.register({
    id: "@cinatra-ai/skill-recommender-agent:recommend",
    priority: 60,
    condition: (_fieldName, schema) =>
      (schema as { "x-renderer"?: string })["x-renderer"] ===
      "@cinatra-ai/skill-recommender-agent:recommend",
    renderer: SkillRecommenderRenderer,
  });

}

// NO top-level call here. Do NOT register at import time.
