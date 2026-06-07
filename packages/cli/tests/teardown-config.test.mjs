import { describe, it, expect } from "vitest";
import {
  resolveTeardownNames,
  validateSchemaName,
  validateQueueName,
} from "../src/teardown-config.mjs";

// These tests exist because of a real production-shape bug:
// `cinatra teardown branch` derived the schema/queue names from the git
// branch alone and ignored what the worktree's `.env.local` declared.
// When the two diverged (manual --slug at setup, custom slug), it dropped
// a phantom schema while the real one was orphaned on Postgres. The
// validation guards exist so a malformed or protected env value throws
// BEFORE any DB / Redis work.

describe("resolveTeardownNames", () => {
  it("env-declared schema and queue beat derived names (the bug-fix path)", () => {
    // A worktree whose .env.local declares a SUPABASE_SCHEMA that differs from
    // its slug-derived schema: the declared value must win, otherwise teardown
    // would drop a phantom schema and orphan the real one (see the fixtures below).
    const r = resolveTeardownNames({
      slug: "worktree-delegate-run",
      envSchema: "cinatra_custom_branch_schema",
      envQueue: "cinatra-bg-custom-branch-schema",
      envSource: "/path/to/worktree/.env.local",
    });
    expect(r.schemaName).toBe("cinatra_custom_branch_schema");
    expect(r.queueName).toBe("cinatra-bg-custom-branch-schema");
    expect(r.schemaSource).toBe("/path/to/worktree/.env.local");
    expect(r.queueSource).toBe("/path/to/worktree/.env.local");
  });

  it("falls back to slug-derived names when env declares neither (hook-installed worktree path)", () => {
    const r = resolveTeardownNames({ slug: "feature-x" });
    expect(r.schemaName).toBe("cinatra_feature_x");
    expect(r.queueName).toBe("cinatra-bg-feature-x");
    expect(r.schemaSource).toBe("derived from slug");
    expect(r.queueSource).toBe("derived from slug");
  });

  it("can mix env-declared schema with derived queue (or vice versa)", () => {
    const r = resolveTeardownNames({
      slug: "feature-x",
      envSchema: "cinatra_my_custom",
      envSource: "/p/.env.local",
    });
    expect(r.schemaName).toBe("cinatra_my_custom");
    expect(r.queueName).toBe("cinatra-bg-feature-x"); // queue still derived
    expect(r.schemaSource).toBe("/p/.env.local");
    expect(r.queueSource).toBe("derived from slug");
  });

  it("rejects env-declared schema that names the live app schema (cinatra)", () => {
    expect(() =>
      resolveTeardownNames({
        slug: "feature-x",
        envSchema: "cinatra",
        envSource: "/leaked/main/.env.local",
      }),
    ).toThrow(/protected schema "cinatra"/);
  });

  it("rejects env-declared schema that names Better Auth's public schema", () => {
    expect(() =>
      resolveTeardownNames({
        slug: "feature-x",
        envSchema: "public",
        envSource: "/p/.env.local",
      }),
    ).toThrow(/protected schema "public"/);
  });

  it("rejects malformed env-declared schema (SQL-injection shape)", () => {
    expect(() =>
      resolveTeardownNames({
        slug: "feature-x",
        envSchema: "drop'; --",
        envSource: "/p/.env.local",
      }),
    ).toThrow(/Postgres identifier shape/);
  });

  it("rejects env-declared queue that names the protected main queue", () => {
    expect(() =>
      resolveTeardownNames({
        slug: "feature-x",
        envQueue: "cinatra-bg-main",
        envSource: "/p/.env.local",
      }),
    ).toThrow(/protected queue "cinatra-bg-main"/);
  });

  it("rejects malformed env-declared queue (not cinatra-bg-* shape)", () => {
    expect(() =>
      resolveTeardownNames({
        slug: "feature-x",
        envQueue: "bull:some-other-queue",
        envSource: "/p/.env.local",
      }),
    ).toThrow(/cinatra-bg-<slug> shape/);
  });

  it("rejects slug=main even when no env values are declared (defense-in-depth)", () => {
    // The slug `main` would derive schema `cinatra_main`, which is shaped like
    // a branch schema but is unsafe to drop on the assumption that the operator
    // mistyped or ran from the main checkout.
    expect(() => resolveTeardownNames({ slug: "main" })).toThrow(
      /protected schema/,
    );
  });

  it("throws if slug is missing or non-string (programmer error)", () => {
    expect(() => resolveTeardownNames({})).toThrow(/slug is required/);
    expect(() => resolveTeardownNames({ slug: "" })).toThrow(/slug is required/);
    expect(() => resolveTeardownNames({ slug: null })).toThrow(
      /slug is required/,
    );
  });

  it("rejects blank env-declared schema (key present but empty — malformed)", () => {
    // Caller passes "" when the env line is `SUPABASE_SCHEMA=` (key present,
    // value empty after trim). Falling back to slug-derived would mask the
    // operator typo, so we throw.
    expect(() =>
      resolveTeardownNames({
        slug: "feature-x",
        envSchema: "",
        envSource: "/p/.env.local",
      }),
    ).toThrow(/SUPABASE_SCHEMA is declared but blank/);
  });

  it("rejects blank env-declared queue (key present but empty — malformed)", () => {
    expect(() =>
      resolveTeardownNames({
        slug: "feature-x",
        envQueue: "",
        envSource: "/p/.env.local",
      }),
    ).toThrow(/BULLMQ_QUEUE_NAME is declared but blank/);
  });
});

describe("validateSchemaName / validateQueueName (exposed for callers reusing the guards)", () => {
  it("validateSchemaName accepts well-formed branch schema names", () => {
    expect(() => validateSchemaName("cinatra_my_branch", "test", "my-branch")).not.toThrow();
    expect(() => validateSchemaName("cinatra_a", "test", "a")).not.toThrow();
  });

  it("validateQueueName accepts well-formed branch queue names", () => {
    expect(() => validateQueueName("cinatra-bg-my-branch", "test")).not.toThrow();
  });
});
