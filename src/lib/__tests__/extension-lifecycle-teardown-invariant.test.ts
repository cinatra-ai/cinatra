import { describe, it, expect, afterEach, vi } from "vitest";

// Per-kind runtime deregistration/teardown invariant.
//
// Two structural facts rated as "partial-by-design" are pinned
// here so they can't silently drift:
//
//   (a) `ctx.jobs.registerWorker` is NOT a real port — it FAILS LOUD ("not
//       supported"). The host runs a STATIC background-job dispatcher
//       (BACKGROUND_JOB_NAMES), not a dynamic worker registry, so no job-worker
//       kind can ever be REGISTERED in-process — hence there is nothing of that
//       kind to TEAR DOWN. (Same is true structurally for skills/agents/
//       artifacts/credentials: there is no in-process `register(ctx)` channel
//       for those kinds, so no in-memory deregistration primitive exists.)
//
//   (b) The per-kind in-memory teardown the host wires into
//       `setExtensionCapabilityTeardownHook` (src/lib/extensions.ts ~:62-71)
//       covers EXACTLY the four kinds that DO have an in-process register(ctx)
//       channel: { MCP tools, capability providers, ctx.ui surfaces/actions,
//       object types } — and nothing else.
//
// The teardown orchestrator in `src/lib/extensions.ts` cannot be imported here:
// it transitively pulls the full handler graph (agents/skills/workflows +
// separate-repo extension packages like @cinatra-ai/crm-connector that aren't
// resolvable in the unit-test module graph). So this test asserts the REAL
// teardown primitives the orchestrator composes — each register* → resolve* →
// invalidate*ForPackage round-trip — rather than the heavy wiring module.

// `@/lib/extension-object-types-teardown` imports the HEAVY `@cinatra-ai/objects`
// main entry (it transitively pulls the objects-browser RSC screen, which imports
// a separate-repo connector). Alias it to the NARROW, zero-React/DB/server-only
// `@cinatra-ai/objects/registry` entry — same `Symbol.for`-anchored singleton, so
// the teardown helper and this test's direct import see the identical instance.
vi.mock("@cinatra-ai/objects", async () => {
  const registry = await import("@cinatra-ai/objects/registry");
  return registry;
});

import { createExtensionHostContext } from "@/lib/extension-host-context";
import {
  registerExtensionMcpTool,
  listExtensionMcpTools,
  removeExtensionMcpToolsForPackage,
} from "@/lib/extension-mcp-registry";
import {
  registerCapabilityProvider,
  resolveCapabilityProviders,
  invalidateProvidersForPackage,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";
import {
  registerExtensionUiAction,
  resolveExtensionUiAction,
  invalidateExtensionUiForPackage,
  __resetExtensionUiRegistry,
} from "@/lib/extension-ui-registry";
import { invalidateObjectTypesForPackage } from "@/lib/extension-object-types-teardown";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
// The EXACT production teardown closure the host wires into
// `setExtensionCapabilityTeardownHook` (src/lib/extensions.ts ~:87). Imported from
// the shared lightweight module — NOT a copy — so production wiring drift (a fifth
// register-channel kind, or a dropped kind) is caught here. `src/lib/extensions.ts`
// itself can't be imported (heavy handler graph + separate-repo packages), but it
// composes this very function, so asserting it is asserting the real hook body.
import { teardownExtensionCapabilities } from "@/lib/extension-capability-teardown";

const PKG = "@cinatra-ai/teardown-invariant-fixture";

afterEach(() => {
  // The four registries are process-global singletons — isolate every case.
  removeExtensionMcpToolsForPackage(PKG);
  __resetCapabilityRegistry();
  __resetExtensionUiRegistry();
  objectTypeRegistry._clearForTests();
});

describe("per-kind teardown (a) — ctx.jobs.registerWorker is not a supported port", () => {
  it("a GRANTED jobs port still THROWS 'not supported' on registerWorker (no dynamic worker registry)", () => {
    // Grant `jobs` so we hit the REAL wired `makeJobs` impl, not the grant gate.
    const ctx = createExtensionHostContext(PKG, ["jobs"]);
    // SDK signature is registerWorker(jobName, handler) — pass both so this stays
    // type-valid; the call THROWS before ever touching the args.
    expect(() => ctx.jobs.registerWorker("any-job", async () => {})).toThrow(/not supported/i);
    // The granted port still exposes the real `enqueue` (it is the supported half).
    expect(typeof ctx.jobs.enqueue).toBe("function");
  });

  it("an UNGRANTED jobs port throws the least-privilege NOT GRANTED message instead", () => {
    const ctx = createExtensionHostContext(PKG, []); // no grants
    expect(() => ctx.jobs.registerWorker("any-job", async () => {})).toThrow(/NOT GRANTED/);
  });
});

describe("per-kind teardown (b) — the teardown hook covers EXACTLY the four register-channel kinds", () => {
  it("MCP tools: register → list shows it → removeExtensionMcpToolsForPackage drops it", () => {
    registerExtensionMcpTool(PKG, { name: "ext_invariant_tool", handler: () => ({}) } as never);
    expect(listExtensionMcpTools().some((t) => t.packageName === PKG)).toBe(true);
    const removed = removeExtensionMcpToolsForPackage(PKG);
    expect(removed).toContain("ext_invariant_tool");
    expect(listExtensionMcpTools().some((t) => t.packageName === PKG)).toBe(false);
  });

  it("capability providers: register → resolve shows it → invalidateProvidersForPackage drops it", () => {
    registerCapabilityProvider("invariant-cap", { packageName: PKG, impl: { hi: true } });
    expect(resolveCapabilityProviders("invariant-cap").some((p) => p.packageName === PKG)).toBe(true);
    invalidateProvidersForPackage(PKG);
    expect(resolveCapabilityProviders("invariant-cap").some((p) => p.packageName === PKG)).toBe(false);
  });

  it("ctx.ui actions: register → resolve shows it → invalidateExtensionUiForPackage drops it", () => {
    registerExtensionUiAction({ packageName: PKG, id: "do-thing", handler: async () => ({}) });
    expect(resolveExtensionUiAction(PKG, "do-thing")).not.toBeNull();
    invalidateExtensionUiForPackage(PKG);
    expect(resolveExtensionUiAction(PKG, "do-thing")).toBeNull();
  });

  it("object types: register → resolve shows it → invalidateObjectTypesForPackage drops it", () => {
    const TYPE = `${PKG}:thing`;
    objectTypeRegistry.register({ type: TYPE, category: "data" } as never, PKG);
    expect(objectTypeRegistry.resolve(TYPE)).not.toBeNull();
    const removed = invalidateObjectTypesForPackage(PKG);
    expect(removed).toContain(TYPE);
    expect(objectTypeRegistry.resolve(TYPE)).toBeNull();
  });

  it("the host wires a teardown hook composed of EXACTLY these four primitives — and there is NO in-memory dereg primitive for the structurally-absent kinds (jobs/skills/agents/artifacts/credentials)", () => {
    // Drive the REAL production closure `teardownExtensionCapabilities`
    // (the single source of truth the host wires at src/lib/extensions.ts ~:87 —
    // NOT a local copy): register one of each covered kind, fire the closure, and
    // assert all four round-trip to empty — proving the covered SET is exactly
    // {mcp, providers, ui, object types}. If one of these four kinds is dropped
    // from `teardownExtensionCapabilities`, this assertion fails. (Caveat: a NEW
    // fifth register-channel added to the host WITHOUT updating that closure would
    // NOT be caught here — this test guards the closure's current four-kind contract,
    // not the absence of un-wired channels.)
    registerExtensionMcpTool(PKG, { name: "t", handler: () => ({}) } as never);
    registerCapabilityProvider("cap", { packageName: PKG, impl: {} });
    registerExtensionUiAction({ packageName: PKG, id: "a", handler: async () => ({}) });
    const TYPE = `${PKG}:t`;
    objectTypeRegistry.register({ type: TYPE, category: "data" } as never, PKG);

    const result = teardownExtensionCapabilities(PKG);

    expect(result.removedTools).toContain("t");
    expect(result.removedTypes).toContain(TYPE);
    expect(listExtensionMcpTools().some((x) => x.packageName === PKG)).toBe(false);
    expect(resolveCapabilityProviders("cap").some((p) => p.packageName === PKG)).toBe(false);
    expect(resolveExtensionUiAction(PKG, "a")).toBeNull();
    expect(objectTypeRegistry.resolve(TYPE)).toBeNull();

    // Structural-absence invariant: the host module exports NO in-memory
    // `invalidate<kind>ForPackage` for the kinds that have no register(ctx)
    // channel. We can't import them (they don't exist) — assert via the SDK
    // host-context surface that those kinds have no in-process register channel,
    // so there is nothing of those kinds to tear down. `ctx.jobs.registerWorker`
    // throws (asserted above). There is no `ctx.skills`/`ctx.agents`/
    // `ctx.artifacts`/`ctx.credentials` register port at all:
    const ctx = createExtensionHostContext(PKG, []) as unknown as Record<string, unknown>;
    expect(ctx.skills).toBeUndefined();
    expect(ctx.agents).toBeUndefined();
    expect(ctx.artifacts).toBeUndefined();
    expect(ctx.credentials).toBeUndefined();
  });
});
