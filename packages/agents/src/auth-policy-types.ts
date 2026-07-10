/**
 * Client-safe AgentAuthPolicy types and schema.
 *
 * Extracted from auth-policy.ts so client components (permissions-tab-client.tsx)
 * can import AgentAuthPolicy + AgentAuthPolicySchema without pulling in the
 * `import "server-only"` guard that lives in auth-policy.ts.
 *
 * auth-policy.ts re-exports everything here — consumers that already import
 * from auth-policy.ts on the server side need no changes.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Widened token union. Backward-compatible superset of the original
// "owner" | "org" | "admin" set. JSONB columns accept the wider string
// literal range without a DB-level change (no CHECK constraint).
//
// This is the type of a SINGLE visibility token. The three run-access fields
// on AgentAuthPolicy each hold a NON-EMPTY ARRAY of these tokens (a union of
// grants) — see AgentAuthPolicyVisibilitySelection below.
// ---------------------------------------------------------------------------

export type AgentAuthPolicyVisibility =
  | "owner"
  | "org"
  | `org:${string}`
  | "admin"
  | "workspace"
  | `team:${string}`
  | `project:${string}`;

/**
 * A visibility SELECTION: a NON-EMPTY array of visibility tokens. Multi-scope
 * access (#1069) makes each run-access field a union of grants — a user
 * matching ANY token is admitted.
 *
 * Non-emptiness is encoded as a tuple `[T, ...T[]]` so that `selection[0]` is
 * always a defined token (never `T | undefined`) and the empty selection is
 * structurally unrepresentable. Every write is an array; stored scalar
 * policies coerce to a one-element array at parse time (see the schema).
 */
export type AgentAuthPolicyVisibilitySelection = [
  AgentAuthPolicyVisibility,
  ...AgentAuthPolicyVisibility[],
];

export type AgentAuthPolicy = {
  runListVisibility: AgentAuthPolicyVisibilitySelection;
  runDataVisibility: AgentAuthPolicyVisibilitySelection;
  runExecuteVisibility: AgentAuthPolicyVisibilitySelection;
  allowRunSharing: boolean;
  description?: string;
};

/**
 * Visibility inputs for a non-published agent_template read; the admin-standing
 * trio (admin-parity P4, cinatra#1129) is built by
 * `resolveTemplateVisibilityActor` (./auth-policy) and consumed by the store's
 * `applyAgentTemplateVisibility`.
 */
export type AgentTemplateVisibilityOptions = {
  actorUserId?: string | null;
  includeNonPublished?: boolean;
  actorPlatformRole?: "platform_admin" | "member";
  actorOrgRole?: "org_owner" | "org_admin" | "member";
  actorOrganizationId?: string | null;
};

export const DEFAULT_AGENT_AUTH_POLICY: AgentAuthPolicy = Object.freeze({
  // Inner arrays are frozen too: the default is shared by reference
  // (resolveEffectivePolicy returns it directly), so an accidental in-place
  // mutation of a field must fail fast rather than corrupt every caller.
  runListVisibility: Object.freeze(["owner"]),
  runDataVisibility: Object.freeze(["owner"]),
  runExecuteVisibility: Object.freeze(["owner"]),
  allowRunSharing: false,
}) as unknown as AgentAuthPolicy;

// ---------------------------------------------------------------------------
// Visibility token schema — widened to a union with UUID validation on the
// team:/project: prefix tails.
// ---------------------------------------------------------------------------

const UUID_TAIL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The runtime union (literals + refined strings) infers as `string` in zod —
// we narrow the schema's output type to AgentAuthPolicyVisibility via an
// explicit ZodType annotation so consumers (store.ts, permissions-actions.ts)
// preserve the precise union after `safeParse`.
//
// Exported so the client form can compose its own schema against the canonical
// visibility shape. A permissive client schema would downgrade server-side
// rejections of malformed values into an indistinguishable "transient failure"
// toast.
export const AgentAuthPolicyVisibilitySchema: z.ZodType<AgentAuthPolicyVisibility> = z.union([
  z.literal("owner"),
  z.literal("org"),
  z.literal("admin"),
  z.literal("workspace"),
  z
    .string()
    .regex(/^org:/)
    .refine((s) => UUID_TAIL.test(s.slice("org:".length)), {
      message: "org:<id> tail must be a UUID",
    }) as unknown as z.ZodType<`org:${string}`>,
  z
    .string()
    .regex(/^team:/)
    .refine((s) => UUID_TAIL.test(s.slice("team:".length)), {
      message: "team:<id> tail must be a UUID",
    }) as unknown as z.ZodType<`team:${string}`>,
  z
    .string()
    .regex(/^project:/)
    .refine((s) => UUID_TAIL.test(s.slice("project:".length)), {
      message: "project:<id> tail must be a UUID",
    }) as unknown as z.ZodType<`project:${string}`>,
]);

// ---------------------------------------------------------------------------
// Selection schema — a single token OR a non-empty array of tokens, coerced to
// a non-empty array on read. Stored scalar policies (pre-multi-scope) parse to
// a one-element array; explicit arrays must be non-empty. This is COERCION
// ONLY — canonicalization of the token SET (dedupe / workspace-collapse /
// owner-strip) is normalizeVisibilitySelection()'s job, applied at write time.
// ---------------------------------------------------------------------------

export const AgentAuthPolicyVisibilitySelectionSchema: z.ZodType<AgentAuthPolicyVisibilitySelection> =
  z
    .union([
      AgentAuthPolicyVisibilitySchema,
      z.array(AgentAuthPolicyVisibilitySchema).nonempty(),
    ])
    .transform(
      (v) => (Array.isArray(v) ? v : [v]) as AgentAuthPolicyVisibilitySelection,
    ) as unknown as z.ZodType<AgentAuthPolicyVisibilitySelection>;

export const AgentAuthPolicySchema: z.ZodType<AgentAuthPolicy> = z.object({
  runListVisibility: AgentAuthPolicyVisibilitySelectionSchema,
  runDataVisibility: AgentAuthPolicyVisibilitySelectionSchema,
  runExecuteVisibility: AgentAuthPolicyVisibilitySelectionSchema,
  allowRunSharing: z.boolean(),
  description: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Selection helpers — shared by the access picker and every server write path.
// ---------------------------------------------------------------------------

/**
 * Canonicalize a visibility selection to its stored form.
 *
 * Invariants (#1069 / #1070):
 *   - dedupe, preserving first-seen order
 *   - `workspace` present  ⇒  the selection is exactly `["workspace"]`
 *     (workspace = "everyone in the workspace"; any narrower token is subsumed)
 *   - `owner` mixed with ANY other token is stripped — the owner always retains
 *     access, so listing `owner` alongside a wider grant is redundant. `owner`
 *     alone stays `["owner"]`.
 *   - `admin` IS mixable (an owner-aware positive grant, e.g. `admin + team:X`
 *     is a meaningful union) and is never stripped.
 *   - NO upward collapse: an explicit set of team/project tokens is never
 *     rewritten to `org:<id>`; org-implied team tokens are never stripped.
 *   - the result is ALWAYS non-empty (an all-`owner` or empty input yields
 *     `["owner"]`).
 *
 * This does NOT validate token shape — callers pass already-typed tokens (the
 * schema owns shape validation). It canonicalizes the SET only.
 */
export function normalizeVisibilitySelection(
  input: readonly AgentAuthPolicyVisibility[],
): AgentAuthPolicyVisibilitySelection {
  // Dedupe, preserving first-seen order.
  const deduped: AgentAuthPolicyVisibility[] = [];
  for (const tok of input) {
    if (!deduped.includes(tok)) deduped.push(tok);
  }

  // `workspace` subsumes every narrower token — collapse to exactly workspace.
  if (deduped.includes("workspace")) return ["workspace"];

  // Strip `owner` when mixed with any other token (the owner always retains
  // access). `owner` alone is preserved. `admin` and every scoped token stay —
  // no upward collapse, no implied-token stripping.
  const hasOther = deduped.some((t) => t !== "owner");
  const result = hasOther ? deduped.filter((t) => t !== "owner") : deduped;

  // Non-empty guarantee: an all-`owner` selection (or an empty input) is
  // `["owner"]`.
  if (result.length === 0) return ["owner"];
  return result as AgentAuthPolicyVisibilitySelection;
}

/**
 * True iff the selection is exactly the single `owner` token. Replaces the
 * pre-array `field === "owner"` exact gates (a selection that merely CONTAINS
 * `owner` is not owner-only — normalization strips a mixed `owner` anyway).
 */
export function isExactlyOwner(
  selection: readonly AgentAuthPolicyVisibility[],
): boolean {
  return selection.length === 1 && selection[0] === "owner";
}
