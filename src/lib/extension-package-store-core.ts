// Pure, IO-free core for the runtime extension package store (the runtime installer).
//
// Everything here is deterministic and host-only but has NO filesystem,
// network, `server-only`, or `@/lib/*` dependency, so it is exhaustively
// unit-testable. The `server-only` IO wrapper (`extension-package-store.ts`)
// composes these helpers; the loader host wrapper (`runtime-package-loader.ts`)
// injects the IO around them.
//
// Responsibilities:
//   - compute the on-disk store dir name for a `<pkg>@<ver>/<digest>` layout
//     (collision-safe, path-traversal-safe, length-bounded);
//   - parse + verify Subresource-Integrity (SRI) strings against tarball bytes
//     (the runtime installer verifies npm/pacote SRI `dist.integrity` over
//     the EXACT downloaded tarball bytes BEFORE materialization);
//   - derive a digest-segment from the verified tarball;
//   - the bundled-dependencies gate (runtime deps must be physically bundled
//     in the tarball — the materializer NEVER runs a lifecycle install);
//   - a deterministic content hash over a materialized package directory, used
//     to re-verify integrity on every boot (tamper-evidence on disk).

import { createHash } from "node:crypto";
// The import classifier below uses the TypeScript compiler API (parser only —
// `createSourceFile`, no type-checker, no program). A real parser is the
// decisive correctness fix over a hand-rolled lexer/regex: it gets `import {
// type as t }` (a VALUE import of an export literally named `type`), template-
// literal `${import("…")}` interpolations, and regex literals exactly right —
// the three classes of edge case a lexer kept mis-classifying. `typescript` is
// already a project dependency. This core module is imported by the server-only
// materializer, so `typescript` is added to `serverExternalPackages` in
// `next.config.ts` (it must not enter the Turbopack/standalone bundle graph;
// Node resolves it at runtime).
import ts from "typescript";

// ---------------------------------------------------------------------------
// Store path layout
// ---------------------------------------------------------------------------

// (cinatra#791) The V1 `<pkg@ver__hash>/<digest>` layout helpers
// (storePackageDirName / sanitizeStoreSegment / storePackageDir /
// storeTarballPath) are RETIRED — the V2 kind-segregated layout below is the
// only store grammar (clean cutover, no back-compat).

function joinPosix(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, "")))
    .filter((p) => p.length > 0)
    .join("/");
}

// ---------------------------------------------------------------------------
// Subresource Integrity (SRI)
// ---------------------------------------------------------------------------

const SUPPORTED_SRI_ALGORITHMS = new Set(["sha256", "sha384", "sha512"]);

export type ParsedSri = { algorithm: string; base64: string };

/**
 * Parse an SRI string (`sha512-<base64>`). npm/pacote `dist.integrity` is always
 * a single `sha512-` SRI; we also accept sha256/sha384. A multi-hash SRI (space
 * separated) parses to its STRONGEST supported entry. Returns null on an
 * unsupported/malformed value (callers fail closed).
 */
export function parseSri(integrity: string): ParsedSri | null {
  if (!integrity || typeof integrity !== "string") return null;
  const candidates: ParsedSri[] = [];
  for (const token of integrity.trim().split(/\s+/)) {
    const dash = token.indexOf("-");
    if (dash <= 0) continue;
    const algorithm = token.slice(0, dash).toLowerCase();
    const base64 = token.slice(dash + 1);
    if (!SUPPORTED_SRI_ALGORITHMS.has(algorithm)) continue;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) continue;
    candidates.push({ algorithm, base64 });
  }
  if (candidates.length === 0) return null;
  // Prefer the strongest algorithm.
  const order = ["sha512", "sha384", "sha256"];
  candidates.sort((a, b) => order.indexOf(a.algorithm) - order.indexOf(b.algorithm));
  return candidates[0];
}

/** Compute the SRI string (`<alg>-<base64>`) for tarball bytes. */
export function sriForBytes(bytes: Uint8Array, algorithm: "sha256" | "sha384" | "sha512" = "sha512"): string {
  const base64 = createHash(algorithm).update(bytes).digest("base64");
  return `${algorithm}-${base64}`;
}

/**
 * Verify tarball bytes against an expected SRI string. Recomputes the hash with
 * the SAME algorithm the SRI declares and compares base64 (constant-time-ish via
 * length + char compare on the digest). Fails closed on a malformed SRI.
 */
export function sriMatches(bytes: Uint8Array, expectedIntegrity: string): boolean {
  const parsed = parseSri(expectedIntegrity);
  if (!parsed) return false;
  const actual = createHash(parsed.algorithm).update(bytes).digest("base64");
  return timingSafeEqualStrings(actual, parsed.base64);
}

/**
 * The hex digest used as the `<digest>` path segment: hex sha512 of the EXACT
 * tarball bytes. Path-safe (hex), stable, and binds the store dir to the
 * verified tarball.
 */
export function tarballDigestSegment(bytes: Uint8Array): string {
  return createHash("sha512").update(bytes).digest("hex");
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  // Length leak is acceptable (hash outputs are fixed-length per algorithm);
  // avoid early-exit on the first differing char.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Bundled-dependencies gate
// ---------------------------------------------------------------------------

/**
 * Host-internal SDK / ABI packages the HOST supplies to a runtime-loaded
 * extension as a single shared instance — they are NEVER published and are
 * consumed as workspace peers (they are NOT extensions). An extension declares
 * them in `peerDependencies` (the host provides the one true module); it must
 * NEVER list one in `dependencies` or bundle a copy, because a second instance
 * of the SDK breaks ABI identity (the `register(ctx)` contract + the shared
 * host registries rely on the extension importing the SAME module the host
 * loaded). Keep this in sync with the host-internal set in `.pnpmfile.cjs`.
 */
export const HOST_PROVIDED_PACKAGES: ReadonlySet<string> = new Set([
  "@cinatra-ai/sdk-extensions",
  "@cinatra-ai/sdk-ui",
  "@cinatra-ai/mcp-client",
]);

// ---------------------------------------------------------------------------
// Host-peer VALUE-import scanner (model-B runtime-resolution gate)
// ---------------------------------------------------------------------------

/**
 * One host-peer VALUE import found in a source file: the resolved base host
 * peer, the surviving runtime-bound bindings, and the 1-based line of the
 * import statement.
 */
export type HostPeerValueImportHit = {
  peer: string;
  /**
   * The runtime value bindings that survive compilation. Empty for a bare
   * side-effect import (`import "<peer>"`), `require()`, or dynamic `import()`.
   * For a brace import, only the specifiers NOT prefixed with inline `type`.
   */
  bindings: string[];
  line: number;
};

/**
 * Collapse a specifier to its base package: `@scope/name/sub/path` →
 * `@scope/name`, `pkg/sub` → `pkg`. Returns null for a relative/absolute
 * specifier. Mirrors `scripts/extensions/inventory.mjs#basePackageOf`.
 */
export function basePackageOfSpecifier(spec: string): string | null {
  if (typeof spec !== "string" || spec.length === 0) return null;
  if (spec.startsWith(".") || spec.startsWith("/")) return null;
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  return spec.split("/")[0];
}

/** The syntactic form of a parsed module import (drives the value-edge test). */
export type ModuleImportKind = "import" | "export" | "bare" | "require" | "dynamic";

/**
 * One module import/`require`/dynamic-`import`/re-export parsed from a source
 * file. This is the SINGLE shared classification used by BOTH the host-peer
 * value-import filter (`scanHostPeerValueImports`) AND the import-graph
 * edge-follow decision, so the two can never diverge on what survives
 * compilation as a runtime edge.
 */
export type ParsedModuleImport = {
  /** The imported specifier (`./x`, `@scope/pkg`, `@scope/pkg/sub`, `node:fs`). */
  specifier: string;
  /**
   * The runtime value bindings that SURVIVE compilation. Empty for a bare
   * side-effect import, `require`, dynamic `import`, `export … from` with no
   * binding, or an all-inline-`type` brace clause. For a brace import, only the
   * specifiers NOT prefixed with inline `type`. A default/namespace import is a
   * single binding.
   */
  valueBindings: string[];
  /**
   * Whether this import is a RUNTIME edge (a real `import`/`require`/`import()`
   * that the prod `file://` loader actually follows). `false` for `import type`
   * / `export type` and for an all-inline-`type` brace clause — those are erased
   * at compile and have NO runtime graph presence, so the graph trace must NOT
   * follow them (a false-positive fix).
   */
  isValueEdge: boolean;
  kind: ModuleImportKind;
  /** 1-based line of the import statement. */
  line: number;
};

/** Map a source file extension to the TS `ScriptKind` so JSX/TSX is parsed. */
function scriptKindForFile(fileName: string): ts.ScriptKind {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts")) return ts.ScriptKind.TS;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

/** Reconstruct a named-import specifier's reported binding text from its AST
 * element: `foo as bar` → `"foo as bar"`, plain `foo` → `"foo"`. For the
 * `import { type as t }` case the propertyName is the export name `type` and the
 * local name is `t`, so this renders `"type as t"` — a VALUE binding of an
 * export literally named `type`. */
function namedBindingText(propertyName: string | undefined, localName: string): string {
  return propertyName && propertyName !== localName ? `${propertyName} as ${localName}` : localName;
}

/**
 * Parse + classify every module import in `sourceText` — the single shared
 * import classifier, built on the TypeScript parser (`ts.createSourceFile`, no
 * type-checker). A real parser is the decisive fix over a hand-rolled
 * lexer/regex: per-specifier `element.isTypeOnly` is the accurate type/value
 * signal, call expressions inside template-literal `${…}` spans are walked
 * naturally, and regex literals are never mistaken for imports — the three
 * edge-case classes a lexer kept getting wrong.
 *
 * Forms handled (returning `{ specifier, valueBindings, isValueEdge, kind,
 * line }`, the shape both the host-peer filter and the graph edge-follow consume):
 *  - `import type { … } from "x"` / `export type { … } from "x"` → NON-value
 *    edge (declaration-level `isTypeOnly`), `valueBindings: []`.
 *  - `import { … } from "x"` / `export { … } from "x"` → per-specifier
 *    `element.isTypeOnly` drops only TRUE inline type modifiers (`type Foo`); a
 *    value import of an export literally NAMED `type` (`{ type as t }`) is kept
 *    as a value binding. An all-inline-`type` clause is a NON-value edge.
 *  - `import Default from "x"` / `import * as ns from "x"` → value edge.
 *  - bare `import "x"` (no clause) → value edge (`kind:"bare"`).
 *  - `import x = require("x")` (ImportEquals, external module ref) → value edge
 *    (`kind:"require"`).
 *  - `require("x")` / `module.require("x")` / dynamic `import("x")` call
 *    expressions (incl. inside a template-literal interpolation) → value edge.
 *
 * On compiled `.js` the `import type` keyword is already erased, so any surviving
 * host-peer import is a value edge — forward-safe. Known residual blind spot
 * (matching the sibling import-ban gates): a variable-indirected dynamic
 * `import(v)` / `require(v)` is statically unresolvable; acceptable for a
 * first-party no-new-rot ratchet.
 */
export function parseModuleImports(sourceText: string, fileName = "module.ts"): ParsedModuleImport[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    scriptKindForFile(fileName),
  );
  const out: ParsedModuleImport[] = [];
  const lineOf = (node: ts.Node): number =>
    ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile)).line + 1;

  // 1. Declaration-level imports/re-exports + `import x = require(…)`, walked
  //    over the top-level statements.
  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt)) {
      if (!ts.isStringLiteralLike(stmt.moduleSpecifier)) continue;
      const specifier = stmt.moduleSpecifier.text;
      const line = lineOf(stmt);
      const clause = stmt.importClause;

      // Bare side-effect import (`import "x"`) — no clause.
      if (!clause) {
        out.push({ specifier, valueBindings: [], isValueEdge: true, kind: "bare", line });
        continue;
      }
      // `import type { … } from "x"` — the whole statement is erased.
      if (clause.isTypeOnly) {
        out.push({ specifier, valueBindings: [], isValueEdge: false, kind: "import", line });
        continue;
      }
      const valueBindings: string[] = [];
      if (clause.name) valueBindings.push(clause.name.text); // default import
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named)) {
        valueBindings.push(`* as ${named.name.text}`);
      } else if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          if (el.isTypeOnly) continue; // an inline `type Foo` specifier — its binding is erased…
          valueBindings.push(namedBindingText(el.propertyName?.text, el.name.text));
        }
      }
      // …BUT a non-`import type` declaration ALWAYS preserves a runtime module
      // edge under verbatimModuleSyntax / Node type-stripping: `import { type X }`
      // / `import {}` from "x" both emit `import {} from "x"` (kept), so the prod
      // file:// loader still resolves "x". Only declaration-level `import type` is
      // fully erased. So any non-`import type` import is a value edge;
      // `valueBindings` lists just the surviving non-type names (may be empty).
      out.push({ specifier, valueBindings, isValueEdge: true, kind: "import", line });
      continue;
    }

    if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteralLike(stmt.moduleSpecifier)) {
      const specifier = stmt.moduleSpecifier.text;
      const line = lineOf(stmt);
      // `export type { … } from "x"` — erased.
      if (stmt.isTypeOnly) {
        out.push({ specifier, valueBindings: [], isValueEdge: false, kind: "export", line });
        continue;
      }
      const exportClause = stmt.exportClause;
      const valueBindings: string[] = [];
      if (exportClause && ts.isNamedExports(exportClause)) {
        for (const el of exportClause.elements) {
          if (el.isTypeOnly) continue;
          valueBindings.push(namedBindingText(el.propertyName?.text, el.name.text));
        }
        // A non-`export type` named re-export ALWAYS preserves a runtime edge
        // (`export { type X }` / `export {}` from "x" both emit `export {} from
        // "x"`, kept). Only declaration-level `export type` is erased.
        out.push({ specifier, valueBindings, isValueEdge: true, kind: "export", line });
        continue;
      }
      // `export * from "x"` (star re-export, no named bindings) — a runtime edge.
      out.push({ specifier, valueBindings: [], isValueEdge: true, kind: "export", line });
      continue;
    }

    if (
      ts.isImportEqualsDeclaration(stmt) &&
      ts.isExternalModuleReference(stmt.moduleReference) &&
      stmt.moduleReference.expression &&
      ts.isStringLiteralLike(stmt.moduleReference.expression)
    ) {
      // `import x = require("y")`. `import type x = require(...)` is erased.
      if (stmt.isTypeOnly) continue;
      out.push({
        specifier: stmt.moduleReference.expression.text,
        valueBindings: [stmt.name.text],
        isValueEdge: true,
        kind: "require",
        line: lineOf(stmt),
      });
    }
  }

  // 2. `require("x")` + dynamic `import("x")` call expressions — anywhere in the
  //    tree, including inside template-literal `${…}` interpolations. Walking
  //    descendants is what a parser gives "for free"; a lexer would blank whole
  //    template literals and miss these.
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const arg0 = node.arguments[0];
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      // A bare `require("x")` OR a `module.require("x")` member call — both are
      // CommonJS value imports the prod loader follows. The latter is a
      // PropertyAccessExpression callee `<module>.require`.
      const isRequire =
        (ts.isIdentifier(callee) && callee.text === "require") ||
        (ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "require" &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === "module");
      if ((isDynamicImport || isRequire) && arg0 && ts.isStringLiteralLike(arg0)) {
        out.push({
          specifier: arg0.text,
          valueBindings: [],
          isValueEdge: true,
          kind: isRequire ? "require" : "dynamic",
          line: lineOf(node),
        });
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);

  return out;
}

/**
 * Classify every host-internal-peer import in `sourceText` and return the
 * VALUE-bound ones (the model-B hazard the prod `file://` loader cannot
 * resolve). Thin filter over the shared `parseModuleImports` classifier: keep
 * only imports whose subpath-collapsed BASE package ∈ `hostPeers` AND which are
 * a runtime value edge.
 *
 * SAFE (no hit): `import type { … } from`, `export type { … } from`, an
 * all-inline-`type` brace clause. VALUE (hit): a plain brace import/export, a
 * default import, a namespace import, a bare side-effect import,
 * `require("<peer>")`, `module.require("<peer>")`, dynamic `import("<peer>")`. A
 * MIXED brace clause (`import { type X, Y }`) hits with only the non-`type`
 * bindings.
 *
 * `fileName` is forwarded to `parseModuleImports` so the parser derives the
 * correct `ScriptKind` — a `.tsx`/`.jsx` file's JSX must parse as TSX/JSX or a
 * JSX-embedded value `import()`/`require()` is missed (a fail-open gap). Graph
 * walkers MUST pass the real on-disk path.
 */
export function scanHostPeerValueImports(
  sourceText: string,
  hostPeers: ReadonlySet<string> = HOST_PROVIDED_PACKAGES,
  fileName = "module.ts",
): HostPeerValueImportHit[] {
  const hits: HostPeerValueImportHit[] = [];
  for (const imp of parseModuleImports(sourceText, fileName)) {
    if (!imp.isValueEdge) continue;
    const base = basePackageOfSpecifier(imp.specifier);
    if (base === null || !hostPeers.has(base)) continue;
    hits.push({ peer: base, bindings: imp.valueBindings, line: imp.line });
  }
  return hits;
}

export type BundledDepsVerdict =
  | { ok: true }
  | {
      ok: false;
      missing: string[];
      hostProvidedInDeps: string[];
      /**
       * Declared deps that are BOTH bundled AND covered by the signed
       * materialization plan's roots (cinatra#181) — refused: one source of
       * truth per dependency, never two competing copies.
       */
      bundledAndPlanned?: string[];
      /**
       * Plan-root names NOT declared in `dependencies` — refused: the plan and
       * the manifest must reconcile in BOTH directions (a plan covering an
       * undeclared package would smuggle code past the declaration surface).
       */
      planOnlyUndeclared?: string[];
    };

/**
 * The materializer NEVER runs `npm`/`pnpm install` (no lifecycle scripts,
 * the security-hardening rule), and the standalone Next output only traces build-time
 * `node_modules`. So every RUNTIME dependency a package declares must be
 * physically present in the tarball (bundled) for its `file://` import to
 * resolve — EXCEPT host-provided SDK packages, which the host supplies at
 * runtime as a shared instance and which must therefore NOT be bundled.
 *
 * Two failure modes:
 *  - `missing`: a non-host-provided runtime dependency is not bundled.
 *  - `hostProvidedInDeps`: a host-provided SDK package appears in
 *    `dependencies` — it belongs in `peerDependencies` (bundling a duplicate
 *    breaks ABI identity). Hard-rejected.
 *
 * `peerDependencies`/`devDependencies` are NOT checked (peers are host-supplied
 * or optional; dev deps never ship). A package with no runtime `dependencies`
 * always passes (the common case — extensions bundle their own code + type-only
 * import the host SDK, which is erased at compile).
 */
export function validateBundledDependencies(
  pkgJson: Record<string, unknown>,
  presentInNodeModules: ReadonlySet<string>,
  planRootDeps: ReadonlySet<string> | null = null,
): BundledDepsVerdict {
  const deps = pkgJson.dependencies;
  const declared = deps && typeof deps === "object" ? Object.keys(deps as Record<string, unknown>) : [];
  const declaredSet = new Set(declared);
  // Plan↔manifest reconciliation, plan→manifest direction (cinatra#181): every
  // plan ROOT must be a declared dependency. Checked even when the manifest
  // declares NO dependencies (a plan covering anything is then undeclared).
  const planOnlyUndeclared = planRootDeps ? [...planRootDeps].filter((name) => !declaredSet.has(name)) : [];
  if (declared.length === 0) {
    return planOnlyUndeclared.length === 0
      ? { ok: true }
      : { ok: false, missing: [], hostProvidedInDeps: [], planOnlyUndeclared };
  }
  const hostProvidedInDeps = declared.filter((name) => HOST_PROVIDED_PACKAGES.has(name));
  // cinatra#181 gate evolution: a declared (non-host) dep must be bundled XOR
  // covered by the signed plan's roots. `planRootDeps === null` (closure-less)
  // keeps today's behavior byte-for-byte: bundled is the only satisfier.
  const missing = declared.filter(
    (name) =>
      !HOST_PROVIDED_PACKAGES.has(name) &&
      !presentInNodeModules.has(name) &&
      !(planRootDeps?.has(name) ?? false),
  );
  const bundledAndPlanned = planRootDeps
    ? declared.filter(
        (name) => !HOST_PROVIDED_PACKAGES.has(name) && presentInNodeModules.has(name) && planRootDeps.has(name),
      )
    : [];
  return missing.length === 0 &&
    hostProvidedInDeps.length === 0 &&
    bundledAndPlanned.length === 0 &&
    planOnlyUndeclared.length === 0
    ? { ok: true }
    : {
        ok: false,
        missing,
        hostProvidedInDeps,
        ...(bundledAndPlanned.length > 0 ? { bundledAndPlanned } : {}),
        ...(planOnlyUndeclared.length > 0 ? { planOnlyUndeclared } : {}),
      };
}

// ---------------------------------------------------------------------------
// Content hash — boot-time tamper-evidence
// ---------------------------------------------------------------------------

export type ContentHashEntry = { relPath: string; bytes: Uint8Array };

/**
 * Deterministic content hash over a materialized package directory: sorts
 * entries by POSIX relative path, then folds `relPath\0<sha512(bytes)>` for each
 * into a single sha512. Re-running it over the on-disk dir at boot and comparing
 * to the stored hash detects any post-install file tampering. The sidecar file
 * (`.cinatra-store.json`) itself MUST be excluded by the caller.
 */
export function contentHashOfEntries(entries: readonly ContentHashEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  const outer = createHash("sha512");
  for (const e of sorted) {
    const inner = createHash("sha512").update(e.bytes).digest("hex");
    outer.update(e.relPath);
    outer.update("\0");
    outer.update(inner);
    outer.update("\n");
  }
  return outer.digest("hex");
}

/** The sidecar filename written into each materialized package dir. */
export const STORE_SIDECAR_FILENAME = ".cinatra-store.json";

export type StoreSidecar = {
  /** The SRI the tarball was verified against at install. */
  integrity: string;
  /** Hex sha512 of the verified tarball bytes (== the `<digest>` path segment). */
  tarballDigest: string;
  /** Content hash of the materialized dir (excluding this sidecar). */
  contentHash: string;
  packageName: string;
  version: string;
  /** Registry the tarball was resolved from (drives boot-time trust). */
  registryUrl?: string;
  /**
   * The 128-hex sha512 over the canonical MATERIALIZATION-PLAN bytes when the
   * package was materialized WITH a library-dependency closure (cinatra#181).
   * Absent = closure-less. The REUSE path compares this against the expected
   * plan's hash and FAILS LOUD on mismatch (a signed plan is immutable per
   * (name, version, integrity) — never silently reuse a dir materialized
   * under a different/absent plan, and never destroy a possibly-live dir).
   */
  closureHash?: string;
  /** ISO timestamp (host-supplied, not from the package). */
  materializedAt: string;
};

// ---------------------------------------------------------------------------
// V2 content-addressed store layout (cinatra#790/#791)
// ---------------------------------------------------------------------------
//
// One configurable data root, kind-segregated, content-addressed:
//
//   <root>/<kind>/<slug>/<digest>/           payload (package.json at top)
//   <root>/<kind>/<slug>/<digest>.tgz        verified tarball (boot re-verify)
//   <root>/<kind>/<slug>/<digest>/.cinatra-store.json   sidecar
//   <root>/<kind>/<slug>/current             plain-text active digest (MIRROR /
//                                            ops+GC hint ONLY — never a boot
//                                            selector or trust input)
//   <root>/.staging/                         same-fs staging (invisible to discovery)
//
// `slug` is the npm package name VERBATIM as path segments (`@scope/name` →
// `@scope/` + `name/`; unscoped → one segment). The npm name grammar is the
// only sanitizer: names are validated and REJECTED on any deviation, never
// rewritten (the `@` prefix disambiguates scope dirs from unscoped package
// dirs during discovery, mirroring node_modules). `digest` stays the full hex
// sha512 of the exact tarball bytes (`tarballDigestSegment`). Version is NOT
// in the path — the digest content-addresses; the materializer binds the
// extracted manifest's name+version to the requested install instead.

/** The extension kinds the store segregates by (== the installed_extension DDL enum). */
export const EXTENSION_STORE_KINDS = [
  "agent",
  "connector",
  "artifact",
  "skill",
  "workflow",
] as const;

export type ExtensionStoreKind = (typeof EXTENSION_STORE_KINDS)[number];

export function isExtensionStoreKind(value: unknown): value is ExtensionStoreKind {
  return typeof value === "string" && (EXTENSION_STORE_KINDS as readonly string[]).includes(value);
}

/** Same-filesystem staging dir under the data root (dot-dir → invisible to discovery). */
export const STORE_STAGING_DIRNAME = ".staging";

/** The plain-text active-digest mirror filename inside a slug dir. */
export const STORE_CURRENT_FILENAME = "current";

// The npm package-name grammar (modern names; legacy uppercase names are NOT
// extensions and are refused). Segments cannot start with `.` or `_`, so a
// validated name can never traverse (`..`) or collide with the dot-prefixed
// staging/sidecar entries; `/` appears only as the single scope separator.
const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/**
 * Validate an npm package name for use as a V2 store slug. Throws on anything
 * outside the modern npm name grammar — validate-and-reject, never rewrite.
 */
export function assertValidStorePackageName(packageName: string): void {
  if (
    typeof packageName !== "string" ||
    packageName.length === 0 ||
    packageName.length > 214 ||
    !NPM_NAME_RE.test(packageName)
  ) {
    throw new Error(
      `[package-store] invalid extension package name for the store slug: ${JSON.stringify(packageName)}`,
    );
  }
}

/** The slug path segments for a package name: `@scope/name` → ["@scope","name"]. */
export function storeSlugSegments(packageName: string): string[] {
  assertValidStorePackageName(packageName);
  return packageName.split("/");
}

/** True when `segment` is a well-formed hex tarball-digest path segment. */
export function isStoreDigestSegment(segment: string): boolean {
  return /^[0-9a-f]{64,128}$/.test(segment);
}

function assertStoreDigestSegment(digest: string): void {
  if (!isStoreDigestSegment(digest)) {
    throw new Error(`[package-store] invalid store digest segment: ${JSON.stringify(digest)}`);
  }
}

/** `<root>/<kind>/<slug>/` — the per-package dir holding digest dirs + `current`. */
export function storeSlugDirV2(dataRoot: string, kind: ExtensionStoreKind, packageName: string): string {
  return joinPosix(dataRoot, kind, ...storeSlugSegments(packageName));
}

/** `<root>/<kind>/<slug>/<digest>/` — the materialized payload dir. */
export function storeDigestDirV2(
  dataRoot: string,
  kind: ExtensionStoreKind,
  packageName: string,
  digest: string,
): string {
  assertStoreDigestSegment(digest);
  return joinPosix(storeSlugDirV2(dataRoot, kind, packageName), digest);
}

/** `<root>/<kind>/<slug>/<digest>.tgz` — the verified-tarball sibling. */
export function storeTarballPathV2(
  dataRoot: string,
  kind: ExtensionStoreKind,
  packageName: string,
  digest: string,
): string {
  return `${storeDigestDirV2(dataRoot, kind, packageName, digest)}.tgz`;
}

/** `<root>/<kind>/<slug>/current` — the plain-text active-digest mirror. */
export function currentFilePathV2(
  dataRoot: string,
  kind: ExtensionStoreKind,
  packageName: string,
): string {
  return joinPosix(storeSlugDirV2(dataRoot, kind, packageName), STORE_CURRENT_FILENAME);
}

/**
 * Parse a `current` file's raw text → the digest it names, or null when the
 * content is not a well-formed digest segment (empty/garbage → null, never a
 * throw — the file is a mirror, not a trust input).
 */
export function parseCurrentFileText(raw: string): string | null {
  const trimmed = raw.trim();
  return isStoreDigestSegment(trimmed) ? trimmed : null;
}
