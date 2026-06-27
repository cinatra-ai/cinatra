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

/** Skill id: the agentic agent-builder compiler skill. */
export const COMPILER_AGENTIC_SKILL_ID = id("agent-builder-compiler-agentic");
