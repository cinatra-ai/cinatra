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
 * The `cinatra.llmProvider` block ABI version (distinct from the SDK ABI). v2
 * (cinatra#2093, epic #2086 S6) is the CURRENT shape: v1 plus the two
 * setup-time provider-choice flags {@link LlmProviderDeclaration.defaultCapable}
 * and {@link LlmProviderDeclaration.wizardEligible}. A connector declaring a
 * different value is rejected at the publish/conformance gate. Read AS A
 * LITERAL by the gate's rule derivation (`loadLiveRules` →
 * `extractNumberConst`) — never a re-listed copy (#979 addendum principle).
 * Byte-mirror of `LLM_PROVIDER_ABI_VERSION` in the host `llm-provider-policy.ts`.
 */
export const LLM_PROVIDER_ABI_VERSION = 2 as const;

/**
 * The RETIRING v1 ABI version. Kept as a named literal (not an inline `1`) so
 * the transitional acceptance path below, the retirement ratchet, and the tests
 * that pin it all read the SAME authority — and so deleting the transitional
 * path is a single, greppable edit.
 *
 * The publish/conformance gate NEVER accepts it: a connector RELEASE must be
 * v2. Only the HOST's runtime parse accepts it, and only for a provider on
 * {@link LLM_PROVIDER_V1_RETIREMENT_ALLOWLIST}.
 */
export const LLM_PROVIDER_ABI_VERSION_V1_LEGACY = 1 as const;

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
// ABI v2 — the setup-time provider-choice flags (cinatra#2093, epic #2086 S6).
//
// Before S6, "which providers may be the GLOBAL default" was an imperative
// core secret spread across four fenced sites (the connector-config
// eligibility set, its write-refusal, and two implicit-global exclusion lists
// in the LLM registry/orchestrator), each hardcoding `["openai", "gemini"]` so
// Anthropic was architecturally barred from ever being the default. v2 makes
// that a DECLARED property of the provider, so the four sites all DERIVE from
// one authority instead of re-listing a set:
//
//   defaultCapable  — may this provider be the resolved GLOBAL default (the
//                     value stored in `llm_default_provider`)? Fail-closed:
//                     an undeclared/unknown provider is NOT default-capable.
//   wizardEligible  — may the SETUP WIZARD offer this provider as the owner's
//                     first-run choice? A strict SUBSET of defaultCapable
//                     (enforced by a cross-field refine): the wizard's only
//                     job is to commit the stored default, so offering a
//                     provider that can never BE the default is incoherent.
//                     Gemini declares `true/false` — a perfectly valid global
//                     default, but admin-configured after setup rather than
//                     offered in the first-run wizard.
//
// The optional `probeNativeSkills` member that S6 also adds is a RUNTIME
// surface member on `LlmProviderSurface` (host-connector-services-contract),
// NOT a manifest claim: whether a provider's EFFECTIVE, as-configured MCP mode
// accepts `container.skills` is a live property of the stored connection
// (an Anthropic key in `function-tools` mode rejects every `container.skills`
// request while declaring native_mcp "native"), and a manifest can only ever
// state an intent. The declaration says "I can be probed"; the surface does
// the probing.
// ===========================================================================

/**
 * The BUILD-KNOWN v2 flag matrix — the single authority for the two S6 flags,
 * consumed by every layer that cannot import the host policy leaf.
 *
 * WHY IT LIVES IN THE LEAF: `@cinatra-ai/agents` depends on `@cinatra-ai/llm`
 * (not the reverse), so `packages/llm`'s resolvers and `src/lib/database.ts`'s
 * eligibility chokepoint cannot read the host catalog
 * (`BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS`) without inverting the layering.
 * They read THIS table instead, and the host catalog COMPOSES its own
 * declarations from it (never re-listing the values) so the two can never
 * drift. The existing agents↔sdk drift-guard coupling test pins that.
 *
 * The matrix is the one ratified by cinatra#2093: OpenAI `true/true`,
 * Anthropic `true/true` (the un-fencing), Gemini `true/false`.
 */
export const BUILD_KNOWN_LLM_PROVIDER_FLAGS: Readonly<
  Record<LlmProvider, Readonly<{ defaultCapable: boolean; wizardEligible: boolean }>>
> = Object.freeze({
  openai: Object.freeze({ defaultCapable: true, wizardEligible: true }),
  anthropic: Object.freeze({ defaultCapable: true, wizardEligible: true }),
  gemini: Object.freeze({ defaultCapable: true, wizardEligible: false }),
});

/**
 * TRANSITIONAL v1-RETIREMENT RATCHET (cinatra#2093).
 *
 * The ONLY providers whose still-published v1 `cinatra.llmProvider` block the
 * HOST accepts at runtime. Every other provider's v1 block is DROPPED exactly
 * like a malformed one (degrade to the build-known catalog + a diagnostic), and
 * the publish/conformance gate refuses v1 unconditionally, so no NEW v1
 * declaration can ever enter the ecosystem.
 *
 * WHY IT EXISTS: the host pins connector source by SHA
 * (`cinatra-dev-extensions.lock.json` / `cinatra-required-extensions.lock.json`)
 * and those pins only advance AFTER the connector PRs merge — and the
 * production `packageVersion` pins only on the owner's release wave. Between
 * this change landing and that wave, the pinned Gemini connector still carries
 * its v1 block. Refusing it would strand the Gemini model catalog on the stale
 * build-known values for the whole window.
 *
 * RATCHET (enforced by `llm-provider-contract.test.ts`): the allowlist may only
 * ever SHRINK, every member must have an entry in
 * {@link BUILD_KNOWN_LLM_PROVIDER_FLAGS}, and the migration below must assign
 * EXACTLY those flags — so the shim can never invent a capability the real v2
 * declaration does not grant. When the wave lands and the pins carry v2, this
 * const goes to `[]` and the acceptance path below is deleted in one edit.
 */
export const LLM_PROVIDER_V1_RETIREMENT_ALLOWLIST = ["gemini"] as const;

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
    // --- ABI v2 (cinatra#2093, epic #2086 S6) ------------------------------
    /** May this provider be the resolved GLOBAL default (`llm_default_provider`)? */
    defaultCapable: z.boolean(),
    /** May the SETUP WIZARD offer it as the owner's first-run choice? */
    wizardEligible: z.boolean(),
  })
  .strict()
  // Cross-field rule: wizard eligibility is a strict SUBSET of default
  // capability. The wizard's ONLY act is committing the stored default, so a
  // wizard-eligible provider that could never BE the default would render a
  // choice the commit step must then refuse — an incoherent declaration, and
  // exactly the kind of drift a `.strict()` ABI exists to reject at the gate
  // rather than discover at setup time.
  .refine((d) => !d.wizardEligible || d.defaultCapable, {
    message: "wizardEligible requires defaultCapable (wizard eligibility is a subset of default capability)",
    path: ["wizardEligible"],
  });

/**
 * The RETIRING v1 declaration shape — v2 minus the two S6 flags. Kept ONLY to
 * drive the transitional host-side acceptance path
 * ({@link LLM_PROVIDER_V1_RETIREMENT_ALLOWLIST}); the publish/conformance gate
 * never consults it. Deleted with the allowlist.
 */
export const LlmProviderDeclarationV1LegacySchema = z
  .object({
    abiVersion: z.literal(LLM_PROVIDER_ABI_VERSION_V1_LEGACY),
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
  | {
      ok: true;
      declaration: LlmProviderDeclaration;
      /**
       * True when the input was an accepted LEGACY v1 block that this parse
       * MIGRATED to v2 by assigning the provider's
       * {@link BUILD_KNOWN_LLM_PROVIDER_FLAGS} entry. Callers that must not
       * silently normalise (the publish gate) branch on it; the host uses it
       * only for its boot diagnostic. Absent/false on a native v2 block.
       */
      migratedFromV1?: true;
    }
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
  if (parsed.success) return { ok: true, declaration: parsed.data };
  const migrated = migrateAllowlistedV1Declaration(input);
  if (migrated) return { ok: true, declaration: migrated, migratedFromV1: true };
  return { ok: false, diagnostic: sanitizeLlmProviderDiagnostic(parsed.error) };
}

/**
 * TRANSITIONAL (cinatra#2093): accept a still-pinned LEGACY v1 block from a
 * provider on {@link LLM_PROVIDER_V1_RETIREMENT_ALLOWLIST} and migrate it to v2
 * by assigning that provider's {@link BUILD_KNOWN_LLM_PROVIDER_FLAGS} entry —
 * NEVER by inventing flags from the v1 content, which carries no signal about
 * either. Returns `null` (⇒ the caller's normal fail path runs) for anything
 * else, so a v1 block from a NON-allowlisted provider is dropped exactly like a
 * malformed one and no new v1 declaration can ever be accepted.
 *
 * Deleted together with the allowlist once the release wave lands v2 pins.
 */
function migrateAllowlistedV1Declaration(input: unknown): LlmProviderDeclaration | null {
  const legacy = LlmProviderDeclarationV1LegacySchema.safeParse(input);
  if (!legacy.success) return null;
  const allowlisted = (LLM_PROVIDER_V1_RETIREMENT_ALLOWLIST as readonly string[]).includes(
    legacy.data.provider,
  );
  if (!allowlisted) return null;
  const flags = BUILD_KNOWN_LLM_PROVIDER_FLAGS[legacy.data.provider];
  // Defense-in-depth: an allowlist member with no flag entry is a ratchet
  // violation (the unit test pins it) — fail closed rather than guess.
  if (!flags) return null;
  // Re-parse through the v2 schema so the migrated value is subject to EXACTLY
  // the same validation (incl. the wizardEligible⇒defaultCapable refine) as a
  // natively-declared v2 block — the shim gets no privileged path.
  const promoted = LlmProviderDeclarationSchema.safeParse({
    ...legacy.data,
    abiVersion: LLM_PROVIDER_ABI_VERSION,
    defaultCapable: flags.defaultCapable,
    wizardEligible: flags.wizardEligible,
  });
  return promoted.success ? promoted.data : null;
}

/**
 * PUBLISH/authoring verdict wrapper: the authoring/publish path is FAIL-CLOSED
 * on the `cinatra.llmProvider` block (unlike the host path, which DEGRADES an
 * unsupported block to core's fallback). Any diagnostic from
 * {@link parseLlmProvider} becomes a validation error here.
 */
export function validateLlmProviderForPublish(input: unknown): { valid: boolean; errors: string[] } {
  // Deliberately NOT `parseLlmProvider`: the publish path must never accept the
  // transitional v1 migration. A RELEASE is exactly the moment a connector can
  // (and must) carry v2 — accepting v1 here would let the retiring shape
  // re-enter the ecosystem through the one door the ratchet exists to close.
  const parsed = LlmProviderDeclarationSchema.safeParse(input);
  if (parsed.success) return { valid: true, errors: [] };
  return { valid: false, errors: [sanitizeLlmProviderDiagnostic(parsed.error)] };
}

// ===========================================================================
// v2 flag projections (cinatra#2093, epic #2086 S6). PURE + host-neutral: the
// single derivation every un-fenced site calls instead of re-listing a set.
// ===========================================================================

/**
 * May `declaration`'s provider be the resolved GLOBAL default? The derivation
 * that REPLACES the four hardcoded `["openai", "gemini"]` fences.
 */
export function declarationIsDefaultCapable(declaration: LlmProviderDeclaration): boolean {
  return declaration.defaultCapable === true;
}

/**
 * May the setup wizard OFFER `declaration`'s provider as the first-run choice?
 * Re-asserts the subset invariant at read time so a declaration that reached a
 * consumer through some path other than {@link parseLlmProvider} (a hand-built
 * literal, a test fixture) still cannot be wizard-eligible without being
 * default-capable.
 */
export function declarationIsWizardEligible(declaration: LlmProviderDeclaration): boolean {
  return declaration.wizardEligible === true && declaration.defaultCapable === true;
}

/** Providers in `catalog` that may be the resolved global default, in catalog order. */
export function providersWithDefaultCapable(
  catalog: Readonly<Partial<Record<LlmProvider, LlmProviderDeclaration>>>,
): LlmProvider[] {
  return LLM_PROVIDERS.filter((p) => {
    const d = catalog[p];
    return d ? declarationIsDefaultCapable(d) : false;
  });
}

/** Providers in `catalog` the setup wizard may offer, in catalog order. */
export function providersWithWizardEligible(
  catalog: Readonly<Partial<Record<LlmProvider, LlmProviderDeclaration>>>,
): LlmProvider[] {
  return LLM_PROVIDERS.filter((p) => {
    const d = catalog[p];
    return d ? declarationIsWizardEligible(d) : false;
  });
}

/**
 * The BUILD-KNOWN default-capable set — the flag-table projection every layer
 * below `@cinatra-ai/agents` uses (`packages/llm`'s two implicit-global
 * resolvers, `src/lib/database.ts`'s eligibility chokepoint). Order follows
 * {@link LLM_PROVIDERS}.
 */
export function buildKnownDefaultCapableProviders(): LlmProvider[] {
  return LLM_PROVIDERS.filter((p) => BUILD_KNOWN_LLM_PROVIDER_FLAGS[p].defaultCapable);
}

/** The BUILD-KNOWN wizard-eligible set (the providers `/setup/ai` may offer). */
export function buildKnownWizardEligibleProviders(): LlmProvider[] {
  return LLM_PROVIDERS.filter(
    (p) =>
      BUILD_KNOWN_LLM_PROVIDER_FLAGS[p].wizardEligible &&
      BUILD_KNOWN_LLM_PROVIDER_FLAGS[p].defaultCapable,
  );
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
