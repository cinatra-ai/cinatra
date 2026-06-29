import { describe, expect, it } from "vitest";

import {
  decideRuntimeCubeServe,
  filterServeableCubeIds,
  type RuntimeCubeInstallFacts,
} from "../runtime-cube-serve-gate";

const RUNTIME = new Set(["ext_runtime", "ext_other"]);
const isRuntimeCube = (id: string) => RUNTIME.has(id);

const live = (status: "active" | "locked"): RuntimeCubeInstallFacts => ({
  actorVisible: true,
  status,
  trust: { trusted: true },
});

describe("decideRuntimeCubeServe", () => {
  it("ALLOWS a bundled cube without consulting install facts (install-row bypass)", () => {
    const r = decideRuntimeCubeServe({ cubeId: "agent_runs", isRuntimeCube, facts: null });
    expect(r.ok).toBe(true);
  });

  it("ALLOWS a runtime cube that is install-active (active) AND trusted", () => {
    const r = decideRuntimeCubeServe({ cubeId: "ext_runtime", isRuntimeCube, facts: live("active") });
    expect(r.ok).toBe(true);
  });

  it("ALLOWS a runtime cube that is install-active (locked = platform-required) AND trusted", () => {
    const r = decideRuntimeCubeServe({ cubeId: "ext_runtime", isRuntimeCube, facts: live("locked") });
    expect(r.ok).toBe(true);
  });

  it("DENIES a runtime cube with NO facts (no addressable install) — cube_not_active", () => {
    const r = decideRuntimeCubeServe({ cubeId: "ext_runtime", isRuntimeCube, facts: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("cube_not_active");
  });

  it("DENIES a runtime cube not addressable to the actor — cube_not_active", () => {
    const r = decideRuntimeCubeServe({
      cubeId: "ext_runtime",
      isRuntimeCube,
      facts: { actorVisible: false, status: "active", trust: { trusted: true } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("cube_not_active");
  });

  it("DENIES a runtime cube whose install is archived/absent — cube_not_active", () => {
    for (const status of ["archived", "absent"] as const) {
      const r = decideRuntimeCubeServe({
        cubeId: "ext_runtime",
        isRuntimeCube,
        facts: { actorVisible: true, status, trust: { trusted: true } },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("cube_not_active");
    }
  });

  it("DENIES a runtime cube with null trust (trust==null is deny) — cube_untrusted", () => {
    const r = decideRuntimeCubeServe({
      cubeId: "ext_runtime",
      isRuntimeCube,
      facts: { actorVisible: true, status: "active", trust: null },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("cube_untrusted");
  });

  it("DENIES a runtime cube whose trust is not trusted — cube_untrusted", () => {
    const r = decideRuntimeCubeServe({
      cubeId: "ext_runtime",
      isRuntimeCube,
      facts: { actorVisible: true, status: "active", trust: { trusted: false } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("cube_untrusted");
  });
});

describe("filterServeableCubeIds (catalog filter)", () => {
  it("keeps all bundled cubes + only serveable runtime cubes", async () => {
    const out = await filterServeableCubeIds({
      cubeIds: ["agent_runs", "projects", "ext_runtime", "ext_other"],
      isRuntimeCube,
      factsFor: async (id) => (id === "ext_runtime" ? live("active") : null), // ext_other: no install
    });
    expect(out).toEqual(["agent_runs", "projects", "ext_runtime"]);
  });
});
