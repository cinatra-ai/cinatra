// A missing version of a published extension is a typed refusal, not a bare
// error (cinatra#4920): the CLI install route returns 404 for it instead of a
// generic 500. `ETARGET` is npm's own code for "no such version".

import { describe, expect, it, vi } from "vitest";

vi.mock("pacote", () => ({ packument: vi.fn(), extract: vi.fn() }));
import * as pacote from "pacote";
import { getPublishedExtensionSummary } from "../src/verdaccio/client";
import type { VerdaccioConfig } from "../src/types";

const CONFIG: VerdaccioConfig = {
  registryUrl: "https://registry.example.test",
  packageScope: "@example-org",
  token: null,
  uiUrl: null,
};

describe("getPublishedExtensionSummary — missing version", () => {
  it("throws with code ETARGET when the requested version is not published", async () => {
    vi.mocked(pacote.packument).mockResolvedValue({
      "dist-tags": { latest: "1.2.0" },
      versions: { "1.2.0": { name: "@example-org/example-agent", version: "1.2.0", cinatra: { kind: "agent" } } },
    } as never);
    const err = await getPublishedExtensionSummary(
      { packageName: "@example-org/example-agent", packageVersion: "9.9.9" },
      CONFIG,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: unknown }).code).toBe("ETARGET");
    expect((err as Error).message).toMatch(/version 9\.9\.9 of @example-org\/example-agent not found/);
  });
});
