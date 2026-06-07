// Unit tests for cli.mjs schema-name whitelist.
//
// Locks the schemaName safety contract: schemaName must match
// `^[a-zA-Z_][a-zA-Z0-9_]*$` BEFORE any work; invalid input returns an
// error entry without touching the DB.

import { describe, expect, it } from "vitest";

import { compileAndRegisterAgentSkillsViaPg } from "../cli.mjs";

describe("compileAndRegisterAgentSkillsViaPg — schemaName whitelist", () => {
  const VALID_PG_URL = "postgres://unused:unused@localhost:5432/unused";

  it("rejects schemaName containing SQL injection metacharacters", async () => {
    const result = await compileAndRegisterAgentSkillsViaPg({
      repoRoot: "/nonexistent",
      dbUrl: VALID_PG_URL,
      schemaName: "cinatra; DROP TABLE skill_packages; --",
    });
    expect(result.registered).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].slug).toBe("<schema>");
    expect(result.skipped[0].reason).toMatch(/invalid schemaName/);
  });

  it("rejects schemaName with double-quote characters", async () => {
    const result = await compileAndRegisterAgentSkillsViaPg({
      repoRoot: "/nonexistent",
      dbUrl: VALID_PG_URL,
      schemaName: 'evil"schema',
    });
    expect(result.skipped[0].slug).toBe("<schema>");
  });

  it("rejects schemaName starting with a digit", async () => {
    const result = await compileAndRegisterAgentSkillsViaPg({
      repoRoot: "/nonexistent",
      dbUrl: VALID_PG_URL,
      schemaName: "1cinatra",
    });
    expect(result.skipped[0].slug).toBe("<schema>");
  });

  it("rejects empty schemaName", async () => {
    const result = await compileAndRegisterAgentSkillsViaPg({
      repoRoot: "/nonexistent",
      dbUrl: VALID_PG_URL,
      schemaName: "",
    });
    expect(result.skipped[0].slug).toBe("<schema>");
  });

  it("rejects null / undefined schemaName", async () => {
    const r1 = await compileAndRegisterAgentSkillsViaPg({
      repoRoot: "/nonexistent",
      dbUrl: VALID_PG_URL,
      schemaName: null,
    });
    expect(r1.skipped[0].slug).toBe("<schema>");

    const r2 = await compileAndRegisterAgentSkillsViaPg({
      repoRoot: "/nonexistent",
      dbUrl: VALID_PG_URL,
      schemaName: undefined,
    });
    expect(r2.skipped[0].slug).toBe("<schema>");
  });

  it("rejects schemaName with whitespace", async () => {
    const result = await compileAndRegisterAgentSkillsViaPg({
      repoRoot: "/nonexistent",
      dbUrl: VALID_PG_URL,
      schemaName: "cinatra foo",
    });
    expect(result.skipped[0].slug).toBe("<schema>");
  });

  it("accepts canonical schema names (returns empty result for nonexistent repoRoot)", async () => {
    // After the whitelist check passes, the function proceeds to look up
    // <repoRoot>/agents — for /nonexistent that returns silently with
    // empty registered + empty skipped, NOT a <schema> rejection.
    const result = await compileAndRegisterAgentSkillsViaPg({
      repoRoot: "/nonexistent",
      dbUrl: VALID_PG_URL,
      schemaName: "cinatra",
    });
    expect(result.registered).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("accepts branch-isolation schema names (cinatra_<slug>)", async () => {
    const result = await compileAndRegisterAgentSkillsViaPg({
      repoRoot: "/nonexistent",
      dbUrl: VALID_PG_URL,
      schemaName: "cinatra_worktree_schema_cutover_fin",
    });
    expect(result.registered).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("accepts schema names starting with underscore", async () => {
    const result = await compileAndRegisterAgentSkillsViaPg({
      repoRoot: "/nonexistent",
      dbUrl: VALID_PG_URL,
      schemaName: "_private",
    });
    expect(result.skipped).toEqual([]);
  });
});
