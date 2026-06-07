// ---------------------------------------------------------------------------
// STANDALONE agent `contextSlots` reader.
//
// Returns the agent's declared `contextSlots: AgentContextSlot[]` from an
// already-loaded OAS blob (the agent's `cinatra/oas.json`). Mirrors the
// produces reader pattern: pure, no I/O, no registry/db imports, no
// cross-package edges. Caller passes the parsed OAS object; the reader extracts
// and validates only the `metadata.cinatra.contextSlots` slice.
//
// The slot schema is deliberately contract-only in this reader; this module has
// no runtime consumers. Resolver / MCP primitives, the interactive HITL
// renderer, and context-selection-agent invocation are wired outside this
// module. context-selection-agent invocation is explicit per slot in the
// context-using agent's own OAS (an explicit FlowNode + an
// `@cinatra-ai/context-selection-agent` agentDependencies entry; child-local).
// Runtime auto-wiring is intentionally absent; see https://docs.cinatra.ai/guides/developer/context-slots/.
// This module ships only the contract + parser so downstream consumers have a
// stable schema to plug into.
//
// Why is this in `packages/extensions/` (not `packages/agents/`)? Same reason
// as the produces reader: keeps the agents-barrel dep-direction clean
// (extensions does NOT import agents).
// ---------------------------------------------------------------------------

import { z } from "zod";

/** The selection-time UX channel: "interactive" surfaces a HITL picker;
 *  "autonomous" lets the context-agent pick without a gate. */
export type AgentContextSlotSelectionMode = "interactive" | "autonomous";

/** Multi-scope resolution semantics — the ownership chain walks
 *  User → Team → Organization → Workspace, with `projectId` an OPTIONAL
 *  refinement on top.
 *    - "override"   = narrowest scope wins (project refinement ▶ user ▶ team ▶ org ▶ workspace).
 *      The LLM sees ONE ref. Used for "ideal customer profile" where
 *      specificity trumps generality.
 *    - "accumulate" = walk the ownership chain and return all matches
 *      ordered narrow→broad, with a manifest tagging each ref by its
 *      source scope. The LLM sees them as separate attached artifacts
 *      and reconciles itself. Used for "brand voice" where broader
 *      context layers under narrower refinement. */
export type AgentContextSlotResolutionMode = "override" | "accumulate";

/** A single context-slot declaration on an agent OAS. */
export type AgentContextSlot = {
  slotId: string;
  acceptedArtifactExtensions: string[];
  selectionMode: AgentContextSlotSelectionMode;
  resolutionMode: AgentContextSlotResolutionMode;
  minItems?: number;
  maxItems?: number;
  readableOnly?: boolean;
};

// Strict zod schema — `strict()` rejects unknown keys so a typo (e.g.
// `selecMode` instead of `selectionMode`) doesn't silently parse to an
// empty/default value. The reader at the bottom DOES NOT throw on a
// hostile/malformed OAS — it returns `[]` (the same fail-quiet stance as
// the produces reader). Strict at the schema layer is for inputs that
// REACH the schema, not for the outer fail-quiet.
const contextSlotSchema: z.ZodType<AgentContextSlot> = z
  .object({
    slotId: z.string().min(1),
    acceptedArtifactExtensions: z.array(z.string().min(1)).min(1),
    selectionMode: z.enum(["interactive", "autonomous"]),
    resolutionMode: z.enum(["override", "accumulate"]),
    minItems: z.number().int().nonnegative().optional(),
    maxItems: z.number().int().positive().optional(),
    readableOnly: z.boolean().optional(),
  })
  .strict()
  // Post-shape cross-field guard: `minItems` cannot exceed `maxItems`.
  // The resolver assumes this invariant; reject malformed declarations at
  // parse-time so downstream code can trust the shape.
  .refine(
    (s) =>
      typeof s.minItems !== "number" ||
      typeof s.maxItems !== "number" ||
      s.minItems <= s.maxItems,
    { message: "minItems must be ≤ maxItems" },
  ) as z.ZodType<AgentContextSlot>;

const contextSlotsArraySchema = z.array(contextSlotSchema);

/**
 * Parse an agent OAS and return its declared `contextSlots` array.
 * Returns `[]` for legacy / absent / malformed declarations — quietly
 * empty, never throws. The fail-quiet posture mirrors the produces
 * reader: hostile manifests can carry throwing getters / Proxies; the
 * reader must NEVER crash its caller.
 *
 * Slot-ID uniqueness: the schema does NOT enforce slot-ID uniqueness
 * because that's an OAS-level concern (the same agent shouldn't declare
 * two slots with the same id). The resolver MUST detect + reject duplicate
 * slot IDs at registration time.
 */
export function readAgentContextSlotsFromOas(
  oas: unknown,
): AgentContextSlot[] {
  try {
    if (!oas || typeof oas !== "object") return [];
    const metadata = (oas as { metadata?: unknown }).metadata;
    if (!metadata || typeof metadata !== "object") return [];
    const cinatra = (metadata as { cinatra?: unknown }).cinatra;
    if (!cinatra || typeof cinatra !== "object") return [];
    const slots = (cinatra as { contextSlots?: unknown }).contextSlots;
    if (slots === undefined || slots === null) return [];
    const parsed = contextSlotsArraySchema.safeParse(slots);
    if (!parsed.success) return [];
    // Defensive: return new slot objects (no caller-supplied reference
    // pass-through — same smuggle-guard pattern as the produces reader).
    return parsed.data.map((s) => ({
      slotId: s.slotId,
      acceptedArtifactExtensions: [...s.acceptedArtifactExtensions],
      selectionMode: s.selectionMode,
      resolutionMode: s.resolutionMode,
      ...(typeof s.minItems === "number" ? { minItems: s.minItems } : {}),
      ...(typeof s.maxItems === "number" ? { maxItems: s.maxItems } : {}),
      ...(typeof s.readableOnly === "boolean"
        ? { readableOnly: s.readableOnly }
        : {}),
    }));
  } catch {
    return [];
  }
}

/**
 * Test-only export of the inner schema for byte-mirror tests against any
 * future canonical schema location. When the resolver wires the schema as a
 * registry-side write-time check, a mirror test can load both schemas against
 * the same fixtures and assert identical parse outcomes.
 */
export const __test = {
  contextSlotSchema,
  contextSlotsArraySchema,
};
