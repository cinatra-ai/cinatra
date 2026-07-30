import "server-only";

/**
 * Single source of truth for LLM provider / model / capability rules referenced
 * by the OAS validator, OAS compiler, and the `/api/llm-bridge` route.
 *
 * Imported by:
 *   - packages/agents/src/validate-agent-json.ts  — rejects mismatches in
 *     `metadata.cinatra.llm`.
 *   - packages/agents/src/oas-compiler.ts          — wires the same Zod schema
 *     into the canonical Flow metadata.cinatra block.
 *   - src/app/api/llm-bridge/route.ts              — selects the provider/model
 *     when fulfilling a bridge call.
 *
 * Do NOT import from `@cinatra-ai/llm` here — the orchestration
 * package depends on `@cinatra-ai/agents`, so the reverse direction would create
 * a circular dependency (cf. agents → orchestration is forbidden per the
 * package layering rule).
 */
import { z } from "zod";

// ===========================================================================
// llm-providers S1 (#1712, epic #1711) — the versioned LLM-provider
// *declaration* model.
//
// The capability matrix and model catalogs stop being an imperative core switch
// and become *declared* data. Each LLM connector (openai / anthropic / gemini)
// will eventually ship its own `cinatra.llmProvider` manifest block conforming
// to `LlmProviderDeclarationSchema`; core keeps only the vocabulary, the
// declaration schema, two projections (a pure BUILD-KNOWN catalog for
// OAS/authoring validation + a fail-closed LIVE resolver for dispatch/preflight
// wired in a later slice), and enforcement.
//
// This declaration model lives HERE in `llm-provider-policy.ts` — already the
// pure, dependency-light, server-only policy leaf (it MUST NOT import
// `@cinatra-ai/llm` or any connector package: that would invert the
// orchestration → agents layering). Keeping it in this one module (rather than a
// second file) keeps it out of the `/sign-in` route's reachable first-party
// graph budget; the later slice that GENERATES the catalog from the three
// connector manifest blocks will split it into its own generated leaf and carry
// the route-graph ratchet absorb for that +1 at that time.
//
// SCOPE (S1a — this slice): the declaration surface + the core resolver, with
// the build-known catalog reproducing the current matrix bit-for-bit
// (behavior-identical, proven by regression tests). The cross-repo train
// (connector manifest blocks + conformance-gate branch + releases; the
// sdk-extensions leaf schema; the four imperative provider-id gates becoming
// live-resolver queries; the Anthropic native-fallback hardening; the
// provider-id lint) rides later S1 slices per the issue's ordered steps.
// ===========================================================================

// ---------------------------------------------------------------------------
// Provider + capability vocabulary — the closed sets the platform supports.
// Every existing `import { LLM_PROVIDERS, LlmProvider, ... } from
// "./llm-provider-policy"` (and the `@cinatra-ai/agents/llm-provider-policy`
// public subpath) is unchanged. Anything outside these enums is rejected at
// validate-time by the OAS LLM-provider validator with a stable finding code.
// ---------------------------------------------------------------------------
export const LLM_PROVIDERS = ["openai", "anthropic", "gemini"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const LLM_CAPABILITIES = ["media_input", "function_tools", "native_mcp"] as const;
export type LlmCapability = (typeof LLM_CAPABILITIES)[number];

// ---------------------------------------------------------------------------
// ABI version of the `cinatra.llmProvider` manifest block. A connector
// declaring a different major is rejected at the publish/conformance gate
// (that branch is DERIVED from this schema in a later slice). Bump only on a
// breaking change to the declaration shape.
// ---------------------------------------------------------------------------
export const LLM_PROVIDER_ABI_VERSION = 2 as const;

// ---------------------------------------------------------------------------
// ABI v2 — the setup-time provider-choice flags (cinatra#2093, epic #2086 S6).
//
// `defaultCapable` / `wizardEligible` turn "which providers may be the global
// default" from an imperative core secret (four hardcoded `["openai","gemini"]`
// fences that barred Anthropic architecturally) into DECLARED data every fence
// derives from. `wizardEligible` is a strict subset of `defaultCapable` — the
// wizard's only act is committing the stored default.
//
// RE-DECLARED, not imported, from the sdk leaf's
// `BUILD_KNOWN_LLM_PROVIDER_FLAGS` — the same single-authority discipline the
// rest of this model follows (the leaf is a TRUE leaf; this host model
// re-states the shape and `llm-provider-leaf-mirror.test.ts` proves the two
// never drift, now including the flag matrix itself).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// native_mcp status vocabulary. A three-value status so a connector can ship
// the translator code ahead of flipping the declaration (the dormant-Gemini
// ordering the epic requires):
//   - "native"      → the provider satisfies native_mcp today.
//   - "unsupported" → the provider cannot satisfy native_mcp (fail-closed;
//                     function-tool emulation does NOT qualify — the MCP
//                     Injection Rule).
//   - "dormant"     → translator present but the declaration has not been
//                     flipped on; effective capability is provably false until
//                     a later connector release sets "native". Treated exactly
//                     like "unsupported" by every resolver in this slice.
// ---------------------------------------------------------------------------
export const NATIVE_MCP_STATUSES = ["native", "unsupported", "dormant"] as const;
export type NativeMcpStatus = (typeof NATIVE_MCP_STATUSES)[number];

// Approval vocabulary a connector's native-MCP surface declares it can honour.
// Consumed by S2's contract hardening; carried here so the declaration shape is
// stable from S1. "unsupported" ⇒ the connector cannot honour an
// approval_required toolbox (S2 refuses it fail-closed).
export const MCP_APPROVAL_MODES = ["auto_execute", "approval_required", "unsupported"] as const;
export type McpApprovalMode = (typeof MCP_APPROVAL_MODES)[number];

// ---------------------------------------------------------------------------
// The declaration schema — the shape every LLM connector's
// `cinatra.llmProvider` manifest block conforms to. `.strict()` so an unknown
// key fails closed at parse time.
// ---------------------------------------------------------------------------
export const LlmProviderNativeMcpSchema = z
  .object({
    status: z.enum(NATIVE_MCP_STATUSES),
    // Transport metadata (S2 persists+enforces it). Optional in S1; when
    // absent the injection layer treats it as `unknown` and refuses unsupported
    // transports fail-closed in S2.
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
    // --- ABI v2 (cinatra#2093, epic #2086 S6) ------------------------------
    /** May this provider be the resolved GLOBAL default (`llm_default_provider`)? */
    defaultCapable: z.boolean(),
    /** May the SETUP WIZARD offer it as the owner's first-run choice? */
    wizardEligible: z.boolean(),
  })
  .strict()
  // Wizard eligibility is a strict SUBSET of default capability (mirror of the
  // leaf's refine): the wizard's only act is committing the stored default, so
  // offering a provider that could never BE the default is incoherent.
  .refine((d) => !d.wizardEligible || d.defaultCapable, {
    message: "wizardEligible requires defaultCapable (wizard eligibility is a subset of default capability)",
    path: ["wizardEligible"],
  });

export type LlmProviderNativeMcp = z.infer<typeof LlmProviderNativeMcpSchema>;
export type LlmProviderCapabilities = z.infer<typeof LlmProviderCapabilitiesSchema>;
export type LlmProviderModels = z.infer<typeof LlmProviderModelsSchema>;
export type LlmProviderDeclaration = z.infer<typeof LlmProviderDeclarationSchema>;

// ---------------------------------------------------------------------------
// Projection 1 — the pure BUILD-KNOWN declaration catalog.
//
// This reproduces the pre-S1 hardcoded matrix EXACTLY (media_input → gemini
// only; function_tools → all three; native_mcp → openai|anthropic; the
// per-provider ALLOWED_MODEL_IDS with their defaults). It is the compile-time
// truth used by OAS/authoring validation. Later slices REPLACE this literal
// with a catalog GENERATED from the three connector manifest blocks; the shape
// and the derivations below are unchanged by that swap.
//
// Do NOT edit these values to change behavior in S1 — S1 is behavior-identical
// by contract, proven by `llm-provider-declaration.test.ts`. Catalog changes
// (e.g. the Gemini 3.5-only train) ride S3 via the connector manifests.
//
// The catalog is DEEP-frozen (not just `Object.freeze`d at the top level): the
// declared capability truth — including nested `capabilities.native_mcp.status`
// and the `models.allowed` arrays — is the thing core owns, so a typed consumer
// must not be able to mutate it after init (e.g. flip Gemini `native_mcp` on).
// ---------------------------------------------------------------------------
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

export const BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS: Readonly<
  Record<LlmProvider, LlmProviderDeclaration>
> = deepFreeze({
  openai: {
    abiVersion: LLM_PROVIDER_ABI_VERSION,
    provider: "openai",
    // S6 flag matrix (cinatra#2093): OpenAI is default-capable AND offered by
    // the first-run wizard.
    defaultCapable: true,
    wizardEligible: true,
    capabilities: {
      function_tools: true,
      media_input: false,
      native_mcp: { status: "native", approval: "approval_required" },
    },
    models: {
      default: "gpt-5.5",
      allowed: [
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-5",
        "gpt-5-mini",
        "gpt-4.1",
        "gpt-4.1-mini",
        "gpt-4o",
        "gpt-4o-mini",
      ],
    },
  },
  anthropic: {
    abiVersion: LLM_PROVIDER_ABI_VERSION,
    provider: "anthropic",
    // S6 UN-FENCING (cinatra#2093): Anthropic becomes default-capable and
    // wizard-eligible. Before S6 it was barred from the global default in four
    // hardcoded places; those now derive from THIS flag.
    defaultCapable: true,
    wizardEligible: true,
    capabilities: {
      function_tools: true,
      media_input: false,
      // Anthropic honours native MCP but carries no approval knob on either
      // its mcp_servers serialization or its function-tools bridge → declares
      // approval "unsupported"; the adapter REFUSES an approval_required
      // toolbox fail-closed (S2 #1713 AC2, McpApprovalUnsupportedError).
      native_mcp: { status: "native", approval: "unsupported" },
    },
    models: {
      default: "claude-sonnet-4-6",
      allowed: [
        "claude-sonnet-4-6",
        "claude-opus-4-7",
        "claude-3-7-sonnet-latest",
        "claude-3-5-haiku-latest",
      ],
    },
  },
  gemini: {
    abiVersion: LLM_PROVIDER_ABI_VERSION,
    provider: "gemini",
    // S6 flag matrix (cinatra#2093): a perfectly valid GLOBAL default, but
    // admin-configured after setup rather than offered in the first-run wizard.
    defaultCapable: true,
    wizardEligible: false,
    capabilities: {
      function_tools: true,
      media_input: true,
      // Gemini has no production native MCP (the general Gemini 3 endpoints
      // are "coming soon"); function-tool emulation does NOT qualify.
      // fail-closed.
      native_mcp: { status: "unsupported" },
    },
    models: {
      default: "gemini-2.5-flash",
      allowed: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite", "gemini-1.5-pro"],
    },
  },
});

/**
 * Does `declaration` (as-declared, ignoring live activation) satisfy
 * `capability`? Fail-closed on native_mcp: only status "native" qualifies —
 * "dormant" and "unsupported" both return false.
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

// ---------------------------------------------------------------------------
// v2 flag projections (cinatra#2093, epic #2086 S6) — the host-side mirror of
// the leaf's `providersWithDefaultCapable` / `providersWithWizardEligible`.
//
// These answer the two setup-time questions off the DECLARATION catalog rather
// than off a re-listed provider-id set:
//   defaultCapableProviders() — who may be stored in `llm_default_provider`
//   wizardEligibleProviders() — who `/setup/ai` may offer as the first-run pick
//
// The RUNTIME un-fencing chokepoints (`src/lib/database.ts`'s eligibility
// predicate and `packages/llm`'s two implicit-global resolvers) deliberately
// read the SDK LEAF's projection instead of these — `@cinatra-ai/agents`
// depends on `@cinatra-ai/llm`, so those layers cannot import this module. The
// drift-guard mirror test pins the two projections equal, so there is one
// effective authority with two layering-legal entry points.
// ---------------------------------------------------------------------------

/** Providers whose declaration permits them to be the resolved GLOBAL default. */
export function defaultCapableProviders(): LlmProvider[] {
  return LLM_PROVIDERS.filter(
    (p) => BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS[p].defaultCapable === true,
  );
}

/**
 * Providers the setup wizard may OFFER. Re-asserts the subset invariant at read
 * time so a hand-built declaration that bypassed schema validation still cannot
 * be wizard-eligible without being default-capable.
 */
export function wizardEligibleProviders(): LlmProvider[] {
  return LLM_PROVIDERS.filter(
    (p) =>
      BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS[p].wizardEligible === true &&
      BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS[p].defaultCapable === true,
  );
}

// ---------------------------------------------------------------------------
// Projection 2 — the fail-closed LIVE resolver.
//
// The build-known catalog answers "what could this provider do if built and
// active?"; the live resolver answers "what can this provider ACTUALLY do in
// THIS running host right now?" = declaration ∩ activated
// `llm-provider-surface` ∩ adapter runtime-gate readiness. Any absent factor
// ⇒ false. It is a PURE function of its inputs; the host supplies the two live
// factors (surface activation + adapter readiness) — S1a exposes the seam and
// later slices inject the real host lookups into dispatch/preflight.
// ---------------------------------------------------------------------------
export interface EffectiveCapabilityFactors {
  /** The provider's build-known (or later generated) declaration, if any. */
  declaration: LlmProviderDeclaration | undefined;
  /** Is the provider's `llm-provider-surface` activated in this host? */
  surfaceActivated: boolean;
  /** Is the provider adapter's runtime gate ready (SDK present, keys, etc.)? */
  adapterReady: boolean;
}

/**
 * Effective (live) answer to "can this provider satisfy `capability` RIGHT
 * NOW?". Fail-closed: a missing declaration, an inactive surface, or an
 * unready adapter each independently forces `false`.
 */
export function resolveEffectiveProviderCapability(
  factors: EffectiveCapabilityFactors,
  capability: LlmCapability,
): boolean {
  if (!factors.declaration) return false;
  if (!factors.surfaceActivated) return false;
  if (!factors.adapterReady) return false;
  return declarationSatisfiesCapability(factors.declaration, capability);
}

// ---------------------------------------------------------------------------
// Capability matrix — DERIVED from the build-known declaration catalog
// (`BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS` above), which is the declared single
// source of truth for "which provider(s) can satisfy which capability"
// (llm-providers S1, #1712). Previously this was an imperative provider-id
// switch inline here; it now reads the declared catalog so the old switch and
// the new declared data cannot drift, and so a later slice can swap the
// build-known catalog for one GENERATED from the three connector manifest
// blocks with zero change to this function.
//
// This is a BUILD-KNOWN projection (what a provider *could* do if built and
// active) — the OAS/authoring validation surface. The LIVE, fail-closed answer
// (declaration ∩ activated surface ∩ adapter readiness) is
// `resolveEffectiveProviderCapability` above, wired into dispatch/preflight by a
// later slice.
//
//   - media_input    → gemini only (the only adapter with a media ingestion
//                       path; see packages/llm/src/providers/gemini.ts).
//   - function_tools  → broad: every adapter has a non-null tools translator
//                       (Gemini emits FunctionDeclaration[] via translateTools()).
//   - native_mcp      → openai | anthropic. Provider-native MCP server tool;
//                       Gemini is excluded per the MCP Injection Rule
//                       (function-tool emulation does NOT qualify).
// ---------------------------------------------------------------------------

export function canProviderSatisfyCapability(
  provider: LlmProvider,
  capability: LlmCapability,
): boolean {
  const declaration = BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS[provider];
  // Defense-in-depth: an unknown provider has no declaration → fail closed.
  if (!declaration) return false;
  return declarationSatisfiesCapability(declaration, capability);
}

/**
 * All providers that can satisfy `capability`, in `LLM_PROVIDERS` order.
 * The inverse view of `canProviderSatisfyCapability`, used by the run-time
 * preflight and the bridge's actionable error to enumerate the connectors a
 * user could install/configure to unblock a capability.
 */
export function providersForCapability(capability: LlmCapability): LlmProvider[] {
  return LLM_PROVIDERS.filter((p) => canProviderSatisfyCapability(p, capability));
}

// ---------------------------------------------------------------------------
// Build a human-readable, actionable sentence naming the capability and the
// PROVIDER(s) that can satisfy it. Deliberately names the generic provider id
// (a member of the LLM_PROVIDERS capability vocabulary), NOT a specific
// connector package — core must not hardcode an extension-instance name
// (true-IoC: capabilities come from the manifest/registry, enforced by the
// core→extension instance-coupling gate; pinning a connector package here
// would both fail that gate and re-introduce the topology coupling this issue
// is removing). Shared by the bridge 503 message and any future run-time
// preflight so the wording cannot drift between surfaces.
//
// Two phrasings, matching the two ways a capability goes unsatisfied:
//   - `incompatibleProvider` set (the preferred provider IS available but
//     cannot satisfy the capability) → name the mismatch and the alternatives.
//   - otherwise (no installed+configured provider satisfies the capability)
//     → tell the user to install/configure a connector for one of the
//       satisfying providers.
//
// Example:
//   describeCapabilityRequirement("media_input")
//   → 'This agent requires the "media_input" LLM capability, but no installed
//      and configured LLM provider supports it. Install and configure an LLM
//      connector for one of these providers: gemini.'
// ---------------------------------------------------------------------------

export function describeCapabilityRequirement(
  capability: LlmCapability,
  opts?: { incompatibleProvider?: LlmProvider },
): string {
  const providers = providersForCapability(capability);
  const options = providers.join(", ");
  if (opts?.incompatibleProvider) {
    return (
      `This agent requires the "${capability}" LLM capability, but the active ` +
      `provider "${opts.incompatibleProvider}" cannot satisfy it. Install and ` +
      `configure an LLM connector for one of these providers instead: ${options}.`
    );
  }
  return (
    `This agent requires the "${capability}" LLM capability, but no installed ` +
    `and configured LLM provider supports it. Install and configure an LLM ` +
    `connector for one of these providers: ${options}.`
  );
}

// ---------------------------------------------------------------------------
// Per-provider model allowlist. The first entry in each list is the adapter
// default (see provider files referenced in the JSDoc below). Every id here
// MUST be routable by the matching provider's adapter.generate path — do not
// add ids speculatively; they will surface at compile time only.
//
// Defaults pulled from each provider adapter file:
//   packages/llm/src/providers/openai.ts (DEFAULT_MODEL)  → "gpt-5.5"
//     (kept in lock-step with DEFAULT_OPENAI_MODEL_ID below; the adapter
//      duplicates the literal because @cinatra-ai/llm cannot import this
//      package without a circular dependency).
//   packages/llm/src/providers/anthropic.ts (DEFAULT_MODEL) → "claude-sonnet-4-6"
//   packages/llm/src/providers/gemini.ts (DEFAULT_MODEL)    → "gemini-2.5-flash"
// ---------------------------------------------------------------------------

// DERIVED from the declaration catalog's `models.allowed` per provider (S1,
// #1712). Every id here MUST be routable by the matching adapter.generate
// path; the catalog is the single place a model id is added/removed (the
// Gemini 3.5-only train rides S3 via the connector manifest, not an edit here).
// An explicit per-provider literal (not `Object.fromEntries` + cast): keeps the
// record fully typed with no assertion, and the catalog is already deep-frozen
// so these `allowed` arrays are immutable at their source.
export const ALLOWED_MODEL_IDS: Record<LlmProvider, readonly string[]> = Object.freeze({
  openai: BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS.openai.models.allowed,
  anthropic: BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS.anthropic.models.allowed,
  gemini: BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS.gemini.models.allowed,
});

// ---------------------------------------------------------------------------
// Default OpenAI model for a connection without a saved `defaultModel`. Shared
// by every default source — the /setup/ai and /configuration/llm default-model
// pickers plus src/lib/openai-connection-store.ts — so the fallbacks cannot
// drift apart. A saved, still-selectable `connection.defaultModel` always wins
// over this fallback. DERIVED from the openai declaration's `models.default`
// (guaranteed a member of ALLOWED_MODEL_IDS.openai by the schema refinement).
// ---------------------------------------------------------------------------

export const DEFAULT_OPENAI_MODEL_ID = BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS.openai.models.default;

// ---------------------------------------------------------------------------
// Reusable Zod schema for the optional `metadata.cinatra.llm` block. The same
// schema is shared by validate-agent-json.ts and the canonical Flow
// `metadataSchema` so the two layers cannot drift.
//
// The schema itself only enforces shape (unknown provider / unknown
// capability / `.strict()` unknown-key rejection). Cross-field rules
// (preferredModel ∈ ALLOWED_MODEL_IDS[preferredProvider], media_input only on
// gemini) are enforced by the validator post-parse using ALLOWED_MODEL_IDS
// directly.
// ---------------------------------------------------------------------------

export const OasCinatraLlmSchema = z
  .object({
    preferredProvider: z.enum(LLM_PROVIDERS).optional(),
    preferredModel: z.string().min(1).optional(),
    capabilityRequired: z.enum(LLM_CAPABILITIES).optional(),
  })
  .strict()
  .optional();

export type OasCinatraLlm = z.infer<typeof OasCinatraLlmSchema>;
