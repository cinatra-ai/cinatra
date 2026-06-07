/**
 * email_send_events foundation regression gate.
 *
 * Verifies the foundation pieces of the recipient cooldown ledger:
 *   1. normalizeRecipientEmail produces stable lowercase keys
 *   2. asset-email package exports the four ledger helpers
 *   3. drizzle-store migration block declares the table
 *
 * Live database tests (recordEmailSendEvent + findRecentlySentRecipients)
 * belong in live integration coverage once the orchestrator applies the
 * recipient HITL cooldown filter.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, it, expect } from "vitest";

import {
  normalizeRecipientEmail,
  findRecentlySentRecipients,
  recordEmailSendEvent,
  listSendEventsForRun,
} from "@/lib/email-system-persistence";

describe("email_send_events foundation", () => {
  it("normalizeRecipientEmail lowercases + trims", () => {
    expect(normalizeRecipientEmail("  Alice@Example.COM  ")).toBe(
      "alice@example.com",
    );
  });

  it("normalizeRecipientEmail is idempotent", () => {
    const a = normalizeRecipientEmail("alice@example.com");
    const b = normalizeRecipientEmail(a);
    expect(a).toBe(b);
  });

  it("findRecentlySentRecipients shortcuts on empty input (no DB call)", () => {
    const result = findRecentlySentRecipients({
      orgId: "org-1",
      candidateEmails: [],
    });
    expect(result.recentEmails.size).toBe(0);
    expect(result.lastSentByEmail.size).toBe(0);
  });

  it("@/lib/email-system-persistence exports all four ledger helpers", () => {
    expect(typeof normalizeRecipientEmail).toBe("function");
    expect(typeof findRecentlySentRecipients).toBe("function");
    expect(typeof recordEmailSendEvent).toBe("function");
    expect(typeof listSendEventsForRun).toBe("function");
  });

  it("drizzle-store migration declares email_send_events table", () => {
    const drizzlePath = path.resolve(
      __dirname,
      "../../../../src/lib/drizzle-store.ts",
    );
    const content = fs.readFileSync(drizzlePath, "utf8");
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll(\'"\', \'""\')}"."email_send_events"');
    expect(content).toContain("status text NOT NULL CHECK (status IN ('attempted','sent','skipped','failed','replied'))");
    expect(content).toContain("idempotency_key text UNIQUE");
    expect(content).toContain("email_send_events_cooldown_lookup_idx");
  });
});
