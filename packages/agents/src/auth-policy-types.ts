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
// Visibility token schema — widened to a union with id-shape validation on
// the org:/team:/project: prefix tails.
// ---------------------------------------------------------------------------

const UUID_TAIL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Legacy better-auth row ids (cinatra#1907): before src/lib/auth.ts overrode
// `advanced.database.generateId`, better-auth minted 32-char base62 ids for
// orgs/teams/users/members — and those rows are live, interleaved with UUID
// rows. org: and team: tails must accept BOTH shapes or real entities are
// unscopeable. project: stays UUID-only: projects are never better-auth-
// minted, so no legacy-id project rows exist. Duplicated from
// src/lib/id-policy.ts LEGACY_NANOID_RE (packages/* must not import src/lib);
// keep the two in sync.
const LEGACY_BETTER_AUTH_ID_TAIL = /^[a-zA-Z0-9]{32}$/;

function isOrgOrTeamIdTail(tail: string): boolean {
  return UUID_TAIL.test(tail) || LEGACY_BETTER_AUTH_ID_TAIL.test(tail);
}

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
    .refine((s) => isOrgOrTeamIdTail(s.slice("org:".length)), {
      message: "org:<id> tail must be a UUID or 32-char legacy id",
    }) as unknown as z.ZodType<`org:${string}`>,
  z
    .string()
    .regex(/^team:/)
    .refine((s) => isOrgOrTeamIdTail(s.slice("team:".length)), {
      message: "team:<id> tail must be a UUID or 32-char legacy id",
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

// ---------------------------------------------------------------------------
// Agent-creation approval access-scope mapping (cinatra#1327).
//
// A chat-created agent is authored INSIDE the product and is never
// store-installed, so admin APPROVAL is the install-equivalent moment: the
// reviewer must choose WHO can access the agent, exactly as the marketplace
// install step does. This is the agent-approval analogue of
// packages/extensions/src/install-access-target.ts — a PURE mapping. It lives
// HERE (rather than a standalone module) so both the agent-MCP primitive and the
// app-layer approval helper reach it via an ALREADY-loaded module — a standalone
// file would enlarge the reachable first-party graph of the hot agent routes
// (route-graph ratchet). Pure (no IO, no server-only) so it stays unit-testable.
//
// DELIBERATE divergence from accessTargetToInstallPolicy: that helper returns
// `undefined` for the organization target so setExtensionInstallAccess applies
// the KIND default. For "agent_template" that default is OWNER-scoped
// (owner-only) — NOT what "organization access" means. So this mapper returns an
// EXPLICIT policy for every level (never undefined): organization → `workspace`
// (every same-org member), team → `team:<id>`, project → `project:<id>`. An
// approval can therefore never silently fall back to owner-only, and the
// org/team/project semantics match the agent install path
// (installRegistryPackageAtScope), whose organization target grants org-wide
// access.
// ---------------------------------------------------------------------------

/** The access target a reviewer picks at approval — the SAME three levels the
 *  agent / extension install-scope dialogs offer. "user" / "workspace" are not
 *  selectable targets (parity with the install-at-scope schema). */
export type AgentApprovalAccessTarget = {
  level: "organization" | "team" | "project";
  id: string;
};

/**
 * Zod schema for the accessTarget the agent-creation approve decision carries.
 * `level` INTENTIONALLY omits "user" and "workspace".
 */
export const AgentApprovalAccessTargetSchema: z.ZodType<AgentApprovalAccessTarget> =
  z.object({
    level: z.enum(["organization", "team", "project"]),
    id: z.string().min(1),
  });

/**
 * The approval-time access decision. `scoped` carries the reviewer's chosen
 * target (the approvals-UI path). `instant_grant_default` is the documented
 * platform_admin chat-authoring instant grant (cinatra#382): a chat surface
 * cannot show the access-scope dialog, so it keeps the pre-existing default
 * access and persists NO explicit scope. Making this a required parameter of the
 * shared approve→publish pipeline means a publish can never be reached WITHOUT
 * the caller having decided access one way or the other.
 */
export type AgentApprovalAccessDecision =
  | { mode: "scoped"; target: AgentApprovalAccessTarget }
  | { mode: "instant_grant_default" };

/**
 * Map the reviewer's chosen access target to the agent_template access policy
 * persisted at approval. Explicit for every level (never undefined):
 *   organization → ["workspace"]  (every same-org member)
 *   team         → ["team:<id>"]
 *   project      → ["project:<id>"]
 * Run-sharing disabled — parity with the marketplace install-time per-scope
 * policy (accessTargetToInstallPolicy).
 */
export function agentApprovalAccessPolicy(
  target: AgentApprovalAccessTarget,
): AgentAuthPolicy {
  if (target.level === "organization") {
    return {
      runListVisibility: ["workspace"],
      runDataVisibility: ["workspace"],
      runExecuteVisibility: ["workspace"],
      allowRunSharing: false,
    };
  }
  const visibility =
    target.level === "team"
      ? (`team:${target.id}` as const)
      : (`project:${target.id}` as const);
  return {
    runListVisibility: [visibility],
    runDataVisibility: [visibility],
    runExecuteVisibility: [visibility],
    allowRunSharing: false,
  };
}

// ---------------------------------------------------------------------------
// Install-scope picker value adapter (cinatra#1327).
//
// The AccessCombobox (installMode) emits an id-carrying token — "org:<id>" /
// "team:<id>" / "project:<id>" (legacy bare "org"). This is the SAME adapter the
// install-scope dialogs use to turn that token into the {level, id} target; the
// agent-creation APPROVAL scope step reuses it so both surfaces map identically.
// Co-located HERE (a pure, client-safe, already-widely-reachable module) rather
// than a standalone file so it does not enlarge the reachable first-party graph
// of the hot agent routes (route-graph ratchet). owner / admin / workspace are
// NOT selectable targets — the guard returns null so a stray value can never
// reach the server with a malformed target.
// ---------------------------------------------------------------------------

/**
 * Map an AccessCombobox picker value to the {level, id} target, or null when the
 * value is not a selectable target (owner / admin / workspace / empty / an empty
 * prefixed id like "team:"). `activeOrgId` backs the legacy bare "org" token —
 * but with NO active org (activeOrgId === "") the bare token cannot resolve to a
 * real target, so it too returns null rather than forwarding an empty id.
 */
export function pickerValueToTarget(
  value: string,
  activeOrgId: string,
): AgentApprovalAccessTarget | null {
  if (value.startsWith("org:")) {
    const id = value.slice("org:".length);
    return id ? { level: "organization", id } : null;
  }
  if (value === "org")
    return activeOrgId ? { level: "organization", id: activeOrgId } : null;
  if (value.startsWith("team:")) {
    const id = value.slice("team:".length);
    return id ? { level: "team", id } : null;
  }
  if (value.startsWith("project:")) {
    const id = value.slice("project:".length);
    return id ? { level: "project", id } : null;
  }
  // owner / admin / workspace / "" — not a selectable target. Defensive guard.
  return null;
}

/**
 * Required-ness predicate for the approval / install scope step: a scope
 * selection is REQUIRED, so a submit is only allowed when the picker value
 * resolves to a valid target. No selection and the non-target rows both return
 * false — the single source of truth the approval dialog's submit `disabled`
 * binds to, so "cannot approve without a scope" is one pure, unit-tested function.
 */
export function canSubmitApprovalScope(
  value: string,
  activeOrgId: string,
): boolean {
  return pickerValueToTarget(value, activeOrgId) !== null;
}
