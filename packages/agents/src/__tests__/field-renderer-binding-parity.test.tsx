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
import { ListPickerRenderer } from "../list-picker-renderer";
import { ContextSelectorRenderer } from "../context-selector-renderer";
import { CampaignRecipientsReviewRenderer } from "../campaign-recipients-review-renderer";
import { EmailDraftsReviewRenderer } from "../email-drafts-review-renderer";
import { ReviewerAgentOutputRenderer } from "../reviewer-agent-output-renderer";
import { SendConfirmationRenderer } from "../send-confirmation-renderer";
import { CtaRenderer } from "../cta-renderer";
import { SchemaOnlyFloorRenderer } from "../schema-field-renderer";
import { GroupedSetupFormRenderer } from "../grouped-setup-form-renderer";
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
  // gmail-sender (scoped id + bare alias) MIGRATED into @cinatra-ai/email-artifacts
  // (cinatra#1625, eng#548) — now the ExtensionFieldRenderer wrapper at priority 100,
  // still context-gated. Asserted in the gmail-sender migrated block below (it needs
  // GMAIL_CONTEXT, so it is not in this context-free frozen table).
  ["@cinatra-ai/email-outreach-agent:list-picker", ListPickerRenderer as never, 90],
  ["list-picker", ListPickerRenderer as never, 90],
  ["@cinatra-ai/context-selection-agent:context-selector", ContextSelectorRenderer as never, 90],
  ["context-selector", ContextSelectorRenderer as never, 90],
  // MIGRATED field-renderer COMPONENTS (cinatra#1625 S8/M3): list-curator's
  // scrape-schema-review + final-list-review (→ @cinatra-ai/list-curator-agent),
  // blog-linkedin's draft-review (→ @cinatra-ai/blog-linkedin-publish-agent) and
  // blog-wordpress's draft-confirm (→ @cinatra-ai/blog-wordpress-publish-agent).
  // Their ids now resolve to the ExtensionFieldRenderer wrapper (still priority
  // 90, same strict-id condition) — asserted in the dedicated migrated-binding
  // block below, not in this frozen host-component table.
  // follow-up-cadence (2 scoped ids + bare alias) MIGRATED into
  // @cinatra-ai/email-artifacts (cinatra#1625, eng#548) — now the
  // ExtensionFieldRenderer wrapper at priority 90 (both scoped ids load the SAME
  // pack component). Asserted in the migrated-binding it.each + the bare-alias
  // block below, not in this frozen host-component table.
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
  // NOTE: the `@cinatra/email-reviewer-agent:ai-review-panel` legacy-scope alias
  // was DELETED (cinatra#1625 S8/M3, owner action-boundary ruling 2026-07-18) —
  // a retired-scope binding whose review-check mutations were already inert stubs
  // (its "Approve review" action did still resume the interrupt). It now resolves
  // to NO custom entry (asserted below); a stored pre-rename interrupt therefore
  // shows "no renderer configured" with no Continue and cannot be resumed — an
  // unresumable dead-end accepted under the owner's backward-compat waiver (NOT
  // a SchemaFieldRenderer floor).
  ["@cinatra-ai/email-delivery-agent:output", SendConfirmationRenderer as never, 80],
  ["@cinatra-ai/email-delivery-agent:send-confirmation", SendConfirmationRenderer as never, 80],
  ["send-confirmation", SendConfirmationRenderer as never, 80],
  ["@cinatra-ai/email-test-delivery-agent:input", EmailTestDeliveryFormRenderer as never, 80],
  ["@cinatra-ai/email-outreach-agent:cta", CtaRenderer as never, 90],
  ["cta", CtaRenderer as never, 90],
  // The terminal schema-field-fallback is the TRUE registry-bypass floor
  // (cinatra#1625, codex 2026-07-20): SchemaOnlyFloorRenderer renders the same
  // schema-driven UI as the raw SchemaFieldRenderer but never re-enters the
  // registry (a floor that re-resolved its own fallback xRenderer would recurse).
  ["@cinatra-ai/agent-builder:schema-field-fallback", SchemaOnlyFloorRenderer as never, 1],
  ["@cinatra-ai/agent-builder:grouped-setup-form", GroupedSetupFormRenderer as never, 50],
  // NOTE: @cinatra-ai/auditor-agent:review MIGRATED into its extension
  // (cinatra#1625) — it now resolves to the ExtensionFieldRenderer wrapper at
  // priority 80, asserted in the migrated-binding it.each below, not here.
  // NOTE: the @cinatra-ai/trigger-agent renderers (:configure / the never-bound
  // :confirm) were RETIRED with the trigger-agent extension (cinatra#1034).
  // Scheduling is now a platform default rendered by the host TriggerScreen
  // (first-step scheduling gate) + the persistent /trigger tab — no agent
  // declares a trigger renderer, so no trigger id appears in this table. The id
  // now resolves to null (asserted by "an unknown namespaced id resolves to NO
  // custom entry" below).
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

  it("migrated skill-recommend binding resolves to the extension wrapper at the pre-cutover priority", () => {
    // The COMPONENT relocated into @cinatra-ai/skill-recommender-agent
    // (cinatra#1625 S8/M3): the binding is present in the generated component
    // map, so it registers as the ExtensionFieldRenderer wrapper (lazy-loads the
    // extension module, floors on any degrade) — NOT the retired host component,
    // and no longer a WithBindingParams wrapper (the 4636be97 manifest dropped
    // `params.skillsTargetPackage`; the extension renderer is now pure display
    // over the prep-node-gathered `value`). The id + priority (60) are unchanged,
    // so stored/in-flight runs still resolve the SAME binding.
    const id = "@cinatra-ai/skill-recommender-agent:recommend";
    const entry = resolveWith(id);
    expect(entry).toBeTruthy();
    expect(entry!.priority).toBe(60);
    const resolved = entry!.renderer as ComponentType & { displayName?: string };
    expect(resolved.displayName).toBe(`ExtensionFieldRenderer(${id})`);
  });

  it.each([
    ["@cinatra-ai/list-curator-agent:scrape-schema-review", 90],
    ["@cinatra-ai/list-curator-agent:final-list-review", 90],
    ["@cinatra-ai/blog-linkedin-publish-agent:draft-review", 90],
    ["@cinatra-ai/blog-wordpress-publish-agent:draft-confirm", 90],
    // The auditor-review component relocated into @cinatra-ai/auditor-agent
    // (cinatra#1625) at its pre-cutover priority 80.
    ["@cinatra-ai/auditor-agent:review", 80],
    // follow-up-cadence relocated into @cinatra-ai/email-artifacts (cinatra#1625,
    // eng#548): BOTH scoped ids load the same pack component, priority 90.
    ["@cinatra-ai/email-follow-up-agent:follow-up-cadence", 90],
    ["@cinatra-ai/email-drafting-agent:follow-up-cadence", 90],
  ] as const)(
    "migrated field-renderer binding %s resolves to the extension wrapper at the pre-cutover priority",
    (id, priority) => {
      // The COMPONENT relocated into its claiming extension (cinatra#1625): the
      // binding is present in the generated component map, so it registers as
      // the ExtensionFieldRenderer wrapper (which lazy-loads the extension
      // module and floors on any degrade) — NOT a host KIND component. The id +
      // priority are unchanged, so stored/in-flight runs still resolve the SAME
      // binding.
      const entry = resolveWith(id);
      expect(entry, id).toBeTruthy();
      expect(entry!.priority, id).toBe(priority);
      const resolved = entry!.renderer as ComponentType & { displayName?: string };
      expect(resolved.displayName).toBe(`ExtensionFieldRenderer(${id})`);
    },
  );

  it.each([
    ["@cinatra-ai/email-outreach-agent:gmail-sender"],
    // bare unscoped compat alias (stored interrupts) — KEPT (codex Q2).
    ["gmail-sender"],
  ])(
    "migrated gmail-sender binding %s resolves to the extension wrapper at priority 100 WHEN gmail is connected",
    (xRenderer) => {
      const entry = resolveWith(xRenderer, GMAIL_CONTEXT);
      expect(entry, xRenderer).toBeTruthy();
      expect(entry!.priority, xRenderer).toBe(100);
      const resolved = entry!.renderer as ComponentType & { displayName?: string };
      // Both the scoped id and the bare alias resolve to the SAME migrated
      // binding's wrapper (there is only one gmail-sender binding).
      expect(resolved.displayName).toBe(
        "ExtensionFieldRenderer(@cinatra-ai/email-outreach-agent:gmail-sender)",
      );
    },
  );

  it("migrated gmail-sender keeps its CONTEXT GATING (no gmail connection => no match)", () => {
    // The host-owned condition (makeGmailSenderCondition, now in
    // ./gmail-sender-condition) still gates on gmail connected + aliases, so with
    // no gmail the binding does not match and nothing else claims the id.
    expect(resolveWith("@cinatra-ai/email-outreach-agent:gmail-sender", EMPTY_CONTEXT)).toBeNull();
    expect(resolveWith("gmail-sender", EMPTY_CONTEXT)).toBeNull();
  });

  it("migrated gmail-sender keeps the field-name whitelist heuristic (no x-renderer needed)", () => {
    const entry = fieldRendererRegistry.resolve(
      "senderEmail",
      { type: "string" },
      GMAIL_CONTEXT as never,
    );
    expect(entry).toBeTruthy();
    const resolved = entry!.renderer as ComponentType & { displayName?: string };
    expect(resolved.displayName).toBe(
      "ExtensionFieldRenderer(@cinatra-ai/email-outreach-agent:gmail-sender)",
    );
  });

  it("migrated follow-up-cadence bare alias still resolves (stored-interrupt compat, KEPT — codex Q2)", () => {
    // Both cadence bindings load the same pack component, so the bare alias
    // resolving to whichever registered first is harmless. Assert it resolves to
    // an ExtensionFieldRenderer wrapper (not null, not a host component) at 90.
    const entry = resolveWith("follow-up-cadence");
    expect(entry).toBeTruthy();
    expect(entry!.priority).toBe(90);
    const resolved = entry!.renderer as ComponentType & { displayName?: string };
    expect(resolved.displayName).toMatch(
      /^ExtensionFieldRenderer\(@cinatra-ai\/email-(follow-up|drafting)-agent:follow-up-cadence\)$/,
    );
  });

  it("an unknown namespaced id resolves to NO custom entry (schema-fallback path)", () => {
    expect(resolveWith("@cinatra-ai/unknown-agent:whatever")).toBeNull();
  });

  it("the DELETED ai-review-panel legacy alias resolves to NO custom entry (unresumable dead-end, not a schema floor)", () => {
    // cinatra#1625 S8/M3: the retired-scope `ai-review-panel` alias was
    // deleted (owner action-boundary ruling 2026-07-18). Neither the qualified
    // legacy id nor the bare unscoped alias resolves to a custom renderer now —
    // and neither is the `schema-field-fallback` id, so the HITL surface shows
    // "no renderer configured" (no floor, no Continue). Accepted under the
    // owner's backward-compat waiver.
    expect(resolveWith("@cinatra/email-reviewer-agent:ai-review-panel")).toBeNull();
    expect(resolveWith("ai-review-panel")).toBeNull();
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
    expect(hasMidRunHitlBinding("@cinatra-ai/email-outreach-agent:setup-form")).toBe(false);
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
