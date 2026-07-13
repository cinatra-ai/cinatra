import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveSchemaConfigInitialValues } from "@/lib/extension-config-hydration";
import { parseSchemaConfig, type SchemaConfigSurface } from "@/lib/extension-schema-config";

// The host SERVER-side hydration resolver (the opt-in hydration read-action
// contract, cinatra#1082 item 3; owner-ratified). Every failure path must
// resolve `{}` — a blank form — never a throw (which would 500 the setup page).

function surface(raw: unknown): SchemaConfigSurface {
  const r = parseSchemaConfig(raw);
  if (!r.ok) throw new Error(`expected ok, got: ${r.errors.join("; ")}`);
  return r.surface;
}

const PKG = "@cinatra-ai/anthropic-connector";

const hydratingSurface = surface({
  fields: [
    { kind: "text", key: "baseUrl", label: "Base URL" },
    { kind: "secret", key: "apiKey", label: "API key" },
    { kind: "boolean", key: "streaming", label: "Streaming" },
  ],
  hydrateAction: "readConfig",
});

const optedOutSurface = surface({
  fields: [{ kind: "text", key: "baseUrl", label: "Base URL" }],
});

const deps = (
  handler: (input: unknown) => Promise<unknown>,
  extra?: { timeoutMs?: number },
) => ({
  resolveAction: vi.fn((pkg: string, actionId: string) =>
    pkg === PKG && actionId === "readConfig" ? { handler } : null,
  ),
  ...extra,
});

describe("resolveSchemaConfigInitialValues — happy path", () => {
  it("invokes the declared read-action server-side and threads sanitized values", async () => {
    const handler = vi.fn(async () => ({
      baseUrl: "https://api.example",
      streaming: true,
      apiKey: "sk-LEAKED", // must be refused
      stray: "dropped",
    }));
    const d = deps(handler);
    const out = await resolveSchemaConfigInitialValues(
      { surface: hydratingSurface, packageName: PKG, installId: "install-1" },
      d,
    );
    expect(out).toEqual({ baseUrl: "https://api.example", streaming: "true" });
    expect(handler).toHaveBeenCalledWith({});
    expect(d.resolveAction).toHaveBeenCalledWith(PKG, "readConfig");
  });
});

describe("resolveSchemaConfigInitialValues — opt-out default", () => {
  it("no declaration → {} and the registry is NEVER consulted", async () => {
    const d = deps(vi.fn(async () => ({ baseUrl: "x" })));
    const out = await resolveSchemaConfigInitialValues(
      { surface: optedOutSurface, packageName: PKG, installId: "install-1" },
      d,
    );
    expect(out).toEqual({});
    expect(d.resolveAction).not.toHaveBeenCalled();
  });

  it("no addressable install (installId null) → {} and the handler never runs", async () => {
    const handler = vi.fn(async () => ({ baseUrl: "x" }));
    const d = deps(handler);
    const out = await resolveSchemaConfigInitialValues(
      { surface: hydratingSurface, packageName: PKG, installId: null },
      d,
    );
    expect(out).toEqual({});
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("resolveSchemaConfigInitialValues — fail-closed", () => {
  it("declared action not registered → {}", async () => {
    const out = await resolveSchemaConfigInitialValues(
      { surface: hydratingSurface, packageName: PKG, installId: "install-1" },
      { resolveAction: () => null },
    );
    expect(out).toEqual({});
  });

  it("handler throws → {} (never a throw out of the resolver)", async () => {
    const out = await resolveSchemaConfigInitialValues(
      { surface: hydratingSurface, packageName: PKG, installId: "install-1" },
      deps(async () => {
        throw new Error("connector exploded");
      }),
    );
    expect(out).toEqual({});
  });

  it("handler rejects synchronously-shaped rejections too → {}", async () => {
    const out = await resolveSchemaConfigInitialValues(
      { surface: hydratingSurface, packageName: PKG, installId: "install-1" },
      deps(() => Promise.reject(new Error("nope"))),
    );
    expect(out).toEqual({});
  });

  it.each([
    ["a string", "nope"],
    ["null", null],
    ["an array", [1, 2]],
    ["undefined", undefined],
  ])("malformed top-level result (%s) → {}", async (_name, result) => {
    const out = await resolveSchemaConfigInitialValues(
      { surface: hydratingSurface, packageName: PKG, installId: "install-1" },
      deps(async () => result),
    );
    expect(out).toEqual({});
  });

  it("secret-field refusal: a result that is ONLY secrets hydrates nothing", async () => {
    const out = await resolveSchemaConfigInitialValues(
      { surface: hydratingSurface, packageName: PKG, installId: "install-1" },
      deps(async () => ({ apiKey: "sk-LEAKED" })),
    );
    expect(out).toEqual({});
  });

  it("a hung handler times out → {} (the render is never suspended)", async () => {
    const never = new Promise<unknown>(() => {
      /* never settles */
    });
    const out = await resolveSchemaConfigInitialValues(
      { surface: hydratingSurface, packageName: PKG, installId: "install-1" },
      deps(() => never, { timeoutMs: 20 }),
    );
    expect(out).toEqual({});
  });

  it("an invalid injected timeout falls back to the default (does not disable the race)", async () => {
    // NaN timeout must not make setTimeout fire immediately-with-NaN semantics
    // decide the contract — a FAST handler still wins the race and hydrates.
    const out = await resolveSchemaConfigInitialValues(
      { surface: hydratingSurface, packageName: PKG, installId: "install-1" },
      deps(async () => ({ baseUrl: "https://api.example" }), { timeoutMs: Number.NaN }),
    );
    expect(out).toEqual({ baseUrl: "https://api.example" });
  });
});

// ---------------------------------------------------------------------------
// SEAM PIN — the setup route actually threads the resolver into BOTH
// schema-config layouts. Rendering the RSC page in a unit test would need the
// whole auth/DB/registry graph, so this pins the seam at the source level
// instead (same pin-test convention as
// mcp-server-connector-schema-config-pin.test.ts). If open PR #1323's renderer
// restructure (or any later change) drops the `initialValues` thread from a
// `<SchemaConfigConnectorForm>` render site, this goes red.
// ---------------------------------------------------------------------------
describe("setup-route seam pin", () => {
  const pageSource = fs.readFileSync(
    path.join(__dirname, "../../app/connectors/[vendor]/[slug]/[subroute]/page.tsx"),
    "utf8",
  );

  it("the route resolves hydration server-side via the resolver", () => {
    expect(pageSource).toContain("resolveSchemaConfigInitialValues(");
    expect(pageSource).toContain('from "@/lib/extension-config-hydration"');
    // The registry read the route injects (the ctx.ui singleton).
    expect(pageSource).toContain("resolveAction: resolveExtensionUiAction");
  });

  it("EVERY SchemaConfigConnectorForm render site threads initialValues", () => {
    const sites = pageSource.match(/<SchemaConfigConnectorForm[\s\S]*?\/>/g) ?? [];
    expect(sites.length).toBeGreaterThanOrEqual(2); // both layouts (status-probe + probe-less)
    for (const site of sites) {
      expect(site).toContain("initialValues={initialValues}");
    }
  });

  it("the route threads the version-keyed resolver + version identity (S9 non-default serve)", () => {
    expect(pageSource).toContain("resolveActiveInstallForActor");
    expect(pageSource).toContain("resolveVersionedAction:");
    expect(pageSource).toContain("resolveVersionKeyedUiAction");
    expect(pageSource).toContain("isDefault: activeInstall?.isDefault");
  });
});

// cinatra#1392 S9 — a NON-DEFAULT addressed install hydrates from ITS version's
// action (version-keyed), fail-closed to a BLANK form; never the default's.
describe("resolveSchemaConfigInitialValues — non-default version serve (S9)", () => {
  const versionedHandler = vi.fn(async () => ({ baseUrl: "https://v014.example", streaming: false }));
  const versionedDeps = () => ({
    // The default global resolver must NOT be consulted for a non-default install.
    resolveAction: vi.fn(() => ({ handler: async () => ({ baseUrl: "https://DEFAULT.leaked" }) })),
    resolveVersionedAction: vi.fn((pkg: string, ver: string | null | undefined, actionId: string) =>
      pkg === PKG && ver === "0.1.4" && actionId === "readConfig" ? { handler: versionedHandler } : null,
    ),
  });

  it("serves the version-keyed hydrate action for a non-default install (never the default's)", async () => {
    const d = versionedDeps();
    const out = await resolveSchemaConfigInitialValues(
      { surface: hydratingSurface, packageName: PKG, installId: "install-nd", isDefault: false, version: "0.1.4" },
      d,
    );
    expect(out).toEqual({ baseUrl: "https://v014.example", streaming: "false" });
    expect(d.resolveVersionedAction).toHaveBeenCalledWith(PKG, "0.1.4", "readConfig");
    expect(d.resolveAction).not.toHaveBeenCalled(); // fail-closed: no default fall-through
  });

  it("fail-closes to a BLANK form for a non-default install whose version registers no such action", async () => {
    const d = versionedDeps();
    const out = await resolveSchemaConfigInitialValues(
      { surface: hydratingSurface, packageName: PKG, installId: "install-nd", isDefault: false, version: "9.9.9" },
      d,
    );
    expect(out).toEqual({}); // version 9.9.9 has no served action → blank, never the default
    expect(d.resolveAction).not.toHaveBeenCalled();
  });

  it("fail-closes to a BLANK form for a non-default install when NO version-keyed resolver is wired", async () => {
    const resolveAction = vi.fn(() => ({ handler: async () => ({ baseUrl: "https://DEFAULT.leaked" }) }));
    const out = await resolveSchemaConfigInitialValues(
      { surface: hydratingSurface, packageName: PKG, installId: "install-nd", isDefault: false, version: "0.1.4" },
      { resolveAction }, // no resolveVersionedAction
    );
    expect(out).toEqual({});
    expect(resolveAction).not.toHaveBeenCalled();
  });

  it("a DEFAULT install (isDefault omitted or true) keeps the global path — version-keyed never consulted", async () => {
    const d = versionedDeps();
    const out = await resolveSchemaConfigInitialValues(
      { surface: hydratingSurface, packageName: PKG, installId: "install-1", isDefault: true, version: "1.0.0" },
      d,
    );
    expect(out).toEqual({ baseUrl: "https://DEFAULT.leaked" });
    expect(d.resolveVersionedAction).not.toHaveBeenCalled();
  });
});
