import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Import-guard regression test for the SSE dedupe contract.
//
// The dedupe-prepend contract lives in
// `packages/notifications/src/flyout-state.ts` as `applySseNotification`. The
// SSE consumer must route its `notification` event through that helper — NOT
// re-derive the predicate inline. The failure mode this test guards against is
// a future refactor that silently inlines `current.some(...)` again, drops the
// helper, and leaves the in-isolation `flyout-state.test.ts` suite passing
// while the production code-path has stopped using the contract.
//
// The SSE `notification` event handler was extracted (E6 / #1556) out of the
// bell flyout and into the shared client store, so this guard now targets the
// store module `packages/notifications/src/notifications-store.ts` — wherever
// the SSE handler lives is what must route through `./flyout-state`. The
// contract is what's tested; the file path + asserted specifier are just
// pointers and are updated accordingly (the guard's intent is unchanged).
//
// Pattern follows the established repo convention of `readFileSync` +
// regex assertions against source text (see `src/components/ui/sonner.test.tsx`
// and `packages/agents/src/components/__tests__/install-scope-dialog.test.tsx`).
// ---------------------------------------------------------------------------

const STORE_PATH = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "packages",
  "notifications",
  "src",
  "notifications-store.ts",
);
const STORE = readFileSync(STORE_PATH, "utf-8");

// Narrow the search to the SSE listener slice so other notification
// state-updates (markRead, markAllRead, etc.) don't false-positive on
// the dedupe-predicate negative match.
const SSE_HANDLER_SLICE_START = STORE.indexOf(
  'addEventListener("notification"',
);
const SSE_HANDLER_SLICE = (() => {
  if (SSE_HANDLER_SLICE_START < 0) return "";
  const slice = STORE.slice(SSE_HANDLER_SLICE_START);
  // End-anchor priority: the next sibling listener registration, otherwise
  // the EventSource.error registration that today sits below the
  // 'notification' handler. Falls back to the next 4000 chars if neither
  // marker is present (defensive against a future refactor that removes
  // the error listener). 4000 chars is ~80 lines of dense TypeScript, more
  // than enough to cover the handler body without dragging in unrelated
  // state-updates.
  const candidates = [
    slice.indexOf('eventSource.addEventListener("error"', 1),
    slice.indexOf("eventSource.addEventListener(", 1),
    4000,
  ].filter((n) => n > 0);
  const end = Math.min(...candidates);
  return slice.slice(0, end);
})();

describe("notifications-store.ts SSE dedupe contract import-guard", () => {
  it("imports applySseNotification from the package-relative ./flyout-state", () => {
    expect(STORE).toMatch(
      /import\s+\{[\s\S]*?\bapplySseNotification\b[\s\S]*?\}\s+from\s+["']\.\/flyout-state["']/,
    );
  });

  it("calls applySseNotification inside the SSE 'notification' event handler", () => {
    // Positive proof of usage — anchored to the SSE listener slice so we
    // can't be fooled by a stray reference elsewhere. This is the primary
    // guard; the import-only check is necessary but not sufficient.
    expect(SSE_HANDLER_SLICE.length).toBeGreaterThan(0);
    expect(SSE_HANDLER_SLICE).toMatch(
      /setNotifications\(\s*\(\s*current\s*\)\s*=>\s*applySseNotification\(\s*current\s*,\s*parsed\s*\)\s*\)/,
    );
  });

  it("does NOT re-derive the dedupe predicate inline inside the SSE handler (secondary safety net)", () => {
    // Pinned to the SSE slice so unrelated callsites elsewhere in the
    // file can keep using `.some(...)` without tripping the guard
    // (e.g. markReadByPathname path scans for matching unread ids).
    expect(SSE_HANDLER_SLICE).not.toMatch(
      /current\.some\(\s*\(\s*n\s*\)\s*=>\s*n\.id\s*===/,
    );
    expect(SSE_HANDLER_SLICE).not.toMatch(
      /current\.some\(\s*\(\s*([a-zA-Z_$][\w$]*)\s*\)\s*=>\s*\1\.id\s*===\s*parsed\.id/,
    );
  });
});
