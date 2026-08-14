// Auto-scroll lock release on thread switch (#1702). Source-pin (repo
// convention for client components): the scroll lock (userScrolledUpRef) is
// container-level state reused across threads, so without an
// activeThreadId-keyed reset, "scrolled up in thread A" leaked into thread B
// and a newly opened thread rendered at an arbitrary position instead of its
// latest message — the lock was only ever released on stream completion.
//
// MECHANICAL REPOINT (cinatra#2683, epic #2564 S8f): the scroll container, the
// lock and both of its releases moved OUT of chat-page.tsx and into the ONE
// conversation column, which the site widget now mounts too. The behaviour is
// unchanged — so is this pin, aimed at the file that holds it. The reset is a
// standalone effect there rather than folded into the thread-sync effect,
// because the column has no activeThreadIdRef to fold it into; what still
// matters, and is still asserted, is that it runs BEFORE the scroll effect.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PKG_ROOT = path.resolve(__dirname, "..", "..");
const src = readFileSync(path.join(PKG_ROOT, "src", "conversation-column.tsx"), "utf8");

describe("chat auto-scroll lock across thread switches", () => {
  it("releases the scroll lock when the active thread changes", () => {
    expect(src).toMatch(
      /useEffect\(\(\) => \{\s*userScrolledUpRef\.current = false;\s*\}, \[activeThreadId\]\);/,
    );
  });

  it("runs the release BEFORE the scroll effect so a same-render (cached) thread switch scrolls", () => {
    const resetIdx = src.search(
      /userScrolledUpRef\.current = false;\s*\}, \[activeThreadId\]\);/,
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

// ---------------------------------------------------------------------------
// The COLD-LOAD settle pass rides the same reset (cinatra#2740).
// ---------------------------------------------------------------------------
// The single-shot pin above is correct only if the height it reads is final, and
// on a cold reload it is not: the messages arrive asynchronously and their
// content lays out after mount. The column answers with a bounded settle pass
// (`../scroll-settle`), whose BEHAVIOUR — re-pinning until the height holds, the
// reader's lock winning, the re-arm, the disconnect — is measured on a mounted
// surface in `cold-reload-scroll-pin.test.tsx`.
//
// What belongs HERE is the one thing that is an ORDERING fact about this file
// and invisible at runtime until it is wrong: the pass is re-armed AFTER the
// lock reset. React runs effects in definition order, so a pass armed before the
// reset would read the OUTGOING thread's lock and decline to pin the incoming
// one — the #1702 symptom, re-introduced through a new door.
describe("chat cold-load settle pass", () => {
  it("re-arms the pass AFTER the thread-switch lock reset", () => {
    const resetIdx = src.search(
      /userScrolledUpRef\.current = false;\s*\}, \[activeThreadId\]\);/,
    );
    const rearmIdx = src.search(/settleArmedRef\.current = true;/);
    expect(resetIdx).toBeGreaterThan(-1);
    expect(rearmIdx).toBeGreaterThan(-1);
    expect(rearmIdx).toBeGreaterThan(resetIdx);
  });

  it("reads the lock at call time, so a mid-settle scroll-up ends the pass", () => {
    expect(src).toMatch(/isLocked: \(\) => userScrolledUpRef\.current,/);
  });

  it("bounds the pass — stopped on the thread switch and on unmount", () => {
    // Two stop sites: the activeThreadId effect and the unmount cleanup.
    const stops = src.match(/settlePassRef\.current\?\.stop\(\);/g) ?? [];
    expect(stops.length).toBeGreaterThanOrEqual(2);
  });
});
