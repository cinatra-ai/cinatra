/**
 * cinatra#2088 (epic #2086 S1) — the pure bundle-digest + one-hop router
 * reference lint. No DB, no fs: the deterministic revision identity over a
 * manifest's (path, digest) set, and the router-reference validator.
 */
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  computeBundleDigest,
  lintBundleRouterReferences,
  normalizeBundledRelPath,
  SKILL_ROUTER_PATH,
  type BundleManifestEntry,
} from "@/lib/skill-bundle-store";

const d = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("computeBundleDigest — deterministic revision identity", () => {
  it("is order-independent (sorted internally by normalized path)", () => {
    const a: BundleManifestEntry[] = [
      { path: "SKILL.md", digest: d("router") },
      { path: "references/a.md", digest: d("aaa") },
      { path: "references/b.md", digest: d("bbb") },
    ];
    const shuffled: BundleManifestEntry[] = [a[2], a[0], a[1]];
    expect(computeBundleDigest(shuffled)).toBe(computeBundleDigest(a));
  });

  it("normalizes native/backslash + './' paths to the same POSIX identity", () => {
    const posix: BundleManifestEntry[] = [
      { path: "SKILL.md", digest: d("router") },
      { path: "references/x.md", digest: d("xxx") },
    ];
    const native: BundleManifestEntry[] = [
      { path: "./SKILL.md", digest: d("router") },
      { path: "references\\x.md", digest: d("xxx") },
    ];
    expect(computeBundleDigest(native)).toBe(computeBundleDigest(posix));
  });

  it("changes when any file's bytes change (per-file digest is in the frame)", () => {
    const base: BundleManifestEntry[] = [
      { path: "SKILL.md", digest: d("router") },
      { path: "references/x.md", digest: d("xxx") },
    ];
    const changed: BundleManifestEntry[] = [
      { path: "SKILL.md", digest: d("router") },
      { path: "references/x.md", digest: d("XXX-changed") },
    ];
    expect(computeBundleDigest(changed)).not.toBe(computeBundleDigest(base));
  });

  it("changes when the file SET changes (add/remove a reference)", () => {
    const one: BundleManifestEntry[] = [{ path: "SKILL.md", digest: d("router") }];
    const two: BundleManifestEntry[] = [
      { path: "SKILL.md", digest: d("router") },
      { path: "references/x.md", digest: d("xxx") },
    ];
    expect(computeBundleDigest(one)).not.toBe(computeBundleDigest(two));
  });

  it("changes when a file is RENAMED (path is framed, not just bytes)", () => {
    const before: BundleManifestEntry[] = [
      { path: "SKILL.md", digest: d("router") },
      { path: "references/x.md", digest: d("xxx") },
    ];
    const renamed: BundleManifestEntry[] = [
      { path: "SKILL.md", digest: d("router") },
      { path: "references/y.md", digest: d("xxx") },
    ];
    expect(computeBundleDigest(renamed)).not.toBe(computeBundleDigest(before));
  });

  it("rejects an empty manifest, a missing/duplicate router, and a bad path/digest", () => {
    expect(() => computeBundleDigest([])).toThrow(/empty manifest/);
    expect(() => computeBundleDigest([{ path: "references/x.md", digest: d("x") }])).toThrow(/exactly one SKILL\.md/);
    expect(() =>
      computeBundleDigest([
        { path: "SKILL.md", digest: d("r") },
        { path: "SKILL.md", digest: d("r") },
      ]),
    ).toThrow(/duplicate/);
    expect(() =>
      computeBundleDigest([
        { path: "SKILL.md", digest: d("r") },
        { path: "../escape.md", digest: d("e") },
      ]),
    ).toThrow(/traversal|rejected/);
    expect(() =>
      computeBundleDigest([{ path: "SKILL.md", digest: "not-a-sha" }]),
    ).toThrow(/malformed content digest/);
  });

  it("SKILL_ROUTER_PATH is the canonical router path", () => {
    expect(SKILL_ROUTER_PATH).toBe("SKILL.md");
  });
});

describe("lintBundleRouterReferences — one-hop reference lint", () => {
  const manifest = ["SKILL.md", "references/guide.md", "assets/logo.png"];

  it("passes when every relative reference resolves to a manifest path", () => {
    const md = [
      "# Skill",
      "See [the guide](references/guide.md) and the `references/guide.md` file.",
      "![logo](assets/logo.png)",
      "External [docs](https://example.com/x) and an [anchor](#section) are ignored.",
      "A bare word like references is not a path.",
    ].join("\n");
    expect(lintBundleRouterReferences(md, manifest)).toEqual({ ok: true, missing: [] });
  });

  it("flags a dangling one-hop reference to a file that was never bundled", () => {
    const md = "See [missing](references/absent.md) and [ok](references/guide.md).";
    const res = lintBundleRouterReferences(md, manifest);
    expect(res.ok).toBe(false);
    expect(res.missing).toEqual(["references/absent.md"]);
  });

  it("flags a traversal reference (never silently passed)", () => {
    const md = "Bad [escape](../secret/x.md).";
    const res = lintBundleRouterReferences(md, manifest);
    expect(res.ok).toBe(false);
    expect(res.missing).toContain("../secret/x.md");
  });

  it("ignores absolute URLs, mailto, root-absolute, and anchors", () => {
    const md = "[a](http://x/y) [b](mailto:x@y.z) [c](/abs/path.md) [d](#top)";
    expect(lintBundleRouterReferences(md, manifest)).toEqual({ ok: true, missing: [] });
  });

  it("is LINEAR on adversarial input (no polynomial-time backtracking)", () => {
    // The naive regexes for markdown links are polynomial on a body full of
    // `[` or `((`; SKILL.md content arrives from an installed extension, so the
    // scanner must stay linear. Each of these would take super-linear time
    // under a backtracking matcher; here they complete in milliseconds.
    for (const body of ["[".repeat(60_000), "[](".repeat(30_000), "`".repeat(60_000)]) {
      const started = Date.now();
      const res = lintBundleRouterReferences(body, manifest);
      expect(res.ok).toBe(true);
      expect(Date.now() - started).toBeLessThan(1_000);
    }
  });

  it("still extracts a link that FOLLOWS unbalanced brackets", () => {
    const md = "[[[ noise ]]] then [ok](references/guide.md) and [bad](references/absent.md)";
    const res = lintBundleRouterReferences(md, manifest);
    expect(res.missing).toEqual(["references/absent.md"]);
  });
});

describe("normalizeBundledRelPath — DRIFT GUARD against the packages/llm twin", () => {
  // The zip builder in `packages/llm/src/tools/anthropic-skill-content-hash.ts`
  // keeps its own `normalizeBundledRelPath` (the app leaf cannot import the llm
  // barrel — that closes a circular import through src/lib/database.ts). The two
  // MUST agree, or a bundle could normalize one way for the stored manifest and
  // another for the uploaded zip. This test imports both and pins them together.
  it("agrees with the packages/llm implementation on accepted and rejected paths", async () => {
    const llm = await import("../../../packages/llm/src/tools/anthropic-skill-content-hash");
    const corpus = [
      "SKILL.md",
      "references/guide.md",
      "./references/guide.md",
      "references//guide.md",
      "assets\\logo.png",
      "a/./b/c.txt",
      "deep/nested/dir/file.bin",
      "/abs/path.md",
      "../escape.md",
      "a/../b.md",
      "..",
      ".",
      "",
    ];
    for (const input of corpus) {
      let mine: string | null = null;
      let theirs: string | null = null;
      try {
        mine = normalizeBundledRelPath(input);
      } catch {
        mine = null;
      }
      try {
        theirs = llm.normalizeBundledRelPath(input);
      } catch {
        theirs = null;
      }
      expect({ input, mine }).toEqual({ input, mine: theirs });
    }
  });
});

describe("cycle guard — the bundle store must not pull a workspace package into database.ts's graph", () => {
  // `src/lib/database.ts` imports `@/lib/skill-bundle-store`. The
  // `@cinatra-ai/llm` barrel re-exports `packages/llm/src/registry.ts`, which
  // imports `@/lib/database` — so ANY package-barrel import added to the store
  // closes a circular import through the app's central store hub. In the Next
  // production bundle that cycle left an unrelated module namespace undefined
  // and prod boot never answered /api/health. Keep the store on node builtins
  // and `@/lib/*` leaves only.
  it("skill-bundle-store.ts imports only node builtins, server-only, and @/lib leaves", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(
      path.join(process.cwd(), "src/lib/skill-bundle-store.ts"),
      "utf8",
    );
    const specifiers = [...src.matchAll(/^import[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
    const offenders = specifiers.filter(
      (s) => !(s === "server-only" || s.startsWith("node:") || s.startsWith("@/lib/")),
    );
    expect(offenders).toEqual([]);
  });
});
