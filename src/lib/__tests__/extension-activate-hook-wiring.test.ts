import { describe, it, expect, vi } from "vitest";

// Finding 3 (Critical): the UI Server Action path imports only
// `@cinatra-ai/extensions/handler-bootstrap`, NOT `@/lib/extensions`. If the
// activate hook is wired ONLY in `@/lib/extensions`, a Server Action worker
// leaves it UNWIRED → `fireExtensionActivate` returns
// `{ activated:false, reason:"no-host-hook" }` with `finalized:undefined`, which
// the dispatcher now FAIL-CLOSES (placeholder-as-success regression).
//
// The shared `@/lib/extension-activate-hook-wiring` side-effect module wires the
// hook; `handler-bootstrap` (the Server Action path), `@/lib/extensions` (the MCP
// path), and `instrumentation.node.ts` (boot) all import it. This test proves the
// hook is WIRED after importing the shared module / the Server Action bootstrap
// (the dispatcher would otherwise see `no-host-hook`).
//
// NOTE: this file does NOT import the wiring module or handler-bootstrap at the
// top, so the hook starts UNWIRED in this file's isolated module registry — the
// first assertion captures that baseline, then the wiring imports establish it.

// Stub the heavy activator body so wiring stays a pure unit (no DB / registry).
const runHostExtensionInstallAndActivate = vi.fn(async () => ({
  finalized: true as const,
  activated: true as const,
}));
vi.mock("@/lib/extension-runtime-activate", () => ({
  runHostExtensionInstallAndActivate: (...a: unknown[]) =>
    runHostExtensionInstallAndActivate(...(a as [])),
}));

import { fireExtensionActivate } from "@cinatra-ai/extensions";

describe("Finding 3: extension activate-hook wiring", () => {
  it("baseline: with the wiring NOT yet imported, fireExtensionActivate reports the fail-closed no-host-hook signal", async () => {
    const res = await fireExtensionActivate("@cinatra-ai/x", null);
    expect(res.activated).toBe(false);
    expect(res.reason).toBe("no-host-hook");
    // finalized is undefined → the dispatcher fail-closes a connector install.
    expect(res.finalized).toBeUndefined();
  });

  it("importing the shared wiring module WIRES the hook (no longer no-host-hook)", async () => {
    // The side-effect import wires it; the explicit call is idempotent.
    const { wireExtensionActivateHook } = await import("@/lib/extension-activate-hook-wiring");
    wireExtensionActivateHook();

    const res = await fireExtensionActivate("@cinatra-ai/x", "org-1");
    expect(res.reason).not.toBe("no-host-hook");
    expect(runHostExtensionInstallAndActivate).toHaveBeenCalledWith("@cinatra-ai/x", "org-1");
    expect(res.finalized).toBe(true);
    expect(res.activated).toBe(true);
  });

  it("the Server Action entry (handler-bootstrap) side-effect-imports the shared wiring module", async () => {
    // Structural guarantee (Finding 3): the Server Action path's bootstrap MUST
    // import the wiring module so a worker that never imports @/lib/extensions
    // still hot-activates. (A full import here would pull the heavy handler graph;
    // assert the side-effect import line is present instead.)
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await readFile(
      path.join(process.cwd(), "packages/extensions/src/handler-bootstrap.ts"),
      "utf8",
    );
    expect(src).toContain('import "@/lib/extension-activate-hook-wiring"');
  });

  it("Finding 2: the Server Action entry (handler-bootstrap) registers the connector handler WITH a resolveUiSurface dep", async () => {
    // Structural guarantee (Finding 2): the Server Action path's bootstrap registers
    // ONLY the handlers it imports (it does NOT pull src/lib/extensions.ts). So it
    // MUST wire the connector handler's `resolveUiSurface` itself — otherwise the
    // handler fails OPEN and a bundled-react connector slips past the typed
    // ConnectorRequiresRebuildError into the pipeline. Assert the wiring shape:
    // `createConnectorExtensionHandler({ resolveUiSurface: ... resolveConnectorUiSurfaceForPackage ... })`.
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await readFile(
      path.join(process.cwd(), "packages/extensions/src/handler-bootstrap.ts"),
      "utf8",
    );
    // The connector handler must NOT be registered deps-less (the Finding 2 bug).
    expect(src).not.toMatch(/createConnectorExtensionHandler\(\s*\)/);
    expect(src).toContain("resolveUiSurface");
    expect(src).toContain("resolveConnectorUiSurfaceForPackage");
  });
});
