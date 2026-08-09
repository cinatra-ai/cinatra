import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/extensions/runtime-discovery-host", () => ({
  readActiveManifestsFromStore: vi.fn(),
}));
vi.mock("@cinatra-ai/agents/runtime-install-gate", () => ({
  resolveAgentRunAvailabilityMap: vi.fn(async () => new Map()),
}));

import { filterTemplatesToLiveManifest, readLiveAgentPackageNames } from "@/lib/a2a-manifest-gate";
import { readActiveManifestsFromStore } from "@cinatra-ai/extensions/runtime-discovery-host";
import { resolveAgentRunAvailabilityMap } from "@cinatra-ai/agents/runtime-install-gate";

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
    vi.mocked(resolveAgentRunAvailabilityMap).mockResolvedValue(
      new Map([
        ["@x/a", { state: "runnable" }],
        ["@x/b", { state: "runnable" }],
      ]) as never,
    );
    const s = await readLiveAgentPackageNames([
      { packageName: "@x/a", packageVersion: "1.0.0" },
      { packageName: "@x/b", packageVersion: "1.0.0" },
    ]);
    expect(s).not.toBeNull();
    expect([...(s as Set<string>)].sort()).toEqual(["@x/a", "@x/b"]);
    expect(readActiveManifestsFromStore).toHaveBeenCalledWith({ kind: "agent" });
  });

  it("FAIL-OPEN: returns null when the gate read throws", async () => {
    vi.mocked(readActiveManifestsFromStore).mockRejectedValue(new Error("db down"));
    expect(await readLiveAgentPackageNames([{ packageName: "@x/a", packageVersion: "1.0.0" }])).toBeNull();
  });

  // cinatra#2605 — a PUBLISHED agent whose required dependency is not installed
  // must not stay advertised over A2A / registered as an MCP tool while every
  // other surface refuses to run it.
  it("drops a live-manifest agent whose required dependency is not installed", async () => {
    vi.mocked(readActiveManifestsFromStore).mockResolvedValue([
      { packageName: "@x/runnable" }, { packageName: "@x/missing-dep" },
    ] as never);
    vi.mocked(resolveAgentRunAvailabilityMap).mockResolvedValue(
      new Map([
        ["@x/runnable", { state: "runnable" }],
        [
          "@x/missing-dep",
          {
            state: "missing-required-dependency",
            missing: [
              { packageName: "@x/dep", displayName: null, kind: "agent", reason: "not-installed" },
            ],
          },
        ],
      ]) as never,
    );
    const s = await readLiveAgentPackageNames([
      { packageName: "@x/runnable", packageVersion: "1.0.0" },
      { packageName: "@x/missing-dep", packageVersion: "1.0.0" },
    ]);
    expect([...(s as Set<string>)]).toEqual(["@x/runnable"]);
    // The narrowing asks about exactly the PUBLISHED items passed in (with
    // version), not a bare-name reconstruction of the manifest set.
    expect(resolveAgentRunAvailabilityMap).toHaveBeenCalledWith([
      { packageName: "@x/runnable", packageVersion: "1.0.0" },
      { packageName: "@x/missing-dep", packageVersion: "1.0.0" },
    ]);
  });

  it("FAIL-OPEN on an availability failure: keeps the manifest set unnarrowed", async () => {
    vi.mocked(readActiveManifestsFromStore).mockResolvedValue([
      { packageName: "@x/a" }, { packageName: "@x/b" },
    ] as never);
    vi.mocked(resolveAgentRunAvailabilityMap).mockRejectedValue(new Error("gate down"));
    const s = await readLiveAgentPackageNames([
      { packageName: "@x/a", packageVersion: "1.0.0" },
      { packageName: "@x/b", packageVersion: "1.0.0" },
    ]);
    expect([...(s as Set<string>)].sort()).toEqual(["@x/a", "@x/b"]);
  });

  // cinatra#2605 round 3 — the fix under test: the reader must pass each
  // published template's OWN packageVersion into the narrowing (not just its
  // packageName) so the shared availability layer can fence a catalog/template
  // version mismatch — an active published agent at a NEWER version than its
  // bundled catalog record must not have the catalog's stale dependency edges
  // applied unconditionally (the bug: a bare-name call left the fence
  // permanently open and the agent was wrongly dropped as
  // "missing-required-dependency").
  it("threads the published template's packageVersion so a catalog/template version mismatch can fence the dependency arm", async () => {
    vi.mocked(readActiveManifestsFromStore).mockResolvedValue([
      { packageName: "@x/newer-than-catalog" },
    ] as never);
    // The shared narrowing (exercised for real in runtime-install-gate.test.ts)
    // returns `runnable` for a version-fenced mismatch — the dependency arm is
    // skipped rather than evaluating the bundled catalog's stale edges. Here we
    // assert the READER supplies the version that makes that fencing possible.
    vi.mocked(resolveAgentRunAvailabilityMap).mockResolvedValue(
      new Map([["@x/newer-than-catalog", { state: "runnable" }]]) as never,
    );
    const s = await readLiveAgentPackageNames([
      { packageName: "@x/newer-than-catalog", packageVersion: "0.9.9" },
    ]);
    expect(resolveAgentRunAvailabilityMap).toHaveBeenCalledWith([
      { packageName: "@x/newer-than-catalog", packageVersion: "0.9.9" },
    ]);
    expect([...(s as Set<string>)]).toEqual(["@x/newer-than-catalog"]);
  });

  // cinatra#2605 round 3 — multiple published templates can share a
  // packageName at DIFFERENT versions. The reader must pass BOTH pairs through
  // undeduped so the shared narrowing can detect the ambiguity itself
  // (`versionAmbiguous`) rather than the reader silently collapsing to one
  // version and letting a mismatched verdict speak for the other build.
  it("passes multiple published versions of one package as separate pairs (not deduped) for the narrowing to detect ambiguity", async () => {
    vi.mocked(readActiveManifestsFromStore).mockResolvedValue([
      { packageName: "@x/multi-version" },
    ] as never);
    vi.mocked(resolveAgentRunAvailabilityMap).mockResolvedValue(
      new Map([["@x/multi-version", { state: "runnable" }]]) as never,
    );
    const s = await readLiveAgentPackageNames([
      { packageName: "@x/multi-version", packageVersion: "0.1.2" },
      { packageName: "@x/multi-version", packageVersion: "0.9.9" },
    ]);
    expect(resolveAgentRunAvailabilityMap).toHaveBeenCalledWith([
      { packageName: "@x/multi-version", packageVersion: "0.1.2" },
      { packageName: "@x/multi-version", packageVersion: "0.9.9" },
    ]);
    expect([...(s as Set<string>)]).toEqual(["@x/multi-version"]);
  });
});
