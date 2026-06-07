import { describe, it, expect } from "vitest";
import {
  activateExtensionModule,
  bootstrapExtensionModule,
  destroyExtensionModule,
} from "../activate";
import { defineExtension, type ExtensionModule } from "../register";
import type { ExtensionHostContext } from "../host-context";

// Opaque sentinel ctx — activation passes it through without inspecting it.
const ctx = { abiVersion: "1.0.0", packageName: "x" } as unknown as ExtensionHostContext;
const OK = { abiCompatible: true } as const;

function mod(over: Partial<ExtensionModule>): ExtensionModule {
  return defineExtension({ packageName: "@cinatra-ai/test-ext", ...over });
}

describe("activateExtensionModule — gate + register, NO bootstrap", () => {
  it("registers with the host ctx and does NOT bootstrap at register time", async () => {
    const calls: string[] = [];
    let registerCtx: unknown = null;
    const m = mod({
      server: {
        register: (c) => { calls.push("register"); registerCtx = c; },
        bootstrap: () => { calls.push("bootstrap"); },
      },
    });
    const r = await activateExtensionModule(m, ctx, OK);
    expect(r.status).toBe("registered");
    expect(calls).toEqual(["register"]); // bootstrap runs in the later step, not here
    expect(registerCtx).toBe(ctx);
  });

  it("supports the unified top-level `register` shortcut", async () => {
    let called = false;
    const r = await activateExtensionModule(mod({ register: () => { called = true; } }), ctx, OK);
    expect(r.status).toBe("registered");
    expect(called).toBe(true);
  });

  it("refuses an ABI-incompatible module BEFORE running ANY code (incl. config.resolve)", async () => {
    let ran = false;
    let resolveRan = false;
    const m = mod({
      config: { resolve: () => { resolveRan = true; return true; } },
      register: () => { ran = true; },
    });
    const r = await activateExtensionModule(m, ctx, { abiCompatible: false });
    expect(r).toMatchObject({ status: "skipped", reason: "abi-incompatible" });
    expect(ran).toBe(false);
    expect(resolveRan).toBe(false); // ABI gate is BEFORE config.resolve
  });

  it("skips a config-disabled module without running its code", async () => {
    let ran = false;
    const r = await activateExtensionModule(mod({ config: { enabled: false }, register: () => { ran = true; } }), ctx, OK);
    expect(r).toMatchObject({ status: "skipped", reason: "config-disabled" });
    expect(ran).toBe(false);
  });

  it("honors a dynamic config.resolve gate", async () => {
    const m = mod({
      config: { resolve: ({ installedPackages }) => installedPackages.has("@cinatra-ai/nango-connector") },
      register: () => {},
    });
    expect(await activateExtensionModule(m, ctx, { abiCompatible: true, installedPackages: new Set() }))
      .toMatchObject({ status: "skipped", reason: "config-resolve-false" });
    expect((await activateExtensionModule(m, ctx, { abiCompatible: true, installedPackages: new Set(["@cinatra-ai/nango-connector"]) })).status)
      .toBe("registered");
  });

  it("isolates a config.resolve that throws (distinct reason)", async () => {
    const boom = new Error("resolve boom");
    const r = await activateExtensionModule(mod({ config: { resolve: () => { throw boom; } }, register: () => {} }), ctx, OK);
    expect(r).toMatchObject({ status: "failed", reason: "config-resolve-threw" });
    expect(r.error).toBe(boom);
  });

  it("skips a module with no server entry", async () => {
    expect(await activateExtensionModule(mod({}), ctx, OK)).toMatchObject({ status: "skipped", reason: "no-server-entry" });
  });

  it("isolates a register() failure (returns failed, does not throw)", async () => {
    const boom = new Error("register boom");
    const r = await activateExtensionModule(mod({ register: () => { throw boom; } }), ctx, OK);
    expect(r).toMatchObject({ status: "failed", reason: "register-threw" });
    expect(r.error).toBe(boom);
  });
});

describe("bootstrapExtensionModule — runs after all modules are registered", () => {
  it("bootstraps a registered module", async () => {
    let bootstrapped = false;
    const r = await bootstrapExtensionModule(mod({ server: { register: () => {}, bootstrap: () => { bootstrapped = true; } } }), ctx);
    expect(r.status).toBe("bootstrapped");
    expect(bootstrapped).toBe(true);
  });
  it("skips a module with no bootstrap hook", async () => {
    expect(await bootstrapExtensionModule(mod({ register: () => {} }), ctx)).toMatchObject({ status: "skipped", reason: "no-bootstrap" });
  });
  it("isolates a bootstrap failure with a distinct reason", async () => {
    const boom = new Error("bootstrap boom");
    const r = await bootstrapExtensionModule(mod({ server: { register: () => {}, bootstrap: () => { throw boom; } } }), ctx);
    expect(r).toMatchObject({ status: "failed", reason: "bootstrap-threw" });
    expect(r.error).toBe(boom);
  });

  it("register-all THEN bootstrap-all ordering across modules (peer capabilities available)", async () => {
    const order: string[] = [];
    const a = mod({ packageName: "@cinatra-ai/a", server: { register: () => { order.push("reg:a"); }, bootstrap: () => { order.push("boot:a"); } } });
    const b = mod({ packageName: "@cinatra-ai/b", server: { register: () => { order.push("reg:b"); }, bootstrap: () => { order.push("boot:b"); } } });
    for (const m of [a, b]) await activateExtensionModule(m, ctx, OK);
    for (const m of [a, b]) await bootstrapExtensionModule(m, ctx);
    expect(order).toEqual(["reg:a", "reg:b", "boot:a", "boot:b"]); // all registers before any bootstrap
  });
});

describe("destroyExtensionModule", () => {
  it("calls destroy(ctx) when present (status: destroyed)", async () => {
    let destroyed = false;
    const r = await destroyExtensionModule(mod({ server: { register: () => {}, destroy: () => { destroyed = true; } } }), ctx);
    expect(r.status).toBe("destroyed");
    expect(destroyed).toBe(true);
  });
  it("skips when no destroy hook (no-destroy)", async () => {
    expect(await destroyExtensionModule(mod({ register: () => {} }), ctx)).toMatchObject({ status: "skipped", reason: "no-destroy" });
  });
  it("isolates a destroy failure (destroy-threw)", async () => {
    const boom = new Error("destroy boom");
    const r = await destroyExtensionModule(mod({ server: { register: () => {}, destroy: () => { throw boom; } } }), ctx);
    expect(r).toMatchObject({ status: "failed", reason: "destroy-threw" });
    expect(r.error).toBe(boom);
  });
});
