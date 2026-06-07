import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  sanitizeStoreSegment,
  storePackageDirName,
  storePackageDir,
  storeTarballPath,
  parseSri,
  sriForBytes,
  sriMatches,
  tarballDigestSegment,
  validateBundledDependencies,
  contentHashOfEntries,
  scanHostPeerValueImports,
  parseModuleImports,
  HOST_PROVIDED_PACKAGES,
} from "@/lib/extension-package-store-core";

describe("storePackageDirName / sanitizeStoreSegment", () => {
  it("flattens a scoped name to a single path-safe segment (with a uniqueness hash)", () => {
    const dir = storePackageDirName("@cinatra-ai/foo-connector", "1.2.3");
    expect(dir).toMatch(/^cinatra-ai__foo-connector@1\.2\.3__[a-f0-9]{10}$/);
  });
  it("leaves an unscoped name readable", () => {
    expect(storePackageDirName("foo", "0.1.0")).toMatch(/^foo@0\.1\.0__[a-f0-9]{10}$/);
  });
  it("is collision-free for names that sanitize to the same label", () => {
    expect(storePackageDirName("@a/b", "1.0.0")).not.toBe(storePackageDirName("a__b", "1.0.0"));
  });
  it("refuses traversal-unsafe segments", () => {
    expect(() => sanitizeStoreSegment("@x/..")).toThrow(/traversal/);
    expect(() => sanitizeStoreSegment("../etc")).toThrow();
    expect(() => sanitizeStoreSegment("a\0b")).toThrow(/NUL/);
    expect(() => sanitizeStoreSegment("a/b/../c")).toThrow();
  });
  it("rejects unsafe characters", () => {
    expect(() => sanitizeStoreSegment("foo;rm -rf")).toThrow(/unsafe/);
  });
});

describe("storePackageDir / storeTarballPath", () => {
  it("composes <root>/<pkg@ver>/<digest> and a sibling .tgz", () => {
    const dir = storePackageDir("/data/extensions/packages", "@cinatra-ai/foo", "1.0.0", "abc123");
    expect(dir).toMatch(
      /^\/data\/extensions\/packages\/cinatra-ai__foo@1\.0\.0__[a-f0-9]{10}\/abc123$/,
    );
    expect(storeTarballPath("/data/extensions/packages", "@cinatra-ai/foo", "1.0.0", "abc123")).toBe(`${dir}.tgz`);
  });
});

describe("SRI (D2)", () => {
  const bytes = Buffer.from("hello cinatra extension");
  const realSri = sriForBytes(bytes, "sha512");

  it("computes + verifies a matching sha512 SRI", () => {
    expect(realSri.startsWith("sha512-")).toBe(true);
    expect(sriMatches(bytes, realSri)).toBe(true);
  });
  it("fails closed on a mismatched SRI", () => {
    expect(sriMatches(Buffer.from("tampered"), realSri)).toBe(false);
  });
  it("fails closed on a malformed/unsupported SRI", () => {
    expect(sriMatches(bytes, "")).toBe(false);
    expect(sriMatches(bytes, "md5-deadbeef")).toBe(false);
    expect(sriMatches(bytes, "not-an-sri")).toBe(false);
  });
  it("parses a multi-hash SRI to its strongest entry", () => {
    const parsed = parseSri("sha256-abc= sha512-def=");
    expect(parsed?.algorithm).toBe("sha512");
  });
  it("tarballDigestSegment is the hex sha512 of the bytes", () => {
    expect(tarballDigestSegment(bytes)).toBe(createHash("sha512").update(bytes).digest("hex"));
  });
});

describe("validateBundledDependencies (D4)", () => {
  it("passes when there are no runtime dependencies", () => {
    expect(validateBundledDependencies({}, new Set())).toEqual({ ok: true });
    expect(validateBundledDependencies({ dependencies: {} }, new Set())).toEqual({ ok: true });
  });
  it("passes when every runtime dep is physically present", () => {
    const verdict = validateBundledDependencies(
      { dependencies: { "left-pad": "^1", "@scope/x": "1.0.0" } },
      new Set(["left-pad", "@scope/x"]),
    );
    expect(verdict).toEqual({ ok: true });
  });
  it("fails closed listing the missing (unbundled) deps", () => {
    const verdict = validateBundledDependencies(
      { dependencies: { "left-pad": "^1", missing: "1" } },
      new Set(["left-pad"]),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.missing).toEqual(["missing"]);
  });
  it("ignores devDependencies + peerDependencies", () => {
    const verdict = validateBundledDependencies(
      { devDependencies: { vitest: "1" }, peerDependencies: { react: "19" } },
      new Set(),
    );
    expect(verdict).toEqual({ ok: true });
  });
  it("treats host-provided SDK packages as peers (never required to be bundled)", () => {
    // sdk-extensions declared as a peer + NOT bundled → still ok.
    const verdict = validateBundledDependencies(
      { dependencies: { zod: "^4" }, peerDependencies: { "@cinatra-ai/sdk-extensions": "*" } },
      new Set(["zod"]),
    );
    expect(verdict).toEqual({ ok: true });
  });
  it("rejects a host-provided SDK package listed in dependencies (duplicate-ABI hazard)", () => {
    const verdict = validateBundledDependencies(
      { dependencies: { "@cinatra-ai/sdk-extensions": "*", zod: "^4" } },
      new Set(["@cinatra-ai/sdk-extensions", "zod"]),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.hostProvidedInDeps).toEqual(["@cinatra-ai/sdk-extensions"]);
      expect(verdict.missing).toEqual([]); // not a "missing" failure — a wrong-section failure
    }
  });
});

describe("contentHashOfEntries", () => {
  const a = { relPath: "package.json", bytes: Buffer.from("{}") };
  const b = { relPath: "dist/index.js", bytes: Buffer.from("export {}") };

  it("is order-independent (sorts by relPath)", () => {
    expect(contentHashOfEntries([a, b])).toBe(contentHashOfEntries([b, a]));
  });
  it("changes when any file content changes", () => {
    const tampered = { relPath: "dist/index.js", bytes: Buffer.from("export const x=1") };
    expect(contentHashOfEntries([a, b])).not.toBe(contentHashOfEntries([a, tampered]));
  });
  it("changes when a file is added or renamed", () => {
    const c = { relPath: "dist/extra.js", bytes: Buffer.from("") };
    expect(contentHashOfEntries([a, b])).not.toBe(contentHashOfEntries([a, b, c]));
  });
});

describe("scanHostPeerValueImports (host-peer value-import fail-loud scanner)", () => {
  const SDK = "@cinatra-ai/sdk-extensions";

  // ---- SAFE (type-only) — never a hit ------------------------------------
  it("does NOT flag an `import type { … }` (erased at compile)", () => {
    const src = `import type { ExtensionHostContext } from "${SDK}";\nexport function register(ctx) {}`;
    expect(scanHostPeerValueImports(src)).toEqual([]);
  });
  it("does NOT flag an `export type { … } from` re-export", () => {
    const src = `export type { BlogConnectorDefinition } from "${SDK}/blog-contract";`;
    expect(scanHostPeerValueImports(src)).toEqual([]);
  });
  it("does NOT flag a host-peer that is only mentioned in a comment or string literal", () => {
    const src =
      `// import { requireExtensionAction } from "${SDK}" — do NOT do this\n` +
      `/* import { x } from "${SDK}" */\n` +
      `const note = "see ${SDK} docs";\n` +
      `import type { X } from "${SDK}";`;
    expect(scanHostPeerValueImports(src)).toEqual([]);
  });
  it("does NOT flag an import-looking STRING literal, but DOES flag a real import on the next line", () => {
    // A full import statement embedded inside a single/double/template string is
    // data, not code — it must be stripped before the import regex runs. The real
    // import on the line after must still be flagged (no over-stripping).
    const src =
      `const single = 'import { x } from "${SDK}";';\n` +
      `const dbl = "import { y } from '${SDK}'";\n` +
      "const tmpl = `import { z } from \"" +
      SDK +
      "\"`;\n" +
      `import { requireExtensionAction } from "${SDK}";`;
    const hits = scanHostPeerValueImports(src);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ peer: SDK, bindings: ["requireExtensionAction"], line: 4 });
  });
  it("does NOT flag a relative or third-party import", () => {
    const src =
      `import { resendEmailConnector } from "./email-connector";\n` +
      `import { Resend } from "resend";\n` +
      `import type { Foo } from "@cinatra-ai/sdk-extensions";`;
    expect(scanHostPeerValueImports(src)).toEqual([]);
  });
  it("does NOT flag a bare `import \"server-only\"` followed by a type-only host-peer import (no statement-spanning)", () => {
    // The real resend/definition.ts shape: a bare side-effect import on line 1,
    // then an `import type { … } from "<peer>"` on line 2. A statement-spanning
    // regex would mis-read the clause as starting at `"server-only"` and flag it.
    const src = `import "server-only";\nimport type { EmailConnectorDefinition } from "${SDK}";`;
    expect(scanHostPeerValueImports(src)).toEqual([]);
  });
  it("does NOT span across a preceding value import of a DIFFERENT module", () => {
    const src = `import { z } from "zod";\nimport type { Ctx } from "${SDK}";`;
    expect(scanHostPeerValueImports(src)).toEqual([]);
  });
  it("flags an empty `{}` import/export from a host peer (side-effect runtime edge), but NOT a type-only empty import", () => {
    // Under verbatimModuleSyntax an empty `import {} / export {} from "<peer>"` is
    // a preserved runtime module edge the prod file:// loader would resolve.
    expect(scanHostPeerValueImports(`import {} from "${SDK}";`)).toHaveLength(1);
    expect(scanHostPeerValueImports(`export {} from "${SDK}";`)).toHaveLength(1);
    expect(scanHostPeerValueImports(`import type {} from "${SDK}";`)).toEqual([]);
  });

  // ---- VALUE — must be a hit ---------------------------------------------
  it("flags a named value import `import { … } from`", () => {
    const src = `import { requireExtensionAction } from "${SDK}";`;
    const hits = scanHostPeerValueImports(src);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ peer: SDK, bindings: ["requireExtensionAction"], line: 1 });
  });
  it("flags a default value import `import Default from`", () => {
    const src = `import sdk from "${SDK}";`;
    const hits = scanHostPeerValueImports(src);
    expect(hits).toHaveLength(1);
    expect(hits[0].peer).toBe(SDK);
    expect(hits[0].bindings).toEqual(["sdk"]);
  });
  it("flags a namespace value import `import * as ns from`", () => {
    const src = `import * as sdk from "${SDK}";`;
    const hits = scanHostPeerValueImports(src);
    expect(hits).toHaveLength(1);
    expect(hits[0].bindings).toEqual(["* as sdk"]);
  });
  it("flags a bare side-effect import `import \"<peer>\"`", () => {
    const src = `import "${SDK}";`;
    const hits = scanHostPeerValueImports(src);
    expect(hits).toHaveLength(1);
    expect(hits[0].peer).toBe(SDK);
    expect(hits[0].bindings).toEqual([]);
  });
  it("flags a `require(\"<peer>\")` call", () => {
    const src = `const sdk = require("${SDK}");`;
    const hits = scanHostPeerValueImports(src);
    expect(hits).toHaveLength(1);
    expect(hits[0].peer).toBe(SDK);
  });
  it("flags a dynamic `import(\"<peer>\")`", () => {
    const src = `const sdk = await import("${SDK}");`;
    const hits = scanHostPeerValueImports(src);
    expect(hits).toHaveLength(1);
    expect(hits[0].peer).toBe(SDK);
  });
  it("flags a value re-export `export { value } from`", () => {
    const src = `export { requireObjectsProvider } from "${SDK}";`;
    const hits = scanHostPeerValueImports(src);
    expect(hits).toHaveLength(1);
    expect(hits[0].bindings).toEqual(["requireObjectsProvider"]);
  });

  // ---- MIXED — the subtle case -------------------------------------------
  it("flags `import { type X, Y, type Z }` with ONLY the non-type binding (Y)", () => {
    const src = `import { type ExtensionHostContext, requireExtensionAction, type Foo } from "${SDK}";`;
    const hits = scanHostPeerValueImports(src);
    expect(hits).toHaveLength(1);
    expect(hits[0].bindings).toEqual(["requireExtensionAction"]);
  });
  it("DOES flag a brace import whose specifiers are ALL inline-`type` (verbatimModuleSyntax keeps the `import {}` runtime shell)", () => {
    const src = `import { type A, type B } from "${SDK}";`;
    const hits = scanHostPeerValueImports(src);
    expect(hits).toHaveLength(1);
    expect(hits[0].bindings).toEqual([]);
  });
  it("handles a renamed value binding `{ foo as bar }`", () => {
    const src = `import { requireExtensionAction as guard } from "${SDK}";`;
    const hits = scanHostPeerValueImports(src);
    expect(hits).toHaveLength(1);
    expect(hits[0].bindings).toEqual(["requireExtensionAction as guard"]);
  });

  // ---- subpath collapses to the base peer --------------------------------
  it("resolves a subpath specifier `…/blog-contract` to the base host peer", () => {
    const src = `import { registerBlogConnector } from "${SDK}/blog-contract";`;
    const hits = scanHostPeerValueImports(src);
    expect(hits).toHaveLength(1);
    expect(hits[0].peer).toBe(SDK);
  });
  it("flags sdk-ui and mcp-client value imports too (the full host-peer set)", () => {
    const src =
      `import { useNotify } from "@cinatra-ai/sdk-ui";\n` +
      `import { McpClient } from "@cinatra-ai/mcp-client";`;
    const hits = scanHostPeerValueImports(src);
    expect(hits.map((h) => h.peer).sort()).toEqual(["@cinatra-ai/mcp-client", "@cinatra-ai/sdk-ui"]);
  });

  // ---- multi-import files + line numbers ----------------------------------
  it("reports correct 1-based line numbers across a multi-import file", () => {
    const src =
      `import type { Ctx } from "${SDK}";\n` + // 1 — safe
      `import { good } from "./local";\n` + // 2 — relative
      `\n` + // 3
      `import { requireExtensionAction } from "${SDK}";\n` + // 4 — VALUE
      `export function register(ctx) {}\n` + // 5
      `const lazy = () => import("@cinatra-ai/mcp-client");`; // 6 — dynamic VALUE
    const hits = scanHostPeerValueImports(src);
    expect(hits).toHaveLength(2);
    expect(hits.find((h) => h.line === 4)?.bindings).toEqual(["requireExtensionAction"]);
    expect(hits.find((h) => h.line === 6)?.peer).toBe("@cinatra-ai/mcp-client");
  });

  // ---- custom host-peer set ----------------------------------------------
  it("honors a caller-supplied host-peer set (default = HOST_PROVIDED_PACKAGES)", () => {
    const src = `import { x } from "@acme/host-peer";\nimport { y } from "${SDK}";`;
    // default set: only sdk-extensions is a peer
    expect(scanHostPeerValueImports(src).map((h) => h.peer)).toEqual([SDK]);
    // custom set: only @acme/host-peer is a peer
    const custom = scanHostPeerValueImports(src, new Set(["@acme/host-peer"]));
    expect(custom.map((h) => h.peer)).toEqual(["@acme/host-peer"]);
  });
  it("exports HOST_PROVIDED_PACKAGES as the canonical 3-entry default", () => {
    expect([...HOST_PROVIDED_PACKAGES].sort()).toEqual([
      "@cinatra-ai/mcp-client",
      "@cinatra-ai/sdk-extensions",
      "@cinatra-ai/sdk-ui",
    ]);
  });
});

describe("parseModuleImports (shared import classifier — value-edge awareness)", () => {
  const get = (src: string) => parseModuleImports(src);

  it("classifies `import type { … } from` as a NON-value edge (erased, not followed)", () => {
    const [imp] = get(`import type { Ctx } from "./contract";`);
    expect(imp).toMatchObject({ specifier: "./contract", isValueEdge: false, kind: "import" });
    expect(imp.valueBindings).toEqual([]);
  });
  it("classifies `export type { … } from` as a NON-value edge", () => {
    const [imp] = get(`export type { Ctx } from "./contract";`);
    expect(imp).toMatchObject({ specifier: "./contract", isValueEdge: false });
  });
  it("classifies an all-inline-type brace import as a VALUE edge (the `import {}` runtime shell survives) with empty bindings", () => {
    const [imp] = get(`import { type A, type B } from "./contract";`);
    expect(imp.isValueEdge).toBe(true);
    expect(imp.valueBindings).toEqual([]);
  });
  it("classifies a mixed `{ type X, Y }` brace import as a VALUE edge with only Y", () => {
    const [imp] = get(`import { type X, valueY } from "./contract";`);
    expect(imp.isValueEdge).toBe(true);
    expect(imp.valueBindings).toEqual(["valueY"]);
  });
  it("classifies default / namespace / bare / require / dynamic as VALUE edges", () => {
    expect(get(`import D from "./d";`)[0]).toMatchObject({ isValueEdge: true, kind: "import" });
    expect(get(`import * as ns from "./n";`)[0]).toMatchObject({ isValueEdge: true });
    expect(get(`import "./side-effect";`)[0]).toMatchObject({ isValueEdge: true, kind: "bare" });
    expect(get(`const x = require("./r");`)[0]).toMatchObject({ isValueEdge: true, kind: "require" });
    expect(get(`const y = import("./dyn");`)[0]).toMatchObject({ isValueEdge: true, kind: "dynamic" });
  });
  it("reports the specifier and 1-based line for every import (relative AND bare)", () => {
    const src = `import type { A } from "./type-only";\nimport { v } from "./value";\nimport { z } from "@scope/pkg";`;
    const imps = get(src);
    expect(imps).toHaveLength(3);
    expect(imps[0]).toMatchObject({ specifier: "./type-only", line: 1, isValueEdge: false });
    expect(imps[1]).toMatchObject({ specifier: "./value", line: 2, isValueEdge: true });
    expect(imps[2]).toMatchObject({ specifier: "@scope/pkg", line: 3, isValueEdge: true });
  });
  it("does not see imports inside comments or string literals", () => {
    const src =
      `// import { x } from "./hidden";\n` +
      `const s = "import { y } from './alsoHidden'";\n` +
      `import { real } from "./real";`;
    const imps = get(src);
    expect(imps).toHaveLength(1);
    expect(imps[0]).toMatchObject({ specifier: "./real", line: 3 });
  });

  // ---- parser-only edge cases --------------------------------------------
  // These three are the classes a lexer/regex kept mis-classifying; the TS
  // parser resolves them structurally.
  it("sees a dynamic `import(\"x\")` inside a template-literal interpolation", () => {
    const imps = get("const x = `prefix ${await import(\"./dyn\")} suffix`;");
    const dyn = imps.find((i) => i.specifier === "./dyn");
    expect(dyn).toMatchObject({ specifier: "./dyn", isValueEdge: true, kind: "dynamic" });
  });
  it("sees a `require(\"x\")` inside a template-literal interpolation", () => {
    const imps = get("const x = `${require(\"./r\")}`;");
    const req = imps.find((i) => i.specifier === "./r");
    expect(req).toMatchObject({ specifier: "./r", isValueEdge: true, kind: "require" });
  });
  it("`import { type as t }` is a VALUE import of an export named `type`", () => {
    // TS: element.isTypeOnly === false, propertyName === "type", local === "t".
    // The lexer dropped this as type-only; the parser keeps it as a value binding.
    const [imp] = get(`import { type as t } from "./mod";`);
    expect(imp.isValueEdge).toBe(true);
    expect(imp.valueBindings).toEqual(["type as t"]);
  });
  it("`import { type as t, type Real }` keeps only the value binding `type as t`", () => {
    const [imp] = get(`import { type as t, type Real } from "./mod";`);
    expect(imp.isValueEdge).toBe(true);
    expect(imp.valueBindings).toEqual(["type as t"]);
  });
  it("a regex literal whose body looks like an import is NOT an import", () => {
    const src = `const r = /import { x } from "\\/sdk"/;\nimport { real } from "./real";`;
    const imps = get(src);
    expect(imps).toHaveLength(1);
    expect(imps[0]).toMatchObject({ specifier: "./real", line: 2 });
  });
  it("parses `import x = require(\"y\")` (ImportEquals) as a value require edge", () => {
    const [imp] = get(`import sdk = require("./y");`);
    expect(imp).toMatchObject({ specifier: "./y", isValueEdge: true, kind: "require" });
    expect(imp.valueBindings).toEqual(["sdk"]);
  });
  it("recognizes a `module.require(\"x\")` member call as a value require edge", () => {
    const [imp] = get(`const sdk = module.require("./r");`);
    expect(imp).toMatchObject({ specifier: "./r", isValueEdge: true, kind: "require" });
  });
  it("does NOT treat an UNRELATED `<obj>.require(\"x\")` member call as an import", () => {
    // Only `module.require` is the CommonJS escape hatch; `foo.require(...)` is
    // an arbitrary method call and must NOT be classified as a value edge.
    expect(get(`foo.require("./r");`)).toEqual([]);
  });
  it("derives the TSX ScriptKind from a `.tsx` fileName so a JSX-embedded value import parses", () => {
    // With the default `module.ts` scriptKind the JSX fails to parse and the
    // `import()` is missed; the `.tsx` fileName picks TSX and finds it.
    const src = `export function Reg(){ return <div>{import("./dyn")}</div>; }`;
    const found = parseModuleImports(src, "reg.tsx").find((i) => i.specifier === "./dyn");
    expect(found).toMatchObject({ specifier: "./dyn", isValueEdge: true, kind: "dynamic" });
  });
});

describe("scanHostPeerValueImports — parser-only edge cases", () => {
  const SDK = "@cinatra-ai/sdk-extensions";

  it("flags a dynamic `import(\"<peer>\")` inside a template interpolation", () => {
    const hits = scanHostPeerValueImports("const x = `${await import(\"" + SDK + "\")}`;");
    expect(hits).toHaveLength(1);
    expect(hits[0].peer).toBe(SDK);
  });
  it("flags a `require(\"<peer>\")` inside a template interpolation", () => {
    const hits = scanHostPeerValueImports("const x = `${require(\"" + SDK + "\")}`;");
    expect(hits).toHaveLength(1);
    expect(hits[0].peer).toBe(SDK);
  });
  it("flags `import { type as t } from \"<peer>\"` (value import of export named `type`)", () => {
    const hits = scanHostPeerValueImports(`import { type as t } from "${SDK}";`);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ peer: SDK, bindings: ["type as t"], line: 1 });
  });
  it("a regex literal whose body mentions the peer is NOT a hit", () => {
    const src = `const r = /import { x } from "${SDK}"/;`;
    expect(scanHostPeerValueImports(src)).toEqual([]);
  });
  it("a regex literal does not suppress a real import on a later line", () => {
    const src = `const r = /import { x } from "${SDK}"/;\nimport { requireExtensionAction } from "${SDK}";`;
    const hits = scanHostPeerValueImports(src);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ peer: SDK, bindings: ["requireExtensionAction"], line: 2 });
  });
  it("flags `import sdk = require(\"<peer>\")` (ImportEquals value require)", () => {
    const hits = scanHostPeerValueImports(`import sdk = require("${SDK}");`);
    expect(hits).toHaveLength(1);
    expect(hits[0].peer).toBe(SDK);
  });
  it("flags a `module.require(\"<peer>\")` member call (CommonJS escape hatch)", () => {
    const hits = scanHostPeerValueImports(`const sdk = module.require("${SDK}");`);
    expect(hits).toHaveLength(1);
    expect(hits[0].peer).toBe(SDK);
  });
  it("flags a JSX-embedded value `import(\"<peer>\")` when the fileName is `.tsx`", () => {
    const src = `export function Reg(){ return <div>{import("${SDK}")}</div>; }`;
    const hits = scanHostPeerValueImports(src, undefined, "reg.tsx");
    expect(hits).toHaveLength(1);
    expect(hits[0].peer).toBe(SDK);
  });
});
