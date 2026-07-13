import { describe, expect, it } from "vitest";

import { chatCaptureSchemaQueries } from "@/lib/chat-capture-schema";
import { CHAT_CAPTURE_TURN_STATUSES } from "@/lib/chat-capture/ledger";
// The migration module is plain ESM with no runtime deps — import the DDL
// constant directly so bootstrap and upgrade paths are pinned to each other.
import { chatCaptureLedgerDdlSql } from "../../../migrations/core/core__0037_chat-capture-ledger.mjs";

// ---------------------------------------------------------------------------
// Status-vocabulary + DDL sync pins (cinatra#1367): the CHECK constraint in
// the bootstrap leaf, the core__0037 migration, and the TypeScript status
// list in the ledger module must never drift from each other.
// ---------------------------------------------------------------------------

function extractStatusCheckList(sql: string): string[] {
  const match = sql.match(/chat_capture_turns_status_check CHECK \(status IN \(([^)]+)\)\)/);
  expect(match, "status CHECK constraint present").toBeTruthy();
  return (match?.[1] ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^'/, "").replace(/'$/, ""));
}

describe("chat-capture schema sync", () => {
  const bootstrapSql = chatCaptureSchemaQueries("app").map((q) => q.text).join("\n");

  it("bootstrap CHECK matches CHAT_CAPTURE_TURN_STATUSES exactly", () => {
    expect(extractStatusCheckList(bootstrapSql)).toEqual([...CHAT_CAPTURE_TURN_STATUSES]);
  });

  it("core__0037 migration CHECK matches CHAT_CAPTURE_TURN_STATUSES exactly", () => {
    expect(extractStatusCheckList(chatCaptureLedgerDdlSql)).toEqual([
      ...CHAT_CAPTURE_TURN_STATUSES,
    ]);
  });

  it("bootstrap and migration create the same table + index shape", () => {
    for (const fragment of [
      "CREATE TABLE IF NOT EXISTS",
      "chat_capture_turns",
      "PRIMARY KEY (thread_id, turn_id)",
      "classifier_called boolean NOT NULL DEFAULT false",
      "chat_capture_turns_owner_created_idx",
      "(owner_user_id, created_at DESC)",
    ]) {
      expect(bootstrapSql).toContain(fragment);
      expect(chatCaptureLedgerDdlSql).toContain(fragment);
    }
  });

  it("ledger has no FK to chat_threads (provenance must survive thread deletion)", () => {
    expect(bootstrapSql).not.toMatch(/REFERENCES[^)]*chat_threads/i);
    expect(chatCaptureLedgerDdlSql).not.toMatch(/REFERENCES[^)]*chat_threads/i);
  });
});
