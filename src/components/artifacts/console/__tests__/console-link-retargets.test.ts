// Console link-retarget + restore-route authz wiring (cinatra#1786).
//
// Source-level contract test (mirrors the chat undo-chip-wiring style): the
// entry affordances and cross-surface links that pointed at the legacy
// `/artifacts?mode=undo` surface now point at the `/configuration/artifacts`
// console, and the nested single-change-set restore route enforces the
// per-object eligibility gate WITHOUT admin-gating (any authorized role).

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

describe("cinatra#1786 — targeted-restore route eligibility wiring", () => {
  const routeSrc = read(
    "src/app/configuration/artifacts/restore/[changeSetId]/page.tsx",
  );

  it("gates on the per-object eligibility loader (no admin bypass)", () => {
    expect(routeSrc).toContain("loadAuthorizedTargetedRestore");
    // Reachable by any authorized role — the route must NOT admin-gate.
    expect(routeSrc).not.toContain("requireAdminSession");
  });

  it("renders the confirmation for an eligible actor and the denied state otherwise", () => {
    expect(routeSrc).toContain("TargetedRestoreMode");
    expect(routeSrc).toContain("artifacts-restore-route-denied");
  });
});
