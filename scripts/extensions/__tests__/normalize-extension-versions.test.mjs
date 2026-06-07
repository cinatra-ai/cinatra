import { describe, expect, it } from "vitest";

import {
  TARGET_VERSION,
  OAS_REL_PATH,
  isOutlier,
  planNormalization,
  formatPlan,
  parseArgs,
  setPackageJsonVersion,
  readOasPackageVersion,
  setOasPackageVersion,
  assertNoPublishingOps,
  normalizeRepos,
} from "../normalize-extension-versions.mjs";

describe("isOutlier", () => {
  it("true when version differs from target, false when equal", () => {
    expect(isOutlier("1.0.0", "0.1.0")).toBe(true);
    expect(isOutlier("0.1.0", "0.1.0")).toBe(false);
    expect(isOutlier(" 0.1.0 ", "0.1.0")).toBe(false); // trims
    expect(isOutlier("0.1.10", "0.1.0")).toBe(true);
  });
});

describe("planNormalization", () => {
  it("splits outliers / already-at / unreadable; deterministic order", () => {
    const plan = planNormalization([
      { name: "b-agent", version: "0.1.1" },
      { name: "a-agent", version: "0.1.0" },
      { name: "c-agent", version: "1.0.0" },
      { name: "d-agent", version: null }, // unreadable
      { name: "a-skill", version: "0.1.0" },
    ]);
    expect(plan.target).toBe("0.1.0");
    expect(plan.toBump).toEqual([
      { name: "b-agent", from: "0.1.1", to: "0.1.0" },
      { name: "c-agent", from: "1.0.0", to: "0.1.0" },
    ]);
    expect(plan.alreadyAt).toEqual(["a-agent", "a-skill"]);
    expect(plan.unreadable).toEqual(["d-agent"]);
  });
  it("a fleet already at target → no bumps", () => {
    const plan = planNormalization([{ name: "x", version: "0.1.0" }]);
    expect(plan.toBump).toEqual([]);
    expect(plan.alreadyAt).toEqual(["x"]);
  });

  it("selects OAS-only drift (package.json already 0.1.0 but oas drifted)", () => {
    const plan = planNormalization([
      { name: "oas-drift", version: "0.1.0", oasVersion: "0.1.3" }, // pkg fine, oas stale
      { name: "both-drift", version: "0.2.0", oasVersion: "0.2.0" },
      { name: "clean-agent", version: "0.1.0", oasVersion: "0.1.0" },
      { name: "non-agent", version: "0.1.0" }, // no oasVersion → skill/connector
    ]);
    expect(plan.toBump).toEqual([
      { name: "both-drift", from: "0.2.0", to: "0.1.0", oasFrom: "0.2.0", oasTo: "0.1.0" },
      { name: "oas-drift", from: "0.1.0", to: "0.1.0", oasFrom: "0.1.3", oasTo: "0.1.0" },
    ]);
    expect(plan.alreadyAt).toEqual(["clean-agent", "non-agent"]);
  });

  it("an agent with an unreadable/missing OAS is surfaced as unreadable, not clean", () => {
    const plan = planNormalization([
      { name: "bad-agent", version: "0.1.0", oasUnreadable: true },
      { name: "ok", version: "0.1.0", oasVersion: "0.1.0" },
    ]);
    expect(plan.unreadable).toEqual(["bad-agent"]);
    expect(plan.alreadyAt).toEqual(["ok"]);
    expect(plan.toBump).toEqual([]);
  });
});

describe("formatPlan", () => {
  it("reports counts + per-repo bump lines + unreadable", () => {
    const msg = formatPlan(planNormalization([
      { name: "b", version: "0.1.1" },
      { name: "a", version: "0.1.0" },
      { name: "u", version: null },
    ]));
    expect(msg).toContain("target 0.1.0");
    expect(msg).toContain("to bump:    1");
    expect(msg).toContain("already at: 1");
    expect(msg).toContain("UNREADABLE: 1");
    expect(msg).toContain("• b: 0.1.1 → 0.1.0");
  });
});

describe("parseArgs", () => {
  it("dry-run by default; flags + only/target", () => {
    expect(parseArgs([])).toEqual({ apply: false, push: false, only: null, target: "0.1.0" });
    expect(parseArgs(["--apply"])).toMatchObject({ apply: true, push: false });
    expect(parseArgs(["--apply", "--push"])).toMatchObject({ apply: true, push: true });
    expect(parseArgs(["--only", "a, b ,c"])).toMatchObject({ only: ["a", "b", "c"] });
    expect(parseArgs(["--target", "0.2.0"])).toMatchObject({ target: "0.2.0" });
  });
});

describe("setPackageJsonVersion", () => {
  it("sets the version, preserves other fields, trailing newline", () => {
    const out = setPackageJsonVersion(JSON.stringify({ name: "@cinatra-ai/x", version: "1.0.0", type: "module" }), "0.1.0");
    const obj = JSON.parse(out);
    expect(obj.version).toBe("0.1.0");
    expect(obj.name).toBe("@cinatra-ai/x");
    expect(obj.type).toBe("module");
    expect(out.endsWith("\n")).toBe(true);
  });
  it("throws when there is no version field", () => {
    expect(() => setPackageJsonVersion(JSON.stringify({ name: "x" }), "0.1.0")).toThrow(/no string `version`/);
  });
});

describe("readOasPackageVersion", () => {
  it("reads metadata.cinatra.packageVersion; null when absent/unparseable", () => {
    expect(readOasPackageVersion(JSON.stringify({ metadata: { cinatra: { packageVersion: "0.1.3" } } }))).toBe("0.1.3");
    expect(readOasPackageVersion(JSON.stringify({ metadata: { cinatra: {} } }))).toBe(null);
    expect(readOasPackageVersion(JSON.stringify({ openapi: "3.0.0" }))).toBe(null);
    expect(readOasPackageVersion("{ not json")).toBe(null);
  });
});

describe("setOasPackageVersion (scoped, minimal-diff, post-validated)", () => {
  it("syncs metadata.cinatra.packageVersion and preserves the rest byte-for-byte", () => {
    const text = `{
  "openapi": "3.0.0",
  "metadata": {
    "cinatra": {
      "packageName": "@cinatra-ai/web-research-agent",
      "packageVersion": "0.1.3",
      "toolboxes": ["web_search"]
    }
  }
}
`;
    const r = setOasPackageVersion(text, "0.1.0");
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    // Only the 5 chars of the version string changed — everything else identical.
    expect(r.text).toBe(text.replace('"packageVersion": "0.1.3"', '"packageVersion": "0.1.0"'));
    expect(JSON.parse(r.text).metadata.cinatra.packageVersion).toBe("0.1.0");
    expect(JSON.parse(r.text).metadata.cinatra.packageName).toBe("@cinatra-ai/web-research-agent");
  });

  it("idempotent: already at target → no change", () => {
    const text = JSON.stringify({ metadata: { cinatra: { packageVersion: "0.1.0" } } });
    expect(setOasPackageVersion(text, "0.1.0")).toMatchObject({ ok: true, changed: false });
  });

  it("no metadata.cinatra.packageVersion field → ok no-op (non-agent OAS, untouched)", () => {
    const text = JSON.stringify({ openapi: "3.0.0", info: { version: "9.9.9" } });
    const r = setOasPackageVersion(text, "0.1.0");
    expect(r).toMatchObject({ ok: true, changed: false });
    expect(r.text).toBe(text);
  });

  it("does NOT touch a coincidental packageVersion elsewhere — only metadata.cinatra", () => {
    // A decoy `packageVersion` inside a schema example must be left alone.
    const text = `{
  "components": { "examples": { "x": { "packageVersion": "9.9.9" } } },
  "metadata": { "cinatra": { "packageVersion": "0.1.3" } }
}
`;
    const r = setOasPackageVersion(text, "0.1.0");
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    const obj = JSON.parse(r.text);
    expect(obj.metadata.cinatra.packageVersion).toBe("0.1.0");
    expect(obj.components.examples.x.packageVersion).toBe("9.9.9"); // decoy untouched
  });

  it("unparseable OAS → ok:false (caller must fail closed, never silently skip)", () => {
    expect(setOasPackageVersion("{ not json", "0.1.0")).toMatchObject({ ok: false, changed: false });
  });
});

describe("assertNoPublishingOps (the no-publish guard)", () => {
  it("allows clone/add/commit/push-branch (HEAD)", () => {
    expect(() => assertNoPublishingOps("gh", ["repo", "clone", "cinatra-ai/x", "/tmp/x"])).not.toThrow();
    expect(() => assertNoPublishingOps("git", ["-C", "/tmp/x", "add", "package.json"])).not.toThrow();
    expect(() => assertNoPublishingOps("git", ["-C", "/tmp/x", "commit", "-m", "chore: pin version to v0.1.0"])).not.toThrow();
    expect(() => assertNoPublishingOps("git", ["-C", "/tmp/x", "push", "origin", "HEAD"])).not.toThrow();
  });
  it("does NOT falsely block a branch named like v629-… (only semver-shaped tags)", () => {
    expect(() => assertNoPublishingOps("git", ["push", "origin", "v629-version-normalize-tool"])).not.toThrow();
    expect(() => assertNoPublishingOps("git", ["push", "origin", "main"])).not.toThrow();
    expect(() => assertNoPublishingOps("git", ["push", "origin", "HEAD:refs/heads/main"])).not.toThrow();
  });
  it("BLOCKS git tag, bare version-tag push, --tags, gh release, publish", () => {
    expect(() => assertNoPublishingOps("git", ["-C", "/tmp/x", "tag", "v0.1.0"])).toThrow(/never `git tag`/);
    expect(() => assertNoPublishingOps("git", ["-C", "/tmp/x", "push", "origin", "v0.1.0"])).toThrow(/version tag/i);
    expect(() => assertNoPublishingOps("git", ["push", "--tags"])).toThrow(/tag/i);
    expect(() => assertNoPublishingOps("git", ["push", "--follow-tags"])).toThrow(/tag/i);
    expect(() => assertNoPublishingOps("gh", ["release", "create", "v0.1.0"])).toThrow(/never `gh release`/);
    expect(() => assertNoPublishingOps("gh", ["api", "--method", "POST", "publish"])).toThrow(/never publish/);
  });
  it("BLOCKS tag-push REFSPEC destinations incl. force (+) and mirror", () => {
    expect(() => assertNoPublishingOps("git", ["push", "origin", "HEAD:refs/tags/v0.1.0"])).toThrow(/refs\/tags/);
    expect(() => assertNoPublishingOps("git", ["push", "origin", "refs/heads/main:refs/tags/v0.1.0"])).toThrow(/refs\/tags/);
    expect(() => assertNoPublishingOps("git", ["push", "origin", "refs/tags/v0.1.0"])).toThrow(/refs\/tags/);
    expect(() => assertNoPublishingOps("git", ["push", "origin", "+refs/tags/v0.1.0"])).toThrow(/refs\/tags/);
    expect(() => assertNoPublishingOps("git", ["push", "origin", "+HEAD:refs/tags/v0.1.0"])).toThrow(/refs\/tags/);
    expect(() => assertNoPublishingOps("git", ["push", "--mirror", "origin"])).toThrow(/mirror/i);
  });
});

describe("normalizeRepos", () => {
  const makeOps = () => {
    const calls = [];
    const files = new Map();
    return {
      calls,
      files,
      ops: {
        run: (tool, args, opts = {}) => {
          (opts.assert || (() => {}))(tool, args);
          calls.push([tool, ...args]);
          // simulate clone writing a package.json into the temp dir
          if (tool === "gh" && args[0] === "repo" && args[1] === "clone") {
            const dir = args[3];
            files.set(`${dir}/package.json`, JSON.stringify({ name: "@cinatra-ai/pkg", version: "1.0.0", type: "module" }));
          }
          return Promise.resolve({ stdout: "" });
        },
        readFile: (p) => Promise.resolve(files.get(p)),
        writeFile: (p, t) => { files.set(p, t); return Promise.resolve(); },
        mkdtemp: () => Promise.resolve("/tmp/vnorm-abc"),
      },
    };
  };

  it("dry-run does no git/gh ops", async () => {
    const { calls, ops } = makeOps();
    const res = await normalizeRepos([{ name: "a", from: "1.0.0" }], { apply: false, push: false, target: "0.1.0", ops });
    expect(calls).toEqual([]);
    expect(res).toEqual([{ name: "a", from: "1.0.0", to: "0.1.0", action: "dry-run" }]);
  });

  it("--apply (no push): clone → set version → add → commit; NO push; NO tag/release", async () => {
    const { calls, files, ops } = makeOps();
    const res = await normalizeRepos([{ name: "a", from: "1.0.0" }], { apply: true, push: false, target: "0.1.0", ops });
    const tools = calls.map((c) => `${c[0]} ${c.slice(1).filter((x) => !x.startsWith("/")).join(" ")}`);
    expect(tools.some((t) => t.startsWith("gh repo clone"))).toBe(true);
    // clone is config-proof: --no-tags (nothing to push, no local tag state)
    expect(calls.some((c) => c[0] === "gh" && c.includes("--no-tags"))).toBe(true);
    expect(tools.some((t) => t.includes("add package.json"))).toBe(true);
    expect(tools.some((t) => t.includes("commit"))).toBe(true);
    expect(calls.some((c) => c.includes("push"))).toBe(false);
    expect(calls.some((c) => c.includes("tag"))).toBe(false);
    expect(calls.some((c) => c[0] === "gh" && c[1] === "release")).toBe(false);
    // version was actually rewritten in the temp file
    expect(JSON.parse(files.get("/tmp/vnorm-abc/package.json")).version).toBe("0.1.0");
    expect(res[0].action).toBe("committed (not pushed)");
  });

  it("--apply --push: also pushes the default branch (HEAD), still no tag", async () => {
    const { calls, ops } = makeOps();
    const res = await normalizeRepos([{ name: "a", from: "1.0.0" }], { apply: true, push: true, target: "0.1.0", ops });
    expect(calls.some((c) => c[0] === "git" && c.includes("push") && c.includes("HEAD"))).toBe(true);
    // push is config-proof: --no-follow-tags overrides push.followTags=true
    expect(calls.some((c) => c[0] === "git" && c.includes("push") && c.includes("--no-follow-tags"))).toBe(true);
    expect(calls.some((c) => c.includes("tag"))).toBe(false);
    expect(res[0].action).toBe("committed+pushed");
  });

  it("syncs cinatra/oas.json alongside package.json, adds BOTH, one commit", async () => {
    const calls = [];
    const files = new Map();
    const ops = {
      run: (tool, args, opts = {}) => {
        (opts.assert || (() => {}))(tool, args);
        calls.push([tool, ...args]);
        if (tool === "gh" && args[0] === "repo" && args[1] === "clone") {
          const dir = args[3];
          files.set(`${dir}/package.json`, JSON.stringify({ name: "@cinatra-ai/web-research-agent", version: "1.0.0" }));
          files.set(`${dir}/${OAS_REL_PATH}`, JSON.stringify({ metadata: { cinatra: { packageVersion: "0.1.3" } } }));
        }
        return Promise.resolve({ stdout: "" });
      },
      readFile: (p) => Promise.resolve(files.get(p)),
      writeFile: (p, t) => { files.set(p, t); return Promise.resolve(); },
      mkdtemp: () => Promise.resolve("/tmp/vnorm-oas"),
    };
    const res = await normalizeRepos([{ name: "web-research-agent", from: "1.0.0", oasFrom: "0.1.3", oasTo: "0.1.0" }], { apply: true, push: true, target: "0.1.0", ops });
    const added = calls.filter((c) => c[0] === "git" && c.includes("add")).map((c) => c[c.length - 1]);
    expect(added).toContain("package.json");
    expect(added).toContain(OAS_REL_PATH);
    // exactly one commit
    expect(calls.filter((c) => c[0] === "git" && c.includes("commit"))).toHaveLength(1);
    expect(JSON.parse(files.get("/tmp/vnorm-oas/package.json")).version).toBe("0.1.0");
    expect(JSON.parse(files.get(`/tmp/vnorm-oas/${OAS_REL_PATH}`)).metadata.cinatra.packageVersion).toBe("0.1.0");
    expect(res[0].action).toBe("committed+pushed");
    expect(res[0].files).toEqual(["package.json", OAS_REL_PATH]);
  });

  it("OAS-only drift (package.json already 0.1.0): commits ONLY oas.json", async () => {
    const calls = [];
    const files = new Map();
    const ops = {
      run: (tool, args, opts = {}) => {
        (opts.assert || (() => {}))(tool, args);
        calls.push([tool, ...args]);
        if (tool === "gh" && args[1] === "clone") {
          const dir = args[3];
          files.set(`${dir}/package.json`, JSON.stringify({ name: "@cinatra-ai/x", version: "0.1.0" })); // already target
          files.set(`${dir}/${OAS_REL_PATH}`, JSON.stringify({ metadata: { cinatra: { packageVersion: "0.1.1" } } }));
        }
        return Promise.resolve({ stdout: "" });
      },
      readFile: (p) => Promise.resolve(files.get(p)),
      writeFile: (p, t) => { files.set(p, t); return Promise.resolve(); },
      mkdtemp: () => Promise.resolve("/tmp/vnorm-oasonly"),
    };
    const res = await normalizeRepos([{ name: "x", from: "0.1.0", oasFrom: "0.1.1", oasTo: "0.1.0" }], { apply: true, push: false, target: "0.1.0", ops });
    const added = calls.filter((c) => c[0] === "git" && c.includes("add")).map((c) => c[c.length - 1]);
    expect(added).toEqual([OAS_REL_PATH]); // package.json NOT re-added (unchanged)
    expect(res[0].files).toEqual([OAS_REL_PATH]);
  });

  it("idempotent re-run (everything already at target): NO commit, NO empty commit", async () => {
    const calls = [];
    const files = new Map();
    const ops = {
      run: (tool, args, opts = {}) => {
        (opts.assert || (() => {}))(tool, args);
        calls.push([tool, ...args]);
        if (tool === "gh" && args[1] === "clone") {
          const dir = args[3];
          files.set(`${dir}/package.json`, JSON.stringify({ name: "@cinatra-ai/x", version: "0.1.0" }));
          files.set(`${dir}/${OAS_REL_PATH}`, JSON.stringify({ metadata: { cinatra: { packageVersion: "0.1.0" } } }));
        }
        return Promise.resolve({ stdout: "" });
      },
      readFile: (p) => Promise.resolve(files.get(p)),
      writeFile: (p, t) => { files.set(p, t); return Promise.resolve(); },
      mkdtemp: () => Promise.resolve("/tmp/vnorm-idem"),
    };
    const res = await normalizeRepos([{ name: "x", from: "0.1.0" }], { apply: true, push: true, target: "0.1.0", ops });
    expect(calls.some((c) => c[0] === "git" && c.includes("commit"))).toBe(false);
    expect(calls.some((c) => c[0] === "git" && c.includes("push"))).toBe(false);
    expect(res[0].action).toBe("already at target (no change)");
  });

  it("fails the repo closed when an agent OAS cannot be scoped safely", async () => {
    const files = new Map();
    const ops = {
      run: (tool, args, opts = {}) => {
        (opts.assert || (() => {}))(tool, args);
        if (tool === "gh" && args[1] === "clone") {
          const dir = args[3];
          files.set(`${dir}/package.json`, JSON.stringify({ name: "@cinatra-ai/x", version: "0.1.0" }));
          files.set(`${dir}/${OAS_REL_PATH}`, "{ not valid json with packageVersion 0.1.3");
        }
        return Promise.resolve({ stdout: "" });
      },
      readFile: (p) => Promise.resolve(files.get(p)),
      writeFile: (p, t) => { files.set(p, t); return Promise.resolve(); },
      mkdtemp: () => Promise.resolve("/tmp/vnorm-badoas"),
    };
    const res = await normalizeRepos([{ name: "x", from: "0.1.0", oasFrom: "0.1.3", oasTo: "0.1.0" }], { apply: true, push: false, target: "0.1.0", ops });
    expect(res[0].action).toBe("error");
    expect(res[0].error).toMatch(/could not be normalized safely/);
  });

  it("non-agent with a REAL fs-style readFile (throws ENOENT for missing OAS) commits package.json only", async () => {
    // Reproduces the back-compat trap: real fs.readFile rejects on a missing file.
    const calls = [];
    const files = new Map();
    const ops = {
      run: (tool, args, opts = {}) => {
        (opts.assert || (() => {}))(tool, args);
        calls.push([tool, ...args]);
        if (tool === "gh" && args[1] === "clone") {
          files.set(`${args[3]}/package.json`, JSON.stringify({ name: "@cinatra-ai/skill", version: "1.0.0", cinatra: { kind: "skill" } }));
        }
        return Promise.resolve({ stdout: "" });
      },
      readFile: (p) => (files.has(p) ? Promise.resolve(files.get(p)) : Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))),
      writeFile: (p, t) => { files.set(p, t); return Promise.resolve(); },
      mkdtemp: () => Promise.resolve("/tmp/vnorm-skill"),
    };
    const res = await normalizeRepos([{ name: "skill", from: "1.0.0" }], { apply: true, push: false, target: "0.1.0", ops });
    expect(res[0].action).toBe("committed (not pushed)"); // NOT "error"
    expect(res[0].files).toEqual(["package.json"]);
  });

  it("agent with a MISSING OAS fails closed (surfaced, not silently committed)", async () => {
    const files = new Map();
    const ops = {
      run: (tool, args, opts = {}) => {
        (opts.assert || (() => {}))(tool, args);
        if (tool === "gh" && args[1] === "clone") {
          files.set(`${args[3]}/package.json`, JSON.stringify({ name: "@cinatra-ai/a", version: "1.0.0", cinatra: { kind: "agent" } }));
        }
        return Promise.resolve({ stdout: "" });
      },
      readFile: (p) => (files.has(p) ? Promise.resolve(files.get(p)) : Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))),
      writeFile: (p, t) => { files.set(p, t); return Promise.resolve(); },
      mkdtemp: () => Promise.resolve("/tmp/vnorm-agent-nooas"),
    };
    const res = await normalizeRepos([{ name: "a", from: "1.0.0" }], { apply: true, push: false, target: "0.1.0", ops });
    expect(res[0].action).toBe("error");
    expect(res[0].error).toMatch(/missing cinatra\/oas\.json/);
  });

  it("captures per-repo errors without aborting the batch", async () => {
    const ops = {
      run: (tool, args, opts = {}) => {
        (opts.assert || (() => {}))(tool, args);
        if (tool === "gh" && args[1] === "clone") return Promise.reject(new Error("clone failed"));
        return Promise.resolve({ stdout: "" });
      },
      readFile: () => Promise.resolve("{}"),
      writeFile: () => Promise.resolve(),
      mkdtemp: () => Promise.resolve("/tmp/x"),
    };
    const res = await normalizeRepos([{ name: "a", from: "1.0.0" }, { name: "b", from: "0.2.0" }], { apply: true, push: false, target: "0.1.0", ops });
    expect(res).toHaveLength(2);
    expect(res.every((r) => r.action === "error")).toBe(true);
  });

  it("the guard fails closed if a forbidden op is ever attempted", async () => {
    // an ops.run that tries to tag should be rejected by the injected assert
    const ops = {
      run: (tool, args, opts = {}) => { (opts.assert || (() => {}))(tool, args); return Promise.resolve({ stdout: "" }); },
      readFile: () => Promise.resolve(JSON.stringify({ name: "x", version: "1.0.0" })),
      writeFile: () => Promise.resolve(),
      mkdtemp: () => Promise.resolve("/tmp/x"),
    };
    // directly assert the guard a caller would pass
    expect(() => assertNoPublishingOps("git", ["-C", "/tmp/x", "tag", "v0.1.0"])).toThrow();
  });
});

describe("module constant", () => {
  it("targets 0.1.0 by default", () => {
    expect(TARGET_VERSION).toBe("0.1.0");
  });
});
