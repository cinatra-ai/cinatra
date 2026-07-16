// Auto-scroll lock release on thread switch (#1702). Source-pin (repo
// convention for client components): the scroll lock (userScrolledUpRef) is
// container-level state reused across threads, so without an
// activeThreadId-keyed reset, "scrolled up in thread A" leaked into thread B
// and a newly opened thread rendered at an arbitrary position instead of its
// latest message — the lock was only ever released on stream completion.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PKG_ROOT = path.resolve(__dirname, "..", "..");
const src = readFileSync(path.join(PKG_ROOT, "src", "chat-page.tsx"), "utf8");

describe("chat auto-scroll lock across thread switches", () => {
  it("releases the scroll lock when the active thread changes (inside the thread-sync effect)", () => {
    // Folded into the existing activeThreadIdRef sync effect — the file is a
    // baselined file-size-ratchet bottleneck, so no standalone effect.
    expect(src).toMatch(
      /useEffect\(\(\) => \{\s*activeThreadIdRef\.current = activeThreadId;\s*userScrolledUpRef\.current = false;\s*\}, \[activeThreadId\]\);/,
    );
  });

  it("runs the release BEFORE the scroll effect so a same-render (cached) thread switch scrolls", () => {
    const resetIdx = src.search(
      /activeThreadIdRef\.current = activeThreadId;\s*userScrolledUpRef\.current = false;/,
    );
    const scrollEffectIdx = src.search(
      /scrollToBottom\(\);\s*\}, \[messages, streamingCount, pendingExternalHandle, typingIndicators, scrollToBottom\]\);/,
    );
    expect(resetIdx).toBeGreaterThan(-1);
    expect(scrollEffectIdx).toBeGreaterThan(-1);
    // React runs effects in definition order: the lock must already be clear
    // when scrollToBottom fires for the new thread's messages.
    expect(resetIdx).toBeLessThan(scrollEffectIdx);
  });

  it("keeps the stream-completion release (the other legitimate reset)", () => {
    expect(src).toMatch(
      /if \(prevHasActiveStreamRef\.current && !hasActiveStream\) userScrolledUpRef\.current = false;/,
    );
  });
});
