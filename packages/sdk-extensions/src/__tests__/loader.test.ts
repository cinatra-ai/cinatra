import { describe, it, expect } from "vitest";
import { runStaticBundleActivation, type LoaderRecord, type LoaderDeps } from "../loader";
import type { ExtensionHostContext } from "../host-context";

const ctx = { abiVersion: "1.0.0", packageName: "x" } as unknown as ExtensionHostContext;

function deps(over: Partial<LoaderDeps> = {}): LoaderDeps {
  return {
    importServerEntry: () => Promise.resolve({ register: () => {} }),
    makeContext: () => ctx,
    abiCompatible: () => true,
    ...over,
  };
}
const rec = (packageName: string, serverEntry: string | null = "./register"): LoaderRecord => ({ packageName, serverEntry });

describe("runStaticBundleActivation — the shared loader driver", () => {
  it("only loads records that declare a serverEntry", async () => {
    const seen: string[] = [];
    const results = await runStaticBundleActivation(
      [rec("@cinatra-ai/a"), rec("@cinatra-ai/b", null)],
      deps({ importServerEntry: (p) => { seen.push(p); return Promise.resolve({ register: () => {} }); } }),
    );
    expect(seen).toEqual(["@cinatra-ai/a"]); // b has no serverEntry
    expect(results.find((r) => r.packageName === "@cinatra-ai/a")?.status).toBe("registered");
  });

  it("register-all THEN bootstrap-all, with bootstrap actually reached", async () => {
    // Regression guard: the loader MUST preserve top-level `bootstrap` (not reduce
    // the import to `{ register }`). A module exporting both register + bootstrap
    // must see ALL registers run before ANY bootstrap, and every bootstrap fire.
    const order: string[] = [];
    const importServerEntry = (p: string) => {
      const short = p.split("/")[1];
      return Promise.resolve({
        register: () => { order.push("reg:" + short); },
        bootstrap: () => { order.push("boot:" + short); },
      });
    };
    const results = await runStaticBundleActivation(
      [rec("@cinatra-ai/a"), rec("@cinatra-ai/b")],
      deps({ importServerEntry }),
    );
    expect(order).toEqual(["reg:a", "reg:b", "boot:a", "boot:b"]);
    expect(results.filter((r) => r.status === "registered").map((r) => r.packageName)).toEqual([
      "@cinatra-ai/a",
      "@cinatra-ai/b",
    ]);
    expect(results.filter((r) => r.status === "bootstrapped").map((r) => r.packageName)).toEqual([
      "@cinatra-ai/a",
      "@cinatra-ai/b",
    ]);
  });

  it("preserves bootstrap on the split `server` entry too", async () => {
    const order: string[] = [];
    const results = await runStaticBundleActivation(
      [rec("@cinatra-ai/a")],
      deps({
        importServerEntry: () =>
          Promise.resolve({ server: { register: () => order.push("reg"), bootstrap: () => order.push("boot") } }),
      }),
    );
    expect(order).toEqual(["reg", "boot"]);
    expect(results.map((r) => r.status)).toEqual(["registered", "bootstrapped"]);
  });

  it("honors the config gate through the loader (config.enabled === false)", async () => {
    let registered = false;
    const results = await runStaticBundleActivation(
      [rec("@cinatra-ai/a")],
      deps({
        importServerEntry: () =>
          Promise.resolve({ register: () => { registered = true; }, config: { enabled: false } }),
      }),
    );
    expect(results[0]).toMatchObject({ status: "skipped", reason: "config-disabled" });
    expect(registered).toBe(false);
  });

  it("honors a dynamic config.resolve gate through the loader", async () => {
    let registered = false;
    const results = await runStaticBundleActivation(
      [rec("@cinatra-ai/a")],
      deps({
        importServerEntry: () =>
          Promise.resolve({ register: () => { registered = true; }, config: { resolve: () => false } }),
      }),
    );
    expect(results[0]).toMatchObject({ status: "skipped", reason: "config-resolve-false" });
    expect(registered).toBe(false);
  });

  it("isolates a FAILING-FIRST extension so a later one still registers + bootstraps", async () => {
    // Regression guard: a 'stop after first failure' regression would leave b
    // unregistered. b must still register AND bootstrap.
    const order: string[] = [];
    const importServerEntry = (p: string) => {
      const short = p.split("/")[1];
      if (short === "a") {
        return Promise.resolve({ register: () => { throw new Error("a boom"); }, bootstrap: () => order.push("boot:a") });
      }
      return Promise.resolve({ register: () => order.push("reg:b"), bootstrap: () => order.push("boot:b") });
    };
    const results = await runStaticBundleActivation(
      [rec("@cinatra-ai/a"), rec("@cinatra-ai/b")],
      deps({ importServerEntry }),
    );
    expect(results.find((r) => r.packageName === "@cinatra-ai/a")).toMatchObject({ status: "failed", reason: "register-threw" });
    expect(results.find((r) => r.packageName === "@cinatra-ai/b" && r.status === "registered")).toBeTruthy();
    expect(results.find((r) => r.packageName === "@cinatra-ai/b" && r.status === "bootstrapped")).toBeTruthy();
    // a failed register → a's bootstrap never runs; b's does.
    expect(order).toEqual(["reg:b", "boot:b"]);
  });

  it("skips when the importer is undefined (no importer registered)", async () => {
    const results = await runStaticBundleActivation([rec("@cinatra-ai/a")], deps({ importServerEntry: () => undefined }));
    expect(results[0]).toMatchObject({ status: "skipped", reason: "no-server-entry" });
  });

  it("skips a module whose imported entry has no register export", async () => {
    const results = await runStaticBundleActivation([rec("@cinatra-ai/a")], deps({ importServerEntry: () => Promise.resolve({}) }));
    expect(results[0]).toMatchObject({ status: "skipped", reason: "no-server-entry" });
  });

  it("isolates an import() rejection", async () => {
    const results = await runStaticBundleActivation(
      [rec("@cinatra-ai/a")],
      deps({ importServerEntry: () => Promise.reject(new Error("chunk load fail")) }),
    );
    expect(results[0]).toMatchObject({ status: "failed", reason: "register-threw" });
  });

  it("refuses an ABI-incompatible record BEFORE importing (no top-level module code runs)", async () => {
    // The ABI verdict must precede importServerEntry — importing executes the
    // module's top-level code, which must NOT run for an incompatible extension.
    let imported = false;
    let ran = false;
    const results = await runStaticBundleActivation(
      [rec("@cinatra-ai/a")],
      deps({
        abiCompatible: () => false,
        importServerEntry: () => {
          imported = true;
          return Promise.resolve({ register: () => { ran = true; } });
        },
      }),
    );
    expect(results[0]).toMatchObject({ status: "skipped", reason: "abi-incompatible" });
    expect(imported).toBe(false); // gate precedes import — module never loaded
    expect(ran).toBe(false);
  });

  it("passes a per-package ctx from makeContext", async () => {
    const ctxFor: string[] = [];
    let registerCtxPkg = "";
    const perPkgCtx = (p: string) => ({ abiVersion: "1.0.0", packageName: p } as unknown as ExtensionHostContext);
    await runStaticBundleActivation([rec("@cinatra-ai/a")], deps({
      makeContext: (p) => { ctxFor.push(p); return perPkgCtx(p); },
      importServerEntry: () => Promise.resolve({ register: (c: ExtensionHostContext) => { registerCtxPkg = c.packageName; } }),
    }));
    expect(ctxFor).toEqual(["@cinatra-ai/a"]);
    expect(registerCtxPkg).toBe("@cinatra-ai/a");
  });
});
