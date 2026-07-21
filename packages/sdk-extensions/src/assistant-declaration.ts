// The assistant DECLARATION (`cinatra/config.json` `assistant` block) — the
// SINGLE authoritative schema + validator + projection for the multi-vendor
// Assistants epic (cinatra#1873, W1 foundation cinatra#1874).
//
// An assistant is an `agent`-kind extension whose package-root
// `cinatra/config.json` carries an `assistant` block. The FILE shape is
// `{ formatVersion, access?, assistant? }` (the same file may also carry the
// connector `access` block, which the connector parser owns — see
// `access-config.ts`; this parser validates only the `assistant` domain and the
// top-level structure, fail-closed on unknown top-level keys).
//
//     { "formatVersion": 1,
//       "assistant": {
//         "abiVersion": 1,
//         "displayName": "Cinatra",
//         "preferredTag": "cinatra",
//         "persona": "…",
//         "skillBundle": ["chat-assistant-core"],
//         "allowedTools": [], "allowedAgents": [],
//         "modelPrefs": { "provider": "anthropic", "model": "…" },
//         "mcp": { "enabled": true, "restriction": "org-members" },
//         "launch": { "kind": "local" },
//         "delivery": { "kind": "host-runtime" } } }
//
// FAIL-CLOSED (mirrors `access-config.ts`): `.strict()` at every level — unknown
// keys anywhere hard-fail; `formatVersion`/`abiVersion` must be EXACTLY 1 (an
// unknown future version fails closed rather than being half-understood); a
// malformed `preferredTag` (not an already-normalized flat token) fails; an
// `assistant` block that validates but PROJECTS to an invalid `assistant_config`
// is a parse error. This is the ONE shared parser consumed by all four
// touchpoints (manifest generator, install validation, production store read,
// scaffold) AND the connector-access-config-gate agent-package scan.
//
// zod v4 (optional peerDependency — same precedent as `access-config.ts`).

import { z } from "zod";
import {
  assistantConfigSchema,
  type AssistantConfig,
} from "./assistant-config-contract";

/** The only `formatVersion` this validator understands. Unknown = hard-fail. */
export const ASSISTANT_DECLARATION_FORMAT_VERSION = 1;

/** The only assistant-block `abiVersion` this validator understands. */
export const ASSISTANT_DECLARATION_ABI_VERSION = 1;

/** Launch topology of an assistant — `local` runs on the host runtime; `remote`
 *  proxies to a `targetProvider` (a connected site / external vendor). */
export const ASSISTANT_LAUNCH_KINDS = ["local", "remote"] as const;
export type AssistantLaunchKind = (typeof ASSISTANT_LAUNCH_KINDS)[number];

/** Delivery channel of an assistant's turns. */
export const ASSISTANT_DELIVERY_KINDS = ["host-runtime", "webhook", "mcp-poll"] as const;
export type AssistantDeliveryKind = (typeof ASSISTANT_DELIVERY_KINDS)[number];

/**
 * A well-formed flat namespace token (handle / alias / preferredTag): lowercase
 * [a-z0-9] segments joined by single `_`/`-`, no leading/trailing separator.
 * The declaration REQUIRES an already-normalized token so a malformed
 * `preferredTag` fails at parse time (AC#6); the runtime claim path
 * (`assistant_tag_alias` / `assistant_handles`) is where the namespace primitive
 * actually reserves it under the advisory lock.
 */
export const FLAT_TOKEN_RE = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;

/** Reusable flat-token validator (exported for the namespace primitive + tests). */
export function isFlatToken(value: unknown): value is string {
  return typeof value === "string" && FLAT_TOKEN_RE.test(value);
}

const flatToken = z
  .string()
  .min(1)
  .refine((v) => FLAT_TOKEN_RE.test(v), {
    message: "must be an already-normalized flat token (lowercase a-z0-9 with single _/- separators, no leading/trailing separator)",
  });

// `.strict()` at EVERY level — unknown keys hard-fail (fail-closed contract).
const modelPrefsBlockSchema = z
  .object({
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    temperature: z.number().min(0).max(2).optional(),
  })
  .strict();

const mcpBlockSchema = z
  .object({
    enabled: z.boolean().optional(),
    restriction: z.enum(["org-members", "platform-admins"]).optional(),
  })
  .strict();

const launchBlockSchema = z
  .object({
    kind: z.enum(ASSISTANT_LAUNCH_KINDS),
    targetProvider: z.string().min(1).optional(),
  })
  .strict();

const deliveryBlockSchema = z
  .object({
    kind: z.enum(ASSISTANT_DELIVERY_KINDS),
  })
  .strict();

const assistantBlockSchema = z
  .object({
    abiVersion: z.literal(ASSISTANT_DECLARATION_ABI_VERSION),
    displayName: z.string().min(1),
    preferredTag: flatToken,
    persona: z.string().min(1),
    skillBundle: z.array(z.string().min(1)),
    allowedTools: z.array(z.string().min(1)).optional(),
    allowedAgents: z.array(z.string().min(1)).optional(),
    modelPrefs: modelPrefsBlockSchema.optional(),
    mcp: mcpBlockSchema.optional(),
    launch: launchBlockSchema,
    delivery: deliveryBlockSchema,
  })
  .strict();

/** The declared assistant block (post-validation, pre-projection). */
export type AssistantDeclarationBlock = z.infer<typeof assistantBlockSchema>;

// The FILE schema. `access` is accepted opaquely here (the connector parser in
// `access-config.ts` owns its validation); the top-level `.strict()` still
// rejects any UNKNOWN top-level key, which is the fail-closed guarantee for the
// assistant domain.
const declarationFileSchema = z
  .object({
    formatVersion: z.literal(ASSISTANT_DECLARATION_FORMAT_VERSION),
    access: z.unknown().optional(),
    assistant: assistantBlockSchema.optional(),
  })
  .strict();

/**
 * The resolved assistant declaration the host persists to
 * `installed_extension.assistant_declaration` (jsonb) at install and the
 * registry reads. `assistantConfig` is the PROJECTED, validated sidecar the
 * `agent_templates.assistant_config` column receives; `block` is the full
 * validated declaration (metadata the registry/routing layer needs:
 * displayName, preferredTag, launch, delivery).
 */
export type ResolvedAssistantDeclaration = {
  formatVersion: typeof ASSISTANT_DECLARATION_FORMAT_VERSION;
  block: AssistantDeclarationBlock;
  assistantConfig: AssistantConfig;
};

export class AssistantDeclarationError extends Error {
  constructor(message: string) {
    super(`[assistant-declaration] ${message}`);
    this.name = "AssistantDeclarationError";
  }
}

/**
 * Project a validated assistant block into the `assistant_config` sidecar shape
 * and VALIDATE the projection with `assistantConfigSchema` (the app store's
 * write validator). An unprojectable declaration throws — fail-closed. Pure.
 */
export function projectAssistantDeclaration(block: AssistantDeclarationBlock): AssistantConfig {
  const projected: Record<string, unknown> = {
    persona: block.persona,
    skillBundle: block.skillBundle,
    allowedTools: block.allowedTools ?? [],
    allowedAgents: block.allowedAgents ?? [],
    modelPrefs: block.modelPrefs ?? {},
  };
  if (block.mcp) projected.mcp = block.mcp;
  const parsed = assistantConfigSchema.safeParse(projected);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("; ");
    throw new AssistantDeclarationError(`assistant block does not project to a valid assistant_config: ${detail}`);
  }
  return parsed.data;
}

export type ParseAssistantDeclarationResult =
  | { ok: true; declaration: ResolvedAssistantDeclaration | null }
  | { ok: false; error: string };

/**
 * Validate a parsed `cinatra/config.json` value (the caller owns file IO) and
 * resolve the assistant declaration. Fail-LOUD via {@link parseAssistantDeclaration};
 * this is the discriminated-result form so a scan/gate can surface a field-level
 * message without a throw.
 *
 * A file that validates with NO `assistant` block resolves `{ ok:true,
 * declaration:null }` — the package simply declares no assistant. A present but
 * malformed `assistant` block (or an unprojectable one) is `{ ok:false }`.
 */
export function safeParseAssistantDeclaration(
  raw: unknown,
  opts: { packageName: string },
): ParseAssistantDeclarationResult {
  const parsed = declarationFileSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: `invalid cinatra/config.json for ${opts.packageName}: ${detail}` };
  }
  const block = parsed.data.assistant;
  if (!block) return { ok: true, declaration: null };
  try {
    const assistantConfig = projectAssistantDeclaration(block);
    return {
      ok: true,
      declaration: {
        formatVersion: ASSISTANT_DECLARATION_FORMAT_VERSION,
        block,
        assistantConfig,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Throwing form: validate + resolve, or throw {@link AssistantDeclarationError}.
 * Returns `null` when the file carries no `assistant` block. This is the shared
 * entry the install seams + store reader use (fail-closed).
 */
export function parseAssistantDeclaration(
  raw: unknown,
  opts: { packageName: string },
): ResolvedAssistantDeclaration | null {
  const result = safeParseAssistantDeclaration(raw, opts);
  if (!result.ok) throw new AssistantDeclarationError(result.error);
  return result.declaration;
}

/** Does this parsed config.json declare an assistant? Cheap presence check for
 *  the XOR gate (declaration ⊕ compilable OAS) — does NOT validate the block. */
export function hasAssistantBlock(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "assistant" in raw &&
    (raw as { assistant?: unknown }).assistant !== undefined &&
    (raw as { assistant?: unknown }).assistant !== null
  );
}
