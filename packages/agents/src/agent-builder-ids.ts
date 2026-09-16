// Centralized agent-builder identity table (the identity-surface ruling:
// "centralize the id table").
//
// WHY: the agent-builder domain matches producers to consumers by a string
// identity of the shape `@cinatra-ai/agent-builder:<id>` — an x-renderer id, a
// skill id, or an object-type id. Before this table those literals were spelled
// out at ~20 call sites across packages/agents/src; a producer that emits one
// id and a consumer that matches a DIFFERENT spelling of the "same" id would
// silently mismatch (no compiler error — they are plain strings). This module
// is the SINGLE authority for every agent-builder id routed WITHIN
// packages/agents; producers and consumers import the constant so a rename or
// typo is a build error, not a silent runtime mismatch.
//
// PURITY CONTRACT: this is a pure, dependency-free, ENVIRONMENT-NEUTRAL module
// (no `"use client"`, no React, no host `@/` import). It is imported by both
// server modules (execution.ts, oas-compiler.ts, store.ts) and client renderer
// modules (grouped-setup-form-renderer.tsx, skill-selector-renderer.tsx, …), so
// it must never pull a client-only or server-only graph in. Constants only.
//
// SCOPE BOUNDARY: this table governs the ids produced+consumed inside
// packages/agents. Cross-package object-type-id MAP KEYS (the
// `@cinatra-ai/agent-builder:agent-template` entries in packages/objects'
// taxonomy, the host retention/new-url maps, the skills mcp doc strings, and
// the agent-ui-protocol equality check) are intentionally left as data-contract
// / boundary literals: those packages do not (and to avoid dependency cycles
// must not) depend on @cinatra-ai/agents, and the literals there are persisted
// taxonomy keys / human-readable docs, not the agent-builder string-routing the
// ruling targets. AGENT_TEMPLATE_TYPE_ID is exported here for the
// packages/agents internal producers (store.ts, mcp/handlers.ts,
// integration/register-object-types.ts) that DO live in this package.

/** The package-scope lexeme every agent-builder id is namespaced under. The
 * `agent-builder` scope is a STABLE virtual identity (NOT a real extension dir
 * under extensions/) — it is the agent-builder domain's persisted/contract
 * namespace, so it is named in exactly one place here. */
export const AGENT_BUILDER_ID_SCOPE = "@cinatra-ai/agent-builder";

const id = (suffix: string): string => `${AGENT_BUILDER_ID_SCOPE}:${suffix}`;

/** Object-type id for a compiled agent template (cinatra.objects + taxonomy). */
export const AGENT_TEMPLATE_TYPE_ID = id("agent-template");

/** x-renderer id: the grouped multi-field setup form (one submit). */
export const GROUPED_SETUP_FORM_RENDERER_ID = id("grouped-setup-form");

/** x-renderer id: the catch-all schema-field fallback renderer. */
export const SCHEMA_FIELD_FALLBACK_RENDERER_ID = id("schema-field-fallback");

/** x-renderer id: the personal-skill field renderer. */
export const PERSONAL_SKILL_RENDERER_ID = id("personal-skill");

/** x-renderer id: the skill-selector field renderer. */
export const SKILL_SELECTOR_RENDERER_ID = id("skill-selector");

/** x-renderer id: the trigger wait-status field renderer. */
export const TRIGGER_WAIT_STATUS_RENDERER_ID = id("trigger-wait-status");

/** x-renderer id: the artifact-review REDIRECT card (cinatra#1796, epic #1620
 * S13). Emitted at an `input-required` interrupt whose gate carries the
 * `cinatra.artifactReview.targetsInput` marker — the host has PINNED the run's
 * immutable review targets and routes the human to the agent-run review surface
 * (`/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]`, the #2014
 * chrome mounted under the agent run per owner ruling 2026-07-25 (3)) instead
 * of the legacy in-panel reviewer envelope. The card is display-only: a link to
 * the pinned review surface, NO approve/continue affordance (the typed decision
 * is taken on the review surface and delivered by the resume-delivery worker), so
 * the legacy in-panel approve path can never double-resume a marked gate. The id
 * deliberately does NOT end in `:output` so the run panel never classifies it
 * mid-run (no auto-emitted Continue row). */
export const ARTIFACT_REVIEW_REDIRECT_RENDERER_ID = id("artifact-review-redirect");

/** Skill id: the agentic agent-builder compiler skill. */
export const COMPILER_AGENTIC_SKILL_ID = id("agent-builder-compiler-agentic");

// ---------------------------------------------------------------------------
// THE DECLARED REVIEW'S GATE IDS — one review per artifact (cinatra#3080).
// ---------------------------------------------------------------------------

/**
 * The mark a COMPANION declared-review gate's `reviewTaskId` carries.
 *
 * A marked step that produced several artifacts raises ONE REVIEW PER ARTIFACT
 * (issue #3080 item 4: "no new multi-target gate is minted"; the drawing, twice:
 * `app-lifecycle-cards.html` §II "a card carries one target panel over one
 * floor", `app-artifact-review.html` §VI "One artifact per review, one reference
 * per gate"). The FIRST artifact keeps the run's own `wayflow-<taskId>` gate —
 * the id the resume wire, the card ref, the park moment and the deep link all
 * already name, so nothing that addresses this run's review moves — and every
 * further artifact opens a COMPANION gate whose id is that carrier plus this
 * mark and the artifact's 1-based ordinal.
 *
 * It is DISJOINT from every other family by construction: an auto-gate id starts
 * `lifecycle-review:` and a carrier id is `wayflow-<taskId>` with no mark in it,
 * so `isDeclaredReviewCompanionTaskId` recognizes exactly the companions and the
 * resume-delivery worker keeps resuming the run on the carrier alone.
 */
export const DECLARED_REVIEW_COMPANION_MARK = "~artifact:";

/** The companion gate id for the `ordinal`-th artifact (1-based) of a declared
 *  review whose carrier gate is `carrierTaskId`. Deterministic and injective on
 *  `(carrier, ordinal)`, so a re-driven emit of the same artifact re-derives the
 *  same id and the gate emitter (idempotent on `(run, task)`) is a no-op. */
export function declaredReviewCompanionTaskId(carrierTaskId: string, ordinal: number): string {
  return `${carrierTaskId}${DECLARED_REVIEW_COMPANION_MARK}${ordinal}`;
}

/** The EXACT shape `declaredReviewCompanionTaskId` mints: a non-empty carrier,
 *  the mark, and the artifact's ordinal — which is never 1, because the first
 *  artifact keeps the carrier gate itself. Built from the mark so the minter and
 *  the reader can never drift apart. */
const DECLARED_REVIEW_COMPANION_SHAPE = new RegExp(
  `^.+${DECLARED_REVIEW_COMPANION_MARK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([0-9]+)$`,
);

/** Whether a `reviewTaskId` names a COMPANION gate of a declared review — a real
 *  review of a real artifact that carries no WayFlow resume wire of its own,
 *  because its run is parked on the carrier gate.
 *
 *  READ AS THE MINTED SHAPE, NEVER AS A SUBSTRING (the convergence round of
 *  2026-09-16). A carrier id is a WayFlow task id this module does not author,
 *  so "contains the mark" is a claim about a string nothing here controls: a
 *  carrier that merely CARRIED the mark would be read as a companion and the
 *  resume-delivery worker would mark its intent delivered without ever resuming
 *  the parked run. The shape — the mark, then an ordinal of 2 or more, then the
 *  end — is what the minter above produces and nothing else, so the two families
 *  are disjoint by construction rather than by assumption. */
export function isDeclaredReviewCompanionTaskId(reviewTaskId: string): boolean {
  const match = DECLARED_REVIEW_COMPANION_SHAPE.exec(reviewTaskId);
  if (!match) return false;
  return Number.parseInt(match[1], 10) >= 2;
}
