/**
 * Install-profile + dev-fixture activation contract (`cinatra install demo`;
 * cinatra-cli#122). Pure env logic — no IO, no mocks needed. Proves the
 * relocation matrix: demo ⇒ always seed; dev default ⇒ never; dev opt-in ⇒ seed;
 * prod ⇒ never (both CINATRA_RUNTIME_MODE=production and NODE_ENV=production).
 */
import { describe, it, expect } from "vitest";
import {
  getInstallProfile,
  isDemoProfile,
  isEnvFlagEnabled,
  shouldRunDemoSeed,
  shouldSeedDevFixtures,
} from "@/lib/install-profile";

/** A strict-development env bag (the fixtures' precondition), minus profile/opt-in. */
const strictDev = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  ({ CINATRA_RUNTIME_MODE: "development", NODE_ENV: "test", ...extra });

describe("getInstallProfile / isDemoProfile", () => {
  it("is 'demo' ONLY for the exact string 'demo'", () => {
    expect(getInstallProfile({ CINATRA_INSTALL_PROFILE: "demo" })).toBe("demo");
    expect(isDemoProfile({ CINATRA_INSTALL_PROFILE: "demo" })).toBe(true);
  });
  it("defaults to 'dev' when unset or an unrecognised value (fail-safe)", () => {
    expect(getInstallProfile({})).toBe("dev");
    expect(getInstallProfile({ CINATRA_INSTALL_PROFILE: "DEMO" })).toBe("dev");
    expect(getInstallProfile({ CINATRA_INSTALL_PROFILE: "prod" })).toBe("dev");
    expect(isDemoProfile({})).toBe(false);
  });
});

describe("isEnvFlagEnabled", () => {
  it("accepts 1/true/yes/on (case-insensitive, trimmed)", () => {
    for (const v of ["1", "true", "TRUE", "Yes", " on ", "YES"]) {
      expect(isEnvFlagEnabled(v)).toBe(true);
    }
  });
  it("rejects 0/false/no/empty/undefined/garbage", () => {
    for (const v of ["0", "false", "no", "off", "", "  ", "2", "enabled", undefined]) {
      expect(isEnvFlagEnabled(v)).toBe(false);
    }
  });
});

describe("shouldSeedDevFixtures — the relocation matrix", () => {
  it("DEMO ⇒ always seeds", () => {
    expect(shouldSeedDevFixtures(strictDev({ CINATRA_INSTALL_PROFILE: "demo" }))).toBe(true);
  });

  it("DEV DEFAULT (no profile, no opt-in) ⇒ never seeds", () => {
    expect(shouldSeedDevFixtures(strictDev())).toBe(false);
    expect(shouldSeedDevFixtures(strictDev({ CINATRA_INSTALL_PROFILE: "dev" }))).toBe(false);
  });

  it("DEV OPT-IN (CINATRA_DEV_FIXTURES truthy) ⇒ seeds", () => {
    expect(shouldSeedDevFixtures(strictDev({ CINATRA_DEV_FIXTURES: "1" }))).toBe(true);
    expect(shouldSeedDevFixtures(strictDev({ CINATRA_DEV_FIXTURES: "true" }))).toBe(true);
  });

  it("DEV OPT-IN with a falsy flag ⇒ does not seed", () => {
    expect(shouldSeedDevFixtures(strictDev({ CINATRA_DEV_FIXTURES: "0" }))).toBe(false);
    expect(shouldSeedDevFixtures(strictDev({ CINATRA_DEV_FIXTURES: "false" }))).toBe(false);
  });

  it("PROD ⇒ never seeds, even with demo profile or the opt-in flag", () => {
    // Not development runtime.
    expect(
      shouldSeedDevFixtures({
        CINATRA_RUNTIME_MODE: "production",
        CINATRA_INSTALL_PROFILE: "demo",
        CINATRA_DEV_FIXTURES: "1",
      }),
    ).toBe(false);
    // Production Node env pins it off too, even if RUNTIME_MODE says development.
    expect(
      shouldSeedDevFixtures({
        CINATRA_RUNTIME_MODE: "development",
        NODE_ENV: "production",
        CINATRA_INSTALL_PROFILE: "demo",
      }),
    ).toBe(false);
  });

  it("demo profile OUTSIDE strict development runtime ⇒ never seeds", () => {
    expect(shouldSeedDevFixtures({ CINATRA_INSTALL_PROFILE: "demo" })).toBe(false);
  });
});

describe("shouldRunDemoSeed — the pending monolithic-seed one-shot", () => {
  const demoDev = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
    ({ CINATRA_RUNTIME_MODE: "development", NODE_ENV: "test", CINATRA_INSTALL_PROFILE: "demo", ...extra });

  it("fires ONLY once a human admin exists and it has not already run", () => {
    expect(shouldRunDemoSeed({ humanAdminExists: true, alreadySeeded: false }, demoDev())).toBe(true);
  });

  it("waits while no human admin exists (fresh demo DB, nobody registered yet)", () => {
    expect(shouldRunDemoSeed({ humanAdminExists: false, alreadySeeded: false }, demoDev())).toBe(false);
  });

  it("never re-runs once the one-shot completed", () => {
    expect(shouldRunDemoSeed({ humanAdminExists: true, alreadySeeded: true }, demoDev())).toBe(false);
  });

  it("never runs on a plain dev instance (no demo profile), even with an admin", () => {
    expect(
      shouldRunDemoSeed({ humanAdminExists: true, alreadySeeded: false }, {
        CINATRA_RUNTIME_MODE: "development",
        NODE_ENV: "test",
      }),
    ).toBe(false);
  });

  it("never runs outside strict development runtime", () => {
    expect(
      shouldRunDemoSeed({ humanAdminExists: true, alreadySeeded: false }, {
        CINATRA_INSTALL_PROFILE: "demo",
      }),
    ).toBe(false);
    expect(
      shouldRunDemoSeed({ humanAdminExists: true, alreadySeeded: false }, {
        CINATRA_RUNTIME_MODE: "development",
        NODE_ENV: "production",
        CINATRA_INSTALL_PROFILE: "demo",
      }),
    ).toBe(false);
  });
});
