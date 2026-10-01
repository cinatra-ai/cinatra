/**
 * cinatra#2951 — structural pin for the repair road.
 *
 * The product decision recorded on cinatra#2951 (2026-09-11) names the NEW-RUN
 * road as the intended repair road: a requested change on a reviewed artifact
 * dispatches a NEW run of the producing agent carrying the request
 * (`lifecycle-repair-dispatch-store`, the
 * `producer_repair` delivery). The direct-call repair function
 * `repairBlogPostDraft` was never reachable through the product — no route, no
 * orchestration step, no assistant action called it — so it is removed and the
 * comments that named it as a completion path name the new-run road instead.
 *
 * Why source-text and not behavior: the invariant IS the absence of an export and
 * the honesty of the naming; there is no runtime to drive for either. Same
 * technique as the sibling `a2a-internal-actor-seam-structural.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const AGENTS_SRC = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

function read(file: string): string {
  return readFileSync(path.join(AGENTS_SRC, file), "utf8");
}

describe("cinatra#2951 — the uncalled direct repair function is gone", () => {
  it("`repairBlogPostDraft` is no export of blog-post-repair-producer", () => {
    const source = read("blog-post-repair-producer.ts");
    expect(source).not.toContain("repairBlogPostDraft");
    expect(source).not.toMatch(/export\s+(async\s+)?function\s+repairBlogPostDraft/);
  });

  it("its input and result types went with it", () => {
    const source = read("blog-post-repair-producer.ts");
    expect(source).not.toContain("RepairBlogPostDraftInput");
    expect(source).not.toContain("RepairBlogPostDraftResult");
  });

  it("the lifecycle declaration re-export the registry owns is untouched", () => {
    const source = read("blog-post-repair-producer.ts");
    expect(source).toContain('export { BLOG_POST_LIFECYCLE } from "./lifecycle-repair-producer-registry"');
    expect(source).toContain("export const BLOG_POST_LIFECYCLE_CONFIG");
  });
});

describe("cinatra#2951 — the comments name the new-run road", () => {
  it("the CMS bridge names the dispatched new run, not a direct-call function", () => {
    const source = read("lifecycle-repair-cms-production-bridge.ts");
    expect(source).not.toContain("repairBlogPostDraft");
    expect(source).toContain("dispatched `producer_repair` run");
  });

  it("the dispatch store names the producing agent's own graph on the dispatched run", () => {
    const source = read("lifecycle-repair-dispatch-store.ts");
    expect(source).not.toContain("repairBlogPostDraft");
    expect(source).toContain("the producing agent's own graph");
  });
});

describe("cinatra#2951 — the audit evidence names its producing call honestly", () => {
  const index = readFileSync(
    path.join(REPO_ROOT, "scripts/ci/chat-hitl-capture-index.json"),
    "utf8",
  );

  it("the evidence index names no direct-call repair function", () => {
    expect(index).not.toContain("repairBlogPostDraft");
  });

  it("it names the new-run road as the producing call of the repair reading", () => {
    expect(index).toContain("new-run road");
  });
});
