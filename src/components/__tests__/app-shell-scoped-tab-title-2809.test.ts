import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Source-guard: the shell reads the tab title through the TRAIL's own rule
// (cinatra#2809, per-scope surfaces S3).
//
// The behavioral contract lives in `src/lib/breadcrumb-trail.ts`
// (`agentInstanceTabLabel`) and is unit-tested in
// `src/lib/__tests__/scoped-tab-title-2809.test.ts`. This guard proves the
// shell actually WIRES it, so nobody re-introduces the bare-tree-only
// recogniser (`segments[0] === "agents"`) that left every scoped agent address
// on the route's static title while the trail beside it read resolved names.
//
// Follows the repo convention of readFileSync + regex assertions against source
// text (root vitest env is "node"; no DOM render) — see
// `src/components/__tests__/app-shell-embed-trust.test.ts`.
// ---------------------------------------------------------------------------

const APP_SHELL = readFileSync(path.join(__dirname, "..", "app-shell.tsx"), "utf-8");

describe("app-shell tab title wiring (cinatra#2809)", () => {
  it("imports the trail's own tab-title rule", () => {
    expect(APP_SHELL).toMatch(
      /import\s*\{[\s\S]*?\bagentInstanceTabLabel\b[\s\S]*?\}\s*from\s*["']@\/lib\/breadcrumb-trail["']/,
    );
  });

  it("derives the agent label from that rule, not from a hand-rolled path match", () => {
    expect(APP_SHELL).toMatch(
      /const agentLabel = agentInstanceTabLabel\(pathname, breadcrumbSegments\)/,
    );
    expect(APP_SHELL).not.toMatch(/segments\[0\] === "agents"/);
    expect(APP_SHELL).not.toMatch(/segments\.slice\(0, 4\)/);
  });

  it("still leaves an id-bearing route's title to the route itself when no label resolves", () => {
    expect(APP_SHELL).toMatch(/segments\.some\(\(seg\) => isIdLikeSegment\(seg\)\)/);
    expect(APP_SHELL).toMatch(/resolved = null;/);
    expect(APP_SHELL).toMatch(/if \(!resolved\) return;/);
  });

  it("re-asserts the resolved title when the route's own metadata lands after it", () => {
    // The launch redirect replaces the launcher address with the created
    // instance's own, and React commits that route's `<title>` after this
    // effect has run — the tab went back to the route's generic title while the
    // trail beside it named the run.
    expect(APP_SHELL).toMatch(/new MutationObserver\(apply\)/);
    expect(APP_SHELL).toMatch(
      /observer\.observe\(head, \{ childList: true, subtree: true, characterData: true \}\)/,
    );
    // Guarded, so the re-assert cannot loop on its own write.
    expect(APP_SHELL).toMatch(/if \(document\.title !== resolved\) document\.title = resolved;/);
    expect(APP_SHELL).toMatch(/observer\.disconnect\(\)/);
  });
});
