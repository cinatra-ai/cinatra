/**
 * §VII route consolidation & retirement (cinatra#1431, issue AC-3): the former
 * `/data`, `/data/types` and `/data-safety` route trees are DELETED outright —
 * no redirects, so a stale link 404s via the normal not-found. This is a
 * source-level contract (no server): the App-Router page files that defined
 * those routes must not exist, and the merge-proposals surface must have moved
 * under `/artifacts`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const APP = path.resolve(__dirname, "..", "..");
const p = (rel: string) => path.join(APP, rel);

describe("cinatra#1431 §VII — /data* routes retired (no redirects)", () => {
  it.each([
    "data",
    "data/page.tsx",
    "data/types/page.tsx",
    "data/[id]/page.tsx",
    "data-safety",
    "data-safety/change-sets/page.tsx",
    "data-safety/change-sets/[changeSetId]/page.tsx",
    "data-safety/merge-proposals/page.tsx",
    "data-safety/merge-proposals/[proposalId]/page.tsx",
  ])("the retired route file/dir '%s' no longer exists", (rel) => {
    expect(existsSync(p(rel))).toBe(false);
  });
});

describe("merge-proposals relocated under /artifacts", () => {
  it("the detail route moved to /artifacts/merge-proposals/[proposalId]", () => {
    expect(existsSync(p("artifacts/merge-proposals/[proposalId]/page.tsx"))).toBe(true);
    expect(existsSync(p("artifacts/merge-proposals/[proposalId]/actions.ts"))).toBe(true);
  });

  it("the bare /artifacts/merge-proposals path is a notFound guard (no shadow of /artifacts/[id])", () => {
    expect(existsSync(p("artifacts/merge-proposals/page.tsx"))).toBe(true);
  });

  it("the consolidated /artifacts surface exists", () => {
    expect(existsSync(p("artifacts/page.tsx"))).toBe(true);
  });
});
