/**
 * cinatra#2398 — REGRESSION PIN for the always-on registration path.
 *
 * The whole defect was a placement one: the co-located skill scan existed only
 * on the DETACHED DEV block (`dev-boot.ts` -> `loadAllSkillPackagesAtBoot`,
 * which returns immediately unless `CINATRA_RUNTIME_MODE === "development"`),
 * so a production standalone boot never registered an image-bundled
 * extension's `skills/<slug>/SKILL.md` at all. These assertions exist so the
 * phase cannot quietly become dev-only again — by policy, by placement, or by
 * being dropped from the sequence.
 *
 * The ORDER assertion (before `skills-catalog-rebuild`) is pinned by the
 * orchestrator's own sequence tests, in BOTH the dev and the prod list.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ register: vi.fn(async () => ({ registered: [], retired: [], sweepSkippedReason: null })) }));

vi.mock("@cinatra-ai/skills/bundled-skill-registration", () => ({
  registerBundledColocatedSkills: h.register,
}));

import { bundledSkillRegistrationPhases } from "@/lib/boot/phases/bundled-skill-registration";

beforeEach(() => {
  h.register.mockClear();
});

describe("bundled-skill-registration boot phase", () => {
  it("is declared ALWAYS-ON — never `dev-only`", () => {
    const [phase] = bundledSkillRegistrationPhases();
    expect(phase).toBeDefined();
    expect(phase!.name).toBe("bundled-skill-registration");
    expect(phase!.policy).not.toBe("dev-only");
    // `degraded`: a registration failure must not abort boot — the lazy
    // resolver still self-heals on demand, exactly as it did before.
    expect(phase!.policy).toBe("degraded");
  });

  it("drives the registrar when the runtime mode is PRODUCTION", async () => {
    const prior = process.env.CINATRA_RUNTIME_MODE;
    process.env.CINATRA_RUNTIME_MODE = "production";
    try {
      const [phase] = bundledSkillRegistrationPhases();
      await phase!.run();
      expect(h.register).toHaveBeenCalledTimes(1);
    } finally {
      if (prior === undefined) delete process.env.CINATRA_RUNTIME_MODE;
      else process.env.CINATRA_RUNTIME_MODE = prior;
    }
  });

  it("carries no runtime-mode branch of its own — dev drives the same registrar", async () => {
    const prior = process.env.CINATRA_RUNTIME_MODE;
    process.env.CINATRA_RUNTIME_MODE = "development";
    try {
      const [phase] = bundledSkillRegistrationPhases();
      await phase!.run();
      expect(h.register).toHaveBeenCalledTimes(1);
    } finally {
      if (prior === undefined) delete process.env.CINATRA_RUNTIME_MODE;
      else process.env.CINATRA_RUNTIME_MODE = prior;
    }
  });

  it("propagates a registrar failure to the runner, which the `degraded` policy swallows", async () => {
    h.register.mockRejectedValueOnce(new Error("catalog unavailable"));
    const [phase] = bundledSkillRegistrationPhases();
    await expect(phase!.run()).rejects.toThrow("catalog unavailable");
  });
});
