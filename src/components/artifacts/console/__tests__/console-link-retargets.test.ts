// Console link-retarget + restore-route authz wiring (cinatra#1786).
//
// Source-level contract test (mirrors the chat undo-chip-wiring style): the
// entry affordances and cross-surface links that pointed at the legacy
// `/artifacts?mode=undo` surface now point at the `/configuration/artifacts`
// console, and the nested single-change-set restore route enforces BOTH the
// platform-admin gate and, on top of it, the per-object eligibility gate.
//
// cinatra#2700 (epic #2699) REVERSED the admin carve-out this file used to pin.
// `/configuration` is the admin area throughout, so the restore route is
// admin-gated like every other route in the segment; the assertion below asserts
// the gate's PRESENCE where it used to assert its absence. The per-object check
// is unchanged and still runs after the gate — an admin gets no bypass — so an
// admin addressing a foreign or no-longer-restorable change set still sees the
// graceful denied state rather than a broken confirmation.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("cinatra#1786 — legacy /artifacts?mode=undo links retargeted to the console", () => {
  it("the command menu links to the console restore tab and the change-review surface, not the retired modes", () => {
    const src = read("src/components/command-menu.tsx");
    expect(src).toContain("/configuration/artifacts?tab=restore");
    expect(src).not.toContain("/artifacts?mode=undo");
    expect(src).not.toContain("/artifacts?mode=merge");
  });

  it("the object-history panel change-set link points at the console restore tab", () => {
    const src = read("src/components/data-safety/object-history-panel.tsx");
    expect(src).toContain('href="/configuration/artifacts?tab=restore"');
    expect(src).not.toContain("/artifacts?mode=undo");
  });

  it("the object detail drawer full-history link points at the console restore tab", () => {
    const src = read("packages/objects/src/screens/object-detail-drawer.tsx");
    expect(src).toContain('href="/configuration/artifacts?tab=restore"');
    expect(src).not.toContain("/artifacts?mode=undo");
  });

  it("undoDeepLink builds the nested targeted-restore route", () => {
    const src = read("src/components/data-safety/undo-toast.tsx");
    expect(src).toContain("/configuration/artifacts/restore/");
    expect(src).not.toContain("/artifacts?mode=undo");
  });
});

describe("cinatra#1786 + #2700 — targeted-restore route gate + eligibility wiring", () => {
  const routeSrc = read(
    "src/app/configuration/artifacts/restore/[changeSetId]/page.tsx",
  );

  it("requires the platform-admin session (cinatra#2700 — the /configuration rule)", () => {
    expect(routeSrc).toContain("await requireAdminSession()");
    // The retired session-only gate must not creep back in.
    expect(routeSrc).not.toContain("getAuthSession");
    // ...and the page must not advertise the retired member self-service path.
    expect(routeSrc).not.toContain("no administrator role required");
  });

  it("keeps the per-object eligibility loader ON TOP of the admin gate (no admin bypass)", () => {
    expect(routeSrc).toContain("loadAuthorizedTargetedRestore");
  });

  it("the confirm ACTION carries the same gate — a server action bypasses the page", () => {
    const actionSrc = read("src/components/data-safety/restore-change-set-action.ts");
    expect(actionSrc).toContain("await requireAdminSession()");
    expect(actionSrc).not.toContain("await requireAuthSession()");
    // The per-object loop is untouched by the sweep.
    expect(actionSrc).toContain("assertChangeSetRestoreAccess");
  });

  it("renders the confirmation for an eligible actor and the denied state otherwise", () => {
    expect(routeSrc).toContain("TargetedRestoreMode");
    expect(routeSrc).toContain("artifacts-restore-route-denied");
  });
});
