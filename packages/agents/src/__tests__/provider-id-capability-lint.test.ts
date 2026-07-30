/**
 * llm-providers S1 (#1712, AC5) — provider-id capability-decision ledger.
 *
 * Mirrors the #1620 G1 "no-new-rot" ratchet pattern for the LLM-provider
 * boundary: a CAPABILITY DECISION ("which provider(s) can satisfy which LLM
 * capability") must read the declared capability matrix
 * (`canProviderSatisfyCapability` / the declaration catalog), NOT a hardcoded
 * provider-id literal. Two PLATFORM policies are exempt (they enumerate
 * provider ids for resolution ORDER / fallback SCAN, not capability truth).
 *
 * SCOPE (S1b): this ledger enforces the invariant on the HOST DISPATCH surface
 * — the sites the package layering lets us rewire onto the agents catalog
 * (`src/` sits above both `@cinatra-ai/agents` and `@cinatra-ai/llm`). The
 * capability catalog lives in `@cinatra-ai/agents`, and `@cinatra-ai/agents`
 * depends on `@cinatra-ai/llm` — so the in-`packages/llm` gates (the
 * `injectMcpTools` gemini short-circuit + the registry/mcp-access provider
 * unions) CANNOT import the catalog without inverting the layering. Rewiring
 * them requires the neutral build-known-catalog leaf that the AC6 catalog-
 * generation slice extracts; they carry a DEFER disposition here and are NOT
 * scanned yet. A full AST + `.github` CI gate (the complete #1620-G1 ratchet)
 * is deferred with that extraction.
 *
 * The ledger:
 *   - REWIRED sites must contain `canProviderSatisfyCapability(...)` and MUST
 *     NOT reintroduce a boolean native-MCP provider union — a revert FAILS.
 *   - EXEMPT platform policies are asserted present so the exemption is live,
 *     not a stale comment.
 *   - DEFER sites are documented (dispositions), tracked for the AC6 slice.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// packages/agents/src/__tests__ → repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

// Strip line + block comments so the negative capability-literal checks below
// cannot be evaded by a comparison that survives only inside a comment (e.g. a
// "was: ..." note). Deliberately coarse — good enough for a source ledger.
const stripComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("provider-id capability-decision ledger (#1712 AC5)", () => {
  it("REWIRED — the bridge native-MCP OBO gate reads the capability matrix, not a provider union", () => {
    const route = read("src/app/api/llm-bridge/route.ts");
    // The rewired gate.
    expect(route).toContain(
      'canProviderSatisfyCapability(mcpEffectiveProvider, "native_mcp")',
    );
    // Must NOT reintroduce a boolean native-MCP provider comparison as the gate.
    // Rejects EITHER individual comparison (order/format-independent), comments
    // stripped first so a "was: ..." note cannot false-green it. The remaining
    // `as "openai" | "anthropic"` TYPE cast on the OBO builder call (a cast, not
    // a capability decision; the mcp-access builder types widen in the AC6
    // slice) uses `|`, not `===`, so it is correctly not matched.
    expect(stripComments(route)).not.toMatch(
      /mcpEffectiveProvider\s*===\s*"(?:openai|anthropic)"/,
    );
  });

  it("REWIRED — the dispatch resolver routes capability via the matrix", () => {
    const dispatch = read("src/app/api/llm-bridge/_llm-dispatch.ts");
    expect(dispatch).toContain("canProviderSatisfyCapability(candidate, cap)");
    expect(dispatch).toContain(
      "canProviderSatisfyCapability(effectiveProvider, capability)",
    );
  });

  it("RESOLVED — global-default eligibility is now DERIVED from the ABI v2 declaration, not a provider-id list", () => {
    // cinatra#2093 (epic #2086 S6) closed the first half of this exemption.
    // The implicit-global resolution ORDER used to be the hardcoded
    // `["openai", "gemini"]` literal that architecturally barred Anthropic; it
    // now derives from the `defaultCapable` flag via the SDK leaf (which
    // `@cinatra-ai/llm` MAY import — the cycle that forced the exemption only
    // applies to the `@cinatra-ai/agents` catalog).
    const registry = read("packages/llm/src/registry.ts");
    expect(registry).not.toContain('const globalEligible: LlmProvider[] = ["openai", "gemini"]');
    expect(registry).toContain("buildKnownDefaultCapableProviders()");

    const llmIndex = read("packages/llm/src/index.ts");
    // The SECOND implicit-global resolver derives from the SAME helper rather
    // than carrying its own copy of the list.
    expect(llmIndex).not.toContain('const globalEligible: LlmProvider[] = ["openai", "gemini"]');
    expect(llmIndex).toContain("resolveImplicitGlobalProviderOrder()");
  });

  it("EXEMPT — the image-provider fallback SCAN order stays a provider-id list (order, not capability)", () => {
    const registry = read("packages/llm/src/registry.ts");
    // Image generation is the `separate-default` purpose: it resolves through
    // its OWN stored preference and deliberately does not follow
    // `llm_default_provider`, so its scan order is a platform policy rather
    // than a capability question.
    expect(registry).toContain('const allProviders: LlmProvider[] = ["openai", "anthropic", "gemini"]');
  });

  it("DEFER — the in-packages/llm capability gates are ledgered pending the AC6 neutral-leaf extraction", () => {
    // These remain provider-id literals ONLY because @cinatra-ai/llm cannot
    // import the @cinatra-ai/agents catalog (agents depends on llm — a cycle).
    // Asserting they still exist keeps the disposition live: when the AC6 slice
    // extracts the neutral build-known catalog and rewires them, this block is
    // updated in the same change (a stale disposition FAILS).
    const llmIndex = read("packages/llm/src/index.ts");
    // injectMcpTools gemini short-circuit (native_mcp gate).
    expect(llmIndex).toContain('if (params.provider === "gemini") return params.tools;');

    const registry = read("packages/llm/src/registry.ts");
    // The native-MCP-injectable provider union on the resolver signatures.
    expect(registry).toMatch(/provider: "openai" \| "anthropic"/);
  });
});
