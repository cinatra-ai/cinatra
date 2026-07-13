import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// #1384 / #1216-S2 cutover tripwire (cinatra#1367, codex round-0 finding 4).
//
// Chat-capture detection is enqueued from the thread-persistence chokepoint
// `upsertChatThreadInDatabase` (src/lib/database.ts) — the one function every
// current chat entry point (save route, chat server actions, MCP handlers)
// persists through. The stream-s2 cutover that replaces this persistence path
// MUST re-hook `maybeEnqueueChatCaptureForThread` (or an equivalent with the
// same semantics: a user turn is enqueued once its content is durably
// persisted) at its replacement chokepoint. This source-level test fails the
// moment the hook is dropped from the current path, forcing the cutover PR to
// move it rather than lose it.
//
// Source-level on purpose: importing database.ts pulls the full sync-pg
// module graph, which unit tests cannot boot; the load-bearing fact here is
// simply "the persist chokepoint still reaches the enqueue module".
// ---------------------------------------------------------------------------

describe("chat-capture enqueue hook (persistence-chokepoint contract)", () => {
  it("upsertChatThreadInDatabase still hooks @/lib/chat-capture/enqueue", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/lib/database.ts"),
      "utf8",
    );
    const fnStart = source.indexOf("export function upsertChatThreadInDatabase(");
    expect(fnStart).toBeGreaterThan(-1);
    // Bound the search to the region between this function and the next
    // export, so the hook can't satisfy the test from an unrelated location.
    const nextExport = source.indexOf("\nexport function", fnStart + 1);
    const body = source.slice(fnStart, nextExport === -1 ? undefined : nextExport);
    expect(body).toContain('import("@/lib/chat-capture/enqueue")');
    expect(body).toContain("maybeEnqueueChatCaptureForThread");
  });
});
