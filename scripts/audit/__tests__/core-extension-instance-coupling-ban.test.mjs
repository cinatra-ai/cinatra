import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  scanInstanceCoupling,
  diffGrown,
  diffShrunk,
  baselineGrowth,
  growthAllowance,
  maskAllowlistedIds,
  discoverExtensionNames,
  SCANNER_EPOCH,
} from "../core-extension-instance-coupling-ban.mjs";
import { GENERATED_MANIFEST_FILES } from "../../extensions/generated-manifest-files.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const GATE = join(REPO_ROOT, "scripts/audit/core-extension-instance-coupling-ban.mjs");

function runGate(extraEnv = {}) {
  return spawnSync("node", [GATE], { cwd: REPO_ROOT, env: { ...process.env, ...extraEnv }, encoding: "utf8" });
}

describe("core-extension-instance-coupling-ban gate", () => {
  it("derives extension names from package.json (same source as the import-ban gate)", () => {
    const names = discoverExtensionNames();
    expect(names.size).toBeGreaterThan(50);
    expect(names.has("@cinatra-ai/blog-skills")).toBe(true);
  });

  it("counts real hardcoded coupling (string + path literals) — sentinel: src/lib/blog/generation.ts", () => {
    const occ = scanInstanceCoupling();
    const genKeys = Object.keys(occ).filter((k) => k.startsWith("src/lib/blog/generation.ts ::"));
    expect(genKeys.length).toBeGreaterThan(0);
    expect(genKeys.some((k) => k.includes("package :: @cinatra-ai/"))).toBe(true);
  });

  it("regression guard: src/lib/blog/openai.ts is de-coupled (IoC cutover — resolves skills by capability key, not hardcoded extension)", () => {
    const occ = scanInstanceCoupling();
    const openaiKeys = Object.keys(occ).filter((k) => k.startsWith("src/lib/blog/openai.ts ::"));
    expect(openaiKeys).toEqual([]);
    // prefill-generation.ts is likewise de-coupled.
    const prefillKeys = Object.keys(occ).filter((k) => k.includes("prefill-generation.ts ::"));
    expect(prefillKeys).toEqual([]);
  });

  it("counts imports too (the src-only import-ban does not scan packages/ — close that hole)", () => {
    const occ = scanInstanceCoupling();
    // packages/* files that reference an extension package name (incl. imports)
    const pkgRefs = Object.keys(occ).filter((k) => k.startsWith("packages/") && k.includes(":: package ::"));
    expect(pkgRefs.length).toBeGreaterThan(0);
  });

  it("does NOT false-positive on the CORE @cinatra-ai/extensions/<subpath> package path", () => {
    const occ = scanInstanceCoupling();
    // `extensions/components/...` is a core packages/extensions subpath, NOT an
    // extensions/<scope>/<name> folder → must not be counted as a path.
    const fp = Object.keys(occ).filter((k) => k.includes("path :: extensions/components"));
    expect(fp).toEqual([]);
  });

  it("does NOT scan the extensions/ tree, the generated manifest TREE, or tests (unified exempt set, #36)", () => {
    const occ = scanInstanceCoupling();
    const files = new Set(Object.keys(occ).map((k) => k.split(" :: ")[0]));
    for (const f of files) {
      expect(f.startsWith("extensions/")).toBe(false);
      // The whole generator-emitted set is the ONE permanent-exempt class
      // (owner ruling on #36) — none of its files may appear in the scan.
      expect(GENERATED_MANIFEST_FILES, f).not.toContain(f);
      expect(/\.(test|spec)\.|\/__tests__\/|\/__mocks__\//.test(f)).toBe(false);
    }
  });

  it("the generated-tree exemption is the EXPLICIT emitted list, not a prefix — a hand-added file under src/lib/generated/ IS counted", () => {
    const root = mkdtempSync(join(tmpdir(), "instance-gate-genexempt-"));
    try {
      mkdirSync(join(root, "src/lib/generated"), { recursive: true });
      // A generator-emitted file naming an extension: EXEMPT (generator output).
      writeFileSync(
        join(root, "src/lib/generated/extensions.server.ts"),
        'export const M = { "@scope/sample-connector": {} };\n',
      );
      writeFileSync(
        join(root, "src/lib/generated/connector-setup-pages.ts"),
        'export const L = { "sample-connector": () => import("@scope/sample-connector/setup-page") };\n',
      );
      // A NON-emitted, hand-added file in the same dir: COUNTED (smuggling guard).
      writeFileSync(
        join(root, "src/lib/generated/hand-added-smuggle.ts"),
        'import { x } from "@scope/sample-connector";\nexport const y = x;\n',
      );
      const extensions = { names: new Set(["@scope/sample-connector"]), dirPaths: new Set() };
      const occ = scanInstanceCoupling(root, extensions, { allowlist: new Map() });
      expect(occ["src/lib/generated/extensions.server.ts :: package :: @scope/sample-connector"]).toBeUndefined();
      expect(occ["src/lib/generated/connector-setup-pages.ts :: package :: @scope/sample-connector"]).toBeUndefined();
      expect(occ["src/lib/generated/hand-added-smuggle.ts :: package :: @scope/sample-connector"]).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scanner-correctness regression: the comment-adjacent import shape stays counted (fixture); the live transport cluster is RETIRED", () => {
    // The historic live carrier of this regression —
    // src/lib/register-transport-connectors.ts, whose `@/lib/*` line comment
    // blinded the old regex stripper to its static import cluster — was fully
    // decoupled by the transport-DI inversion (cinatra#151 Stage 3; renamed
    // register-host-connector-services.ts, zero extension names). Pin BOTH
    // facts: the live tree carries no transport keys, and the comment-adjacent
    // shape itself is still counted via a synthetic fixture.
    const occ = scanInstanceCoupling();
    const transport = Object.keys(occ).filter(
      (k) =>
        k.startsWith("src/lib/register-transport-connectors.ts :: package ::") ||
        k.startsWith("src/lib/register-host-connector-services.ts :: package ::"),
    );
    expect(transport).toEqual([]);

    const root = mkdtempSync(join(tmpdir(), "instance-gate-comment-adjacent-"));
    try {
      mkdirSync(join(root, "src/lib"), { recursive: true });
      writeFileSync(
        join(root, "src/lib/binder.ts"),
        [
          "// `@/lib/*` is no longer reachable from any connector package itself.",
          'import { register } from "@scope/sample-connector/deps";',
          "export const x = register; /* trailing block */",
          "",
        ].join("\n"),
      );
      const extensions = { names: new Set(["@scope/sample-connector"]), dirPaths: new Set() };
      const fixtureOcc = scanInstanceCoupling(root, extensions, { allowlist: new Map() });
      expect(fixtureOcc["src/lib/binder.ts :: package :: @scope/sample-connector"]).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scanner-correctness regression (fixture): a placeholder-import comment directly above a live loader entry does not hide it", () => {
    const root = mkdtempSync(join(tmpdir(), "instance-gate-"));
    try {
      mkdirSync(join(root, "src/lib"), { recursive: true });
      writeFileSync(
        join(root, "src/lib/loader-map.ts"),
        [
          "const LOADERS = {",
          '  // replace the placeholder with `() => import("@scope/sample-connector/setup-page")`.',
          '  "sample-connector": () => import("@scope/sample-connector/setup-page"),',
          "};",
          "export default LOADERS;",
          "",
        ].join("\n"),
      );
      const extensions = {
        names: new Set(["@scope/sample-connector"]),
        dirPaths: new Set(),
      };
      const occ = scanInstanceCoupling(root, extensions, { allowlist: new Map() });
      // ONE live occurrence — the comment naming the same package never counts,
      // and the comment must not swallow the live entry below it.
      expect(occ["src/lib/loader-map.ts :: package :: @scope/sample-connector"]).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("regression guard: the connector loader/registry surfaces are de-coupled (loaders + readiness resolve from the generated manifest)", () => {
    const occ = scanInstanceCoupling();
    for (const file of [
      "src/lib/connector-setup-pages.ts",
      "src/lib/connector-modules.server.ts",
      "src/lib/connector-readiness.server.ts",
      "src/lib/connectors-registry.server.ts",
      "packages/connectors/src/pages.tsx",
      "src/app/plugins-registry.tsx",
      "src/app/api/app/setup-status/route.ts",
      "src/app/configuration/llm/apis-page.tsx",
      "src/app/connectors/wordpress/page.tsx",
      "src/app/connectors/resend/page.tsx",
      "src/app/connectors/resend/actions.ts",
    ]) {
      const keys = Object.keys(occ).filter((k) => k.startsWith(`${file} ::`));
      expect(keys, `expected ${file} to stay de-coupled`).toEqual([]);
    }
  });

  it("masks documented data-contract IDs before counting and reports them separately (exempt-set logic)", () => {
    const root = mkdtempSync(join(tmpdir(), "instance-gate-"));
    try {
      mkdirSync(join(root, "src/lib"), { recursive: true });
      writeFileSync(
        join(root, "src/lib/sample.ts"),
        [
          '// comment naming @scope/alpha-skills should never count',
          'const contract = "@scope/alpha-skills:make-things";', // exact allowlisted ID
          'const longer = "@scope/alpha-skills:make-things-v2";', // NOT allowlisted — shares a prefix only
          'const runtime = "@scope/alpha-skills";', // bare name — still counted
          'const other = "@scope/beta-connector";',
          "",
        ].join("\n"),
      );
      const extensions = {
        names: new Set(["@scope/alpha-skills", "@scope/beta-connector"]),
        dirPaths: new Set(),
      };
      const allowlist = new Map([["@scope/alpha-skills:make-things", "stable persisted capability key, not runtime selection"]]);
      const allowlistHits = new Map();
      const occ = scanInstanceCoupling(root, extensions, { allowlist, allowlistHits });
      // The EXACT allowlisted contract ID is masked — the bare runtime
      // reference AND the longer prefix-sharing ID still count (2), or the
      // allowlist would be a ratchet bypass for suffixed IDs.
      expect(occ["src/lib/sample.ts :: package :: @scope/alpha-skills"]).toBe(2);
      expect(occ["src/lib/sample.ts :: package :: @scope/beta-connector"]).toBe(1);
      expect(allowlistHits.get("@scope/alpha-skills:make-things")).toBe(1);
      // Without the allowlist, the contract ID's embedded name is counted too.
      const occNoAllow = scanInstanceCoupling(root, extensions, { allowlist: new Map() });
      expect(occNoAllow["src/lib/sample.ts :: package :: @scope/alpha-skills"]).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maskAllowlistedIds is boundary-exact: never masks a longer ID sharing an allowlisted prefix, or a prefixed/suffixed token", () => {
    const allowlist = new Map([["@scope/x:thing", "stable contract"]]);
    const hits = new Map();
    const masked = maskAllowlistedIds(
      'a("@scope/x:thing"); b("@scope/x:thing-v2"); c("pre@scope/x:thing"); d("@scope/x:thing.ext");',
      allowlist,
      hits,
    );
    expect(masked).not.toContain('"@scope/x:thing"');
    expect(masked).toContain("@scope/x:thing-v2");
    expect(masked).toContain("pre@scope/x:thing");
    expect(masked).toContain("@scope/x:thing.ext");
    expect(hits.get("@scope/x:thing")).toBe(1);
    // The sentinel is printable and not name-shaped.
    expect(masked).toMatch(/ALLOWLISTED_DATA_CONTRACT_ID/);
    // Regex metacharacters in an ID are escaped, not interpreted.
    const m2 = maskAllowlistedIds('x("@scope/y:a.b(c)")', new Map([["@scope/y:a.b(c)", "j"]]), new Map());
    expect(m2).not.toContain("@scope/y:a.b(c)");
  });

  it("growthAllowance NEVER permits growth — the zero-tolerance flip (#36) retired the epoch recompute path", () => {
    // THE bypass-resistance pin: the formerly sanctioned one-step epoch
    // advance (base N, committed N+1 == script epoch) no longer allows growth
    // — it is now a hard ERROR (the epoch is frozen; a scanner change must
    // land with the revealed references fixed, never via re-baselining).
    const formerlySanctioned = growthAllowance(SCANNER_EPOCH - 1, SCANNER_EPOCH);
    expect(formerlySanctioned.allowGrowth).toBe(false);
    expect(formerlySanctioned.error).toMatch(/FROZEN|can no longer sanction/);
    // Steady state: epochs equal — no error, and STILL no allowance.
    expect(growthAllowance(SCANNER_EPOCH, SCANNER_EPOCH)).toEqual({ allowGrowth: false, error: null });
    // A committed baseline whose epoch does not match the script must fail.
    expect(growthAllowance(SCANNER_EPOCH, SCANNER_EPOCH - 1).error).toMatch(/does not match/);
    // ANY base/committed epoch mismatch is tampering and must fail.
    expect(growthAllowance(SCANNER_EPOCH - 2, SCANNER_EPOCH).error).toMatch(/FROZEN|can no longer sanction/);
    expect(growthAllowance(SCANNER_EPOCH + 1, SCANNER_EPOCH).error).toMatch(/FROZEN|can no longer sanction/);
    // Exhaustive: NO epoch pair, in any direction, yields allowGrowth=true.
    for (let base = SCANNER_EPOCH - 2; base <= SCANNER_EPOCH + 2; base++) {
      for (let committed = SCANNER_EPOCH - 2; committed <= SCANNER_EPOCH + 2; committed++) {
        expect(growthAllowance(base, committed).allowGrowth, `base=${base} committed=${committed}`).toBe(false);
      }
    }
  });

  it("diffGrown flags a NEW occurrence and a GROWN count; diffShrunk flags a reduced count", () => {
    const base = { "a.ts :: package :: @x/foo": 1 };
    const cur = { "a.ts :: package :: @x/foo": 2, "b.ts :: path :: extensions/x/y": 1 };
    expect(diffGrown(base, cur)).toEqual([
      "a.ts :: package :: @x/foo (1 -> 2)",
      "b.ts :: path :: extensions/x/y (0 -> 1)",
    ]);
    expect(diffShrunk({ "a.ts :: package :: @x/foo": 2 }, { "a.ts :: package :: @x/foo": 1 })).toEqual([
      "a.ts :: package :: @x/foo (2 -> 1)",
    ]);
  });

  it("baselineGrowth catches a committed baseline that exceeds the base (regenerate-to-pass bypass)", () => {
    expect(baselineGrowth({ "a :: package :: @x/y": 1 }, { "a :: package :: @x/y": 2 })).toEqual([
      "a :: package :: @x/y (1 -> 2)",
    ]);
    // shrink-only is allowed
    expect(baselineGrowth({ "a :: package :: @x/y": 2 }, { "a :: package :: @x/y": 1 })).toEqual([]);
  });

  it("the committed repo state PASSES the gate (no NEW coupling vs the baseline)", () => {
    const res = runGate();
    expect(res.status, res.stderr || res.stdout).toBe(0);
    expect(res.stdout).toMatch(/no NEW instance coupling/);
  });

  it("fails CLOSED on a set-but-unresolvable base ref", () => {
    const res = runGate({ CORE_EXT_INSTANCE_BAN_BASE: "refs/does/not/exist-deadbeef" });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/did not resolve|Failing closed/);
  });

  it("rejects a flag-like base ref", () => {
    const res = runGate({ CORE_EXT_INSTANCE_BAN_BASE: "--upload-pack=evil" });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/flag-like/);
  });
});
