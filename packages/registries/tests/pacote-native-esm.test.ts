import { expect, it, vi } from "vitest";

const packument = vi.hoisted(() => vi.fn());
// Node cannot synthesize named exports for pacote's computed CommonJS methods.
// Match that namespace shape, unlike the named-export mocks in other suites.
vi.mock("pacote", () => ({ default: { packument } }));

import { resolveExtensionDistIntegrity } from "../src/verdaccio/client";

it("reads a pinned manifest through a native CommonJS default export and keeps registry auth scoped", async () => {
  packument.mockResolvedValue({
    versions: { "1.0.0": { dist: { integrity: "sha512-fixture" } } },
  });
  const result = await resolveExtensionDistIntegrity(
    { packageName: "@fixture/agent", packageVersion: "1.0.0" },
    { registryUrl: "https://registry.example.test", packageScope: "@fixture", token: "test-only", uiUrl: null },
  );
  expect(result.integrity).toBe("sha512-fixture");
  expect(packument).toHaveBeenCalledWith("@fixture/agent", expect.objectContaining({
    "//registry.example.test/:_authToken": "test-only",
  }));
});
