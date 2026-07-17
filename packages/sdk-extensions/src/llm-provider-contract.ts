// Shared LLM-PROVIDER declaration contract — `cinatra.llmProvider` v1
// (cinatra#1712, epic #1711 "LLM provider capabilities become
// extension-contributed", S1 AC1).
//
// This is the CANONICAL v1 LEAF schema for the versioned top-level
// `cinatra.llmProvider` manifest field: the declaration surface by which each
// LLM connector (openai / anthropic / gemini) ships its OWN capability matrix
// (function_tools / media_input / native_mcp) + model catalog, so core stops
// hardcoding the matrix and keeps only the vocabulary, resolvers, and
// enforcement.
//
// EXACT PUBLIC MIRROR OF THE HOST MODEL. The host-side declaration model lives
// in `@cinatra-ai/agents`'s `packages/agents/src/llm-provider-policy.ts`
// (`LlmProviderDeclarationSchema` + `LLM_PROVIDER_ABI_VERSION` + the
// `NATIVE_MCP_STATUSES` / `MCP_APPROVAL_MODES` / `LLM_PROVIDERS` /
// `LLM_CAPABILITIES` vocabulary + the `BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS`
// catalog). This file is that model's PUBLIC, host-neutral projection — the
// same S1/#1621 discipline `artifact-contract.ts` and the S11a
// `dashboard-contribution-contract.ts` use: it lives in
// `@cinatra-ai/sdk-extensions` (a TRUE LEAF — it imports nothing but `zod` and
// NEVER imports `@cinatra-ai/agents`, which would invert the orchestration →
// agents layering) so a connector extension types its `cinatra.llmProvider`
// claim against the SDK alone. It re-declares the SAME shape rather than
// importing the host module; a drift-guard coupling test in `@cinatra-ai/agents`
// (which MAY depend on this leaf) asserts the two stay byte-for-byte equivalent
// (same ABI version, same vocabularies, same accept/reject verdict on a battery
// of inputs). The host-side projections (the build-known catalog, the two
// resolvers, enforcement) stay in the agents policy leaf; THIS file owns only
// the DECLARATION shape the connector authors + the publish/conformance gate
// share.
//
// WHY THE LEAF (the single-authority rule): both the extension-repo publish
// CONFORMANCE gate (`scripts/extensions/conformance-gate.mjs`, its
// `checkLlmProvider` branch) and any authoring/host reader import the ONE shared
// source so no two of them drift. `cinatra.llmProvider` is a TOP-LEVEL manifest
// field carried on `kind:"connector"` LLM connectors; the gate DERIVES
// {@link LLM_PROVIDER_ABI_VERSION} and the enum vocabularies from THIS source
// text (never a re-listed copy — the #979 conformance-rules addendum
// principle), so the leaf stays the single authority. The gate hand-mirrors the
// object grammar / cross-field rules as plain JS (it runs on bare `node`, no TS
// toolchain); this schema stays the runtime authority.
//
// FIELD-TOLERANT PARSE (the two-mode discipline). Like `parseArtifactUi` /
// `parseChatViews` / `parseDashboardContribution`, the block is carried as RAW
// `unknown` so a malformed `cinatra.llmProvider` can NEVER reject the
// surrounding connector manifest and drop the connector's other claims:
//  - host / runtime: `{ ok: false }` ⇒ the caller DROPS the provider
//    declaration (the provider falls back to core's build-known catalog /
//    fail-closed resolution) and surfaces `diagnostic` — degrade, never reject
//    the whole extension.
//  - publish / conformance gate: the SAME `{ ok: false }` is rejected
//    FAIL-CLOSED (see {@link validateLlmProviderForPublish}).

import { z } from "zod";

// ===========================================================================
// Versioning + vocabulary. MIRRORS the host policy leaf's exports of the same
// names. Read AS DATA LITERALS by the conformance gate's rule derivation
// (`scripts/extensions/lib/conformance-rules.mjs`) — never a re-listed copy.
// ===========================================================================

/**
 * The `cinatra.llmProvider` block ABI version (distinct from the SDK ABI). v1
 * is the only shape this schema accepts; a future v2 is an additive, versioned
 * migration. A connector declaring a different value is rejected at the
 * publish/conformance gate. Read AS A LITERAL by the gate's rule derivation
 * (`loadLiveRules` → `extractNumberConst`) — never a re-listed copy (#979
 * addendum principle). Byte-mirror of `LLM_PROVIDER_ABI_VERSION` in the host
 * `llm-provider-policy.ts`.
 */
export const LLM_PROVIDER_ABI_VERSION = 1 as const;

/**
 * The closed provider vocabulary — the `provider` discriminator a connector's
 * `cinatra.llmProvider` block binds to. Byte-mirror of `LLM_PROVIDERS` in the
 * host policy leaf. Derived as a data array by the conformance gate.
 */
export const LLM_PROVIDERS = ["openai", "anthropic", "gemini"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/**
 * The closed capability vocabulary — the exact KEY set of the `capabilities`
 * object. Byte-mirror of `LLM_CAPABILITIES` in the host policy leaf. Derived as
 * a data array by the conformance gate (the required capability keys).
 */
export const LLM_CAPABILITIES = ["media_input", "function_tools", "native_mcp"] as const;
export type LlmCapability = (typeof LLM_CAPABILITIES)[number];

/**
 * native_mcp status vocabulary. Three values so a connector can ship the
 * translator code ahead of flipping the declaration (the dormant-Gemini
 * ordering the epic requires):
 *   - "native"      → the provider satisfies native_mcp today.
 *   - "unsupported" → the provider cannot satisfy native_mcp (fail-closed;
 *                     function-tool emulation does NOT qualify — the MCP
 *                     Injection Rule).
 *   - "dormant"     → translator present but the declaration is not flipped on;
 *                     effective capability is provably false until a later
 *                     connector release sets "native".
 * Byte-mirror of `NATIVE_MCP_STATUSES` in the host policy leaf.
 */
export const NATIVE_MCP_STATUSES = ["native", "unsupported", "dormant"] as const;
export type NativeMcpStatus = (typeof NATIVE_MCP_STATUSES)[number];

/**
 * Approval vocabulary a connector's native-MCP surface declares it can honour
 * ("unsupported" ⇒ the connector cannot honour an approval_required toolbox;
 * S2 refuses it fail-closed). Byte-mirror of `MCP_APPROVAL_MODES` in the host
 * policy leaf.
 */
export const MCP_APPROVAL_MODES = ["auto_execute", "approval_required", "unsupported"] as const;
export type McpApprovalMode = (typeof MCP_APPROVAL_MODES)[number];

// ===========================================================================
// The declaration schema — the EXACT shape every LLM connector's
// `cinatra.llmProvider` manifest block conforms to. `.strict()` everywhere so
// an unknown key fails closed at parse time. Byte-mirror of the host policy
// leaf's `LlmProvider*Schema` family.
// ===========================================================================

export const LlmProviderNativeMcpSchema = z
  .object({
    status: z.enum(NATIVE_MCP_STATUSES),
    // Transport metadata (S2 persists + enforces it). Optional in S1; when
    // absent the injection layer treats it as `unknown` and refuses
    // unsupported transports fail-closed in S2.
    transports: z.array(z.string().min(1)).nonempty().optional(),
    approval: z.enum(MCP_APPROVAL_MODES).optional(),
  })
  .strict();

export const LlmProviderCapabilitiesSchema = z
  .object({
    function_tools: z.boolean(),
    media_input: z.boolean(),
    native_mcp: LlmProviderNativeMcpSchema,
  })
  .strict();

export const LlmProviderModelsSchema = z
  .object({
    default: z.string().min(1),
    allowed: z.array(z.string().min(1)).nonempty(),
  })
  .strict()
  // The default MUST be a member of the allowlist — otherwise the connector's
  // own fallback would route a model it does not declare as routable.
  .refine((m) => m.allowed.includes(m.default), {
    message: "models.default must be a member of models.allowed",
    path: ["default"],
  });

export const LlmProviderDeclarationSchema = z
  .object({
    abiVersion: z.literal(LLM_PROVIDER_ABI_VERSION),
    provider: z.enum(LLM_PROVIDERS),
    capabilities: LlmProviderCapabilitiesSchema,
    models: LlmProviderModelsSchema,
  })
  .strict();

export type LlmProviderNativeMcp = z.infer<typeof LlmProviderNativeMcpSchema>;
export type LlmProviderCapabilities = z.infer<typeof LlmProviderCapabilitiesSchema>;
export type LlmProviderModels = z.infer<typeof LlmProviderModelsSchema>;
export type LlmProviderDeclaration = z.infer<typeof LlmProviderDeclarationSchema>;

// ===========================================================================
// Tolerant parse + fail-closed publish wrapper (the two-mode discipline).
// ===========================================================================

export type LlmProviderParseResult =
  | { ok: true; declaration: LlmProviderDeclaration }
  | { ok: false; diagnostic: string };

/**
 * SANITIZE a zod validation failure into a single-line diagnostic that echoes
 * only the failing PATH + zod issue CODE — never a received value — so a
 * hostile manifest can't smuggle content into host logs / the boot diagnostic
 * (the same discipline as the S1 `parseArtifactUi` / S9-a `parseChatViews`
 * sanitizers).
 */
function sanitizeLlmProviderDiagnostic(error: z.ZodError): string {
  const parts = error.issues.slice(0, 6).map((issue) => {
    const at = issue.path.length ? issue.path.join(".") : "<root>";
    return `${at} (${issue.code})`;
  });
  const suffix = error.issues.length > 6 ? "; …" : "";
  return `cinatra.llmProvider is invalid: ${parts.join("; ")}${suffix}`;
}

/**
 * TOLERANT validator for the `cinatra.llmProvider` block (the S1 `parseArtifactUi`
 * discipline). NEVER throws and NEVER implies the surrounding manifest is
 * invalid:
 *  - host / runtime: on `{ ok: false }` the caller DROPS the provider
 *    declaration (falls back to core's build-known catalog / fail-closed
 *    resolution) and surfaces `diagnostic` — degrade, never reject the whole
 *    extension.
 *  - publish / conformance gate: the SAME `{ ok: false }` is rejected
 *    fail-closed (see {@link validateLlmProviderForPublish}).
 */
export function parseLlmProvider(input: unknown): LlmProviderParseResult {
  const parsed = LlmProviderDeclarationSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, diagnostic: sanitizeLlmProviderDiagnostic(parsed.error) };
  }
  return { ok: true, declaration: parsed.data };
}

/**
 * PUBLISH/authoring verdict wrapper: the authoring/publish path is FAIL-CLOSED
 * on the `cinatra.llmProvider` block (unlike the host path, which DEGRADES an
 * unsupported block to core's fallback). Any diagnostic from
 * {@link parseLlmProvider} becomes a validation error here.
 */
export function validateLlmProviderForPublish(input: unknown): { valid: boolean; errors: string[] } {
  const r = parseLlmProvider(input);
  return r.ok ? { valid: true, errors: [] } : { valid: false, errors: [r.diagnostic] };
}

/**
 * Does `declaration` (as-declared, ignoring live activation) satisfy
 * `capability`? Fail-closed on native_mcp: only status "native" qualifies —
 * "dormant" and "unsupported" both return false. Byte-mirror of the host policy
 * leaf's `declarationSatisfiesCapability` — the pure, host-neutral projection an
 * authoring surface can share without importing `@cinatra-ai/agents`.
 */
export function declarationSatisfiesCapability(
  declaration: LlmProviderDeclaration,
  capability: LlmCapability,
): boolean {
  const caps = declaration.capabilities;
  switch (capability) {
    case "media_input":
      return caps.media_input === true;
    case "function_tools":
      return caps.function_tools === true;
    case "native_mcp":
      return caps.native_mcp.status === "native";
    default:
      // Defense-in-depth: any future enum member is unsatisfied until declared.
      return false;
  }
}
