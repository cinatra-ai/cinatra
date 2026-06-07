// Worktree-name collision guard.
//
// Pure logic for detecting whether a proposed worktree slug collides with an
// existing worktree directory or local branch in the same repo. Replaces the
// older planning-number collision guard; the new check is content-neutral —
// it only looks at name uniqueness, never at slot/identifier semantics.
//
// Public surface:
//   - sanitizeWorktreeSlug(input)
//   - findCollisions({ slug, repoRoot, listWorktrees, listBranches })
//   - runCollisionCheck({ slug, repoRoot, ...inject })
//   - makeDefaultGitImpl(repoRoot)
//   - formatResult(result)

import { execFileSync } from "node:child_process";

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,29}$/;

export function sanitizeWorktreeSlug(input) {
  if (typeof input !== "string") return null;
  const lowered = input.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  const trimmed = lowered.replace(/^-+/, "").replace(/-+$/, "");
  if (!trimmed) return null;
  const capped = trimmed.slice(0, 30);
  return SLUG_REGEX.test(capped) ? capped : null;
}

/**
 * Find worktree/branch collisions for a proposed slug.
 *
 * `selfWorktreePath` / `selfBranch` (optional): the worktree path / branch
 * the caller is operating IN. Matching the slug to the caller's own worktree
 * or branch is NOT a collision — it's the resume case for `cinatra setup
 * branch` re-running inside an already-provisioned worktree.
 */
export function findCollisions({
  slug,
  listWorktrees,
  listBranches,
  selfWorktreePath,
  selfBranch,
}) {
  if (!slug) {
    return { verdict: "INVALID", reason: "slug is empty or unsanitized" };
  }
  const worktrees = listWorktrees();
  const branches = listBranches();

  const wtCollision = worktrees.find(
    (w) => w.path && w.path.split("/").pop() === slug
  );
  if (wtCollision) {
    // Self-match — caller is operating inside this worktree. Not a collision.
    if (selfWorktreePath && wtCollision.path === selfWorktreePath) {
      return { verdict: "FREE", slug, kind: "self-worktree" };
    }
    return {
      verdict: "COLLISION",
      kind: "worktree",
      slug,
      path: wtCollision.path,
      branch: wtCollision.branch,
    };
  }

  const branchCollision = branches.find(
    (b) => b === slug || b === `worktree-${slug}` || b === `cinatra-ai-${slug}`
  );
  if (branchCollision) {
    // Self-match — caller is operating on this branch.
    if (selfBranch && (branchCollision === selfBranch || branchCollision === `worktree-${selfBranch}`)) {
      return { verdict: "FREE", slug, kind: "self-branch" };
    }
    return { verdict: "COLLISION", kind: "branch", slug, branch: branchCollision };
  }

  return { verdict: "FREE", slug };
}

export function makeDefaultGitImpl(repoRoot) {
  return {
    listWorktrees() {
      try {
        const out = execFileSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], {
          encoding: "utf8",
        });
        const entries = [];
        let cur = {};
        for (const line of out.split("\n")) {
          if (line.startsWith("worktree ")) {
            if (cur.path) entries.push(cur);
            cur = { path: line.slice("worktree ".length).trim() };
          } else if (line.startsWith("branch ")) {
            cur.branch = line.slice("branch ".length).trim();
          } else if (line.startsWith("HEAD ")) {
            cur.head = line.slice("HEAD ".length).trim();
          }
        }
        if (cur.path) entries.push(cur);
        return entries;
      } catch {
        return [];
      }
    },
    listBranches() {
      try {
        const out = execFileSync(
          "git",
          ["-C", repoRoot, "for-each-ref", "--format=%(refname:short)", "refs/heads/"],
          { encoding: "utf8" }
        );
        return out.split("\n").map((s) => s.trim()).filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

export function runCollisionCheck({
  slug,
  repoRoot,
  listWorktrees,
  listBranches,
  selfWorktreePath,
  selfBranch,
}) {
  if (!listWorktrees || !listBranches) {
    const impl = makeDefaultGitImpl(repoRoot ?? process.cwd());
    listWorktrees ??= impl.listWorktrees;
    listBranches ??= impl.listBranches;
  }
  const sanitized = sanitizeWorktreeSlug(slug);
  if (!sanitized) {
    return { verdict: "INVALID", reason: `slug ${JSON.stringify(slug)} fails ${SLUG_REGEX}` };
  }
  return findCollisions({
    slug: sanitized,
    listWorktrees,
    listBranches,
    selfWorktreePath,
    selfBranch,
  });
}

export function formatResult(result) {
  if (!result) return "[collision-guard] (no result)";
  if (result.verdict === "FREE") return `[collision-guard] FREE slug=${result.slug}`;
  if (result.verdict === "INVALID") return `[collision-guard] INVALID ${result.reason}`;
  if (result.verdict === "COLLISION") {
    if (result.kind === "worktree") {
      return `[collision-guard] COLLISION kind=worktree slug=${result.slug} path=${result.path}`;
    }
    return `[collision-guard] COLLISION kind=branch slug=${result.slug} branch=${result.branch}`;
  }
  return `[collision-guard] UNKNOWN ${JSON.stringify(result)}`;
}
