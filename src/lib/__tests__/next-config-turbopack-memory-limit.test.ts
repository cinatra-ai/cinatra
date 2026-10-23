import { afterEach, describe, expect, it, vi } from "vitest";

async function loadConfig(mode: string | undefined, limit: string | undefined) {
  vi.stubEnv("NODE_ENV", mode);
  vi.stubEnv("CINATRA_DEV_TURBOPACK_MEMORY_LIMIT", limit);
  vi.stubEnv("SUPABASE_DB_URL", "configuration-test-fixture");
  vi.stubEnv("SENTRY_AUTH_TOKEN", undefined);
  vi.stubEnv("CINATRA_BUILD_CPUS", undefined);
  vi.resetModules();
  return (await import("../../../next.config")).default;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("development Turbopack memory limit", () => {
  it("passes the configured byte count to Turbopack in development", async () => {
    const config = await loadConfig("development", "2147483648");
    expect(config.experimental?.turbopackMemoryLimit).toBe(2147483648);
  });

  it.each([
    ["development", undefined],
    ["development", ""],
    ["production", undefined],
    ["production", "2147483648"],
    ["test", "2147483648"],
    [undefined, "2147483648"],
  ])("keeps the option absent for mode %s and value %s", async (mode, limit) => {
    const config = await loadConfig(mode, limit);
    expect(config.experimental).not.toHaveProperty("turbopackMemoryLimit");
    expect(config.turbopack?.resolveAlias).toEqual({ sonner: "./node_modules/sonner" });
    expect(config.experimental?.reactDebugChannel).toBe(false);
  });
});
