// What a published agent's summary reads, now that a tarball ships no root
// `agent.json` (cinatra#4920).
//
// The release note rides in the package manifest's `cinatra` block
// (`cinatra.changelog`); the publish time is the registry's own record for the
// version (`time[version]` of the full packument). `getAgentPackage` feeds both
// to the summary that the registry detail screen and `agent_registry_list` read.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

vi.mock("pacote", () => ({ packument: vi.fn(), extract: vi.fn() }));
import * as pacote from "pacote";
import { getAgentPackage } from "../src/verdaccio/client";
import type { VerdaccioConfig } from "../src/types";

const CONFIG: VerdaccioConfig = {
  registryUrl: "https://registry.example.test",
  packageScope: "@example-org",
  token: null,
  uiUrl: null,
};

const PACKAGE_NAME = "@example-org/example-agent";
const OAS_DOCUMENT = { component_type: "Flow", name: "example-agent" };

/** Serve one version: the packument (with its publish time) and the extracted tree. */
function serveVersion(options: {
  cinatra: Record<string, unknown>;
  time?: Record<string, string>;
}): void {
  vi.mocked(pacote.packument).mockResolvedValue({
    "dist-tags": { latest: "1.2.0" },
    versions: { "1.2.0": { name: PACKAGE_NAME, version: "1.2.0" } },
    ...(options.time ? { time: options.time } : {}),
  } as never);
  vi.mocked(pacote.extract).mockImplementation((async (_spec: string, dest: string) => {
    await mkdir(join(dest, "cinatra"), { recursive: true });
    await writeFile(
      join(dest, "package.json"),
      JSON.stringify({ name: PACKAGE_NAME, version: "1.2.0", cinatra: { kind: "agent", ...options.cinatra } }),
      "utf8",
    );
    await writeFile(join(dest, "cinatra", "oas.json"), JSON.stringify(OAS_DOCUMENT), "utf8");
    return {} as never;
  }) as never);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("getAgentPackage summary fields that no root agent.json carries (cinatra#4920)", () => {
  it("reads the changelog from the manifest's cinatra block", async () => {
    serveVersion({ cinatra: { changelog: "  Fixed the retry loop  " } });
    const detail = await getAgentPackage({ packageName: PACKAGE_NAME }, CONFIG);
    expect(detail.changelog).toBe("Fixed the retry loop");
  });

  it("has no changelog when the manifest declares none or a blank one", async () => {
    serveVersion({ cinatra: {} });
    expect((await getAgentPackage({ packageName: PACKAGE_NAME }, CONFIG)).changelog).toBeNull();
    serveVersion({ cinatra: { changelog: "   " } });
    expect((await getAgentPackage({ packageName: PACKAGE_NAME }, CONFIG)).changelog).toBeNull();
    serveVersion({ cinatra: { changelog: 42 } });
    expect((await getAgentPackage({ packageName: PACKAGE_NAME }, CONFIG)).changelog).toBeNull();
  });

  it("reads the publish time from the packument's time for the extracted version", async () => {
    serveVersion({
      cinatra: {},
      time: { "1.1.0": "2026-01-01T00:00:00.000Z", "1.2.0": "2026-02-03T04:05:06.000Z" },
    });
    const detail = await getAgentPackage({ packageName: PACKAGE_NAME }, CONFIG);
    expect(detail.publishedAt).toBe("2026-02-03T04:05:06.000Z");
  });

  it("has an empty publish time when the packument carries none", async () => {
    serveVersion({ cinatra: {} });
    const detail = await getAgentPackage({ packageName: PACKAGE_NAME }, CONFIG);
    expect(detail.publishedAt).toBe("");
  });
});
