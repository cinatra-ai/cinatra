/**
 * cinatra#2042 / #1796 (epic #2037 S4, acceptance #2047 row 8) — the
 * reviewer-agent / auditor-agent RETIREMENT identity gate, at EXACT ZERO.
 *
 * The AC requires the retirement grep to be EXACT-IDENTITY: the two retired
 * scoped package refs (assembled from parts in RETIRING below, never written as
 * literals in this file — see the note there) and their binding ids
 * `…:<binding>`, NOT a plain `reviewer-agent` substring — so RETAINED
 * packages like `code-reviewer-agent` / `security-reviewer-agent` never trip it.
 *
 * STATE: the retirement is COMPLETE. The owner ruled on the row-8 knot
 * (#2047, 2026-07-27): the five dependent flows (email-drafting, email-follow-up,
 * email-outreach, email-recipient-selection, blog-pipeline) each removed their
 * embedded reviewer/auditor step and required dependency and merged in their own
 * repos; core then removed the dev-extension entries, both lock pins, the
 * tsconfig alias, every generated binding/registration, the reviewer rendering
 * path (#1796's teardown) and the auditor's separate approval endpoints.
 *
 * So this file no longer RATCHETS a baseline — it asserts ZERO, in BOTH
 * constructions the acceptance used:
 *
 *   (1) `git grep -F` on the exact package ref (the ledger's construction);
 *   (2) `git grep -P` with the boundary-exact pattern from the #2047 annex —
 *       left boundary = the literal scope prefix, right = a negative lookahead
 *       over the package-name charset — which is also PROVEN here to
 *       discriminate against the retained `*-reviewer-agent` packages.
 *
 * A reintroduction of either identity anywhere in the tree fails the build.
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

/**
 * The exact-identity retiring-agent package refs.
 *
 * ASSEMBLED FROM PARTS, deliberately: writing the literals here would make this
 * guard file the last remaining match for its own assertion. The pre-teardown
 * version of this test carried the literals and excluded itself by path — which
 * a CROSS-REPO sweep (no exclusion list) would still have counted. Assembling
 * removes the special case entirely: the whole tree, this file included, greps
 * to true zero. Same technique the email-outreach-agent guard adopted
 * (email-outreach-agent#44).
 */
const SCOPE = "@cinatra-ai/";
const RETIRING = [`${SCOPE}${"reviewer"}-agent`, `${SCOPE}${"auditor"}-agent`] as const;

/** Files matching the exact package ref (fixed-string), repo-wide. */
function filesMatchingExactId(pkg: string): string[] {
  // `-F` fixed-string, exact package ref; `-l` list files; `git grep` respects
  // .gitignore (never scans node_modules). NO path exclusion: nothing in the
  // tree — this file included — may name either identity. Empty match ⇒
  // non-zero exit ⇒ no files.
  try {
    const out = execSync(`git grep -l -F ${JSON.stringify(pkg)} -- .`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Hits for the #2047-annex boundary-exact PCRE, repo-wide. */
function boundaryExactHits(): string[] {
  const pattern = `${SCOPE}(${"reviewer"}|${"auditor"})-agent(?![A-Za-z0-9._-])`;
  try {
    const out = execSync(`git grep -n -P ${JSON.stringify(pattern)} -- .`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

describe("cinatra#2042/#1796 — reviewer/auditor retirement identity gate", () => {
  it("EXACT-IDENTITY: the retiring package refs never match a RETAINED *-reviewer-agent package", () => {
    const retained = [
      `${SCOPE}code-reviewer-agent`,
      `${SCOPE}security-reviewer-agent`,
      `${SCOPE}${"reviewer"}-agent-v2`,
    ];
    const boundaryRe = new RegExp(
      `${SCOPE}(${"reviewer"}|${"auditor"})-agent(?![A-Za-z0-9._-])`,
    );
    for (const keep of retained) {
      expect(boundaryRe.test(keep), keep).toBe(false);
    }
    for (const keep of retained.slice(0, 2)) {
      for (const retire of RETIRING) {
        expect(keep.includes(retire)).toBe(false);
      }
    }
    // Control: the retiring refs themselves DO match, so a green result above is
    // discrimination and not a silently broken pattern.
    for (const retire of RETIRING) {
      expect(boundaryRe.test(retire), retire).toBe(true);
    }
  });

  it("ZERO (fixed-string): no file anywhere in the tree references either retired package ref", () => {
    for (const pkg of RETIRING) {
      const files = filesMatchingExactId(pkg);
      expect(files, `${pkg} still referenced by:\n${files.join("\n")}`).toEqual([]);
    }
  });

  it("ZERO (boundary-exact PCRE, the #2047 annex construction): no line matches either identity", () => {
    const hits = boundaryExactHits();
    expect(hits, `retired identities still present:\n${hits.join("\n")}`).toEqual([]);
  });

  it("the retirement is COMPLETE — neither package is a declared dev extension or a lock pin", () => {
    // Structural companion to the greps: the greps prove no TEXT survives; this
    // proves the DECLARATION surfaces that make a package installable are clean,
    // so a future re-add cannot be a silent data-only change.
    const read = (p: string) =>
      execSync(`git show HEAD:${p}`, { cwd: REPO_ROOT, encoding: "utf8" });
    const pkgJson = JSON.parse(read("package.json")) as {
      cinatra?: { devExtensions?: Record<string, string> };
    };
    const devExtensions = Object.keys(pkgJson.cinatra?.devExtensions ?? {});
    const devLock = JSON.parse(read("cinatra-dev-extensions.lock.json")) as {
      packages: Array<{ packageName: string }>;
    };
    const requiredLock = JSON.parse(read("cinatra-required-extensions.lock.json")) as {
      packages: Array<{ packageName: string }>;
    };
    const pinned = [
      ...devLock.packages.map((p) => p.packageName),
      ...requiredLock.packages.map((p) => p.packageName),
    ];
    for (const pkg of RETIRING) {
      expect(devExtensions, pkg).not.toContain(pkg);
      expect(pinned, pkg).not.toContain(pkg);
    }
  });
});
