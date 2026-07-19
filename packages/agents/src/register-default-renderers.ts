// Field-renderer registration (cinatra#151 Stage 5 — manifest-driven).
//
// The host owns a table of NEUTRAL renderer KINDS (component primitives,
// below). WHICH x-renderer ID activates which kind — the agent-identity
// binding — is extension-owned data: each agent declares
// `cinatra.fieldRenderers` in its package.json manifest, validated
// fail-closed by scripts/extensions/agent-binding-kinds.mjs and delivered to
// this module through TWO sources:
//   - build-time: the generated `src/lib/generated/agent-bindings.ts` map
//     (presence-derived, byte-pinned) — registered synchronously at
//     `ensureDefaultFieldRenderersRegistered()` exactly like the retired
//     hand map, so bundled agents keep their render timing;
//   - runtime: packages installed AFTER build contribute via the
//     installed-package collector (field-renderer-bindings.server.ts) and the
//     panels' `useRuntimeFieldRendererBindings()` hook, which registers the
//     same normalized entries idempotently on arrival.
//
// This module names NO concrete extension: kind names and the bare legacy
// aliases are host-neutral strings; full IDs come exclusively from the
// generated map / the validated runtime data. (The `@cinatra/...` entries at
// the bottom are in-flight-run compatibility aliases for a RETIRED scope that
// is not — and must never become — a real extension package.)

import { createElement, type ComponentType } from "react";
import {
  fieldRendererRegistry,
  type FieldRendererCondition,
  type FieldRendererProps,
} from "./field-renderer-registry";
import {
  GENERATED_FIELD_RENDERER_BINDINGS,
} from "@/lib/generated/agent-bindings";
import {
  GmailSenderFieldRenderer,
  makeGmailSenderCondition,
} from "./gmail-sender-renderer";
import { ListPickerRenderer } from "./list-picker-renderer";
import { ContextSelectorRenderer } from "./context-selector-renderer";
import { FollowUpCadenceFieldRenderer } from "./follow-up-cadence-renderer";
import { CampaignRecipientsReviewRenderer } from "./campaign-recipients-review-renderer";
import { EmailDraftsReviewRenderer } from "./email-drafts-review-renderer";
import {
  AiReviewPanelRenderer,
  isAiReviewPanelField,
} from "./ai-review-panel-renderer";
import { ReviewerAgentOutputRenderer } from "./reviewer-agent-output-renderer";
import { SendConfirmationRenderer } from "./send-confirmation-renderer";
import { CtaRenderer } from "./cta-renderer";
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
} from "./grouped-setup-form-renderer";
import {
  GROUPED_SETUP_FORM_RENDERER_ID,
  PERSONAL_SKILL_RENDERER_ID,
  SKILL_SELECTOR_RENDERER_ID,
  SCHEMA_FIELD_FALLBACK_RENDERER_ID,
} from "./agent-builder-ids";
import { EmailTestDeliveryFormRenderer } from "./email-test-delivery-form-renderer";
import { hasFieldRendererComponent } from "./field-renderer-components";
import { makeExtensionFieldRenderer } from "./extension-field-renderer";

// ---------------------------------------------------------------------------
// The normalized binding shape this module registers from. Mirrors
// GeneratedFieldRendererBinding (and the runtime collector's output) without
// importing either, so both sources funnel through one registration path.
// ---------------------------------------------------------------------------
export type FieldRendererBindingInput = {
  readonly id: string;
  readonly kind: string;
  readonly priority: number;
  readonly midRunHitl?: boolean;
  readonly a2uiTranslator?: string;
  readonly params?: Readonly<Record<string, unknown>>;
};

// ---------------------------------------------------------------------------
// KIND TABLE — the host's renderer primitives, keyed by neutral kind name.
// `bareAliases` carries the historical UNSCOPED compat strings the retired
// hand-map predicates accepted (stored interrupts / resume payloads) — they
// are host-neutral and remain accepted for every binding of that kind.
// A repo test pins set-equality between these keys and
// KNOWN_FIELD_RENDERER_KINDS (scripts/extensions/agent-binding-kinds.mjs) so
// the validator vocabulary and this table cannot drift.
// ---------------------------------------------------------------------------
const RENDERER_KIND_TABLE: Record<
  string,
  {
    renderer: ComponentType<FieldRendererProps>;
    bareAliases?: readonly string[];
    /**
     * Optional custom condition factory for kinds whose match logic goes
     * beyond strict ID equality (e.g. gmail-sender's context gating +
     * field-name whitelist heuristic). Receives the full match-ID set
     * (binding ID + bare aliases); the factory owns everything else.
     */
    makeCondition?: (matchIds: readonly string[]) => FieldRendererCondition;
  }
> = {
  // MIGRATED (cinatra#1625): the auditor-review component moved into
  // @cinatra-ai/auditor-agent (the pure snapshot->onChange renderer). The KIND
  // stays (the manifest still declares it — kind-vocabulary set-equality), but
  // the host ships no component: a bundled binding resolves map-first to the
  // extension wrapper (hasFieldRendererComponent -> makeExtensionFieldRenderer),
  // and a not-in-build binding of this kind degrades to the SchemaFieldRenderer
  // floor here (AC4 never-blank). Same shape as final-list-review /
  // linkedin-draft-review / wordpress-draft-confirm below.
  "auditor-review": { renderer: SchemaFieldRenderer },
  "campaign-recipients-review": {
    renderer: CampaignRecipientsReviewRenderer,
    bareAliases: ["campaign-recipients-review"],
  },
  "context-selector": {
    renderer: ContextSelectorRenderer,
    bareAliases: ["context-selector"],
  },
  cta: { renderer: CtaRenderer, bareAliases: ["cta"] },
  "email-drafts-review": {
    renderer: EmailDraftsReviewRenderer,
    bareAliases: ["email-drafts-review"],
  },
  // scrape-schema-review + final-list-review: the COMPONENTS migrated into
  // @cinatra-ai/list-curator-agent (cinatra#1625 S8/M3). The KIND stays in the
  // table — the binding still declares it (kind-vocabulary set-equality) and
  // conditionFor() reads its bare aliases — but the host no longer ships a
  // component: a bundled binding resolves map-first to the extension wrapper
  // (hasFieldRendererComponent → makeExtensionFieldRenderer), and a NOT-in-build
  // binding of this kind (runtime-installed absent from the map) degrades to the
  // SchemaFieldRenderer floor here (AC4 never-blank), which is exactly this entry.
  "final-list-review": { renderer: SchemaFieldRenderer },
  "follow-up-cadence": {
    renderer: FollowUpCadenceFieldRenderer,
    bareAliases: ["follow-up-cadence"],
  },
  "gmail-sender": {
    renderer: GmailSenderFieldRenderer,
    bareAliases: ["gmail-sender"],
    makeCondition: makeGmailSenderCondition,
  },
  // MIGRATED (cinatra#1625 S8/M3): the blog-linkedin draft-review component
  // moved into @cinatra-ai/blog-linkedin-publish-agent. The KIND stays (the
  // manifest still declares it — kind-vocabulary set-equality; conditionFor()
  // reads its bare aliases), but the host ships no component: a bundled binding
  // resolves map-first to the extension wrapper, and a not-in-build binding of
  // this kind degrades to the SchemaFieldRenderer floor here (AC4 never-blank).
  // Same shape as final-list-review / scrape-schema-review above.
  "linkedin-draft-review": { renderer: SchemaFieldRenderer },
  "list-picker": { renderer: ListPickerRenderer, bareAliases: ["list-picker"] },
  "reviewer-output": { renderer: ReviewerAgentOutputRenderer },
  // See the final-list-review note above — the component migrated; the kind + its
  // floor stay host so the vocabulary holds and a not-in-build binding never blanks.
  "scrape-schema-review": { renderer: SchemaFieldRenderer },
  "send-confirmation": {
    renderer: SendConfirmationRenderer,
    bareAliases: ["send-confirmation"],
  },
  // MIGRATED (cinatra#1625 S8/M3): the skill-recommender component moved into
  // @cinatra-ai/skill-recommender-agent. The KIND stays (the manifest still
  // declares it — kind-vocabulary set-equality; conditionFor() reads its bare
  // aliases), but the host ships no component: a bundled binding resolves
  // map-first to the extension wrapper (hasFieldRendererComponent →
  // makeExtensionFieldRenderer), and a not-in-build binding of this kind degrades
  // to the SchemaFieldRenderer floor here (AC4 never-blank). Same shape as
  // final-list-review / scrape-schema-review / linkedin-draft-review /
  // wordpress-draft-confirm above.
  "skill-recommend": { renderer: SchemaFieldRenderer },
  "test-delivery-input": { renderer: EmailTestDeliveryFormRenderer },
  "wayflow-setup-form": { renderer: GroupedSetupFormRenderer },
  // MIGRATED (cinatra#1625 S8/M3): the blog-wordpress draft-confirm component
  // moved into @cinatra-ai/blog-wordpress-publish-agent. The KIND stays (the
  // manifest still declares it — kind-vocabulary set-equality; conditionFor()
  // reads its bare aliases), but the host ships no component: a bundled binding
  // resolves map-first to the extension wrapper, and a not-in-build binding of
  // this kind degrades to the SchemaFieldRenderer floor here (AC4 never-blank).
  // Same shape as final-list-review / scrape-schema-review / linkedin-draft-review above.
  "wordpress-draft-confirm": { renderer: SchemaFieldRenderer },
};

/** Pinned by the kind-vocabulary set-equality test. */
export function knownFieldRendererKinds(): readonly string[] {
  return Object.keys(RENDERER_KIND_TABLE).sort();
}

function xRendererOf(schema: Record<string, unknown>): string {
  const xr = (schema as { ["x-renderer"]?: unknown })["x-renderer"];
  return typeof xr === "string" ? xr : "";
}

// Strict-equality condition: the binding's full ID, plus the kind's bare
// compat aliases. No prefix/substring/regex matching — the namespace-collision
// posture of the retired hand map is preserved. Kinds with a custom factory
// (gmail-sender) own their extra logic; the ID set is still injected.
function conditionFor(id: string, kind: string): FieldRendererCondition {
  const kindEntry = RENDERER_KIND_TABLE[kind];
  const matchIds = [id, ...(kindEntry?.bareAliases ?? [])];
  if (kindEntry?.makeCondition) return kindEntry.makeCondition(matchIds);
  return (_fieldName, schema) => matchIds.includes(xRendererOf(schema));
}

// Wrap the kind component so a binding's validated `params` reach the
// renderer as the `bindingParams` prop (the pinned params contract). No JSX —
// this is a .ts module.
function withBindingParams(
  Component: ComponentType<FieldRendererProps>,
  params: Readonly<Record<string, unknown>> | undefined,
): ComponentType<FieldRendererProps> {
  if (params === undefined) return Component;
  const Wrapped = (props: FieldRendererProps) =>
    createElement(Component, { ...props, bindingParams: params });
  Wrapped.displayName = `WithBindingParams(${Component.displayName ?? Component.name ?? "FieldRenderer"})`;
  return Wrapped;
}

/**
 * Register normalized manifest bindings into the client registry.
 * Idempotent (registry replace-by-id). Unknown kinds are SKIPPED with a
 * warning — runtime data can never break the host; build-time data cannot
 * contain unknown kinds (generation is fail-closed against the shared
 * validator vocabulary).
 */
export function registerFieldRendererBindings(
  bindings: ReadonlyArray<FieldRendererBindingInput>,
): void {
  for (const b of bindings) {
    // S8 spine (cinatra#1625): a binding whose component has migrated into its
    // claiming extension (declared cinatra.fieldRenderers[].component and is in
    // THIS build) resolves to the extension-shipped component via the generated
    // build map; a missing/degraded module falls back to SchemaFieldRenderer
    // (the ExtensionFieldRenderer wrapper's floor — never blank/crash). The
    // condition (xRenderer id + the kind's bare compat aliases) and the
    // manifest-declared params contract are UNCHANGED — a map-hit is a 1:1 swap
    // of the SAME binding's renderer, so the binding's own scoped id always
    // resolves map-first and its legacy scoped aliases keep resolving. The map is
    // EMPTY today, so every binding takes the host KIND path below
    // (behavior-preserving).
    //
    // SHARED BARE-ALIAS CAVEAT (a per-claimant-migration concern, inert here):
    // a kind's bare compat alias (e.g. "email-drafts-review") can be claimed by
    // SEVERAL bindings of that kind; among equal priority the registry resolves
    // the first-registered. Today that is invisible (all same-kind bindings share
    // ONE host component). When a claimant slice migrates only SOME bindings of a
    // shared kind, the unscoped bare alias becomes genuinely ambiguous (no
    // arbitration rule can bind an unscoped string to one of several claimants) —
    // that slice must migrate the shared-kind cohort together or scope the alias.
    // The spine deliberately does not change arbitration priority to force this.
    if (hasFieldRendererComponent(b.id)) {
      fieldRendererRegistry.register({
        id: b.id,
        priority: b.priority,
        condition: conditionFor(b.id, b.kind),
        renderer: withBindingParams(makeExtensionFieldRenderer(b.id), b.params),
        midRunHitl: b.midRunHitl === true,
      });
      continue;
    }
    const kindEntry = RENDERER_KIND_TABLE[b.kind];
    if (!kindEntry) {
      console.warn(
        `[field-renderers] unknown renderer kind "${b.kind}" for ${b.id} — skipped (host has no component for it)`,
      );
      continue;
    }
    fieldRendererRegistry.register({
      id: b.id,
      priority: b.priority,
      condition: conditionFor(b.id, b.kind),
      renderer: withBindingParams(kindEntry.renderer, b.params),
      midRunHitl: b.midRunHitl === true,
    });
  }
}

/**
 * Idempotent. Safe to call multiple times — the registry's register() replaces
 * by id, so repeated calls are no-ops. The module-scope flag was removed because
 * it would survive hot-reloads and permanently suppress re-registration after
 * the registry's entries are cleared.
 */
export function ensureDefaultFieldRenderersRegistered(): void {
  // -------------------------------------------------------------------------
  // Host-internal entries — agent-builder surfaces owned by the host itself.
  // -------------------------------------------------------------------------

  // Grouped setup form renderer. Priority 50 — below every custom
  // renderer (60-100) so specialized per-field renderers still win on their
  // own xRenderer matches, but above the schema-field-fallback (priority 1).
  fieldRendererRegistry.register({
    id: GROUPED_SETUP_FORM_RENDERER_ID,
    priority: 50,
    condition: isGroupedSetupFormField,
    renderer: GroupedSetupFormRenderer,
  });

  fieldRendererRegistry.register({
    id: PERSONAL_SKILL_RENDERER_ID,
    priority: 90,
    condition: isPersonalSkillField,
    renderer: PersonalSkillRenderer,
  });

  fieldRendererRegistry.register({
    id: SKILL_SELECTOR_RENDERER_ID,
    priority: 95,
    condition: isSkillSelectorField,
    renderer: SkillSelectorRenderer,
  });

  // Fallback renderer for plain JSON Schema fields emitted as
  // setup-field INTERRUPTs. Resolves only when the emitted xRenderer equals
  // SCHEMA_FIELD_FALLBACK_RENDERER_ID — custom renderers (priority 60-100)
  // always win when their condition matches.
  fieldRendererRegistry.register({
    id: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
    priority: 1,
    condition: (_fieldName, schema) =>
      xRendererOf(schema) === SCHEMA_FIELD_FALLBACK_RENDERER_ID,
    renderer: SchemaFieldRenderer,
  });

  // -------------------------------------------------------------------------
  // Legacy-scope compatibility aliases for in-flight runs. `@cinatra/...` is a
  // RETIRED scope (never a real extension package) kept only so interrupts
  // persisted before the rename keep resolving.
  // -------------------------------------------------------------------------

  fieldRendererRegistry.register({
    id: "@cinatra/email-reviewer-agent:output",
    priority: 80,
    condition: (_fieldName, schema) =>
      xRendererOf(schema) === "@cinatra/email-reviewer-agent:output",
    renderer: ReviewerAgentOutputRenderer,
  });

  fieldRendererRegistry.register({
    id: "@cinatra/email-reviewer-agent:ai-review-panel",
    priority: 80,
    condition: isAiReviewPanelField,
    renderer: AiReviewPanelRenderer,
  });

  // -------------------------------------------------------------------------
  // Manifest-driven entries: the generated build-time bindings (presence-
  // derived from each agent's `cinatra.fieldRenderers` declaration). Runtime-
  // installed packages register later through the panels' hook — same
  // normalized shape, same registration path.
  // -------------------------------------------------------------------------
  registerFieldRendererBindings(GENERATED_FIELD_RENDERER_BINDINGS);
}

// NO top-level call here. Do NOT register at import time.
