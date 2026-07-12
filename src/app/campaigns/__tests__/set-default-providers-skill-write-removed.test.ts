import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Removal guard (cinatra#1104 / S3a core half): the core LLM-settings save
 * action `setDefaultProvidersAction` must NOT persist the Anthropic skill-upload
 * opt-in or run the eager sync/GC orchestration anymore. That write path moved
 * entirely to the anthropic-connector Skills tab, which persists + orchestrates
 * through the `@cinatra-ai/host:anthropic-skill-config` host capability.
 *
 * Source-level assertion (a `"use server"` module cannot be imported into a
 * plain unit test without the full server graph): the write path is fully gone
 * from core's `campaigns/actions.ts`, and no duplicate writer remains.
 *
 * The canonical *reader* (`readAnthropicSkillSyncEnabledFromDatabase`) and its
 * writer primitive stay in `src/lib/database.ts` — the writer is now the
 * host-capability persistence path (`anthropic-skill-config-service.ts`), whose
 * `{ read, write }` contract is exercised (against mocked DB accessors) by
 * `src/lib/__tests__/anthropic-skill-config-capability.test.ts`.
 */
const actionsSource = readFileSync(
  fileURLToPath(new URL("../actions.ts", import.meta.url)),
  "utf8",
);

describe("setDefaultProvidersAction: Anthropic skill-write path removed from core (#1104)", () => {
  it("does not import or call the canonical skill-sync-enabled writer", () => {
    expect(actionsSource).not.toContain("writeAnthropicSkillSyncEnabledToDatabase");
  });

  it("does not import or call the eager skill-sync/GC orchestration", () => {
    expect(actionsSource).not.toContain("orchestrateAnthropicSkillSync");
  });

  it("no longer reads the anthropicSkillSyncEnabled form field", () => {
    expect(actionsSource).not.toContain("anthropicSkillSyncEnabled");
  });
});
