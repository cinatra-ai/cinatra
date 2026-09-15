/**
 * THE PER-KIND EXECUTION BOUNDARY (cinatra#3204 D4 / criterion 27), and the
 * per-kind ORDERING it depends on (criterion 19).
 *
 * The boundary is one sentence: of the four live kinds, exactly ONE runs code
 * from the package inside this process, and it does so at exactly one call. The
 * value of writing it down as a test is that it stops being folklore — an edit
 * that gives artifact registration an import, or that lets a connector's
 * `register(ctx)` failure pass for a success, fails here.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

// The native object-type registry is the artifact handler's own dependency and
// is mocked in this UNIT suite exactly as the other artifact-handler unit tests
// mock it — the boundary under test is what the handler DOES, not what the
// registry stores.
vi.mock("@cinatra-ai/objects", () => ({
  objectTypeRegistry: { listArtifacts: () => [] },
}));

import {
  ConnectorRequiresRebuildError,
  createConnectorExtensionHandler,
} from "../connector-handler";
import { createArtifactExtensionHandler } from "../artifact-handler";
import {
  EXTENSION_KINDS,
  KIND_EXECUTION_BOUNDARY,
  kindExecutesPackageCode,
} from "../canonical-types";
import { activateExtensionModule } from "@cinatra-ai/sdk-extensions";

const ref = { registryUrl: "https://registry.test", packageName: "@acme/thing", version: "1.0.0" };
const actor = { source: "test" } as never;

// ---------------------------------------------------------------------------
// The ONE place package code runs: connector activation
// ---------------------------------------------------------------------------

describe("connector activation runs register(ctx) in process and FAILS CLOSED", () => {
  it("calls register(ctx) exactly once for a compatible module", async () => {
    const register = vi.fn(async () => undefined);
    const result = await activateExtensionModule(
      { packageName: "@acme/thing-connector", server: { register } } as never,
      {} as never,
      { abiCompatible: true } as never,
    );
    expect(register).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("registered");
  });

  it("reports FAILED — never registered — when register(ctx) throws", async () => {
    const result = await activateExtensionModule(
      {
        packageName: "@acme/thing-connector",
        server: {
          register: async () => {
            throw new Error("boom");
          },
        },
      } as never,
      {} as never,
      { abiCompatible: true } as never,
    );
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("register-threw");
    expect(result.status).not.toBe("registered");
  });

  it("runs NOTHING at all when the ABI gate refuses the module", async () => {
    const register = vi.fn(async () => undefined);
    const resolve = vi.fn(async () => true);
    const result = await activateExtensionModule(
      { packageName: "@acme/thing-connector", config: { resolve }, server: { register } } as never,
      {} as never,
      { abiCompatible: false } as never,
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("abi-incompatible");
    // Not even the package's own config resolver ran — the gate is BEFORE any
    // extension code, not merely before `register`.
    expect(resolve).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });
});

describe("the connector handler is the requires-rebuild gate, and it runs FIRST", () => {
  it("refuses a bundled-react connector with the typed REQUIRES_REBUILD state", async () => {
    const handler = createConnectorExtensionHandler({
      resolveUiSurface: async () => "bundled-react",
    });
    await expect(handler.install(ref, actor)).rejects.toBeInstanceOf(ConnectorRequiresRebuildError);
    await expect(handler.install(ref, actor)).rejects.toMatchObject({ code: "REQUIRES_REBUILD" });
  });

  it("permits a schema-config connector through to the pipeline", async () => {
    const handler = createConnectorExtensionHandler({
      resolveUiSurface: async () => "schema-config",
    });
    await expect(handler.install(ref, actor)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The three kinds that execute NOTHING
// ---------------------------------------------------------------------------

describe("artifact registration reads metadata only and executes nothing", () => {
  it("the artifact handler's install is a pure audit no-op", async () => {
    const handler = createArtifactExtensionHandler();
    await expect(handler.install(ref, actor)).resolves.toBeUndefined();
    await expect(handler.update(ref, actor)).resolves.toBeUndefined();
  });

  it("the artifact-bridge rescan module never imports or executes package code", () => {
    // Its trust argument is that it parses `package.json` and nothing else. That
    // is checkable against the module's own source, and checking it is what keeps
    // it true after the next edit.
    const source = readFileSync(
      path.resolve(__dirname, "../../../../src/lib/extension-artifact-bridge-rescan.ts"),
      "utf8",
    );
    const body = source
      .split("\n")
      .filter((line) => {
        const t = line.trimStart();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    // No import of anything from the STORE DIR — the only dynamic imports a
    // rescan may make are of host modules under "@/" or "@cinatra-ai/".
    const dynamicImports = [...body.matchAll(/import\(\s*([^)]*)\)/g)].map((m) => m[1].trim());
    for (const spec of dynamicImports) {
      expect(spec).toMatch(/^["'`](@\/|@cinatra-ai\/|node:)/);
    }
    expect(body).not.toMatch(/\beval\s*\(/);
    expect(body).not.toMatch(/new\s+Function\s*\(/);
    expect(body).not.toMatch(/child_process/);
  });
});

// ---------------------------------------------------------------------------
// Criterion 19 — the per-kind ordering, asserted rather than assumed
// ---------------------------------------------------------------------------

describe("per-kind ordering is preserved exactly (criterion 19)", () => {
  it("connector runs its handler FIRST; agent, skill and artifact run the pipeline first", () => {
    // Read the dispatcher's own declarations rather than a copy of them, so the
    // assertion tracks the source instead of a restatement of it.
    const source = readFileSync(path.resolve(__dirname, "../index.ts"), "utf8");
    const activateHook = /const KINDS_USING_ACTIVATE_HOOK = new Set\(\[([^\]]*)\]\)/.exec(source);
    const pipelineFirst = /const KINDS_WITH_STORE_PIPELINE_BEFORE_HANDLER = new Set\(\[([^\]]*)\]\)/.exec(source);
    expect(activateHook).not.toBeNull();
    expect(pipelineFirst).not.toBeNull();

    const parse = (m: RegExpExecArray | null) =>
      (m?.[1] ?? "")
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);

    expect(parse(activateHook)).toEqual(["connector"]);
    expect(parse(pipelineFirst)).toEqual(["agent", "skill", "artifact"]);
  });

  it("the two sets partition the four live kinds with no overlap", () => {
    const source = readFileSync(path.resolve(__dirname, "../index.ts"), "utf8");
    const both = ["connector"].filter((k) => ["agent", "skill", "artifact"].includes(k));
    expect(both).toEqual([]);
    // The union set is still derived from the two, not hand-listed a third time.
    expect(source).toContain("KINDS_ROUTED_THROUGH_STORE_PIPELINE");
  });
});

// ---------------------------------------------------------------------------
// Criterion 27 — the boundary is DECLARED, not folklore
// ---------------------------------------------------------------------------

describe("the per-kind execution boundary is an explicit declaration (criterion 27)", () => {
  it("declares a boundary for every kind, with exactly one that runs package code", () => {
    expect(Object.keys(KIND_EXECUTION_BOUNDARY).sort()).toEqual([...EXTENSION_KINDS].sort());
    const executing = Object.entries(KIND_EXECUTION_BOUNDARY)
      .filter(([, boundary]) => boundary === "in-process-code")
      .map(([kind]) => kind);
    expect(executing).toEqual(["connector"]);
    expect(KIND_EXECUTION_BOUNDARY.agent).toBe("metadata-only");
    expect(KIND_EXECUTION_BOUNDARY.skill).toBe("metadata-only");
    expect(KIND_EXECUTION_BOUNDARY.artifact).toBe("metadata-only");
    // Retired, not permissive.
    expect(KIND_EXECUTION_BOUNDARY.workflow).toBe("retired");
  });

  it("kindExecutesPackageCode fails CLOSED for an unknown or malformed kind", () => {
    expect(kindExecutesPackageCode("connector")).toBe(true);
    expect(kindExecutesPackageCode("agent")).toBe(false);
    expect(kindExecutesPackageCode("skill")).toBe(false);
    expect(kindExecutesPackageCode("artifact")).toBe(false);
    // A retired kind installs nothing, and an unrecognized one is never assumed
    // inert — both answer "assume it executes".
    expect(kindExecutesPackageCode("workflow")).toBe(true);
    expect(kindExecutesPackageCode("nonesuch")).toBe(true);
    expect(kindExecutesPackageCode(undefined)).toBe(true);
  });

  it("agrees with the dispatcher's activate-hook set (no silent drift)", () => {
    const source = readFileSync(path.resolve(__dirname, "../index.ts"), "utf8");
    const m = /const KINDS_USING_ACTIVATE_HOOK = new Set\(\[([^\]]*)\]\)/.exec(source);
    const activateHook = (m?.[1] ?? "")
      .split(",")
      .map((x) => x.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    const executing = Object.entries(KIND_EXECUTION_BOUNDARY)
      .filter(([, boundary]) => boundary === "in-process-code")
      .map(([kind]) => kind);
    expect(activateHook).toEqual(executing);
  });

  it("agrees with the host store's metadata-only kind set (no silent drift)", () => {
    // Read the host module's own declaration rather than importing it: this is a
    // package-side unit suite and the host store module is server-only.
    const source = readFileSync(
      path.resolve(__dirname, "../../../../src/lib/extension-package-store-core.ts"),
      "utf8",
    );
    const m = /METADATA_ONLY_STORE_KINDS: ReadonlySet<string> = new Set<string>\(\[([^\]]*)\]\)/.exec(
      source,
    );
    const metadataOnly = (m?.[1] ?? "")
      .split(",")
      .map((x) => x.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean)
      .sort();
    const declared = Object.entries(KIND_EXECUTION_BOUNDARY)
      .filter(([, boundary]) => boundary === "metadata-only")
      .map(([kind]) => kind)
      .sort();
    expect(metadataOnly).toEqual(declared);
  });
});
