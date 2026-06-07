import { describe, expect, it } from "vitest";
import {
  sanitizeWorktreeSlug,
  findCollisions,
  formatResult,
} from "../src/worktree-collision-guard.mjs";

describe("worktree-collision-guard / sanitizeWorktreeSlug", () => {
  it("accepts lowercase kebab", () => {
    expect(sanitizeWorktreeSlug("feature-x")).toBe("feature-x");
  });

  it("downcases", () => {
    expect(sanitizeWorktreeSlug("Feature-X")).toBe("feature-x");
  });

  it("strips invalid characters", () => {
    expect(sanitizeWorktreeSlug("foo bar / baz")).toBe("foo-bar-baz");
  });

  it("trims leading/trailing dashes", () => {
    expect(sanitizeWorktreeSlug("---foo---")).toBe("foo");
  });

  it("caps at 30 characters", () => {
    const long = "a".repeat(50);
    expect(sanitizeWorktreeSlug(long)).toBe("a".repeat(30));
  });

  it("rejects empty input", () => {
    expect(sanitizeWorktreeSlug("")).toBeNull();
    expect(sanitizeWorktreeSlug(null)).toBeNull();
  });

  it("rejects pure punctuation", () => {
    expect(sanitizeWorktreeSlug("---")).toBeNull();
  });
});

describe("worktree-collision-guard / findCollisions", () => {
  const baseInject = {
    listWorktrees: () => [],
    listBranches: () => [],
  };

  it("returns FREE when slug is unique", () => {
    const result = findCollisions({ slug: "foo", ...baseInject });
    expect(result.verdict).toBe("FREE");
    expect(result.slug).toBe("foo");
  });

  it("detects worktree collision", () => {
    const result = findCollisions({
      slug: "foo",
      listWorktrees: () => [{ path: "/repo/.worktrees/foo", branch: "refs/heads/foo" }],
      listBranches: () => [],
    });
    expect(result.verdict).toBe("COLLISION");
    expect(result.kind).toBe("worktree");
  });

  it("detects branch collision (exact match)", () => {
    const result = findCollisions({
      slug: "bar",
      listWorktrees: () => [],
      listBranches: () => ["bar", "main", "other"],
    });
    expect(result.verdict).toBe("COLLISION");
    expect(result.kind).toBe("branch");
    expect(result.branch).toBe("bar");
  });

  it("detects worktree- prefixed branch collision", () => {
    const result = findCollisions({
      slug: "bar",
      listWorktrees: () => [],
      listBranches: () => ["worktree-bar"],
    });
    expect(result.verdict).toBe("COLLISION");
    expect(result.kind).toBe("branch");
    expect(result.branch).toBe("worktree-bar");
  });

  it("detects cinatra-ai- prefixed branch collision (heavy clones)", () => {
    const result = findCollisions({
      slug: "bar",
      listWorktrees: () => [],
      listBranches: () => ["cinatra-ai-bar"],
    });
    expect(result.verdict).toBe("COLLISION");
    expect(result.kind).toBe("branch");
  });

  it("returns INVALID when slug is empty", () => {
    const result = findCollisions({ slug: "", ...baseInject });
    expect(result.verdict).toBe("INVALID");
  });
});

describe("worktree-collision-guard / findCollisions self-match", () => {
  it("treats existing worktree at selfWorktreePath as FREE (resume case)", () => {
    const result = findCollisions({
      slug: "foo",
      listWorktrees: () => [{ path: "/repo/.worktrees/foo", branch: "refs/heads/foo" }],
      listBranches: () => [],
      selfWorktreePath: "/repo/.worktrees/foo",
    });
    expect(result.verdict).toBe("FREE");
    expect(result.kind).toBe("self-worktree");
  });

  it("treats existing branch matching selfBranch as FREE", () => {
    const result = findCollisions({
      slug: "bar",
      listWorktrees: () => [],
      listBranches: () => ["worktree-bar"],
      selfBranch: "bar",
    });
    expect(result.verdict).toBe("FREE");
    expect(result.kind).toBe("self-branch");
  });

  it("still detects other-worktree collision even when selfWorktreePath set", () => {
    const result = findCollisions({
      slug: "foo",
      listWorktrees: () => [{ path: "/other/foo", branch: "refs/heads/foo" }],
      listBranches: () => [],
      selfWorktreePath: "/repo/.worktrees/foo",
    });
    expect(result.verdict).toBe("COLLISION");
  });
});

describe("worktree-collision-guard / formatResult", () => {
  it("formats FREE", () => {
    expect(formatResult({ verdict: "FREE", slug: "x" })).toMatch(/FREE.*slug=x/);
  });

  it("formats worktree COLLISION", () => {
    expect(
      formatResult({ verdict: "COLLISION", kind: "worktree", slug: "x", path: "/p" })
    ).toMatch(/COLLISION.*worktree.*slug=x.*path=\/p/);
  });

  it("formats branch COLLISION", () => {
    expect(
      formatResult({ verdict: "COLLISION", kind: "branch", slug: "x", branch: "x" })
    ).toMatch(/COLLISION.*branch.*slug=x.*branch=x/);
  });
});
