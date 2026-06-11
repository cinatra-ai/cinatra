// Lazy/guarded host-access cutover — the Ops cluster's
// capability resolution surfaces (object-type registrars, CRM sync bootstrap,
// CRM pointer writer, dev-tunnel status). The host names no connector
// package; every consumer resolves through the capability registry at call
// time and DEGRADES when no provider is registered (extension absent or not
// yet activated).

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  registerCapabilityProvider,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";
import { runExtensionObjectTypeRegistrars } from "@/lib/extension-object-type-registrars";
import {
  ensureCrmSyncRegistrations,
  resolveCrmPointerWriter,
} from "@/lib/crm-integration-providers";
import { getDevTunnelStatus } from "@/lib/dev-tunnel-status";

beforeEach(() => {
  __resetCapabilityRegistry();
  vi.restoreAllMocks();
});

describe("runExtensionObjectTypeRegistrars (object-type-registrar)", () => {
  it("degrades to a no-op with an empty registry (extension absent)", () => {
    expect(() => runExtensionObjectTypeRegistrars()).not.toThrow();
  });

  it("invokes every registered registrar", () => {
    const a = vi.fn();
    const b = vi.fn();
    registerCapabilityProvider("object-type-registrar", {
      packageName: "@v/a-connector",
      impl: { registerObjectTypes: a },
    });
    registerCapabilityProvider("object-type-registrar", {
      packageName: "@v/b-connector",
      impl: { registerObjectTypes: b },
    });
    runExtensionObjectTypeRegistrars();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("isolates a throwing registrar (warn + continue) and skips invalid impls", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ok = vi.fn();
    registerCapabilityProvider("object-type-registrar", {
      packageName: "@v/bad-connector",
      impl: {
        registerObjectTypes: () => {
          throw new Error("boom");
        },
      },
    });
    registerCapabilityProvider("object-type-registrar", {
      packageName: "@v/not-a-registrar",
      impl: { somethingElse: true },
    });
    registerCapabilityProvider("object-type-registrar", {
      packageName: "@v/ok-connector",
      impl: { registerObjectTypes: ok },
    });
    expect(() => runExtensionObjectTypeRegistrars()).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("@v/bad-connector");
  });
});

describe("ensureCrmSyncRegistrations (crm-sync-bootstrap)", () => {
  it("degrades to a no-op with an empty registry (connector absent)", () => {
    expect(() => ensureCrmSyncRegistrations()).not.toThrow();
  });

  it("invokes registered bootstraps and isolates failures", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ok = vi.fn();
    registerCapabilityProvider("crm-sync-bootstrap", {
      packageName: "@v/bad-connector",
      impl: {
        ensureSyncRegistrations: () => {
          throw new Error("boom");
        },
      },
    });
    registerCapabilityProvider("crm-sync-bootstrap", {
      packageName: "@v/crm-connector",
      impl: { ensureSyncRegistrations: ok },
    });
    expect(() => ensureCrmSyncRegistrations()).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("resolveCrmPointerWriter (crm-pointer-writer)", () => {
  it("returns null with an empty registry (degraded: the repair job warns + completes)", () => {
    expect(resolveCrmPointerWriter()).toBeNull();
  });

  it("returns the structurally-valid registered writer", async () => {
    const writePointer = vi.fn(async () => {});
    registerCapabilityProvider("crm-pointer-writer", {
      packageName: "@v/not-a-writer",
      impl: { nope: true },
    });
    registerCapabilityProvider("crm-pointer-writer", {
      packageName: "@v/crm-connector",
      impl: { writePointer },
    });
    const writer = resolveCrmPointerWriter();
    expect(writer).not.toBeNull();
    await writer!.writePointer({
      type: "account",
      externalId: "x1",
      name: "Acme",
      orgId: "o1",
      userId: "u1",
    });
    expect(writePointer).toHaveBeenCalledWith({
      type: "account",
      externalId: "x1",
      name: "Acme",
      orgId: "o1",
      userId: "u1",
    });
  });
});

describe("crm-connector serverEntry activation through the REAL loader surfaces", () => {
  // Codex finding (Ops round-1, HIGH): a fake-ctx test misses the grant gate —
  // the REAL host context throws NOT GRANTED on an undeclared port. This test
  // drives the EXACT loader path: the generated server-entry map entry + the
  // manifest record's requestedHostPorts + the real grant-aware host context.
  it("activates with the manifest-recorded grants and registers the three capabilities", async () => {
    const [{ GENERATED_EXTENSION_SERVER_ENTRIES, STATIC_EXTENSION_MANIFEST }, hostCtx] =
      await Promise.all([
        import("@/lib/generated/extensions.server"),
        import("@/lib/extension-host-context"),
      ]);
    const record = STATIC_EXTENSION_MANIFEST["@cinatra-ai/crm-connector"];
    expect(record?.serverEntry).toBe("./register");
    // The register body uses ctx.capabilities — the manifest MUST grant it.
    expect(record?.requestedHostPorts).toContain("capabilities");

    const entry = GENERATED_EXTENSION_SERVER_ENTRIES["@cinatra-ai/crm-connector"];
    expect(entry).toBeDefined();
    const loaded = (await entry!.load()) as { register?: (ctx: unknown) => void };
    expect(typeof loaded.register).toBe("function");

    const ctx = hostCtx.createExtensionHostContext(
      "@cinatra-ai/crm-connector",
      (record!.requestedHostPorts ?? []) as Parameters<
        typeof hostCtx.createExtensionHostContext
      >[1],
    );
    expect(() => loaded.register!(ctx)).not.toThrow();
    const { resolveCapabilityProviders } = await import("@/lib/extension-capabilities-registry");
    for (const capability of ["object-type-registrar", "crm-sync-bootstrap", "crm-pointer-writer"]) {
      expect(
        resolveCapabilityProviders(capability).map((p) => p.packageName),
      ).toContain("@cinatra-ai/crm-connector");
    }
  });
});

describe("getDevTunnelStatus (dev-tunnel-status)", () => {
  it("degrades to not-connected with an empty registry (connector absent)", () => {
    expect(getDevTunnelStatus()).toEqual({ connected: false, funnelUrlPreview: null });
  });

  it("passes through the registered provider's reads", () => {
    registerCapabilityProvider("dev-tunnel-status", {
      packageName: "@v/tailscale-connector",
      impl: {
        getConnectionStatus: () => ({ connected: true, tailnet: "t.ts.net" }),
        getFunnelUrlPreview: () => "https://my-clone.t.ts.net",
      },
    });
    expect(getDevTunnelStatus()).toEqual({
      connected: true,
      funnelUrlPreview: "https://my-clone.t.ts.net",
    });
  });

  it("a throwing provider read degrades to not-connected (warn, never throws into the page)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerCapabilityProvider("dev-tunnel-status", {
      packageName: "@v/tailscale-connector",
      impl: {
        getConnectionStatus: () => {
          throw new Error("boom");
        },
        getFunnelUrlPreview: () => null,
      },
    });
    expect(getDevTunnelStatus()).toEqual({ connected: false, funnelUrlPreview: null });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
