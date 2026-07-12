import { describe, it, expect, beforeEach, vi } from "vitest";
import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";
import {
  createExtensionHostContext,
  createNonDefaultVersionHostContext,
} from "@/lib/extension-host-context";
import {
  registerCapabilityProvider,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";
import {
  computePreResolvedEdgeMaps,
  publishPreResolvedEdgeMaps,
  __resetPreResolvedEdgesForTests,
} from "@/lib/extension-pre-resolved-edges";
import {
  beginVersionKeyedRegistration,
  __resetVersionKeyedServingForTests,
} from "@/lib/extension-version-keyed-serving";
import { getExtensionCtxIdentity } from "@/lib/extension-ctx-dependent-identity";
import { _resetExtensionMcpForTests } from "@/lib/extension-mcp-registry";

// cinatra#1392 S8 — the host ctx's two edge-bound consume seams:
//   1. `ctx.mcp.callPrimitive` runs inside the extension-ctx identity ALS frame
//      (the CALLING record's identity, not the outer run's);
//   2. `ctx.capabilities.resolveProviders` applies the loader-published
//      pre-resolved versioned pins (SYNC substitution, fail-closed).

const CALLER = "@x/caller";
const TARGET = "@x/dep";
const V = "0.1.4";
const CAP = "email-send";

// Capture what identity the (mocked) self-invoker observes inside the frame.
const seenIdentities: unknown[] = [];
vi.mock("@/lib/extension-self-mcp", () => ({
  callHostPrimitive: vi.fn(async (name: string) => {
    seenIdentities.push(getExtensionCtxIdentity());
    return { called: name };
  }),
}));
vi.mock("@/lib/extension-host-actor", () => ({
  resolveExtensionActorContext: vi.fn(async () => null),
  resolveExtensionActorSummary: vi.fn(async () => null),
  requireExtensionOrganizationId: vi.fn(async () => "org-1"),
}));

function row(over: Partial<InstalledExtension> & { id: string }): InstalledExtension {
  return {
    packageName: TARGET,
    status: "active",
    organizationId: "org-1",
    ownerLevel: "organization",
    ownerId: null,
    isDefault: true,
    dependencyEdges: [],
    ...over,
  } as unknown as InstalledExtension;
}

function publishCallerPin() {
  publishPreResolvedEdgeMaps(
    computePreResolvedEdgeMaps([
      row({
        id: "i-caller",
        packageName: CALLER,
        dependencyEdges: [
          {
            packageName: TARGET,
            edgeType: "runtime",
            versionConstraint: { kind: "exact", version: V },
            requirement: "required",
            resolvedInstallId: "i-sib",
            resolutionReason: "test-fixture",
          } as never,
        ],
      }),
      row({ id: "i-sib", isDefault: false, version: V }),
    ]),
  );
}

beforeEach(() => {
  seenIdentities.length = 0;
  __resetCapabilityRegistry();
  __resetPreResolvedEdgesForTests();
  __resetVersionKeyedServingForTests();
  _resetExtensionMcpForTests();
});

describe("ctx.mcp.callPrimitive — the extension-ctx identity frame (S8)", () => {
  it("the DEFAULT ctx runs the invoker under its (packageName, default) identity", async () => {
    const ctx = createExtensionHostContext(CALLER, ["mcp"], {}, { version: "1.0.0", isDefault: true });
    await expect(ctx.mcp.callPrimitive("objects_list", {})).resolves.toEqual({ called: "objects_list" });
    expect(seenIdentities).toEqual([{ packageName: CALLER, version: "1.0.0", isDefault: true }]);
  });

  it("an identity-less legacy ctx carries the default identity (compat)", async () => {
    const ctx = createExtensionHostContext(CALLER, ["mcp"]);
    await ctx.mcp.callPrimitive("objects_list", {});
    expect(seenIdentities).toEqual([{ packageName: CALLER, version: null, isDefault: true }]);
  });
});

describe("ctx.mcp.callPrimitive on the NON-DEFAULT ctx (S8)", () => {
  it("REFUSES during register (sink not settled) — the register-only contract holds", () => {
    const sink = beginVersionKeyedRegistration(CALLER, V);
    const ctx = createNonDefaultVersionHostContext(CALLER, ["mcp"], {}, sink, {
      version: V,
      isDefault: false,
    });
    expect(() => ctx.mcp.callPrimitive("objects_list", {})).toThrow(/not available during register/);
    expect(seenIdentities).toEqual([]);
  });

  it("dispatches under the NON-DEFAULT identity once the sink settled", async () => {
    const sink = beginVersionKeyedRegistration(CALLER, V);
    const ctx = createNonDefaultVersionHostContext(CALLER, ["mcp"], {}, sink, {
      version: V,
      isDefault: false,
    });
    sink.commit();
    await expect(ctx.mcp.callPrimitive("objects_list", {})).resolves.toEqual({ called: "objects_list" });
    expect(seenIdentities).toEqual([{ packageName: CALLER, version: V, isDefault: false }]);
  });

  it("WITHOUT a sink the probe behavior is preserved (callPrimitive rejects)", async () => {
    const ctx = createNonDefaultVersionHostContext(CALLER, ["mcp"], {}, undefined, {
      version: V,
      isDefault: false,
    });
    await expect(ctx.mcp.callPrimitive("objects_list", {})).rejects.toThrow(/not available/);
  });
});

describe("ctx.capabilities.resolveProviders — SYNC edge-bound substitution (S8)", () => {
  it("no pins → the global registry's providers, unchanged", () => {
    registerCapabilityProvider(CAP, { packageName: TARGET, impl: { tag: "default" } });
    const ctx = createExtensionHostContext(CALLER, ["capabilities"]);
    const out = ctx.capabilities.resolveProviders(CAP);
    expect(out.map((p) => (p.impl as { tag: string }).tag)).toEqual(["default"]);
  });

  it("a versioned pin substitutes the RETAINED provider for the default's entry", () => {
    registerCapabilityProvider(CAP, { packageName: TARGET, impl: { tag: "default" } });
    publishCallerPin();
    const sink = beginVersionKeyedRegistration(TARGET, V);
    sink.retainCapabilityProvider(CAP, { packageName: TARGET, impl: { tag: "versioned" } });
    sink.commit();
    const ctx = createExtensionHostContext(CALLER, ["capabilities"], {}, { version: null, isDefault: true });
    const out = ctx.capabilities.resolveProviders(CAP);
    expect(out.map((p) => (p.impl as { tag: string }).tag)).toEqual(["versioned"]);
  });

  it("a pin whose version is not servable THROWS (fail-closed, never the default provider)", () => {
    registerCapabilityProvider(CAP, { packageName: TARGET, impl: { tag: "default" } });
    publishCallerPin(); // nothing retained for TARGET@V
    const ctx = createExtensionHostContext(CALLER, ["capabilities"], {}, { version: null, isDefault: true });
    expect(() => ctx.capabilities.resolveProviders(CAP)).toThrow(/refused/);
  });

  it("the NON-DEFAULT ctx applies ITS OWN version's pins (probe capability reads included)", () => {
    registerCapabilityProvider(CAP, { packageName: TARGET, impl: { tag: "default" } });
    // The non-default caller (CALLER@9.9.9) pins TARGET@V; the default caller has no pins.
    publishPreResolvedEdgeMaps(
      computePreResolvedEdgeMaps([
        row({
          id: "i-caller-sib",
          packageName: CALLER,
          isDefault: false,
          version: "9.9.9",
          dependencyEdges: [
            {
              packageName: TARGET,
              edgeType: "runtime",
              versionConstraint: { kind: "exact", version: V },
              requirement: "required",
              resolvedInstallId: "i-sib",
              resolutionReason: "test-fixture",
            } as never,
          ],
        }),
        row({ id: "i-sib", isDefault: false, version: V }),
      ]),
    );
    const sink = beginVersionKeyedRegistration(TARGET, V);
    sink.retainCapabilityProvider(CAP, { packageName: TARGET, impl: { tag: "versioned" } });
    sink.commit();
    const ownSink = beginVersionKeyedRegistration(CALLER, "9.9.9");
    const ctx = createNonDefaultVersionHostContext(CALLER, ["capabilities"], {}, ownSink, {
      version: "9.9.9",
      isDefault: false,
    });
    const out = ctx.capabilities.resolveProviders(CAP);
    expect(out.map((p) => (p.impl as { tag: string }).tag)).toEqual(["versioned"]);
    // The DEFAULT identity of the same package resolves the global provider.
    const defCtx = createExtensionHostContext(CALLER, ["capabilities"]);
    expect(defCtx.capabilities.resolveProviders(CAP).map((p) => (p.impl as { tag: string }).tag)).toEqual([
      "default",
    ]);
  });
});
