import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("pacote", () => ({ packument: vi.fn() }));
import * as pacote from "pacote";
import { listExtensionPackages } from "../src/verdaccio/client";
import type { VerdaccioConfig } from "../src/types";

const CONFIG: VerdaccioConfig = {
  registryUrl: "https://registry.example.test",
  packageScope: "@acme",
  token: null,
  uiUrl: null,
};

async function catalogEntry(manifest: Record<string, unknown>) {
  const packageName = "@acme/example-extension";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ [packageName]: {} }))));
  vi.mocked(pacote.packument).mockResolvedValue({
    "dist-tags": { latest: "0.1.0" },
    versions: { "0.1.0": { name: packageName, version: "0.1.0", ...manifest } },
  } as never);
  return (await listExtensionPackages({ limit: 10 }, CONFIG))[0];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("registry display metadata (cinatra#3571)", () => {
  it.each(["agent", "skill", "connector", "artifact"])(
    "preserves the %s manifest's human name and vendor independently of npm author",
    async (kind) => {
      const row = await catalogEntry({
        title: "Legacy package title",
        author: "Package maintainer",
        cinatra: { kind, displayName: "Example Extension", vendor: { key: "acme", name: "Acme Studio" } },
      });
      expect(row).toMatchObject({ title: "Example Extension", vendorName: "Acme Studio", author: "Package maintainer", packageVersion: "0.1.0", kind });
    },
  );

  it("keeps declared metadata when a published pack has no npm title or author", async () => {
    const row = await catalogEntry({ cinatra: { kind: "artifact", displayName: "JSON", vendor: { key: "acme", name: "Acme Studio" } } });
    expect(row).toMatchObject({ title: "JSON", vendorName: "Acme Studio", author: null });
  });

  it("retains legacy title and author when extension display metadata is absent", async () => {
    expect(await catalogEntry({ title: "Legacy title", author: { name: "Legacy author" }, cinatra: { kind: "skill" } })).toMatchObject({ title: "Legacy title", author: "Legacy author" });
  });

  it.each(["", "   ", 42, { name: "invalid" }])("ignores invalid or empty display metadata: %j", async (displayName) => {
    const row = await catalogEntry({ title: "Legacy title", cinatra: { kind: "artifact", displayName, vendor: { name: displayName } } });
    expect(row?.title).toBe("Legacy title");
    expect(row?.vendorName ?? null).toBeNull();
  });
});
