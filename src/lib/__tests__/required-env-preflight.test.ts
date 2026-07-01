import { describe, expect, it, vi } from "vitest";

import {
  checkRequiredEnv,
  runRequiredEnvPreflight,
  validateEncryptionKey,
} from "@/lib/boot/required-env-preflight";

// ---------------------------------------------------------------------------
// Required-env preflight (cinatra#789 item 3). Hard vars abort a prod boot with a
// clear aggregated message; soft vars warn only; the whole thing is inert outside
// app-runtime production and during the Next build phase (so the image build survives).
// ---------------------------------------------------------------------------

const HEX_32 = "00".repeat(32); // 64 hex chars -> 32 bytes

const fullEnv = (): Record<string, string | undefined> => ({
  // The preflight only checks PRESENCE (non-empty) of SUPABASE_DB_URL, not its
  // format, so this is a deliberately non-DSN placeholder (a real postgresql://
  // literal would trip the secret-scan-gate's Postgres detector).
  SUPABASE_DB_URL: "db-url-placeholder-present",
  BETTER_AUTH_SECRET: "s".repeat(32),
  CINATRA_ENCRYPTION_KEY: HEX_32,
  CINATRA_BRIDGE_TOKEN: "bridge-token-value",
});

describe("validateEncryptionKey", () => {
  it("accepts a 64-char hex key (32 bytes)", () => {
    expect(validateEncryptionKey(HEX_32)).toBeNull();
  });
  it("accepts a base64 32-byte key", () => {
    const b64 = Buffer.alloc(32, 7).toString("base64");
    expect(validateEncryptionKey(b64)).toBeNull();
  });
  it("rejects a key that decodes to the wrong length", () => {
    expect(validateEncryptionKey("deadbeef")).toMatch(/must decode to 32 bytes/);
  });
});

describe("checkRequiredEnv (pure)", () => {
  it("reports no problems when all vars are present + valid", () => {
    const r = checkRequiredEnv(fullEnv());
    expect(r.hardFailures).toEqual([]);
    expect(r.softMissing).toEqual([]);
  });

  it("flags each missing hard var by name", () => {
    const r = checkRequiredEnv({});
    const names = r.hardFailures.map((f) => f.name).sort();
    expect(names).toEqual(["BETTER_AUTH_SECRET", "CINATRA_ENCRYPTION_KEY", "SUPABASE_DB_URL"]);
  });

  it("flags a malformed encryption key as a hard failure", () => {
    const env = { ...fullEnv(), CINATRA_ENCRYPTION_KEY: "not-a-valid-key" };
    const r = checkRequiredEnv(env);
    expect(r.hardFailures.map((f) => f.name)).toEqual(["CINATRA_ENCRYPTION_KEY"]);
  });

  it("flags a missing soft var (bridge token) as soft-missing only", () => {
    const env = fullEnv();
    delete env.CINATRA_BRIDGE_TOKEN;
    const r = checkRequiredEnv(env);
    expect(r.hardFailures).toEqual([]);
    expect(r.softMissing.map((s) => s.name)).toEqual(["CINATRA_BRIDGE_TOKEN"]);
  });

  it("treats whitespace-only as missing", () => {
    const r = checkRequiredEnv({ SUPABASE_DB_URL: "   " });
    expect(r.hardFailures.some((f) => f.name === "SUPABASE_DB_URL")).toBe(true);
  });
});

describe("runRequiredEnvPreflight (armed only in app-prod runtime, not build)", () => {
  const prodDeps = { isProd: () => true, isBuildPhase: () => false };

  it("no-ops (no throw) outside app-runtime production", () => {
    const warn = vi.fn();
    const report = runRequiredEnvPreflight({
      env: {},
      isProd: () => false,
      isBuildPhase: () => false,
      logWarn: warn,
    });
    expect(report.hardFailures).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("no-ops during the Next build phase even in prod (image build has no secrets)", () => {
    expect(() =>
      runRequiredEnvPreflight({ env: {}, isProd: () => true, isBuildPhase: () => true }),
    ).not.toThrow();
  });

  it("THROWS a clear aggregated message naming every missing hard var in prod", () => {
    let msg = "";
    try {
      runRequiredEnvPreflight({ env: {}, ...prodDeps });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toMatch(/SUPABASE_DB_URL/);
    expect(msg).toMatch(/BETTER_AUTH_SECRET/);
    expect(msg).toMatch(/CINATRA_ENCRYPTION_KEY/);
    expect(msg).toMatch(/refusing to boot/i);
  });

  it("does NOT throw and WARNS on a missing soft var when hard vars are present", () => {
    const warn = vi.fn();
    const env = fullEnv();
    delete env.CINATRA_BRIDGE_TOKEN;
    expect(() => runRequiredEnvPreflight({ env, ...prodDeps, logWarn: warn })).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/CINATRA_BRIDGE_TOKEN/));
  });

  it("passes cleanly when everything is present in prod", () => {
    expect(() => runRequiredEnvPreflight({ env: fullEnv(), ...prodDeps })).not.toThrow();
  });
});
