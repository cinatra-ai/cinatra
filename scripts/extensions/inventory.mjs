#!/usr/bin/env node
// Extension inventory + dependency-graph generator.
//
// Produces the authoritative, machine-readable picture the milestone is built on:
//   - per-extension records (scope, kind, license, manifest deps, host @/ imports)
//   - a cross-kind dependency graph from FOUR signal sources
//   - a host-side reference-site inventory categorized by coupling nature
//
// The dependency graph here is the CANDIDATE source for the later manifest
// backfill — it is NOT the canonical `cinatra.dependencies` (no manifest
// declares that yet). The CI drift gate is deferred; this script's `--check`
// mode is intentionally non-failing for now.
//
// Usage:
//   node scripts/extensions/inventory.mjs            # regenerate JSON artifacts
//   node scripts/extensions/inventory.mjs --check    # report drift vs committed JSON (exit 0)
//   node scripts/extensions/inventory.mjs --print     # print summary only, write nothing

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
// The extension SOURCE tree scanned for the coupling dimensions. Defaults to the
// cloned-back `extensions/` under the repo root. `CINATRA_INVENTORY_EXT_ROOT`
// redirects ONLY this scan to an alternate, fully-populated tree — a TEST
// isolation hook (cinatra#380): the import-ban gate's live-subprocess fixtures
// write a scratch `@/` edge into a PRIVATE per-test clone of the tree rather than
// mutating the shared committed `extensions/`, so a concurrent inventory scan in
// the wholesale `pnpm test:root` run can never observe the transient fixture.
// Production gate/CLI runs leave it unset and scan the real tree unchanged. Only
// the EXT scan is redirected; host reference-site scanning and the generated
// artifacts stay anchored at the real repo root.
const EXT_ROOT = process.env.CINATRA_INVENTORY_EXT_ROOT
  ? join(process.env.CINATRA_INVENTORY_EXT_ROOT)
  : join(REPO_ROOT, "extensions");

// No in-tree-exempt extensions: anthropic-connector is un-exempt — extractable
// like every other connector. (The exemption only ever made sense for the
// VENDORED `extensions/anthropics/skills` bundle, not the connector.) The set is
// kept (empty) so `inTreeExempt` stays a real flag.
const IN_TREE_EXEMPT = new Set([]);

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function walkFiles(dir, predicate, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, predicate, acc);
    else if (predicate(full)) acc.push(full);
  }
  return acc;
}

const isSource = (f) => /\.(ts|tsx|mts|cts|mjs|js|jsx)$/.test(f);

// Strip // line and /* */ block comments before import scanning, so prose like
// `// The package must NOT import `@/lib/database`` is NOT counted as a real
// import (a false positive the backtick-aware regex would otherwise create, and
// the commented-import over-inclusion). The `[^:]` guard preserves
// `https://` URLs inside string literals.
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// ---------------------------------------------------------------------------
// 1. Connector tool-prefix catalog (agent -> connector inference source)
// ---------------------------------------------------------------------------
async function loadConnectorCatalog() {
  const descMod = await import(
    join(REPO_ROOT, "packages/connectors-catalog/src/descriptors.mjs")
  );
  const prefixToPackage = [];
  for (const d of descMod.CONNECTOR_DESCRIPTORS ?? []) {
    for (const prefix of d.mcpPrimitivePrefixes ?? []) {
      if (prefix) prefixToPackage.push({ prefix, packageName: d.packageName });
    }
  }
  // longest prefix first so `google_calendar_` wins over a hypothetical `google_`
  prefixToPackage.sort((a, b) => b.prefix.length - a.prefix.length);
  return {
    prefixToPackage,
    primitiveOverrides: deriveFacadePrimitiveOverrides(listExtensions()),
  };
}

/**
 * Facade-primitive overrides, DERIVED from the extension manifests
 * (cinatra#151 Stage 4): a connector that owns a facade primitive whose name
 * does not carry its tool prefix declares it as `cinatra.facadePrimitives`
 * (e.g. gmail-connector declares `["email_send"]`). This replaces the
 * hand-written `connectors-catalog/src/overrides.mjs` map — the catalog
 * derives instead of naming a concrete package in core. Deterministic on
 * collision: the lexicographically-first package name wins, with a warning
 * (two claimants is a manifest bug, not a resolution choice).
 * Exported for unit tests.
 */
export function deriveFacadePrimitiveOverrides(extensionEntries) {
  const overrides = {};
  for (const e of extensionEntries) {
    let pkg;
    try {
      pkg = readJson(e.pkgPath);
    } catch {
      continue;
    }
    if (!pkg?.name) continue;
    const declared = Array.isArray(pkg?.cinatra?.facadePrimitives)
      ? pkg.cinatra.facadePrimitives
      : [];
    for (const primitive of declared) {
      if (typeof primitive !== "string" || primitive.length === 0) continue;
      const existing = overrides[primitive];
      if (existing && existing !== pkg.name) {
        console.warn(
          `[inventory] facade primitive "${primitive}" is claimed by both ${existing} and ${pkg.name} — ` +
            `keeping the lexicographically first (fix the manifests: one owner per primitive).`,
        );
        if (pkg.name < existing) overrides[primitive] = pkg.name;
        continue;
      }
      overrides[primitive] = pkg.name;
    }
  }
  return overrides;
}

// ---------------------------------------------------------------------------
// 2. Per-extension records
// ---------------------------------------------------------------------------
// Pure text scanners (exported so the gate's form-coverage is directly unit-
// testable without a fixture dir). Each takes RAW source text and strips
// comments internally, so a test exercises BOTH the form coverage AND the
// comment-stripping in one pass.

/** Distinct `@/...` host-module specifiers referenced in `rawText`. Catches
 * `from "@/x"`, bare `import "@/x"`, dynamic `import("@/x")`, `require("@/x")`,
 * AND backtick `import(`@/x`)`. (A backtick specifier WITH ${interpolation} or a
 * variable-indirected `import(v)` is statically unresolvable — a known residual
 * blind spot of regex scanning; acceptable for a first-party no-new-rot ratchet.) */
export function scanHostImportsInText(rawText) {
  const text = stripComments(rawText);
  const hits = new Set();
  const re = /(?:from|import|require)\s*\(?\s*["'`](@\/[^"'`]+)["'`]/g;
  let m;
  while ((m = re.exec(text))) hits.add(m[1]);
  return hits;
}

/** Distinct OTHER-extension package specifiers in `rawText` (ANY scope —
 * @cinatra-ai, sibling extension scopes, …; `allNames.has(pkg)` keeps only real extensions,
 * so non-extension scoped deps such as sdk-extensions or radix are ignored). */
export function scanCrossExtImportsInText(rawText, selfName, allNames) {
  const text = stripComments(rawText);
  const hits = new Set();
  const re = /(?:from|import|require)\s*\(?\s*["'`](@[^"'`/]+\/[^"'`/]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const pkg = m[1];
    if (pkg !== selfName && allNames.has(pkg)) hits.add(pkg);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// SDK-only coupling
// ---------------------------------------------------------------------------
// The CANONICAL rule: an extension's ONLY permitted `@cinatra-ai/*`
// CODE deps are the two SDK packages. Every OTHER first-party scoped dep —
// `@cinatra-ai/mcp-server`, `@cinatra-ai/objects`, a sibling connector, a
// sibling-extension-scope package, … — is extraction-blocking coupling and a violation,
// whether it arrives via a runtime import, an `import type`, OR a package.json
// `dependencies`/`peerDependencies` entry (many couplings are UNDECLARED in
// package.json and resolved via workspace hoist, so SOURCE scanning is required,
// not just manifest reading).

// The only always-allowed first-party scoped code deps. A specifier's BASE
// package (scope/name, subpath stripped) is matched against this set, so a
// portable subpath such as `@cinatra-ai/sdk-ui/marketplace` is allowed too.
export const SDK_PACKAGES = new Set([
  "@cinatra-ai/sdk-extensions",
  "@cinatra-ai/sdk-ui",
]);

// First-party scopes whose non-SDK packages are extraction-blocking coupling.
// `@cinatra-ai` is the host scope; each in-tree `extensions/<scope>/` is a
// sibling-extension scope. Any other scope (radix, openai, anthropic-ai SDK, …)
// is a normal third-party npm dep. VENDOR-AGNOSTIC: derived from the on-disk
// `extensions/` scope dirs, never a hard-coded vendor list; the host scope is
// always included (the SDK lives in `packages/`, not `extensions/`).
function deriveFirstPartyScopes() {
  const scopes = new Set(["@cinatra-ai"]);
  try {
    for (const entry of readdirSync(EXT_ROOT, { withFileTypes: true })) {
      if (entry.isDirectory()) scopes.add("@" + entry.name);
    }
  } catch {
    // extensions/ absent (pre-clone-back) — fall back to the host scope only.
  }
  return scopes;
}
export const FIRST_PARTY_SCOPES = deriveFirstPartyScopes();

// A regex matching ONLY a real `extensions/<scope>/` path, built from the in-tree
// scope dir names (vendor-agnostic). Anchored to the actual scope dirs so it does
// NOT match the host's own `packages/extensions/src/` (a generic `extensions/<word>/`
// would). Matches nothing when `extensions/` is absent (pre-clone-back).
const EXTENSION_PATH_RE = (() => {
  let dirNames = [];
  try {
    dirNames = readdirSync(EXT_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    /* extensions/ absent */
  }
  if (dirNames.length === 0) return /$^/; // never matches
  const alt = dirNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`extensions/(${alt})/`);
})();

/** Collapse a specifier to its base package: `@scope/name/sub/path` → `@scope/name`,
 * `pkg/sub` → `pkg`. Returns `null` for a relative/bare-module specifier. */
export function basePackageOf(spec) {
  if (typeof spec !== "string" || spec.length === 0) return null;
  if (spec.startsWith(".") || spec.startsWith("/")) return null;
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    if (parts.length < 2) return null;
    return parts[0] + "/" + parts[1];
  }
  return spec.split("/")[0];
}

/** True when `spec` is a first-party (host scope or an in-tree sibling-extension
 * scope) NON-SDK code coupling — the SDK-only violation predicate. SDK packages
 * (and their subpaths) are allowed; everything outside the first-party scopes is
 * ignored. `firstPartyScopes` defaults to the on-disk-derived set (injectable for
 * tests). */
export function isSdkOnlyViolation(spec, firstPartyScopes = FIRST_PARTY_SCOPES) {
  const base = basePackageOf(spec);
  if (!base) return false;
  const scope = base.startsWith("@") ? base.split("/")[0] : null;
  if (!scope || !firstPartyScopes.has(scope)) return false;
  return !SDK_PACKAGES.has(base);
}

/** Distinct NON-SDK first-party base packages IMPORTED in `rawText` — runtime
 * `import`/`require`/dynamic-import AND `import type` (the regex is statement-
 * agnostic, so `import type { X } from "@cinatra-ai/objects"` is captured the
 * same as a value import). Self-imports are excluded. Returns base packages
 * (subpaths collapsed) so the ratchet unit is `(extension, base-package)`. */
export function scanSdkOnlyImportsInText(rawText, selfName, firstPartyScopes = FIRST_PARTY_SCOPES) {
  const text = stripComments(rawText);
  const hits = new Set();
  // Capture the FULL specifier (incl. subpath) so `basePackageOf` can collapse
  // `@cinatra-ai/sdk-ui/marketplace` → allowed and `@cinatra-ai/mcp-server/credentials`
  // → `@cinatra-ai/mcp-server` (a violation). `[^"'`]+` spans the subpath.
  const re = /(?:from|import|require)\s*\(?\s*["'`](@[^"'`]+\/[^"'`]+)["'`]/g;
  let m;
  while ((m = re.exec(text))) {
    const base = basePackageOf(m[1]);
    if (!base || base === selfName) continue;
    if (isSdkOnlyViolation(base, firstPartyScopes)) hits.add(base);
  }
  return hits;
}

/** Distinct NON-SDK first-party base packages declared in a package.json's
 * `dependencies` + `peerDependencies` (+ `optionalDependencies`). Self is
 * excluded. These keys are already base packages. */
export function sdkOnlyManifestDeps(pkg, selfName, firstPartyScopes = FIRST_PARTY_SCOPES) {
  const hits = new Set();
  const decl = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.peerDependencies ?? {}),
    ...(pkg?.optionalDependencies ?? {}),
  };
  for (const key of Object.keys(decl)) {
    if (key === selfName) continue;
    if (isSdkOnlyViolation(key, firstPartyScopes)) hits.add(key);
  }
  return hits;
}

function scanSdkOnlyViolations(extName, extDir, pkg) {
  const hits = new Set();
  for (const f of walkFiles(extDir, isSource)) {
    for (const h of scanSdkOnlyImportsInText(readFileSync(f, "utf8"), extName)) hits.add(h);
  }
  for (const h of sdkOnlyManifestDeps(pkg, extName)) hits.add(h);
  return [...hits].sort();
}

function scanHostInternalImports(extDir) {
  // Distinct `@/...` host modules an extension imports — the EMPIRICAL basis for
  // the ExtensionHostContext port set + the decoupling target list.
  const hits = new Set();
  for (const f of walkFiles(extDir, isSource)) {
    for (const h of scanHostImportsInText(readFileSync(f, "utf8"))) hits.add(h);
  }
  return [...hits].sort();
}

function scanCrossExtensionImports(extName, extDir, allNames) {
  const hits = new Set();
  for (const f of walkFiles(extDir, isSource)) {
    for (const h of scanCrossExtImportsInText(readFileSync(f, "utf8"), extName, allNames)) hits.add(h);
  }
  return [...hits].sort();
}

function oasChildAgentRefs(extDir, selfName) {
  const oasPath = join(extDir, "cinatra", "oas.json");
  if (!existsSync(oasPath)) return [];
  let oas;
  try {
    oas = readJson(oasPath);
  } catch {
    return [];
  }
  const refs = new Set();
  const rc = oas["$referenced_components"] ?? {};
  for (const v of Object.values(rc)) {
    const pn = v?.metadata?.cinatra?.packageName;
    const ct = v?.component_type;
    if (pn && pn !== selfName && (ct === "FlowNode" || ct === "ApiNode")) {
      refs.add(pn);
    }
  }
  return [...refs].sort();
}

function oasConnectorCandidates(extDir, catalog) {
  // Agent→connector edges are NOT statically declared in the agentspec OAS:
  // an agent invokes a connector capability via a runtime HTTP ApiNode, and the
  // only on-disk trace is a free-text token (e.g. `email_send` appears as a
  // `riskClass`, gmail_/apollo_ prefixes appear in node metadata). Per
  // these are CANDIDATES (warnings), not truth — scan the raw OAS
  // text for any connector tool prefix or override key and map to the owning
  // connector. The confident graph (workspace-dep / agentDependencies /
  // FlowNode child refs) is built separately.
  const oasPath = join(extDir, "cinatra", "oas.json");
  if (!existsSync(oasPath)) return [];
  let text;
  try {
    text = readFileSync(oasPath, "utf8");
  } catch {
    return [];
  }
  const out = new Map(); // packageName -> Set<token>
  const note = (pkg, token) => {
    if (!out.has(pkg)) out.set(pkg, new Set());
    out.get(pkg).add(token);
  };
  // quoted snake_case tokens are the candidate primitive surface
  const tokens = new Set();
  const re = /"([a-z][a-z0-9]*_[a-z0-9_]+)"/g;
  let m;
  while ((m = re.exec(text))) tokens.add(m[1]);
  for (const tok of tokens) {
    const override = catalog.primitiveOverrides[tok];
    if (override) {
      note(override, tok);
      continue;
    }
    const match = catalog.prefixToPackage.find((p) => tok.startsWith(p.prefix));
    if (match) note(match.packageName, tok);
  }
  return [...out.entries()]
    .map(([packageName, toks]) => ({ packageName, tokens: [...toks].sort() }))
    .sort((a, b) => a.packageName.localeCompare(b.packageName));
}

function listExtensions() {
  const out = [];
  // extensions/ is cloned back before gate jobs; guard the scan so
  // a consumer running without the tree returns empty rather than ENOENT-crashing
  // (gate main paths additionally fail-closed on an empty tree).
  if (!existsSync(EXT_ROOT)) return out;
  for (const scope of readdirSync(EXT_ROOT, { withFileTypes: true })) {
    if (!scope.isDirectory()) continue;
    const scopeDir = join(EXT_ROOT, scope.name);
    for (const ext of readdirSync(scopeDir, { withFileTypes: true })) {
      if (!ext.isDirectory()) continue;
      const dir = join(scopeDir, ext.name);
      const pkgPath = join(dir, "package.json");
      if (!existsSync(pkgPath)) continue;
      out.push({ scope: scope.name, slug: ext.name, dir, pkgPath });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Host-side reference-site inventory
// ---------------------------------------------------------------------------
function hostReferenceSites(extNames) {
  // cinatra-side files (src/, packages/ excluding extensions) that mention an
  // extension package name or the extensions/ path. Categorized by coupling.
  const roots = [join(REPO_ROOT, "src"), join(REPO_ROOT, "packages"), join(REPO_ROOT, "scripts")];
  const sites = [];
  // Match any extension package name across ALL scopes (@cinatra-ai + sibling
  // extension scopes), regex-escaped — NOT a hardcoded @cinatra-ai/ prefix (which
  // silently missed sibling-scope reference sites that lacked a path mention).
  const escaped = [...extNames].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pkgRe = new RegExp(`(?:${escaped.join("|")})(?![\\w-])`);
  for (const root of roots) {
    for (const f of walkFiles(root, isSource)) {
      const rel = relative(REPO_ROOT, f);
      if (rel.startsWith("packages/sdk-extensions")) continue;
      // Generated manifest files are the manifest itself, not hand-authored
      // coupling to reconcile — exclude from the reference-site inventory.
      if (rel.startsWith("src/lib/generated/")) continue;
      // This migration tooling/tests reference extension packages only as
      // fixtures, not host coupling — exclude so the count is stable.
      if (rel.startsWith("scripts/extensions/")) continue;
      const text = readFileSync(f, "utf8");
      const mentionsPkg = pkgRe.test(text);
      const mentionsPath = EXTENSION_PATH_RE.test(text);
      if (!mentionsPkg && !mentionsPath) continue;
      let category = "static-import";
      if (rel.includes("/generated/")) category = "declarative-manifest";
      else if (/extension(-handler|s\.ts|s-dev-watcher|-accent|registry)|register-extension|mcp-server|handler-bootstrap/.test(rel))
        category = "runtime-registration";
      else if (rel.includes("__tests__") || rel.endsWith(".test.ts") || rel.endsWith(".test.mjs"))
        category = "test-fixture";
      else if (rel.startsWith("scripts/")) category = "tooling";
      else if (/import\s+[^;]*from\s+["']@cinatra-ai\//.test(text)) category = "static-import";
      else category = "soft-reference";
      sites.push({ file: rel, category });
    }
  }
  sites.sort((a, b) => a.file.localeCompare(b.file));
  return sites;
}

// ---------------------------------------------------------------------------
// Canonical ExtensionDependency enums — mirror packages/extensions/src/canonical-types.ts
// (literals here because inventory.mjs runs under plain node, no TS import).
// ---------------------------------------------------------------------------
const VALID_DEPENDENCY_EDGE_TYPES = new Set(["runtime", "install-time", "peer"]);
const VALID_DEPENDENCY_REQUIREMENTS = new Set(["required", "optional"]);
const VALID_EXTENSION_KINDS = new Set(["agent", "connector", "artifact", "skill", "workflow"]);

function isValidVersionConstraint(vc) {
  if (!vc || typeof vc !== "object") return false;
  if (vc.kind === "semver-range") return typeof vc.range === "string" && vc.range.length > 0;
  if (vc.kind === "exact") return typeof vc.version === "string" && vc.version.length > 0;
  if (vc.kind === "git-ref") return typeof vc.ref === "string" && vc.ref.length > 0;
  return false;
}

// A `cinatra.dependencies[]` entry counts as a VALID lifecycle declaration ONLY
// when the FULL ExtensionDependency edge shape is present + valid. `packageName`
// alone is NOT enough: a malformed row (missing edgeType/requirement/
// versionConstraint) must not be allowed to hide a real cross-extension coupling
// from the import-ban gate, AND must not weaken closure behaviour
// (`dependency-closure.ts` treats any non-`"required"` requirement as optional).
// `kind`, when present, must be a valid ExtensionKind and match the depended-on
// extension's actual kind (looked up via `nameToKind`).
export function isValidExtensionDependency(dep, nameToKind = new Map()) {
  if (!dep || typeof dep !== "object") return false;
  if (typeof dep.packageName !== "string" || dep.packageName.length === 0) return false;
  if (!VALID_DEPENDENCY_EDGE_TYPES.has(dep.edgeType)) return false;
  if (!VALID_DEPENDENCY_REQUIREMENTS.has(dep.requirement)) return false;
  if (!isValidVersionConstraint(dep.versionConstraint)) return false;
  if (dep.kind !== undefined) {
    if (!VALID_EXTENSION_KINDS.has(dep.kind)) return false;
    const targetKind = nameToKind.get(dep.packageName);
    if (targetKind && dep.kind !== targetKind) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 4. Build
// ---------------------------------------------------------------------------
export async function buildInventory() {
  const catalog = await loadConnectorCatalog();
  const raw = listExtensions();
  const allNames = new Set(
    raw.map((e) => {
      try {
        return readJson(e.pkgPath).name;
      } catch {
        return null;
      }
    }).filter(Boolean),
  );
  // name → declared kind, for validating that a dependency's `kind` matches the
  // depended-on extension's actual kind (strict ExtensionDependency check).
  const nameToKind = new Map();
  for (const e of raw) {
    try {
      const p = readJson(e.pkgPath);
      if (p?.name && p?.cinatra?.kind) nameToKind.set(p.name, p.cinatra.kind);
    } catch {
      /* skip unreadable manifest */
    }
  }

  const extensions = [];
  for (const e of raw) {
    const pkg = readJson(e.pkgPath);
    const name = pkg.name;
    const cin = pkg.cinatra ?? {};
    const npmDeps = pkg.dependencies ?? {};
    const workspaceDeps = Object.entries(npmDeps)
      .filter(([, v]) => typeof v === "string" && v.startsWith("workspace:"))
      .map(([k]) => k);
    const extWorkspaceDeps = workspaceDeps.filter((d) => allNames.has(d));
    const hasLicenseFile = existsSync(join(e.dir, "LICENSE"));
    // A cross-extension import is DECLARED (and therefore allowed by the
    // import-ban gate) only when the dependency is present in BOTH package
    // resolution (`dependencies: workspace:*`) AND lifecycle metadata
    // (`cinatra.dependencies[]` with the FULL valid ExtensionDependency shape),
    // so the dependency closure can install, activate, and uninstall it safely.
    // Either alone — or a malformed `{ packageName }`-only row — is NOT enough.
    const declaredCinatraDeps = new Set(
      (Array.isArray(cin.dependencies) ? cin.dependencies : [])
        .filter((d) => isValidExtensionDependency(d, nameToKind))
        .map((d) => d.packageName),
    );
    const declaredCrossExtDeps = new Set(
      workspaceDeps.filter((d) => allNames.has(d) && declaredCinatraDeps.has(d)),
    );
    const crossExtensionImports = scanCrossExtensionImports(name, e.dir, allNames);
    // The import-ban VIOLATION set: cross-extension imports NOT backed by a
    // declared lifecycle+workspace dependency. Declared connector deps
    // (nango/email/crm/social/blog) are valid architecture, not rot.
    const undeclaredCrossExtensionImports = crossExtensionImports.filter(
      (d) => !declaredCrossExtDeps.has(d),
    );
    extensions.push({
      name,
      scope: e.scope,
      slug: e.slug,
      dir: relative(REPO_ROOT, e.dir),
      kind: cin.kind ?? null,
      apiVersion: cin.apiVersion ?? null,
      version: pkg.version ?? null,
      private: pkg.private === true,
      license: pkg.license ?? null,
      hasLicenseFile,
      inTreeExempt: IN_TREE_EXEMPT.has(name),
      npmDeps: Object.keys(npmDeps).filter((d) => !d.startsWith("@cinatra-ai/")),
      workspaceDeps,
      extWorkspaceDeps, // intra-extension static-import edges (BOTH npm + manifest)
      crossExtensionImports,
      declaredCrossExtensionDeps: [...declaredCrossExtDeps].sort(),
      undeclaredCrossExtensionImports,
      // ALL non-SDK first-party `@cinatra-ai/*` + sibling-scope
      // code coupling — from source imports (runtime AND
      // `import type`) AND package.json deps/peerDeps — collapsed to base
      // packages. This is the real extraction-blocking dimension (catches
      // `mcp-server`/`objects`/`llm`/sibling connectors the cross-extension
      // scanner misses because those live in `packages/`, not `extensions/`).
      sdkOnlyViolations: scanSdkOnlyViolations(name, e.dir, pkg),
      hostInternalImports: scanHostInternalImports(e.dir),
      agentDependencies: cin.agentDependencies ?? null,
      connectorDependencies: cin.connectorDependencies ?? null,
      cinatraDependencies: cin.dependencies ?? null,
      oasChildAgentRefs: oasChildAgentRefs(e.dir, name),
      oasConnectorCandidates: oasConnectorCandidates(e.dir, catalog),
    });
  }
  extensions.sort((a, b) => a.name.localeCompare(b.name));

  // dependency graph: edges with provenance + requirement default
  const edges = [];
  const candidateEdgesRaw = [];
  const addEdge = (from, to, source, edgeType, requirement) => {
    if (!to || from === to || !allNames.has(to)) return;
    edges.push({ from, to, source, edgeType, requirement });
  };
  for (const x of extensions) {
    // (a) workspace static imports => required runtime/code edge
    for (const dep of x.extWorkspaceDeps) addEdge(x.name, dep, "workspace-dep", "runtime", "required");
    // (a2) a cross-extension STATIC import is a confident edge even when the
    // package.json doesn't declare the workspace dep (a static import must carry
    // BOTH a manifest dep AND a code dep, or be decoupled).
    // These are load-bearing for extraction order; the missing-manifest-dep
    // cases are flagged in the summary for the decouple/backfill steps.
    for (const dep of x.crossExtensionImports) addEdge(x.name, dep, "cross-extension-import", "runtime", "required");
    // (b) declared agentDependencies (a Record<packageName, versionConstraint>)
    //     => required agent edge
    for (const depName of Object.keys(x.agentDependencies ?? {})) {
      addEdge(x.name, depName, "agentDependencies", "runtime", "required");
    }
    // (c) OAS child-agent refs => required orchestration edge
    for (const dep of x.oasChildAgentRefs) addEdge(x.name, dep, "oas-child-agent", "runtime", "required");
    // (candidate) connector tool prefix / override mention in the OAS. Agent→
    // connector deps are NOT statically declared (runtime HTTP ApiNode), so
    // these are CANDIDATES (warnings) confirmed by the later manifest
    // backfill — NOT confident edges, NOT used for extraction ordering.
    for (const c of x.oasConnectorCandidates) {
      if (c.packageName === x.name || !allNames.has(c.packageName)) continue;
      candidateEdgesRaw.push({ from: x.name, to: c.packageName, tokens: c.tokens, source: "oas-mention-candidate" });
    }
  }
  // dedupe edges (keep all provenance sources for a from->to pair)
  const edgeMap = new Map();
  for (const e of edges) {
    const key = `${e.from}::${e.to}`;
    if (!edgeMap.has(key)) edgeMap.set(key, { from: e.from, to: e.to, sources: new Set(), edgeType: e.edgeType, requirement: e.requirement });
    edgeMap.get(key).sources.add(e.source);
  }
  const graph = [...edgeMap.values()]
    .map((e) => ({ from: e.from, to: e.to, sources: [...e.sources].sort(), edgeType: e.edgeType, requirement: e.requirement }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  // CANDIDATE edges (agent→connector mentions). Drop any that are already a
  // confident edge; the rest are warnings for the later human review.
  const candidateEdges = candidateEdgesRaw
    .filter((c) => !graph.some((g) => g.from === c.from && g.to === c.to))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  // topological extraction order (deps before dependents). Tarjan-free Kahn.
  const order = topoOrder(extensions.map((x) => x.name), graph);

  const byKind = {};
  for (const x of extensions) byKind[x.kind ?? "null"] = (byKind[x.kind ?? "null"] ?? 0) + 1;

  const summary = {
    totalExtensions: extensions.length,
    byScope: extensions.reduce((a, x) => ((a[x.scope] = (a[x.scope] ?? 0) + 1), a), {}),
    byKind,
    inTreeExempt: extensions.filter((x) => x.inTreeExempt).map((x) => x.name),
    extractTarget: extensions.filter((x) => !x.inTreeExempt).length,
    withHostInternalImports: extensions.filter((x) => x.hostInternalImports.length > 0).map((x) => x.name),
    withCrossExtensionImports: extensions.filter((x) => x.crossExtensionImports.length > 0).map((x) => x.name),
    // Finding: a cross-extension STATIC import not backed by a package.json
    // workspace dep. The decouple + manifest-backfill steps must reconcile each
    // — add the workspace dep or invert the import.
    crossExtensionImportsMissingWorkspaceDep: extensions
      .flatMap((x) =>
        x.crossExtensionImports
          .filter((dep) => !x.workspaceDeps.includes(dep))
          .map((dep) => ({ from: x.name, to: dep })),
      )
      .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    withAgentDependencies: extensions.filter((x) => x.agentDependencies).map((x) => x.name),
    withCinatraDependencies: extensions.filter((x) => x.cinatraDependencies).map((x) => x.name),
    licenses: extensions.reduce((a, x) => ((a[x.license ?? "(none)"] = (a[x.license ?? "(none)"] ?? 0) + 1), a), {}),
    distinctHostInternalImports: distinctHostModules(extensions),
  };

  const referenceSites = hostReferenceSites(allNames);

  return {
    generatedBy: "scripts/extensions/inventory.mjs",
    note: "Extension inventory + candidate dependency graph. The graph is the CANDIDATE source for the later manifest backfill; not yet canonical cinatra.dependencies. No timestamp on purpose (avoids a gated-artifact time-bomb).",
    summary,
    extensions,
    dependencyGraph: graph,
    candidateEdges,
    extractionOrder: order,
    referenceSites,
    referenceSiteCounts: referenceSites.reduce((a, s) => ((a[s.category] = (a[s.category] ?? 0) + 1), a), {}),
  };
}

function distinctHostModules(extensions) {
  const map = new Map();
  for (const x of extensions) {
    for (const imp of x.hostInternalImports) {
      if (!map.has(imp)) map.set(imp, []);
      map.get(imp).push(x.name);
    }
  }
  return [...map.entries()]
    .map(([module, importers]) => ({ module, importers: importers.sort(), count: importers.length }))
    .sort((a, b) => b.count - a.count || a.module.localeCompare(b.module));
}

function topoOrder(nodes, graph) {
  const indeg = new Map(nodes.map((n) => [n, 0]));
  const adj = new Map(nodes.map((n) => [n, []]));
  for (const e of graph) {
    // edge from->to means `from` depends on `to`; `to` must come first.
    if (adj.has(e.to) && indeg.has(e.from)) {
      adj.get(e.to).push(e.from);
      indeg.set(e.from, indeg.get(e.from) + 1);
    }
  }
  const queue = nodes.filter((n) => indeg.get(n) === 0).sort();
  const out = [];
  while (queue.length) {
    const n = queue.shift();
    out.push(n);
    for (const m of (adj.get(n) ?? []).sort()) {
      indeg.set(m, indeg.get(m) - 1);
      if (indeg.get(m) === 0) queue.push(m);
    }
  }
  const cycle = nodes.filter((n) => !out.includes(n));
  return { order: out, cyclicOrUnresolved: cycle.sort() };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const OUT_JSON = join(REPO_ROOT, "generated/extension-inventory.json");
const OUT_GRAPH = join(REPO_ROOT, "generated/extension-dependency-graph.json");

function stable(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

async function main() {
  const args = process.argv.slice(2);
  const inv = await buildInventory();
  const graphDoc = {
    generatedBy: "scripts/extensions/inventory.mjs",
    note: inv.note,
    nodes: inv.extensions.map((x) => ({ name: x.name, kind: x.kind, inTreeExempt: x.inTreeExempt })),
    edges: inv.dependencyGraph,
    candidateEdges: inv.candidateEdges,
    extractionOrder: inv.extractionOrder,
  };

  if (args.includes("--print")) {
    console.log(stable(inv.summary));
    console.log("reference sites:", stable(inv.referenceSiteCounts));
    return;
  }

  if (args.includes("--check")) {
    let drift = false;
    for (const [path, fresh] of [[OUT_JSON, inv], [OUT_GRAPH, graphDoc]]) {
      if (!existsSync(path)) {
        console.log(`[extension-inventory] MISSING ${relative(REPO_ROOT, path)} (run without --check to generate)`);
        drift = true;
        continue;
      }
      const committed = readFileSync(path, "utf8");
      if (committed !== stable(fresh)) {
        console.log(`[extension-inventory] DRIFT ${relative(REPO_ROOT, path)} differs from regenerated output`);
        drift = true;
      }
    }
    if (drift) console.log("[extension-inventory] NOTE: --check is non-failing for now (a later drift gate enforces it).");
    else console.log("[extension-inventory] OK — committed artifacts match regenerated output.");
    return; // exit 0 regardless for now
  }

  mkdirSync(dirname(OUT_JSON), { recursive: true });
  writeFileSync(OUT_JSON, stable(inv));
  writeFileSync(OUT_GRAPH, stable(graphDoc));
  console.log(`[extension-inventory] wrote ${relative(REPO_ROOT, OUT_JSON)} (${inv.extensions.length} extensions)`);
  console.log(`[extension-inventory] wrote ${relative(REPO_ROOT, OUT_GRAPH)} (${inv.dependencyGraph.length} edges)`);
  console.log(stable(inv.summary));
}

// Only run the CLI when invoked directly — importing `buildInventory` (e.g. from
// the manifest generator or tests) must NOT execute main().
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
