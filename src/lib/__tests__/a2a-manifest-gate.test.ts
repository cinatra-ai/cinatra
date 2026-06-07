import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/extensions/runtime-discovery-host", () => ({
  readActiveManifestsFromStore: vi.fn(),
}));

import { filterTemplatesToLiveManifest, readLiveAgentPackageNames } from "@/lib/a2a-manifest-gate";
import { readActiveManifestsFromStore } from "@cinatra-ai/extensions/runtime-discovery-host";

const t = (packageName: string | null) => ({ id: `id:${packageName}`, packageName });

describe("filterTemplatesToLiveManifest (shared A2A canonical-manifest gate)", () => {
  it("keeps ONLY templates whose package is in the live manifest set", () => {
    const out = filterTemplatesToLiveManifest(
      [t("@x/live"), t("@x/archived"), t("@x/never-installed")],
      new Set(["@x/live"]),
    );
    expect(out.map((r) => r.packageName)).toEqual(["@x/live"]);
  });

  it("keeps public AND private — a lifecycle gate, not a visibility filter", () => {
    const out = filterTemplatesToLiveManifest(
      [t("@public/a"), t("@private/b")],
      new Set(["@public/a", "@private/b"]),
    );
    expect(out.map((r) => r.packageName).sort()).toEqual(["@private/b", "@public/a"]);
  });

  it("drops null-packageName templates (cannot match a manifest)", () => {
    const out = filterTemplatesToLiveManifest([t(null), t("@x/live")], new Set(["@x/live"]));
    expect(out.map((r) => r.packageName)).toEqual(["@x/live"]);
  });

  it("fail-OPEN: null live set keeps every published template (same ref)", () => {
    const all = [t("@x/a"), t("@x/b"), t(null)];
    expect(filterTemplatesToLiveManifest(all, null)).toBe(all);
  });

  it("empty live set drops everything", () => {
    expect(filterTemplatesToLiveManifest([t("@x/a")], new Set())).toEqual([]);
  });
});

describe("readLiveAgentPackageNames", () => {
  it("returns the active|locked agent manifest package-name set", async () => {
    vi.mocked(readActiveManifestsFromStore).mockResolvedValue([
      { packageName: "@x/a" }, { packageName: "@x/b" },
    ] as never);
    const s = await readLiveAgentPackageNames();
    expect(s).not.toBeNull();
    expect([...(s as Set<string>)].sort()).toEqual(["@x/a", "@x/b"]);
    expect(readActiveManifestsFromStore).toHaveBeenCalledWith({ kind: "agent" });
  });

  it("FAIL-OPEN: returns null when the gate read throws", async () => {
    vi.mocked(readActiveManifestsFromStore).mockRejectedValue(new Error("db down"));
    expect(await readLiveAgentPackageNames()).toBeNull();
  });
});
