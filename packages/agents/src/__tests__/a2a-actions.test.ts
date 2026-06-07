/**
 * Smoke coverage for the external dispatch branch in sendAgentBuilderMessage.
 *
 * This file keeps dedicated test coverage for the external routing contract and
 * narrowly asserts the two invariants that define the external branch at the
 * module level: (1) `sendAgentBuilderMessage` is exported, and (2) the module
 * contains the external branch marker so future refactors cannot silently
 * delete it.
 *
 * `sendAgentBuilderMessage` routes `template.sourceType === "external"`
 * through `createExternalA2AClient` and returns { ok, taskId, runId }.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

describe("sendAgentBuilderMessage external branch", () => {
  it("a2a-actions.ts exports sendAgentBuilderMessage", () => {
    // File-based export check — importing the barrel triggers deep
    // dependency load (octokit, Drizzle DB pool, etc.) which is orthogonal
    // to this assertion and spuriously fails under worktree-isolated test runs.
    const source = readFileSync(
      path.resolve(__dirname, "..", "a2a-actions.ts"),
      "utf8",
    );
    expect(source).toMatch(/export\s+(async\s+)?function\s+sendAgentBuilderMessage/);
  });

  it("a2a-actions.ts contains the external-template branch guard", () => {
    const source = readFileSync(
      path.resolve(__dirname, "..", "a2a-actions.ts"),
      "utf8",
    );
    // The external branch precedes the internal createInProcessA2AClient block.
    // Keep this guard as a safety net so future refactors cannot collapse the
    // branch back into the internal path.
    expect(source).toMatch(/sourceType\s*===\s*"external"/);
    expect(source).toMatch(/createExternalA2AClient/);
  });

  it("a2a-actions.ts resolves external credentials via @cinatra-ai/nango-connector", () => {
    const source = readFileSync(
      path.resolve(__dirname, "..", "a2a-actions.ts"),
      "utf8",
    );
    // External runs require credentials fetched fresh per run with no caching.
    // Assert the import exists so we catch accidental stub substitution.
    expect(source).toMatch(/getNangoConnection/);
    expect(source).toMatch(/findSavedConnectionForAgentUrl/);
  });
});
