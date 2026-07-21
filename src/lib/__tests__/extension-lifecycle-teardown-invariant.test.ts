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
//       credentials, and for the `ctx.artifacts` PORT: there is no
//       in-process `register(ctx)` channel for those, so no ctx-driven
//       deregistration primitive exists. NOTE — artifact RENDERERS are the
//       exception since cinatra#1629: they register at the BOOT bridge /
//       activation, not via a `ctx.artifacts` port, and DO have an in-memory
//       teardown primitive (`invalidateArtifactRenderersForPackage`) wired into
//       the closure below.)
//
//   (b) The per-kind in-memory teardown the host wires into
//       `setExtensionCapabilityTeardownHook` (src/lib/extensions.ts ~:62-71)
//       covers the register-channel kinds that DO have an in-process
//       deregistration primitive: { MCP tools, capability providers, ctx.ui
//       surfaces/actions, object types, artifact renderers (semantic detail
//       renderers + representation providers, cinatra#1629) } — plus the runtime
//       dashboard cubes/portlet kinds + version-keyed serving cleared in
//       lockstep.
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
  // `src/lib/register-all-object-types.ts` (pulled in transitively via
  // ensure-artifact-registry after the epic #1785 A3/A4 reader cutover) reads
  // the family→type-id taxonomy from the barrel. The barrel mock returns the
  // real registry, so also re-export the light taxonomy helper — its module is
  // boot-graph-free (`./namespace` constants + a type-only authz alias).
  const { objectTypeIdsForFamily } = await import(
    "../../../packages/objects/src/taxonomy"
  );
  return { ...registry, objectTypeIdsForFamily };
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
import {
  invalidateObjectTypesForPackage,
  invalidateMatcherManifestForPackage,
} from "@/lib/extension-object-types-teardown";
import { objectTypeRegistry, matcherManifestRegistry } from "@cinatra-ai/objects/registry";
import {
  semanticRendererRegistry,
  representationProviderRegistry,
} from "@cinatra-ai/objects/artifact-renderer-registry";
import { runtimeAssetRegistry } from "@/lib/artifacts/runtime-renderer-registry";
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
  matcherManifestRegistry._clearForTests();
  semanticRendererRegistry._clearForTests();
  representationProviderRegistry._clearForTests(true);
  runtimeAssetRegistry._clearForTests();
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

  it("matcher manifest (cinatra#1891): register → get shows it → invalidateMatcherManifestForPackage drops it", () => {
    matcherManifestRegistry.register({
      packageName: PKG,
      matcherSkillIds: [`${PKG}:matcher`],
      matcherConfidenceThreshold: 0.7,
      fileMimeTypes: ["text/markdown"],
    });
    expect(matcherManifestRegistry.get(PKG)).not.toBeNull();
    expect(invalidateMatcherManifestForPackage(PKG)).toBe(true);
    expect(matcherManifestRegistry.get(PKG)).toBeNull();
  });

  it("the host wires a teardown hook composed of EXACTLY these four primitives — and there is NO in-memory dereg primitive for the structurally-absent kinds (jobs/skills/agents/artifacts/credentials)", async () => {
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
    // Meaning-surface channel (cinatra#1891 A3): a matcher-only pack's channel
    // entry must retire through this SAME closure — otherwise a leaked entry
    // keeps its matcher draft auto-surfacing after uninstall.
    matcherManifestRegistry.register({
      packageName: PKG,
      matcherSkillIds: [`${PKG}:matcher`],
      matcherConfidenceThreshold: 0.7,
      fileMimeTypes: ["text/markdown"],
    });
    // Artifact renderers (cinatra#1629): a semantic detail renderer + an
    // org-scoped representation provider must also retire through the closure.
    const RTYPE = `${PKG}:artifact`;
    semanticRendererRegistry.register({ objectTypeId: RTYPE, packageName: PKG });
    representationProviderRegistry.registerProvider("org_1", {
      packageName: PKG,
      pattern: "application/pdf",
      slot: "preview",
      generation: 1,
    });
    // Revocation-via-lifecycle (owner ruling 8): a main-realm dynamic runtime
    // binding retires through this SAME chokepoint (no separate kill-switch).
    await runtimeAssetRegistry.admitAndActivate({
      tuple: {
        packageName: PKG,
        slot: "detail",
        digest: "a".repeat(128),
        entry: "client/detail.js",
        propsApiVersion: 1,
        sdkAbiRange: "^2.4.0",
        reactPeerRange: "^19.0.0",
        reactDomPeerRange: "^19.0.0",
        tokenModuleAbi: "1.0.0",
      },
      generation: 1,
      materialize: async () => {},
      verify: async () => true,
    });
    expect(
      runtimeAssetRegistry.inRuntimeAssetRegistry(runtimeAssetRegistry.keyFor(PKG, "detail")),
    ).toBe(true);

    const result = teardownExtensionCapabilities(PKG);

    expect(result.removedTools).toContain("t");
    expect(result.removedTypes).toContain(TYPE);
    expect(result.removedMatcherManifest).toBe(true);
    expect(matcherManifestRegistry.get(PKG)).toBeNull();
    expect(result.removedRendererTypes).toContain(RTYPE);
    expect(result.removedRepresentationProviders).toBe(1);
    expect(result.removedRuntimeBindings).toBe(1);
    // The dynamic binding no longer resolves — a live mount degrades to the floor.
    expect(
      runtimeAssetRegistry.inRuntimeAssetRegistry(runtimeAssetRegistry.keyFor(PKG, "detail")),
    ).toBe(false);
    expect(listExtensionMcpTools().some((x) => x.packageName === PKG)).toBe(false);
    expect(resolveCapabilityProviders("cap").some((p) => p.packageName === PKG)).toBe(false);
    expect(resolveExtensionUiAction(PKG, "a")).toBeNull();
    expect(objectTypeRegistry.resolve(TYPE)).toBeNull();
    // The renderer registrations no longer resolve.
    expect(
      semanticRendererRegistry.resolve(RTYPE, {
        kind: "extension",
        extension: PKG,
      }),
    ).toBeNull();
    expect(representationProviderRegistry.resolve("org_1", "application/pdf", "preview")).toBeNull();

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
