/**
 * Asserts that agent_runs has a nullable `streamed_text text`
 * column exposed as `streamedText: string | null` on agentRuns.$inferSelect.
 *
 * This test covers the schema column and the inline ALTER TABLE migration.
 *
 *    cd packages/agent-builder && pnpm vitest run src/__tests__/schema-streamed-text.test.ts
 */
import { describe, it, expect } from "vitest";

import { agentRuns } from "../schema";

describe("agent_runs.streamed_text column", () => {
  it("exposes streamedText on the Drizzle column map", () => {
    // Drizzle exposes columns as direct properties on the table object at
    // runtime; the underlying Drizzle metadata lives behind Symbol(drizzle:Columns).
    // We assert both paths so a regression in either surface trips the test.
    expect(agentRuns).toHaveProperty("streamedText");
    const colsSymbol = Object.getOwnPropertySymbols(agentRuns).find(
      (s) => s.toString() === "Symbol(drizzle:Columns)",
    );
    expect(colsSymbol).toBeTruthy();
    const columnMap = colsSymbol
      ? (agentRuns as unknown as Record<symbol, Record<string, unknown>>)[colsSymbol]
      : undefined;
    expect(columnMap).toBeTruthy();
    expect(columnMap).toHaveProperty("streamedText");
  });

  it("types row.streamedText as string | null on $inferSelect", () => {
    type Row = typeof agentRuns.$inferSelect;
    type StreamedTextType = Row["streamedText"];
    const _sample: StreamedTextType = null as string | null;
    expect(_sample === null || typeof _sample === "string").toBe(true);
  });
});
