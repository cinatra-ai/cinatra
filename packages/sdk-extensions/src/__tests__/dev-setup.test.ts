import { describe, it, expect, expectTypeOf } from "vitest";

import { isExtensionDevSetupModule } from "../index";
import type {
  ExtensionDevSetupContext,
  ExtensionDevSetupModule,
  ExtensionDevSetupStatus,
} from "../index";

// cinatra#976 (epic #978 W-D) — the connector-owned devSetup HOOK contract.
// These assert the guard + the structural shape the host shell and every
// connector `dev-setup.ts` share.

describe("isExtensionDevSetupModule", () => {
  it("accepts a module exposing a runDevSetup function", () => {
    const mod = { runDevSetup: async () => ({ status: "skipped", reason: "x" }) };
    expect(isExtensionDevSetupModule(mod)).toBe(true);
  });

  it("accepts a synchronous runDevSetup (the entry may be sync or async)", () => {
    const mod = { runDevSetup: () => ({ status: "skipped" as const, reason: "x" }) };
    expect(isExtensionDevSetupModule(mod)).toBe(true);
  });

  it("rejects a module missing runDevSetup", () => {
    expect(isExtensionDevSetupModule({ setup: () => {} })).toBe(false);
  });

  it("rejects a runDevSetup that is not a function", () => {
    expect(isExtensionDevSetupModule({ runDevSetup: "./dev-setup" })).toBe(false);
  });

  it("rejects non-object inputs (null / undefined / primitive)", () => {
    expect(isExtensionDevSetupModule(null)).toBe(false);
    expect(isExtensionDevSetupModule(undefined)).toBe(false);
    expect(isExtensionDevSetupModule("runDevSetup")).toBe(false);
    expect(isExtensionDevSetupModule(42)).toBe(false);
  });

  it("narrows the type for a passing module", () => {
    const mod: unknown = { runDevSetup: () => ({ status: "created" as const, siteUrl: "http://localhost:8080" }) };
    if (isExtensionDevSetupModule(mod)) {
      expectTypeOf(mod).toEqualTypeOf<ExtensionDevSetupModule>();
    }
  });
});

describe("ExtensionDevSetupStatus", () => {
  it("models the four soft-fail outcomes", () => {
    const created: ExtensionDevSetupStatus = { status: "created", siteUrl: "http://localhost:8082" };
    const wired: ExtensionDevSetupStatus = { status: "already-wired", siteUrl: "http://localhost:8082", detail: "d" };
    const skipped: ExtensionDevSetupStatus = { status: "skipped", reason: "not running" };
    const errored: ExtensionDevSetupStatus = { status: "error", reason: "mint failed" };
    expect([created.status, wired.status, skipped.status, errored.status]).toEqual([
      "created",
      "already-wired",
      "skipped",
      "error",
    ]);
  });
});

describe("ExtensionDevSetupContext (structural contract)", () => {
  it("a host-shaped context satisfies the type and drives a hook", async () => {
    // A minimal host-side context — the shell builds exactly this shape.
    const ctx: ExtensionDevSetupContext = {
      capabilities: {
        resolveProviders: (_capability: string) => [] as Array<{ packageName: string; impl: unknown }>,
      },
      helpers: {
        dockerExecCapture: (_container, _argv) => ({ code: 0, out: "" }),
        probeDockerContainer: (_name) => false,
        probeHttp: (_url, _timeoutSeconds) => false,
        probeHttpReachableWithRetry: async (_url, _options) => false,
        isLocalhostUrl: (_url) => true,
        trimTrailingSlashes: (input) => input.replace(/\/+$/, ""),
      },
      log: (_message) => {},
      mintDevConnectCredential: (_client, _widgetOrigin) => null,
      browserBaseUrl: "http://localhost:3000",
    };

    const hook: ExtensionDevSetupModule = {
      runDevSetup: async (c) => {
        // The hook resolves host services + probes through the context.
        c.log("wiring");
        expect(c.capabilities.resolveProviders("@cinatra-ai/host:drupal-mcp")).toEqual([]);
        expect(c.helpers.probeDockerContainer("cinatra-drupal-1")).toBe(false);
        expect(c.browserBaseUrl).toBe("http://localhost:3000");
        return { status: "skipped", reason: "host services unresolved" };
      },
    };

    const result = await hook.runDevSetup(ctx);
    expect(result).toEqual({ status: "skipped", reason: "host services unresolved" });
  });
});
