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
// Widened union. Backward-compatible superset of the original
// "owner" | "org" | "admin" set. JSONB columns accept the wider string
// literal range without a DB-level change (no CHECK constraint).
// ---------------------------------------------------------------------------

export type AgentAuthPolicyVisibility =
  | "owner"
  | "org"
  | `org:${string}`
  | "admin"
  | "workspace"
  | `team:${string}`
  | `project:${string}`;

export type AgentAuthPolicy = {
  runListVisibility: AgentAuthPolicyVisibility;
  runDataVisibility: AgentAuthPolicyVisibility;
  runExecuteVisibility: AgentAuthPolicyVisibility;
  allowRunSharing: boolean;
  description?: string;
};

export const DEFAULT_AGENT_AUTH_POLICY: AgentAuthPolicy = Object.freeze({
  runListVisibility: "owner",
  runDataVisibility: "owner",
  runExecuteVisibility: "owner",
  allowRunSharing: false,
}) as AgentAuthPolicy;

// ---------------------------------------------------------------------------
// Visibility schema — widened to a union with UUID validation on the
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

export const AgentAuthPolicySchema: z.ZodType<AgentAuthPolicy> = z.object({
  runListVisibility: AgentAuthPolicyVisibilitySchema,
  runDataVisibility: AgentAuthPolicyVisibilitySchema,
  runExecuteVisibility: AgentAuthPolicyVisibilitySchema,
  allowRunSharing: z.boolean(),
  description: z.string().optional(),
});
