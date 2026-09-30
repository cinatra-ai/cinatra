import path from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  classifyGeneratedReferences,
  computeLiveCoverage,
  coverageDefects,
  readDeclaredRequiredNames,
  scanHostImportedExtensions,
  FLOOR_BASE_VAR,
  FLOOR_FILE,
  PERMIT_FILE,
  PERMIT_LIST,
  PERMIT_ROAD,
  checkFloorAgainstBase,
} from "../required-extensions-cover-host-imports.mjs";
import {
  NO_PULL_REQUEST_RUN,
  PULL_REQUEST_RUN,
  UNREADABLE_BASE_RUN,
  envWithoutBase,
  makeFloorRepo,
} from "./floor-base-fixture.mjs";
import { stripComments } from "../lib/strip-comments.mjs";

const tmpRoots = [];
afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

function scratchRepo(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), "req-cover-"));
  tmpRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

describe("readDeclaredRequiredNames", () => {
  it("strips version ranges with the last-@ split (scoped names intact)", () => {
    const names = readDeclaredRequiredNames({
      cinatra: {
        extensions: ["@scope/a@^0.1.0", "@scope/b", "@scope/c@", "  ", 42],
      },
    });
    expect([...names].sort()).toEqual(["@scope/a", "@scope/b", "@scope/c"]);
  });
  it("is empty for an absent block", () => {
    expect(readDeclaredRequiredNames({}).size).toBe(0);
  });
});

describe("stripComments (the shared lexer, as this gate consumes it)", () => {
  it("does NOT open a block comment from a literal /* inside a line comment (the @/lib/* blind spot)", () => {
    // The exact failure class of the legacy regex stripper: the
    // register-transport-connectors.ts header contains `@/lib/*` in a LINE
    // comment, which the old block-comment-first regex treated as a block
    // opener — eating the real imports that followed.
    const src = [
      "// runtime entry. `@/lib/*` is no longer reachable from connectors.",
      'import { registerThing } from "@scope/hidden-connector";',
    ].join("\n");
    const out = stripComments(src);
    expect(out).toContain('"@scope/hidden-connector"');
    expect(out).not.toContain("@/lib/*");
  });

  it("removes line and block comments but keeps code and strings", () => {
    const src = [
      "/* block",
      "   spanning lines */",
      'const url = "https://example.com//path"; // trailing comment',
      'import "@scope/kept-connector";',
    ].join("\n");
    const out = stripComments(src);
    expect(out).toContain('"https://example.com//path"');
    expect(out).toContain('"@scope/kept-connector"');
    expect(out).not.toContain("block");
    expect(out).not.toContain("trailing comment");
  });

  it("does not treat // inside strings or template literals as comments", () => {
    const src = 'const a = `http://x // not a comment`;\nconst b = "also // kept";\nimport "@scope/after";\n';
    const out = stripComments(src);
    expect(out).toContain("// not a comment");
    expect(out).toContain("also // kept");
    expect(out).toContain('"@scope/after"');
  });

  it("comment interiors are blanked even when they contain import statements", () => {
    const src = '// import "@scope/commented-connector";\nexport const z = 1;\n';
    const out = stripComments(src);
    expect(out).not.toContain("@scope/commented-connector");
    expect(out).toContain("export const z = 1;");
  });
});

describe("scanHostImportedExtensions", () => {
  it("finds static, dynamic, and require imports; skips tests and comments", () => {
    const root = scratchRepo({
      "src/lib/uses.ts": `import { x } from "@scope/alpha-connector";\nconst y = require("@scope/beta-connector/util");\n`,
      "src/lib/__tests__/uses.test.ts": `import "@scope/test-only-connector";\n`,
      "src/lib/commented.ts": `// import "@scope/commented-connector";\nexport const z = 1;\n`,
      "packages/llm/src/index.ts": `import "@scope/pkgside-connector";\n`,
    });
    const extensionNames = new Set([
      "@scope/alpha-connector",
      "@scope/beta-connector",
      "@scope/test-only-connector",
      "@scope/commented-connector",
      "@scope/pkgside-connector",
    ]);
    const { names, byFile } = scanHostImportedExtensions(["src", "packages"], extensionNames, root);
    expect([...names].sort()).toEqual([
      "@scope/alpha-connector",
      "@scope/beta-connector",
      "@scope/pkgside-connector",
    ]);
    expect(byFile["src/lib/__tests__/uses.test.ts"]).toBeUndefined();
    expect(byFile["src/lib/commented.ts"]).toBeUndefined();
  });

  it("sees imports the legacy regex stripper went blind on (line comment containing /*)", () => {
    const root = scratchRepo({
      "src/lib/transport.ts": [
        "// boot wiring. `@/lib/*` is not reachable from connectors.",
        'import { registerX } from "@scope/wired-connector";',
        "",
      ].join("\n"),
    });
    const { names } = scanHostImportedExtensions(["src"], new Set(["@scope/wired-connector"]), root);
    expect([...names]).toEqual(["@scope/wired-connector"]);
  });

  it("excludes the generated tree when excludeGenerated is set (classified separately)", () => {
    const root = scratchRepo({
      "src/lib/generated/map.ts": `export const m = { a: () => import("@scope/gamma-connector/setup-page") };\n`,
      "src/lib/real.ts": `import "@scope/alpha-connector";\n`,
    });
    const extensionNames = new Set(["@scope/gamma-connector", "@scope/alpha-connector"]);
    const withGenerated = scanHostImportedExtensions(["src"], extensionNames, root);
    expect([...withGenerated.names].sort()).toEqual(["@scope/alpha-connector", "@scope/gamma-connector"]);
    const without = scanHostImportedExtensions(["src"], extensionNames, root, { excludeGenerated: true });
    expect([...without.names]).toEqual(["@scope/alpha-connector"]);
  });

  it("ignores non-extension scoped imports", () => {
    const root = scratchRepo({
      "src/core.ts": `import "@scope/core-package";\n`,
    });
    const { names } = scanHostImportedExtensions(["src"], new Set(["@scope/some-connector"]), root);
    expect(names.size).toBe(0);
  });
});

describe("classifyGeneratedReferences (generator-owned resolution metadata)", () => {
  const extensionNames = new Set([
    "@scope/opt-connector",
    "@scope/req-connector",
    "@scope/unproven-connector",
    "@scope/unknown-connector",
    "@scope/system-skill",
    "@scope/passive-connector",
    "@scope/raw-connector",
  ]);

  const loaderMap = (entries) =>
    `export const GENERATED_TEST_MAP: Record<string, X> = {\n${entries.join("\n")}\n};\n`;

  it("guardedOptional + proven by the generated test ⇒ acquirable-on-demand", () => {
    const source = loaderMap([
      '  "opt-connector": { resolution: "guardedOptional", load: guardedExtensionImport("@scope/opt-connector/register", () => import("@scope/opt-connector/register")) },',
    ]);
    const test = 'const EXPECTED = [\n  { map: "GENERATED_TEST_MAP", key: "opt-connector", resolution: "guardedOptional" },\n];\n';
    const { bootable, acquirable } = classifyGeneratedReferences({
      generatedSources: [{ rel: "g.ts", source }],
      generatedTestSource: test,
      extensionNames,
    });
    expect([...acquirable]).toEqual(["@scope/opt-connector"]);
    expect(bootable.size).toBe(0);
  });

  // cinatra#2044 L-A: `GENERATED_ARTIFACT_RENDERERS` carries dispatch metadata
  // (packageName / slot / representations / propsApiVersion) BETWEEN `resolution`
  // and `load`. The entry regex must tolerate it, or the specifier goes
  // unclassified and the fail-closed net forces an already-guardedOptional
  // package bootable — wrongly demanding a cinatra.extensions + required-lock
  // entry for a dev-enrolled renderer.
  it("guardedOptional + metadata BETWEEN resolution and load (artifact-renderer shape) ⇒ acquirable", () => {
    const source = loaderMap([
      '  "@scope/opt-connector::detail": { resolution: "guardedOptional", "packageName":"@scope/opt-connector","slot":"detail","representations":["application/vnd.x+json"],"propsApiVersion":1, load: guardedExtensionImport("@scope/opt-connector/src/renderers/detail", () => import("@scope/opt-connector/src/renderers/detail")) },',
    ]);
    const test =
      'const EXPECTED = [\n  { map: "GENERATED_TEST_MAP", key: "@scope/opt-connector::detail", resolution: "guardedOptional" },\n];\n';
    const { bootable, acquirable } = classifyGeneratedReferences({
      generatedSources: [{ rel: "g.ts", source }],
      generatedTestSource: test,
      extensionNames,
    });
    expect([...acquirable]).toEqual(["@scope/opt-connector"]);
    expect(bootable.size).toBe(0);
  });

  it("the metadata-tolerant match still fail-closes an UNPROVEN artifact-renderer-shaped entry", () => {
    const source = loaderMap([
      '  "@scope/unproven-connector::detail": { resolution: "guardedOptional", "packageName":"@scope/unproven-connector","slot":"detail","propsApiVersion":1, load: guardedExtensionImport("@scope/unproven-connector/src/renderers/detail", () => import("@scope/unproven-connector/src/renderers/detail")) },',
    ]);
    const { bootable, acquirable } = classifyGeneratedReferences({
      generatedSources: [{ rel: "g.ts", source }],
      generatedTestSource: "const EXPECTED = [];",
      extensionNames,
    });
    expect([...bootable]).toEqual(["@scope/unproven-connector"]);
    expect(acquirable.size).toBe(0);
  });

  it("guardedOptional NOT covered by the generated test ⇒ bootable (fail-closed)", () => {
    const source = loaderMap([
      '  "unproven-connector": { resolution: "guardedOptional", load: guardedExtensionImport("@scope/unproven-connector", () => import("@scope/unproven-connector")) },',
    ]);
    const { bootable, acquirable } = classifyGeneratedReferences({
      generatedSources: [{ rel: "g.ts", source }],
      generatedTestSource: "const EXPECTED = [];",
      extensionNames,
    });
    expect([...bootable]).toEqual(["@scope/unproven-connector"]);
    expect(acquirable.size).toBe(0);
  });

  it("a MISSING generated test makes every guardedOptional entry bootable (fail-closed)", () => {
    const source = loaderMap([
      '  "opt-connector": { resolution: "guardedOptional", load: guardedExtensionImport("@scope/opt-connector", () => import("@scope/opt-connector")) },',
    ]);
    const { bootable } = classifyGeneratedReferences({
      generatedSources: [{ rel: "g.ts", source }],
      generatedTestSource: null,
      extensionNames,
    });
    expect([...bootable]).toEqual(["@scope/opt-connector"]);
  });

  it('resolution: "required" loader entries are bootable', () => {
    const source = loaderMap([
      '  "req-connector": { resolution: "required", load: () => import("@scope/req-connector") },',
    ]);
    const { bootable, acquirable } = classifyGeneratedReferences({
      generatedSources: [{ rel: "g.ts", source }],
      generatedTestSource: "const EXPECTED = [];",
      extensionNames,
    });
    expect([...bootable]).toEqual(["@scope/req-connector"]);
    expect(acquirable.size).toBe(0);
  });

  it("unknown resolution values are bootable (fail-closed)", () => {
    const source = loaderMap([
      '  "unknown-connector": { resolution: "lazyMaybe", load: () => import("@scope/unknown-connector") },',
    ]);
    const { bootable } = classifyGeneratedReferences({
      generatedSources: [{ rel: "g.ts", source }],
      generatedTestSource: "const EXPECTED = [];",
      extensionNames,
    });
    expect([...bootable]).toEqual(["@scope/unknown-connector"]);
  });

  it("a guardedOptional entry claiming guard but not routed through guardedExtensionImport is bootable", () => {
    const source = loaderMap([
      '  "opt-connector": { resolution: "guardedOptional", load: () => import("@scope/opt-connector") },',
    ]);
    const test = 'const EXPECTED = [{ map: "GENERATED_TEST_MAP", key: "opt-connector", resolution: "guardedOptional" }];';
    const { bootable } = classifyGeneratedReferences({
      generatedSources: [{ rel: "g.ts", source }],
      generatedTestSource: test,
      extensionNames,
    });
    expect([...bootable]).toEqual(["@scope/opt-connector"]);
  });

  it("CLIENT-safe field-renderer map: guardedOptional plain-import ⇒ acquirable (no server-guard brand required)", () => {
    // The field-renderer component map is client-consumed, so its loaders are
    // plain `() => import()` (guardedExtensionImport is server-only) and degrade
    // via the SchemaFieldRenderer floor — NOT part of the server-guard proof.
    const source =
      "export const GENERATED_FIELD_RENDERER_COMPONENTS: Record<string, X> = {\n" +
      '  "@scope/opt-connector:some-review": { resolution: "guardedOptional", packageName: "@scope/opt-connector", propsApiVersion: 1, load: () => import("@scope/opt-connector/src/some-renderer") },\n' +
      "};\n";
    const { bootable, acquirable } = classifyGeneratedReferences({
      generatedSources: [{ rel: "g.ts", source }],
      generatedTestSource: "const EXPECTED = [];", // intentionally NOT in the server-guard proof
      extensionNames,
    });
    expect([...acquirable]).toEqual(["@scope/opt-connector"]);
    expect(bootable.size).toBe(0);
  });

  it("CLIENT-safe field-renderer map: required entry ⇒ bootable (a required claimant must never be absent)", () => {
    const source =
      "export const GENERATED_FIELD_RENDERER_COMPONENTS: Record<string, X> = {\n" +
      '  "@scope/req-connector:some-review": { resolution: "required", packageName: "@scope/req-connector", propsApiVersion: 1, load: () => import("@scope/req-connector/src/some-renderer") },\n' +
      "};\n";
    const { bootable, acquirable } = classifyGeneratedReferences({
      generatedSources: [{ rel: "g.ts", source }],
      generatedTestSource: "const EXPECTED = [];",
      extensionNames,
    });
    expect([...bootable]).toEqual(["@scope/req-connector"]);
    expect(acquirable.size).toBe(0);
  });

  it('STATIC_EXTENSION_MANIFEST records: resolution "required" ⇒ bootable; guardedOptional records are passive', () => {
    const source = [
      "export const STATIC_EXTENSION_MANIFEST: Record<string, NormalizedExtensionRecord> = {",
      '  "@scope/system-skill": {"packageName":"@scope/system-skill","resolution":"required"},',
      '  "@scope/passive-connector": {"packageName":"@scope/passive-connector","resolution":"guardedOptional"},',
      "};",
    ].join("\n");
    const { bootable, acquirable } = classifyGeneratedReferences({
      generatedSources: [{ rel: "g.ts", source }],
      generatedTestSource: "const EXPECTED = [];",
      extensionNames,
    });
    expect([...bootable]).toEqual(["@scope/system-skill"]);
    // passive guardedOptional record: neither bootable nor acquirable-by-entry
    expect(acquirable.has("@scope/passive-connector")).toBe(false);
    expect(bootable.has("@scope/passive-connector")).toBe(false);
  });

  it("a record with missing/unknown resolution is bootable (fail-closed)", () => {
    const source = [
      "export const STATIC_EXTENSION_MANIFEST: Record<string, NormalizedExtensionRecord> = {",
      '  "@scope/passive-connector": {"packageName":"@scope/passive-connector"},',
      "};",
    ].join("\n");
    const { bootable } = classifyGeneratedReferences({
      generatedSources: [{ rel: "g.ts", source }],
      generatedTestSource: "const EXPECTED = [];",
      extensionNames,
    });
    expect([...bootable]).toEqual(["@scope/passive-connector"]);
  });

  it("an import-position reference with NO classified loader entry is bootable (fail-closed net)", () => {
    const source = 'export const RAW = { x: () => import("@scope/raw-connector/something") };\n';
    const { bootable } = classifyGeneratedReferences({
      generatedSources: [{ rel: "g.ts", source }],
      generatedTestSource: "const EXPECTED = [];",
      extensionNames,
    });
    expect([...bootable]).toEqual(["@scope/raw-connector"]);
  });

  it("a classified guarded entry does NOT mask an unclassified sibling import of the SAME package (per-specifier net)", () => {
    const source = [
      loaderMap([
        '  "opt-connector": { resolution: "guardedOptional", load: guardedExtensionImport("@scope/opt-connector/register", () => import("@scope/opt-connector/register")) },',
      ]),
      // A future unsupported emission shape: raw import of ANOTHER subpath of
      // the same package, outside any classified entry — must force required.
      'export const RAW = { x: weirdWrapper(() => import("@scope/opt-connector/extra")) };',
    ].join("\n");
    const test = 'const EXPECTED = [{ map: "GENERATED_TEST_MAP", key: "opt-connector", resolution: "guardedOptional" }];';
    const { bootable, acquirable, reasons } = classifyGeneratedReferences({
      generatedSources: [{ rel: "g.ts", source }],
      generatedTestSource: test,
      extensionNames,
    });
    expect(bootable.has("@scope/opt-connector")).toBe(true);
    expect(acquirable.has("@scope/opt-connector")).toBe(false);
    expect(reasons["@scope/opt-connector"].some((r) => r.includes("@scope/opt-connector/extra"))).toBe(true);
  });

  it("required anywhere wins over guardedOptional elsewhere for the same package", () => {
    const source = [
      loaderMap([
        '  "opt-connector": { resolution: "guardedOptional", load: guardedExtensionImport("@scope/opt-connector", () => import("@scope/opt-connector")) },',
      ]),
      "export const OTHER_MAP: Record<string, X> = {",
      '  "opt-connector": { resolution: "required", load: () => import("@scope/opt-connector/register") },',
      "};",
    ].join("\n");
    const test = 'const EXPECTED = [{ map: "GENERATED_TEST_MAP", key: "opt-connector", resolution: "guardedOptional" }];';
    const { bootable, acquirable } = classifyGeneratedReferences({
      generatedSources: [{ rel: "g.ts", source }],
      generatedTestSource: test,
      extensionNames,
    });
    expect(bootable.has("@scope/opt-connector")).toBe(true);
    expect(acquirable.has("@scope/opt-connector")).toBe(false);
  });
});

describe("coverageDefects", () => {
  const base = {
    hostImported: new Set(["@scope/a-connector"]),
    rootDepExtensions: new Set(["@scope/b-connector"]),
    required: new Set(["@scope/a-connector", "@scope/b-connector", "@scope/system-agent"]),
    locked: new Set(["@scope/a-connector", "@scope/b-connector", "@scope/system-agent"]),
    // Declaration equality (cinatra#151 Stage 7): required == systemExtensions.
    systemExtensions: new Set(["@scope/a-connector", "@scope/b-connector", "@scope/system-agent"]),
  };

  it("passes when required == systemExtensions == lock covers imports ∪ root deps", () => {
    const { defects, bootable } = coverageDefects(base);
    expect(defects).toEqual([]);
    expect([...bootable].sort()).toEqual(["@scope/a-connector", "@scope/b-connector"]);
  });

  it("fails when a host import is missing from extensions", () => {
    const { defects } = coverageDefects({
      ...base,
      required: new Set(["@scope/b-connector", "@scope/system-agent"]),
      locked: new Set(["@scope/a-connector", "@scope/b-connector", "@scope/system-agent"]),
    });
    expect(defects.some((d) => d.includes("@scope/a-connector") && d.includes("extensions"))).toBe(true);
  });

  it("fails when a host import is missing from the lock", () => {
    const { defects } = coverageDefects({
      ...base,
      locked: new Set(["@scope/b-connector", "@scope/system-agent"]),
    });
    expect(defects.some((d) => d.includes("@scope/a-connector") && d.includes("acquisition lock"))).toBe(true);
  });

  it("fails on lock ↔ extensions drift in both directions", () => {
    const { defects } = coverageDefects({
      hostImported: new Set(),
      rootDepExtensions: new Set(),
      required: new Set(["@scope/only-required"]),
      locked: new Set(["@scope/only-locked"]),
    });
    expect(defects.some((d) => d.includes("@scope/only-required") && d.includes("no acquisition-lock entry"))).toBe(true);
    expect(defects.some((d) => d.includes("@scope/only-locked") && d.includes("stale lock"))).toBe(true);
  });

  it("fails when systemExtensions ⊄ extensions", () => {
    const { defects } = coverageDefects({
      ...base,
      systemExtensions: new Set(["@scope/system-agent", "@scope/missing-system-skill"]),
    });
    expect(
      defects.some((d) => d.includes("@scope/missing-system-skill") && d.includes("systemExtensions ⊆ extensions")),
    ).toBe(true);
  });

  it("DECLARATION EQUALITY (cinatra#151 Stage 7): fails when extensions ⊃ systemExtensions", () => {
    const { defects } = coverageDefects({
      ...base,
      required: new Set([...base.required, "@scope/extra-connector"]),
      locked: new Set([...base.locked, "@scope/extra-connector"]),
    });
    expect(
      defects.some((d) => d.includes("@scope/extra-connector") && d.includes("equality guard")),
    ).toBe(true);
    // The equality guard's message must never suggest the coverage fix
    // direction (adding to required) — it demands shrink-or-owner-ruling.
    const eq = defects.find((d) => d.includes("equality guard"));
    expect(eq).toMatch(/owner ruling/);
  });

  it("DECLARATION EQUALITY is fail-closed: an absent systemExtensions declaration flags every required name", () => {
    const { defects } = coverageDefects({
      hostImported: new Set(),
      rootDepExtensions: new Set(),
      required: new Set(["@scope/a-connector"]),
      locked: new Set(["@scope/a-connector"]),
      // systemExtensions omitted entirely (defaults to empty set)
    });
    expect(defects.some((d) => d.includes("@scope/a-connector") && d.includes("equality guard"))).toBe(true);
  });
});

describe("repo-live coverage (the gate's own contract against THIS tree)", () => {
  it("the committed declaration + lock cover the live bootable set; the register-transport edges are SEEN", () => {
    // Equivalent to running the gate: a regression here means a bootable
    // package exists that prod cannot acquire. Uses the real tree
    // (extensions/ must be cloned back — same precondition as every IoC gate).
    const repoRoot = path.resolve(__dirname, "..", "..", "..");
    const live = computeLiveCoverage(repoRoot);
    if (live.extensionNames.size === 0) return; // extensions not cloned back: the gate itself fails closed in CI
    const locked = new Set(
      JSON.parse(readFileSync(path.join(repoRoot, "cinatra-required-extensions.lock.json"), "utf8")).packages.map(
        (p) => p.packageName,
      ),
    );
    const { defects } = coverageDefects({
      hostImported: live.hostImported,
      rootDepExtensions: live.rootDepExtensions,
      required: live.required,
      locked,
      systemExtensions: live.systemExtensions,
    });
    expect(defects).toEqual([]);

    // The zero-floor end-state (cinatra#151 Stage 7): the three declarations
    // are EQUAL sets — the equality guard above just verified it (defects
    // empty), pin the sets themselves too.
    expect([...live.required].sort()).toEqual([...live.systemExtensions].sort());
    expect([...locked].sort()).toEqual([...live.required].sort());

    // The under-coverage hole this gate closed (cinatra#7, dep-drop slice) had
    // ONE live carrier: the statically-wired transport DI cluster, whose
    // connector imports sat behind a header line comment containing a literal
    // `/*` (the legacy stripper went blind there). That cluster was CUT OVER
    // by the transport-DI inversion (cinatra#151 Stage 3): the binder —
    // renamed register-host-connector-services.ts — imports NO extension
    // package, and the four transports left the bootable declaration. Pin the
    // end-state (the lexer-correctness shape itself is covered by the fixture
    // tests above).
    expect(live.byFile["src/lib/register-transport-connectors.ts"]).toBeUndefined();
    expect(live.byFile["src/lib/register-host-connector-services.ts"]).toBeUndefined();
    // These connectors stay guarded-optional (NOT in the required/system set),
    // so the host never statically imports them. openai-connector was
    // RE-PROMOTED to the required/system set (refs #595), and
    // anthropic-connector followed it (refs #2332, so the /setup/model provider
    // choice is selectable on a production image) — both are now legitimately
    // host-imported via their generated `required` loaders and covered by the
    // declaration + lock, so neither is pinned here.
    for (const pkg of [
      "@cinatra-ai/drupal-mcp-connector",
      "@cinatra-ai/wordpress-mcp-connector",
    ]) {
      expect(live.hostImported.has(pkg)).toBe(false);
    }

    // Every generated-map-only package must be positively classified — the
    // acquirable set is non-empty by construction once the generator-owned metadata is in
    // the emitted maps (anti-vacuity for the guarded-optional class).
    expect(live.generated.acquirable.size).toBeGreaterThan(0);
    // The system set is generator-classified required and bootable.
    for (const sys of live.systemExtensions) {
      expect(live.hostImported.has(sys) || live.rootDepExtensions.has(sys)).toBe(true);
    }
  });
});

// cinatra#3832: the set of system extensions (cinatra.systemExtensions in the
// root package.json) is compared with the copy on the base branch, so a pull
// request cannot add a package to the set in its own change.
describe("required-extensions-cover-host-imports — system set compared with the base", () => {
  const fixtures = [];
  afterEach(() => {
    while (fixtures.length) fixtures.pop().cleanup();
  });
  const pkg = (systemExtensions) => ({ name: "fixture", cinatra: { systemExtensions } });
  function repo(baseSet, headSet) {
    const f = makeFloorRepo({ base: { [FLOOR_FILE]: pkg(baseSet) }, head: { [FLOOR_FILE]: pkg(headSet) } });
    fixtures.push(f);
    return f.root;
  }

  it("a raised floor (a new package in the system set) FAILS against the base", () => {
    const root = repo(["@x/a"], ["@x/a", "@x/b"]);
    const r = checkFloorAgainstBase({ repoRoot: root, env: PULL_REQUEST_RUN });
    expect(r.ok).toBe(false);
    expect(r.growth).toEqual(["@x/b"]);
  });

  it("a lowered floor (a package removed from the system set) PASSES", () => {
    const root = repo(["@x/a", "@x/b"], ["@x/a"]);
    expect(checkFloorAgainstBase({ repoRoot: root, env: PULL_REQUEST_RUN })).toMatchObject({ ok: true, status: "held" });
  });

  it("a base that cannot be read on a pull request's run FAILS with its reason", () => {
    const root = repo([], []);
    const r = checkFloorAgainstBase({ repoRoot: root, env: UNREADABLE_BASE_RUN });
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toMatch(/did not resolve/);
  });

  it("no pull request PASSES with its line", () => {
    const root = repo([], ["@x/a"]);
    const r = checkFloorAgainstBase({ repoRoot: root, env: NO_PULL_REQUEST_RUN });
    expect(r).toMatchObject({ ok: true, status: "no-base" });
    expect(r.lines[0]).toContain(FLOOR_BASE_VAR);
  });

  it("the gate itself runs the guard: an unreadable base fails it with the reason", () => {
    const res = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "required-extensions-cover-host-imports.mjs")], {
      cwd: path.join(import.meta.dirname, "..", "..", ".."),
      encoding: "utf8",
      env: { ...envWithoutBase(process.env), ...UNREADABLE_BASE_RUN },
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/cannot be compared with the base: the base "origin\/no-such-base-3832" did not resolve/);
  });
});

// cinatra#3832: the record road. The set of system extensions is a register
// of packages allowed after a review: a new package passes in the pull request
// that carries it, with its record in the permits file.
describe("required-extensions-cover-host-imports — the record road for a new system extension", () => {
  const fixtures = [];
  afterEach(() => {
    while (fixtures.length) fixtures.pop().cleanup();
  });
  const pkg = (systemExtensions) => ({ name: "fixture", cinatra: { systemExtensions } });
  const REASON = "the host needs this package at every start";
  const record = (row, reason = REASON, pr = 3900) => ({ list: PERMIT_LIST, row, reason, pr });
  const records = (...permits) => ({ note: "fixture", permits });
  function repo({ baseSet, headSet, basePermits, headPermits }) {
    const base = { [FLOOR_FILE]: pkg(baseSet) };
    if (basePermits !== undefined) base[PERMIT_FILE] = basePermits;
    const head = { [FLOOR_FILE]: pkg(headSet) };
    if (headPermits !== undefined) head[PERMIT_FILE] = headPermits;
    const f = makeFloorRepo({ base, head });
    fixtures.push(f);
    return f.root;
  }
  const check = (root, env = PULL_REQUEST_RUN) => checkFloorAgainstBase({ repoRoot: root, env });

  it("the permits file of this commit holds no records", () => {
    const doc = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "..", "..", PERMIT_FILE), "utf8"));
    expect(doc.permits).toEqual([]);
  });

  it("an addition with its record in the same change PASSES, with a NOTICE naming row, reason and pull request", () => {
    const r = check(repo({ baseSet: ["@x/a"], headSet: ["@x/a", "@x/b"], basePermits: records(), headPermits: records(record("@x/b")) }));
    expect(r).toMatchObject({ ok: true, status: "held", absorbed: ["@x/b"] });
    expect(r.lines).toContain(
      `[required-extensions-cover-host-imports] NOTICE — ADDITION ABSORBED: @x/b, reason: "${REASON}", pull request #3900`,
    );
  });

  it("an addition without its record FAILS, and the refusal names the permits file and the record's form", () => {
    const r = check(repo({ baseSet: ["@x/a"], headSet: ["@x/a", "@x/b"] }));
    expect(r.ok).toBe(false);
    expect(r.growth).toEqual(["@x/b"]);
    expect(r.lines).toContain(`[required-extensions-cover-host-imports] ${PERMIT_ROAD}`);
    expect(PERMIT_ROAD).toContain(PERMIT_FILE);
    expect(PERMIT_ROAD).toMatch(/"list": "system-extensions", "row": .*"reason": .*"pr"/);
  });

  it("a record for a package the set does not hold is an orphan and FAILS", () => {
    const r = check(repo({ baseSet: ["@x/a"], headSet: ["@x/a"], headPermits: records(record("@x/z")) }));
    expect(r.ok).toBe(false);
    expect(r.permitProblems).toEqual(["@x/z: orphan record, the register does not hold its row; remove the record"]);
  });

  it("a carried-forward record PASSES unchanged, and FAILS altered or deleted while its package stands", () => {
    const base = { baseSet: ["@x/a", "@x/b"], headSet: ["@x/a", "@x/b"], basePermits: records(record("@x/b")) };
    expect(check(repo(base))).toMatchObject({ ok: true, status: "held" });
    let r = check(repo({ ...base, headPermits: records(record("@x/b", REASON, 3901)) }));
    expect(r.permitProblems).toEqual(["@x/b: the record is altered while its row stands; carry it unchanged"]);
    r = check(repo({ ...base, headPermits: records() }));
    expect(r.permitProblems).toEqual(["@x/b: the record is deleted while its row stands; carry it unchanged"]);
  });

  it("a record removed together with its package PASSES", () => {
    const r = check(repo({ baseSet: ["@x/a", "@x/b"], headSet: ["@x/a"], basePermits: records(record("@x/b")), headPermits: records() }));
    expect(r).toMatchObject({ ok: true, status: "held" });
  });

  it("a record for a package that stood on the base and is not added in the change FAILS", () => {
    const r = check(repo({ baseSet: ["@x/a"], headSet: ["@x/a"], headPermits: records(record("@x/a")) }));
    expect(r.permitProblems).toEqual(["@x/a: a record annotates an addition, and this change does not add the row"]);
  });

  it("a reason of one repeated word FAILS", () => {
    const r = check(repo({ baseSet: ["@x/a"], headSet: ["@x/a", "@x/b"], headPermits: records(record("@x/b", "yes yes yes yes yes yes yes")) }));
    expect(r.status).toBe("unreadable");
    expect(r.lines[0]).toMatch(/at least 6 words of three letters or more, at least 4 of them different/);
  });

  it("an unreadable permits file on a pull request's run FAILS with its reason (head or base)", () => {
    let r = check(repo({ baseSet: ["@x/a"], headSet: ["@x/a"], basePermits: records(), headPermits: "{ not json" }));
    expect(r.status).toBe("unreadable");
    expect(r.lines[0]).toMatch(/the permit file scripts\/audit\/required-extensions-cover-host-imports\.permits\.json is not readable/);
    r = check(repo({ baseSet: ["@x/a"], headSet: ["@x/a"], basePermits: "{ not json", headPermits: records() }));
    expect(r.status).toBe("unreadable");
    expect(r.lines[0]).toMatch(/permits\.json on "origin\/main" is not readable/);
  });

  it("no pull request PASSES with its line", () => {
    const r = check(repo({ baseSet: ["@x/a"], headSet: ["@x/a", "@x/b"], headPermits: "{ not json" }), NO_PULL_REQUEST_RUN);
    expect(r).toMatchObject({ ok: true, status: "no-base" });
    expect(r.lines[0]).toContain(FLOOR_BASE_VAR);
  });
});
