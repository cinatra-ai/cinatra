// vendor-token-core-gate tests (cinatra#973 — epic cinatra-ai/cinatra#978).
//
// Exercises the token matcher (exact short tokens, substring long tokens,
// camelCase evasion), the import-specifier extraction, the sanctioned-surface
// exclusions, the shrink-only baseline diff, and the live-tree invariants
// (gate green on main; the epic's named defect is ENUMERATED in the floor,
// never exempted; the nango mechanism model is NOT counted).

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import * as gate from "../vendor-token-core-gate.mjs";
import {
  vendorWords,
  admittedGrowth,
  isExemptFile,
  isSanctionedSpecifier,
  subTokens,
  segmentMatchesToken,
  tokenHits,
  extractImportSpecifiers,
  scanVendorTokens,
  diffGrown,
  diffShrunk,
} from "../vendor-token-core-gate.mjs";

const BASELINE = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "vendor-token-core-gate.baseline.json"), "utf8"),
).occurrences;

describe("live tree vs committed baseline (the gate is green on main)", () => {
  const current = scanVendorTokens();

  it("no current occurrence exceeds the baseline", () => {
    expect(diffGrown(BASELINE, current)).toEqual([]);
  });

  it("no baseline entry is stale (the committed floor is exact, no headroom)", () => {
    expect(diffShrunk(BASELINE, current)).toEqual([]);
  });

  it("the baseline is a NON-EMPTY residual floor (enumerated, not allowlisted away)", () => {
    expect(Object.keys(BASELINE).length).toBeGreaterThan(0);
  });

  it("the epic #978 named defect (register-host-connector-services.ts) is ENUMERATED in the floor", () => {
    const keys = Object.keys(BASELINE).filter((k) =>
      k.startsWith("src/lib/register-host-connector-services.ts :: import :: "),
    );
    expect(keys.length).toBeGreaterThan(0);
  });

  it("the nango-system mechanism model is NOT counted (nango is not a vendor token)", () => {
    expect(vendorWords()).not.toContain("nango");
    expect(Object.keys(current).some((k) => k.startsWith("src/app/api/nango/"))).toBe(false);
  });
});

describe("segmentMatchesToken — exact short tokens, substring long tokens, camelCase", () => {
  it("short token `wp` matches only as an exact sub-token", () => {
    expect(segmentMatchesToken("wp-drupal-contract.ts", "wp")).toBe(true);
    expect(segmentMatchesToken("swap-helper.ts", "wp")).toBe(false);
    expect(segmentMatchesToken("wpapi.ts", "wp")).toBe(false); // squashed short token is out of scope
  });

  it("long tokens match as a segment substring (squashed evasion is caught)", () => {
    expect(segmentMatchesToken("wordpress-api.ts", "wordpress")).toBe(true);
    expect(segmentMatchesToken("wordpressapi.ts", "wordpress")).toBe(true);
  });

  it("camelCase boundaries are split (`wordpressApi` / `importSkillFromGithub`)", () => {
    expect(subTokens("wordpressApi")).toEqual(["wordpress", "api"]);
    expect(segmentMatchesToken("importSkillFromGithubForm.tsx", "github")).toBe(true);
  });

  it("a non-vendor segment does not match", () => {
    expect(segmentMatchesToken("connector-readiness.server.ts", "wordpress")).toBe(false);
  });
});

// The fixture's vendor words. The real gate reads them from the pinned packs'
// declarations and the bridge (lib/border-words.mjs, border-words.test.mjs).
const FIXTURE_WORDS = ["wordpress", "wp", "drupal", "youtube"];

describe("tokenHits — path/route segments and specifiers", () => {
  it("a Next.js route dir segment is a hit for the file under it", () => {
    const hits = tokenHits("src/app/api/webhooks/wordpress/route.ts", FIXTURE_WORDS);
    expect(hits.get("wordpress")).toBe(1);
  });

  it("multiple tokens in one path are counted per token", () => {
    const hits = tokenHits("src/lib/wp-drupal-contract.ts", FIXTURE_WORDS);
    expect(hits.get("wp")).toBe(1);
    expect(hits.get("drupal")).toBe(1);
  });

  it("a clean path yields no hits", () => {
    expect(tokenHits("src/lib/connector-readiness.server.ts", FIXTURE_WORDS).size).toBe(0);
  });
});

describe("extractImportSpecifiers — static, side-effect, dynamic, require", () => {
  it("extracts every specifier form", () => {
    const src = [
      `import { a } from "@/lib/wordpress-api";`,
      `import "./drupal-side-effect";`,
      `export { b } from "../linkedin-api";`,
      `const c = await import("@/lib/youtube-api");`,
      `const d = require("@/lib/github-api");`,
    ].join("\n");
    expect(extractImportSpecifiers(src)).toEqual([
      "@/lib/wordpress-api",
      "./drupal-side-effect",
      "../linkedin-api",
      "@/lib/youtube-api",
      "@/lib/github-api",
    ]);
  });
});

describe("sanctioned surfaces — exclusions are exact and enumerated", () => {
  it("tests, mocks, and docs are exempt", () => {
    expect(isExemptFile("src/lib/__tests__/wordpress-api.test.ts")).toBe(true);
    expect(isExemptFile("src/lib/wordpress.spec.ts")).toBe(true);
    expect(isExemptFile("packages/google-oauth-connection/README.md")).toBe(true);
  });

  it("sdk-extensions type contracts and the connectors-catalog identity surface are exempt", () => {
    expect(isExemptFile("packages/sdk-extensions/src/google-oauth-connection-contract.ts")).toBe(true);
    expect(isExemptFile("packages/connectors-catalog/src/descriptors.mjs")).toBe(true);
    expect(isExemptFile("packages/agents/src/reserved-workspace-slugs.ts")).toBe(true);
  });

  it("the generator-emitted manifest files are exempt (explicit list, not a dir prefix)", () => {
    expect(isExemptFile("src/lib/generated/extensions.server.ts")).toBe(true);
    // A hand-added file under src/lib/generated/ is NOT exempt.
    expect(isExemptFile("src/lib/generated/wordpress-smuggle.ts")).toBe(false);
  });

  it("ordinary core source is not exempt", () => {
    expect(isExemptFile("src/lib/wordpress-api.ts")).toBe(false);
    expect(isExemptFile("packages/skills/src/github.ts")).toBe(false);
  });

  it("sanctioned specifiers: framework font loader, LLM SDK, brand icons — and nothing vendor-shaped", () => {
    expect(isSanctionedSpecifier("next/font/google")).toBe(true);
    expect(isSanctionedSpecifier("@google/genai")).toBe(true);
    expect(isSanctionedSpecifier("@icons-pack/react-simple-icons/icons/SiWordpress.mjs")).toBe(true);
    expect(isSanctionedSpecifier("@/lib/wordpress-api")).toBe(false);
    expect(isSanctionedSpecifier("@google/genai-extras")).toBe(false); // exact match only
  });
});

describe("scanVendorTokens — fixture tree", () => {
  const root = mkdtempSync(join(tmpdir(), "vendor-token-gate-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, "src/lib"), { recursive: true });
  writeFileSync(join(root, "src/lib/wordpress-api.ts"), "export const wp = 1;\n");
  writeFileSync(
    join(root, "src/lib/generic.ts"),
    [
      `import { wp } from "./wordpress-api";`,
      `// import { dead } from "./drupal-api"; (commented out — must NOT count)`,
      `import Font from "next/font/google";`,
      `export const ok = wp;`,
    ].join("\n") + "\n",
  );
  const files = ["src/lib/wordpress-api.ts", "src/lib/generic.ts"];
  const occ = scanVendorTokens(root, files, FIXTURE_WORDS);

  it("counts the vendor filename and the generic->vendor import edge", () => {
    expect(occ["src/lib/wordpress-api.ts :: path :: wordpress"]).toBe(1);
    expect(occ["src/lib/generic.ts :: import :: ./wordpress-api"]).toBe(1);
  });

  it("does not count commented-out imports or sanctioned specifiers", () => {
    expect(Object.keys(occ).some((k) => k.includes("drupal"))).toBe(false);
    expect(Object.keys(occ).some((k) => k.includes("next/font/google"))).toBe(false);
  });

  it("a worktree-deleted file is not counted (scan reflects the worktree, not the index)", () => {
    const occ2 = scanVendorTokens(root, [...files, "src/lib/youtube-api.ts"], FIXTURE_WORDS);
    expect(Object.keys(occ2).some((k) => k.startsWith("src/lib/youtube-api.ts"))).toBe(false);
  });
});

describe("diffGrown / diffShrunk — the shrink-only ratchet arithmetic", () => {
  it("a new key and a grown count are both NEW", () => {
    const baseline = { "a.ts :: path :: wordpress": 1 };
    const current = { "a.ts :: path :: wordpress": 2, "b.ts :: path :: drupal": 1 };
    expect(diffGrown(baseline, current)).toEqual([
      "a.ts :: path :: wordpress (1 -> 2)",
      "b.ts :: path :: drupal (0 -> 1)",
    ]);
  });

  it("a removed occurrence is STALE (the floor must ratchet down)", () => {
    const baseline = { "a.ts :: path :: wordpress": 1 };
    expect(diffShrunk(baseline, {})).toEqual(["a.ts :: path :: wordpress (1 -> 0)"]);
  });

  it("identical floors diff to empty in both directions", () => {
    const b = { "a.ts :: path :: wordpress": 1 };
    expect(diffGrown(b, { ...b })).toEqual([]);
    expect(diffShrunk(b, { ...b })).toEqual([]);
  });
});

describe("admittedGrowth — the word-born admission (cinatra#4848)", () => {
  it("a NEW key whose file is byte-identical at the base is admitted; a changed file is not", () => {
    const base = { "a.ts :: path :: wordpress": 1 };
    const committed = { ...base, "b.ts :: path :: acme": 1 };
    expect(admittedGrowth(base, committed, { isUnchangedAtBase: (f) => f === "b.ts" })).toEqual([]);
    expect(admittedGrowth(base, committed, { isUnchangedAtBase: () => false })).toEqual(["b.ts :: path :: acme (0 -> 1)"]);
  });

  it("a key already on the floor never grows this way", () => {
    const base = { "a.ts :: path :: wordpress": 1 };
    expect(admittedGrowth(base, { "a.ts :: path :: wordpress": 2 }, { isUnchangedAtBase: () => true })).toEqual([
      "a.ts :: path :: wordpress (1 -> 2)",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The SDK's exported names (cinatra#4875, class `sdk-name-with-extension-word`).
// The gate is read through its namespace so this file loads on a base without
// the class and fails there by assertion. Fixtures use the `@example-org` scope
// and made-up words (`zorb` vendor, `quill` domain).
// ---------------------------------------------------------------------------

const REPO_ROOT_4875 = join(import.meta.dirname, "..", "..", "..");
const SDK_RULE_FILES = ["packages/sdk-extensions/src/border-words.ts", "packages/sdk-extensions/src/host-context.ts"];
const FIXTURE_SDK = "packages/sdk-a";
const REASON = "A fixture name recorded with a reason for the test of this class.";

/** A function of the gate by name; fails by assertion when the gate lacks it. */
function gateFn(name) {
  expect(typeof gate[name], `vendor-token-core-gate exports ${name}`).toBe("function");
  return gate[name];
}

const sdkRoots = [];
afterAll(() => {
  for (const r of sdkRoots) rmSync(r, { recursive: true, force: true });
});

/**
 * A fixture repository: the SDK rule sources, a bridge, one pinned pack that
 * declares `borderWords`, one SDK package at packages/sdk-a with `exports` and
 * `files`, and the gate's baseline with `sdkNames`.
 */
function makeSdkTree({ exportsMap, files, sdkNames = {}, borderWords = { vendor: ["zorb"], domain: ["quill"] }, baseline }) {
  const root = mkdtempSync(join(tmpdir(), "vendor-sdk-names-"));
  sdkRoots.push(root);
  const all = {
    "package.json": JSON.stringify({ name: "example-app", cinatra: { devExtensions: { "@example-org/zorb-pack": "0.0.0" } } }),
    "scripts/audit/border-words-bridge.json": JSON.stringify({ note: "fixture", vendor: [], domain: [], packages: [] }),
    "extensions/example-org/zorb-pack/package.json": JSON.stringify({
      name: "@example-org/zorb-pack",
      cinatra: { kind: "connector", borderWords },
    }),
    [`${FIXTURE_SDK}/package.json`]: JSON.stringify({ name: "@example-org/sdk-a", exports: exportsMap }),
    "scripts/audit/vendor-token-core-gate.baseline.json": JSON.stringify(baseline ?? { occurrences: {}, sdkNames }),
  };
  for (const [rel, text] of Object.entries(files)) all[`${FIXTURE_SDK}/${rel}`] = text;
  for (const rel of SDK_RULE_FILES) all[rel] = readFileSync(join(REPO_ROOT_4875, rel), "utf8");
  for (const [rel, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const git = (root, ...args) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=fixture", "-c", "user.email=fixture@example.org", ...args], { cwd: root, encoding: "utf8" });

describe("sdk-name-with-extension-word — splitting a name and matching a word (cinatra#4875)", () => {
  const words = ["zorb", "quill", "zorbnet", "a2b"];

  it("camelCase, PascalCase, CONSTANT_CASE, kebab-case and acronym runs are split into words", () => {
    const tokens = gateFn("nameTokens");
    expect(tokens("sendZorb")).toEqual(["send", "zorb"]);
    expect(tokens("ZorbSender")).toEqual(["zorb", "sender"]);
    expect(tokens("ZORB_KIND")).toEqual(["zorb", "kind"]);
    expect(tokens("zorb-kind")).toEqual(["zorb", "kind"]);
    expect(tokens("QUILLConnector")).toEqual(["quill", "connector"]);
    expect(tokens("a2bClient")).toEqual(["a", "2", "b", "client"]);
  });

  it("a word matches a whole word, case-insensitively, or a run of words written together", () => {
    const hits = gateFn("nameWordHits");
    expect(hits("sendZorb", words)).toEqual(["zorb"]);
    expect(hits("ZorbSender", words)).toEqual(["zorb"]);
    expect(hits("ZORB_KIND", words)).toEqual(["zorb"]);
    expect(hits("zorb-kind", words)).toEqual(["zorb"]);
    expect(hits("zorbX", words)).toEqual(["zorb"]);
    expect(hits("HostZorbNetService", words)).toEqual(["zorb", "zorbnet"]);
    expect(hits("a2bClient", words)).toEqual(["a2b"]);
  });

  it("a word inside a longer word is not found (whole words only)", () => {
    const hits = gateFn("nameWordHits");
    expect(hits("ZorbaDance", words)).toEqual([]);
    expect(hits("unzorbed", words)).toEqual([]);
    expect(hits("Quilling", words)).toEqual([]);
  });
});

describe("sdk-name-with-extension-word — what a pack can import is read (cinatra#4875)", () => {
  it("a new pack word and an SDK export named with it in a neutral module fail the gate without an edit to the gate code", () => {
    const check = gateFn("checkSdkNames");
    const root = makeSdkTree({
      exportsMap: { ".": "./src/index.ts" },
      files: {
        "src/index.ts": `export * from "./shapes";\n`,
        "src/shapes.ts": `export interface ZorbWidget { id: string }\nexport const neutral = 1;\n`,
      },
    });
    const result = check(root, { env: {}, packages: [FIXTURE_SDK] });
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("sdk-name-with-extension-word");
    expect(result.lines.join("\n")).toContain("@example-org/sdk-a :: ZorbWidget (zorb)");
  });

  it("a recorded name with a reason passes; a recorded name no longer found is stale; an entry without a reason fails", () => {
    const check = gateFn("checkSdkNames");
    const files = { "src/index.ts": `export interface ZorbWidget { id: string }\n` };
    const ok = makeSdkTree({ exportsMap: { ".": "./src/index.ts" }, files, sdkNames: { "@example-org/sdk-a :: ZorbWidget": REASON } });
    expect(check(ok, { env: {}, packages: [FIXTURE_SDK] }).ok).toBe(true);

    const stale = makeSdkTree({
      exportsMap: { ".": "./src/index.ts" },
      files,
      sdkNames: { "@example-org/sdk-a :: ZorbWidget": REASON, "@example-org/sdk-a :: QuillGone": REASON },
    });
    const s = check(stale, { env: {}, packages: [FIXTURE_SDK] });
    expect(s.ok).toBe(false);
    expect(s.lines.join("\n")).toContain("- @example-org/sdk-a :: QuillGone");

    const bare = makeSdkTree({ exportsMap: { ".": "./src/index.ts" }, files, sdkNames: { "@example-org/sdk-a :: ZorbWidget": "ok" } });
    const b = check(bare, { env: {}, packages: [FIXTURE_SDK] });
    expect(b.ok).toBe(false);
    expect(b.lines.join("\n")).toContain("without a reason");
  });

  it("every form of export a pack can import is read; members of an exported type, class, enum or const object are not", () => {
    const scan = gateFn("scanSdkExportNames");
    const root = makeSdkTree({
      exportsMap: { ".": "./src/index.ts", "./extra": { types: "./src/extra.d.ts", default: "./src/extra.js" } },
      files: {
        "src/index.ts": [
          `export * from "./star";`,
          `export * as zorbSpace from "./ns-target";`,
          `export { plain as QuillRenamed } from "./plain";`,
          `export type { ZorbOnlyType } from "./types";`,
          `export { default } from "./default-fn";`,
          `export namespace Holder { export const zorbInside = 1; }`,
          `export enum Kinds { ZorbMember = 1 }`,
          `export const table = { zorbKey: 1 };`,
          `export class Service { zorbMethod() {} }`,
          `export interface Port { sendZorb(): void }`,
          `export function quillOverload(a: string): void;`,
          `export function quillOverload(a: number): void;`,
          `export function quillOverload(a: unknown): void {}`,
          `const literal = 1;`,
          `export { literal as "zorb-kind" };`,
        ].join("\n"),
        "src/star.ts": `export const ZORB_KIND = "k";\n`,
        "src/ns-target.ts": `export const neutralInside = 1;\nexport const QuillInside = 2;\n`,
        "src/plain.ts": `export const plain = 1;\n`,
        "src/types.ts": `export type ZorbOnlyType = string;\n`,
        "src/default-fn.ts": `export default function sendZorb() {}\n`,
        "src/extra.d.ts": `export declare const quillExtra: number;\n`,
        "src/extra.js": `export const quillExtra = 1;\n`,
      },
    });
    const found = scan(root, ["zorb", "quill"], { packages: [FIXTURE_SDK] });
    expect(Object.keys(found).sort()).toEqual(
      [
        "@example-org/sdk-a :: ZORB_KIND",
        "@example-org/sdk-a :: zorbSpace",
        "@example-org/sdk-a :: zorbSpace.QuillInside",
        "@example-org/sdk-a :: zorbSpace.neutralInside",
        "@example-org/sdk-a :: QuillRenamed",
        "@example-org/sdk-a :: ZorbOnlyType",
        "@example-org/sdk-a :: default",
        "@example-org/sdk-a :: Holder.zorbInside",
        "@example-org/sdk-a :: quillOverload",
        "@example-org/sdk-a :: zorb-kind",
        "@example-org/sdk-a/extra :: quillExtra",
      ].sort(),
    );
  });

  it("an exports map with a subpath pattern fails closed (precedence is not read); the real SDK packages hold none", () => {
    const scan = gateFn("scanSdkExportNames");
    const root = makeSdkTree({
      exportsMap: { "./public": "./src/public.ts", "./*": "./src/*.ts" },
      files: { "src/public.ts": `export const ZorbPublic = 1;\n` },
    });
    expect(() => scan(root, ["zorb"], { packages: [FIXTURE_SDK] })).toThrow(
      "the exports map of @example-org/sdk-a uses a pattern or a null target, which this rule does not read yet",
    );
    for (const dir of ["packages/sdk-extensions", "packages/sdk-ui"]) {
      expect(() => gateFn("sdkEntryPoints")(REPO_ROOT_4875, dir)).not.toThrow();
    }
  });

  it("an exports map with a null target fails closed, also inside a conditions object", () => {
    const scan = gateFn("scanSdkExportNames");
    for (const exportsMap of [
      { ".": "./src/index.ts", "./hidden": null },
      { ".": { types: "./src/index.ts", browser: null } },
    ]) {
      const root = makeSdkTree({ exportsMap, files: { "src/index.ts": `export const ZorbIndex = 1;\n` } });
      expect(() => scan(root, ["zorb"], { packages: [FIXTURE_SDK] })).toThrow(
        "the exports map of @example-org/sdk-a uses a pattern or a null target, which this rule does not read yet",
      );
    }
  });

  it("a namespace-qualified name is matched whole: a word across the namespace boundary is found, once per word", () => {
    const scan = gateFn("scanSdkExportNames");
    const root = makeSdkTree({
      exportsMap: { ".": "./src/index.ts" },
      files: {
        "src/index.ts": [
          `export namespace Project { export const ManagementClient = 1; }`,
          `export * as project from "./mgmt";`,
          `export namespace ZorbNs { export const ZorbThing = 1; }`,
        ].join("\n"),
        "src/mgmt.ts": `export const ManagementApi = 1;\n`,
      },
    });
    const found = scan(root, ["projectmanagement", "zorb"], { packages: [FIXTURE_SDK] });
    expect(found["@example-org/sdk-a :: Project.ManagementClient"]).toEqual(["projectmanagement"]);
    expect(found["@example-org/sdk-a :: project.ManagementApi"]).toEqual(["projectmanagement"]);
    expect(found["@example-org/sdk-a :: ZorbNs.ZorbThing"]).toEqual(["zorb"]);
  });

  it("a module reached by two namespaces is read under each namespace", () => {
    const scan = gateFn("scanSdkExportNames");
    const root = makeSdkTree({
      exportsMap: { ".": "./src/index.ts" },
      files: {
        "src/index.ts": `export * as alpha from "./shared";\nexport * as zorbBeta from "./shared";\n`,
        "src/shared.ts": `export const plain = 1;\n`,
      },
    });
    expect(Object.keys(scan(root, ["zorb"], { packages: [FIXTURE_SDK] }))).toEqual([
      "@example-org/sdk-a :: zorbBeta",
      "@example-org/sdk-a :: zorbBeta.plain",
    ]);
  });
});

describe("sdk-name-with-extension-word — fails closed (cinatra#4875)", () => {
  const cases = [
    ["an entry whose target does not exist", { ".": "./src/missing.ts" }, {}, `@example-org/sdk-a exports "."`],
    ["an export from a module that does not resolve", { ".": "./src/index.ts" }, { "src/index.ts": `export * from "./gone";\n` }, `export ... from "./gone"`],
    [
      "an exported name that does not resolve",
      { ".": "./src/index.ts" },
      { "src/index.ts": `export { Nope } from "./real";\n`, "src/real.ts": `export const real = 1;\n` },
      `"Nope" does not resolve`,
    ],
  ];
  for (const [title, exportsMap, files, text] of cases) {
    it(`${title} is a scanner error naming the entry`, () => {
      const scan = gateFn("scanSdkExportNames");
      const root = makeSdkTree({ exportsMap, files });
      expect(() => scan(root, ["zorb"], { packages: [FIXTURE_SDK] })).toThrow(text);
    });
  }
});

describe("sdk-name-with-extension-word — the record only shrinks against the base (cinatra#4875)", () => {
  const exportsMap = { ".": "./src/index.ts" };

  function committedTree(sdkNames, files, borderWords) {
    const root = makeSdkTree({ exportsMap, files, sdkNames, ...(borderWords ? { borderWords } : {}) });
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    return root;
  }
  const writeFloor = (root, sdkNames) =>
    writeFileSync(join(root, "scripts/audit/vendor-token-core-gate.baseline.json"), JSON.stringify({ occurrences: {}, sdkNames }));

  it("a new name added to the SDK and to the record in the same change is refused against the base", () => {
    const check = gateFn("checkSdkNames");
    const root = committedTree({}, { "src/index.ts": `export const neutral = 1;\n` });
    writeFileSync(join(root, FIXTURE_SDK, "src/index.ts"), `export const neutral = 1;\nexport const ZorbNew = 2;\n`);
    writeFloor(root, { "@example-org/sdk-a :: ZorbNew": REASON });
    const r = check(root, { env: { VENDOR_TOKEN_BASE: "HEAD" }, packages: [FIXTURE_SDK] });
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("+ @example-org/sdk-a :: ZorbNew");
  });

  it("a word a pack newly declares for an unchanged SDK name is admitted (the words moved, the code did not)", () => {
    const check = gateFn("checkSdkNames");
    const root = committedTree({}, { "src/index.ts": `export const QuillOld = 1;\n` }, { vendor: ["zorb"], domain: [], reason: undefined });
    writeFileSync(
      join(root, "extensions/example-org/zorb-pack/package.json"),
      JSON.stringify({ name: "@example-org/zorb-pack", cinatra: { kind: "connector", borderWords: { vendor: ["zorb"], domain: ["quill"] } } }),
    );
    writeFloor(root, { "@example-org/sdk-a :: QuillOld": REASON });
    expect(check(root, { env: { VENDOR_TOKEN_BASE: "HEAD" }, packages: [FIXTURE_SDK] }).ok).toBe(true);
  });

  it("a base without the record is the one-time seed; a flag-like base fails closed", () => {
    const check = gateFn("checkSdkNames");
    const root = makeSdkTree({ exportsMap, files: { "src/index.ts": `export const ZorbSeed = 1;\n` }, baseline: { occurrences: {} } });
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    writeFloor(root, { "@example-org/sdk-a :: ZorbSeed": REASON });
    expect(check(root, { env: { VENDOR_TOKEN_BASE: "HEAD" }, packages: [FIXTURE_SDK] }).ok).toBe(true);
    const flag = check(root, { env: { VENDOR_TOKEN_BASE: "--output=x" }, packages: [FIXTURE_SDK] });
    expect(flag.ok).toBe(false);
    expect(flag.lines.join("\n")).toContain("flag-like");
  });
});

describe("sdk-name-with-extension-word — the real tree (cinatra#4875)", () => {
  it("passes on the real SDK with the record committed, and the record holds the names the issue named", () => {
    const check = gateFn("checkSdkNames");
    const result = check(REPO_ROOT_4875, { env: {} });
    expect(result.lines).toEqual([]);
    expect(result.ok).toBe(true);
    for (const name of ["CrmConnector", "BlogConnector", "CrmPointerWriterProvider"]) {
      expect(Object.keys(result.found)).toContain(`@cinatra-ai/sdk-extensions :: ${name}`);
    }
  });
});
