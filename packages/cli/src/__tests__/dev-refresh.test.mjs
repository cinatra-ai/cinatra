import { describe, expect, it } from "vitest";

import {
  parseDevRefreshFlags,
  looksLikeBundledStack,
  isIsolatedWorktree,
  describeDockerDecision,
  shouldRunDocker,
} from "../dev-refresh.mjs";

describe("parseDevRefreshFlags", () => {
  it("defaults to auto when no docker flags are present", () => {
    expect(parseDevRefreshFlags([])).toEqual({ dockerMode: "auto" });
  });

  it("rejects unknown flags so typos fail loudly", () => {
    expect(() => parseDevRefreshFlags(["--verbose"])).toThrow(/Unknown flag/);
    expect(() => parseDevRefreshFlags(["--dockr=always"])).toThrow(/Unknown flag/);
    expect(() => parseDevRefreshFlags(["--rebuild-shell"])).toThrow(/Unknown flag/);
  });

  it("parses --docker=always and --docker=auto", () => {
    expect(parseDevRefreshFlags(["--docker=always"])).toEqual({ dockerMode: "always" });
    expect(parseDevRefreshFlags(["--docker=auto"])).toEqual({ dockerMode: "auto" });
  });

  it("maps --no-docker to off", () => {
    expect(parseDevRefreshFlags(["--no-docker"])).toEqual({ dockerMode: "off" });
  });

  it("lets --no-docker win over --docker=always", () => {
    expect(parseDevRefreshFlags(["--docker=always", "--no-docker"])).toEqual({ dockerMode: "off" });
  });

  it("throws on an invalid --docker= value", () => {
    expect(() => parseDevRefreshFlags(["--docker=sometimes"])).toThrow(/Invalid --docker/);
  });

  it("rejects a malformed --docker= even alongside --no-docker (typos fail loudly)", () => {
    expect(() => parseDevRefreshFlags(["--no-docker", "--docker=sometimes"])).toThrow(/Invalid --docker/);
  });
});

describe("looksLikeBundledStack", () => {
  it("treats an unset/unparseable SUPABASE_DB_URL as bundled (fresh dev default)", () => {
    expect(looksLikeBundledStack({})).toBe(true);
    expect(looksLikeBundledStack({ SUPABASE_DB_URL: "not a url" })).toBe(true);
  });

  it("treats localhost / 127.0.0.1 / IPv6 loopback as bundled", () => {
    expect(looksLikeBundledStack({ SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:5434/postgres" })).toBe(true);
    expect(looksLikeBundledStack({ SUPABASE_DB_URL: "postgresql://u:p@localhost:5432/db" })).toBe(true);
    expect(looksLikeBundledStack({ SUPABASE_DB_URL: "postgresql://u:p@[::1]:5432/db" })).toBe(true);
  });

  it("treats a remote host as external", () => {
    expect(looksLikeBundledStack({ SUPABASE_DB_URL: "postgresql://u:p@db.example.com:5432/db" })).toBe(false);
  });
});

describe("isIsolatedWorktree", () => {
  it("is false for a default main checkout", () => {
    expect(isIsolatedWorktree({})).toBe(false);
    expect(isIsolatedWorktree({ SUPABASE_SCHEMA: "cinatra", BULLMQ_QUEUE_NAME: "cinatra-background-jobs" })).toBe(false);
  });

  it("is true when SUPABASE_SCHEMA is a non-default per-worktree schema", () => {
    expect(isIsolatedWorktree({ SUPABASE_SCHEMA: "cinatra_dev_refresh" })).toBe(true);
  });

  it("is true when a clone slug is present", () => {
    expect(isIsolatedWorktree({ CINATRA_CLONE_SLUG: "feature-x" })).toBe(true);
  });

  it("is true when BULLMQ_QUEUE_NAME is a non-default per-worktree queue", () => {
    expect(isIsolatedWorktree({ BULLMQ_QUEUE_NAME: "cinatra-bg-feature-x" })).toBe(true);
  });

  it("treats blank/whitespace marker values as not-isolated (default checkout)", () => {
    expect(isIsolatedWorktree({ SUPABASE_SCHEMA: "  ", CINATRA_CLONE_SLUG: " ", BULLMQ_QUEUE_NAME: "" })).toBe(false);
  });
});

describe("describeDockerDecision / shouldRunDocker", () => {
  it("off → never runs docker", () => {
    const d = describeDockerDecision({ dockerMode: "off", env: {} });
    expect(d.run).toBe(false);
    expect(d.reason).toBe("--no-docker");
    expect(shouldRunDocker({ dockerMode: "off", env: {} })).toBe(false);
  });

  it("always → runs docker regardless of env (forced)", () => {
    expect(shouldRunDocker({ dockerMode: "always", env: { SUPABASE_SCHEMA: "cinatra_worktree" } })).toBe(true);
    expect(shouldRunDocker({ dockerMode: "always", env: { SUPABASE_DB_URL: "postgresql://u:p@remote:5432/db" } })).toBe(true);
  });

  it("auto → runs docker for a default bundled main checkout", () => {
    const env = { SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:5434/postgres" };
    expect(shouldRunDocker({ dockerMode: "auto", env })).toBe(true);
    expect(describeDockerDecision({ dockerMode: "auto", env }).reason).toBe("bundled local stack");
  });

  it("auto → skips docker for an isolated worktree (avoids port-conflict with the main stack)", () => {
    const env = {
      SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:5434/postgres",
      SUPABASE_SCHEMA: "cinatra_dev_refresh",
    };
    const d = describeDockerDecision({ dockerMode: "auto", env });
    expect(d.run).toBe(false);
    expect(d.reason).toMatch(/isolated worktree/);
  });

  it("auto → skips docker for external infrastructure", () => {
    const env = { SUPABASE_DB_URL: "postgresql://u:p@db.example.com:5432/db" };
    const d = describeDockerDecision({ dockerMode: "auto", env });
    expect(d.run).toBe(false);
    expect(d.reason).toMatch(/external infrastructure/);
  });

  it("auto → isolated-worktree reason takes precedence over external-infra", () => {
    const env = {
      SUPABASE_DB_URL: "postgresql://u:p@db.example.com:5432/db",
      SUPABASE_SCHEMA: "cinatra_worktree",
    };
    const d = describeDockerDecision({ dockerMode: "auto", env });
    expect(d.run).toBe(false);
    expect(d.reason).toMatch(/isolated worktree/);
  });
});
