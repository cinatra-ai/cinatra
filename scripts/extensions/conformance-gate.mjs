#!/usr/bin/env node
// cinatra#979 — Extension-side boundary conformance gate.
//
// ONE checker for all extension kinds (connector/agent/artifact/skill/
// workflow), run at BOTH enforcement points named in #979:
//   1. core CI, over the MATERIALIZED tree (`extensions/cinatra-ai/<slug>`) —
//      the "reference consumer" loop lives in
//      .github/workflows/extension-conformance-gate.yml, mirroring the
//      existing extension-ioc-gate.yml pattern.
//   2. per-repo CI (an individual extension's own repo) via the reusable
//      `workflow_call` workflow .github/workflows/
//      extension-conformance-gate-reusable.yml, which checks this cinatra
//      repo out at a pinned SHA and runs THIS script against the caller's own
//      checkout root.
//
// Both modes invoke the identical script against a package directory:
//   node scripts/extensions/conformance-gate.mjs --package <dir> [--sdk-root <dir>] [--json] [--strict]
//
// Exit codes (same convention as scripts/extension-ioc-gate.mjs in
// cinatra-ai/ci): 0 = conform, 1 = finding(s), 2 = infra/usage error (a
// broken gate, unreadable package, or a missing SDK source file the rule
// derivation depends on — NEVER a silent pass).
//
// RULE DERIVATION: see scripts/extensions/lib/conformance-rules.mjs. Rules
// with a live, canonical, single-source export (HOST_PORT_NAMES,
// ARTIFACT_ALLOWED_CINATRA_KEYS, CONNECTOR_ACCESS_CONFIG_FORMAT_VERSION) are
// read from that source's CURRENT text, never re-listed here (the #979
// checker-rules addendum's design principle, after the sdkAbiRange
// prose-vs-code drift the #978 fleet audit caught).
//
// BASELINE: findings are checked against a per-package, per-rule baseline
// (conformance-gate.baseline.json, monotonic — `--write-baseline` refuses to
// grow it). A baselined finding is reported but does not fail the exit code;
// it exists so a KNOWN, separately-tracked violation (e.g. the node:fs ban
// vs. gemini/openai-connector, tracked by #981) doesn't block this gate's
// initial rollout on remediation that is a different issue's job. New,
// non-baselined findings always fail.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadLiveRules,
  AGENT_JSON_FORMAT_VERSION,
  CTX_NON_PORT_KEYS,
  NODE_FS_ALLOWLIST,
  PROCESS_ENV_ALLOWLIST,
  PRIVATE_ORG_REPO_SLUGS,
  INTERNAL_HOSTNAME_PATTERNS,
} from "./lib/conformance-rules.mjs";
import { stripComments } from "../audit/lib/strip-comments.mjs";

export const CONFORMANCE_GATE_VERSION = "0.1.0";

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/extensions/ -> repo root, two levels up.
const DEFAULT_SDK_ROOT = resolve(__dirname, "..", "..");
const BASELINE_PATH = resolve(__dirname, "conformance-gate.baseline.json");

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx"];
const DOC_EXTENSIONS = [".md", ".json"];
// `dist`/`build` are skipped even on a package that (unusually) publishes
// pre-built output as its `files` — scanning bundled/minified output for
// import-boundary source patterns is not generally meaningful (no extension
// observed in this checker's fleet spot-check ships source-only-via-dist).
// The packlist check (npm pack, independent of this walk) still covers a
// published dist/ directory's CONTENTS for the packaging rule.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);

/** Walk every file under `root` (source + doc/manifest extensions), skipping
 * build/VCS noise dirs. Callers filter by extension/scope as needed. */
function walkAllFiles(root) {
  const out = [];
  const allExts = [...SOURCE_EXTENSIONS, ...DOC_EXTENSIONS];
  (function recurse(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        recurse(full);
      } else if (allExts.some((ext) => e.name.endsWith(ext))) {
        out.push(full);
      }
    }
  })(root);
  return out;
}

const isSourceFile = (rel) => SOURCE_EXTENSIONS.some((ext) => rel.endsWith(ext));

// The published-package scope: package.json's own `files` allowlist (npm's
// authoritative "what ships" declaration), or a sane default when absent.
// This is the boundary EVERY check below runs against — a repo's dev-only
// tooling (eslint.config.mjs, tools/, a root vitest config) is real content
// but outside the extension→host boundary #979 polices; the actual shipped
// runtime tree is what the manifest generator, the install pipeline, and
// npm's own `pack` all agree on.
const DEFAULT_SCOPE_DIRS = ["src", "cinatra"];

function isInScope(relPath, filesField) {
  const entries = Array.isArray(filesField) && filesField.length > 0 ? filesField : DEFAULT_SCOPE_DIRS;
  // npm's `files` glob entries tolerate a trailing slash on a directory
  // entry ("src/__tests__/" === "src/__tests__") — strip it before matching,
  // or a trailing-slash negation silently fails to exclude anything (found
  // live on drupal-mcp-connector/wordpress-mcp-connector's "!src/__tests__/"
  // during this checker's own fleet spot-check).
  const norm = (e) => e.replace(/\/+$/, "");
  const positive = entries.filter((e) => !e.startsWith("!")).map(norm);
  const negative = entries.filter((e) => e.startsWith("!")).map((e) => norm(e.slice(1)));
  const matches = (pattern) => relPath === pattern || relPath.startsWith(`${pattern}/`);
  if (!positive.some(matches)) return false;
  if (negative.some(matches)) return false;
  return true;
}

function scopedFiles(allRelFiles, pkg) {
  return allRelFiles.filter((f) => isInScope(f, pkg.files));
}

function readPackageJson(pkgDir) {
  const p = join(pkgDir, "package.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1. Imports — only public SDK entrypoints, no core-internal/deep-dist/
//    undeclared-peer imports.
// ---------------------------------------------------------------------------

// Deliberately NARROW, real-import-syntax-anchored patterns — a loose
// "from" + quoted-string scan false-matched arbitrary prose ("derived from
// 'x'", a redacted "all fields stripped" placeholder, etc.) during this
// checker's own fleet spot-check. Each pattern anchors on the actual
// import/require/export keyword so it cannot cross a statement boundary:
//   - static import with bindings: `import {a, b as c} from "x"` / `import *
//     as ns from "x"` / `import type T from "x"` (bindings restricted to
//     identifier/comma/space/braces/asterisk/"as"/"type" characters only)
//   - bare side-effect import: `import "x"`
//   - re-export: `export {a} from "x"` / `export * from "x"`
//   - `require("x")`
//   - dynamic `import("x")`
const IMPORT_PATTERNS = [
  /\bimport\s+(?:type\s+)?[\w*\s{},]+\s+from\s+["']([^"']+)["']/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\bexport\s+(?:type\s+)?[\w*\s{},]*\s*from\s+["']([^"']+)["']/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];

function extractImportSpecifiers(fileText) {
  const specs = [];
  for (const re of IMPORT_PATTERNS) {
    for (const m of fileText.matchAll(re)) specs.push(m[1]);
  }
  return specs;
}

function subpathFor(specifier, pkgName) {
  if (specifier === pkgName) return ".";
  const prefix = `${pkgName}/`;
  return specifier.startsWith(prefix) ? `./${specifier.slice(prefix.length)}` : null;
}

function checkImports(pkgDir, pkg, rules, relFiles) {
  const findings = [];
  const ownName = pkg.name;

  for (const rel of relFiles) {
    const text = stripComments(readFileSync(join(pkgDir, rel), "utf8"));
    for (const spec of extractImportSpecifiers(text)) {
      if (spec.startsWith(".") || spec.startsWith("/")) continue; // relative/own-tree
      if (spec.startsWith("node:")) continue; // node builtins handled by the fs-ban rule
      if (spec === "@/" || spec.startsWith("@/")) {
        findings.push({
          rule: "imports.core-internal",
          file: rel,
          detail: `imports core-internal path "${spec}" — extensions may only reach the host through register(ctx) ports.`,
        });
        continue;
      }
      if (/(^|\/)dist\//.test(spec)) {
        findings.push({
          rule: "imports.deep-dist",
          file: rel,
          detail: `imports a deep "dist/" path ("${spec}") — only a package's declared subpath exports are a stable contract.`,
        });
        continue;
      }
      if (spec.startsWith("@cinatra-ai/")) {
        if (spec === ownName || spec.startsWith(`${ownName}/`)) continue; // own package, fine
        if (spec.startsWith("@cinatra-ai/sdk-extensions")) {
          const sub = subpathFor(spec, "@cinatra-ai/sdk-extensions");
          if (sub === null || !rules.sdkExtensionsExports.includes(sub)) {
            findings.push({
              rule: "imports.undeclared-sdk-subpath",
              file: rel,
              detail: `imports "${spec}" — not one of @cinatra-ai/sdk-extensions's declared exports (${rules.sdkExtensionsExports.join(", ")}).`,
            });
          }
          continue;
        }
        if (spec.startsWith("@cinatra-ai/sdk-ui")) {
          const sub = subpathFor(spec, "@cinatra-ai/sdk-ui");
          if (sub === null || !rules.sdkUiExports.includes(sub)) {
            findings.push({
              rule: "imports.undeclared-sdk-subpath",
              file: rel,
              detail: `imports "${spec}" — not one of @cinatra-ai/sdk-ui's declared exports (${rules.sdkUiExports.join(", ")}).`,
            });
          }
          continue;
        }
        // Any other @cinatra-ai/* package: cross-extension or undeclared
        // first-party coupling — the two public SDK entrypoints are the
        // ONLY first-party code dependency an extension may have.
        findings.push({
          rule: "imports.non-sdk-first-party",
          file: rel,
          detail: `imports "${spec}" — the only first-party package(s) an extension may depend on are @cinatra-ai/sdk-extensions and @cinatra-ai/sdk-ui.`,
        });
        continue;
      }
      // Any other bare npm specifier (react, zod, next, etc.) is out of
      // #979's scope here — that's ordinary dependency hygiene (caught by
      // npm/pnpm install itself, or knip), not the extension→host BOUNDARY
      // this checker polices. Only @cinatra-ai/* first-party coupling,
      // core-internal `@/`, and deep `dist/` paths are boundary concerns.
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// 2. Manifest, per kind.
// ---------------------------------------------------------------------------

function checkManifest(pkgDir, pkg, rules) {
  const findings = [];
  const cinatra = pkg.cinatra;
  if (!cinatra || typeof cinatra !== "object") {
    findings.push({ rule: "manifest.missing", file: "package.json", detail: "no cinatra manifest block." });
    return findings;
  }
  const kind = cinatra.kind;

  // sdkAbiRange: any kind that DECLARES one must have it parse under the
  // supported forms register.ts's rangeBounds() accepts — a MIRROR (not an
  // import: register.ts's parser is a TS function, not a data literal, so it
  // cannot be regex-derived the way the Set/array constants above are) of
  // `packages/sdk-extensions/src/register.ts` rangeBounds(). Drift here can
  // only produce a false CI signal, never a security gap — register.ts
  // itself stays the fail-closed install-time authority regardless.
  if (typeof cinatra.sdkAbiRange === "string" && cinatra.sdkAbiRange.trim() !== "" && cinatra.sdkAbiRange.trim() !== "*") {
    const RANGE_RE = /^(\^|~|>=|=)?\s*\d+(\.(\d+|[xX*]))?(\.(\d+|[xX*]))?$/;
    if (!RANGE_RE.test(cinatra.sdkAbiRange.trim())) {
      findings.push({
        rule: "manifest.sdk-abi-range-malformed",
        file: "package.json",
        detail: `cinatra.sdkAbiRange "${cinatra.sdkAbiRange}" does not parse under a supported range form (bare/^/~/>= + major[.minor[.patch]]) — this fails CLOSED at install, not just here.`,
      });
    }
  }

  if (kind === "artifact") {
    const extraneous = Object.keys(cinatra).filter((k) => !rules.artifactAllowedCinatraKeys.has(k));
    if (extraneous.length > 0) {
      findings.push({
        rule: "manifest.artifact-extraneous-keys",
        file: "package.json",
        detail: `artifact extensions may only declare cinatra.{${[...rules.artifactAllowedCinatraKeys].join(",")}}; unexpected key(s): ${extraneous.join(", ")}.`,
      });
    }
    // #979 addendum: absent sdkAbiRange is unpinned→allowed everywhere EXCEPT
    // for the artifact kind, which must not declare it at all (mirrors
    // ARTIFACT_ALLOWED_CINATRA_KEYS — sdkAbiRange isn't even in that set, so
    // this is really the same rule, called out because the #978 fleet audit
    // got exactly this wrong).
    if ("sdkAbiRange" in cinatra) {
      findings.push({
        rule: "manifest.artifact-sdk-abi-range-present",
        file: "package.json",
        detail: "artifact-kind extensions must not declare cinatra.sdkAbiRange (metadata-only kind; absent is the only conformant state).",
      });
    }
    // cinatra.artifact.ui (cinatra#1621): the versioned renderer block. NESTED
    // (cinatra.artifact.ui.sdkAbiRange), so it is NOT the top-level
    // artifact-sdkAbiRange ban above — that stays. Derived, fail-closed checks.
    findings.push(...checkArtifactUi(pkgDir, pkg, rules));
  } else if (kind === "connector") {
    findings.push(...checkConnectorAccessConfig(pkgDir, rules));
    findings.push(...checkWebhooksDeclaration(pkg));
    if (!("sdkAbiRange" in cinatra)) {
      findings.push({
        rule: "manifest.connector-sdk-abi-range-advisory",
        file: "package.json",
        severity: "advisory",
        detail: 'connector extensions SHOULD declare cinatra.sdkAbiRange (recommend "^2" or a >=2.2 floor) for minimum-minor port refinement + a green compat badge. Not required — advisory only.',
      });
    }
  } else if (kind === "agent") {
    findings.push(...checkAgentManifest(pkgDir));
  }
  // kind === "workflow" | "skill": metadata-only, no rule (#979 addendum).

  return findings;
}

// cinatra#1621 — the versioned `cinatra.artifact.ui` renderer block, FAIL-CLOSED
// at the publish/conformance gate (the boot path degrades-with-diagnostic on the
// SAME shape). Every rule DERIVES from the live leaf source (the slot enum, the
// ui ABI version, the generated sdkAbiRange — loaded in `loadLiveRules`), never
// a re-listed literal. Mirrors the leaf's `parseArtifactUi`/`isContainedEntryPath`
// as regex/JS (the checker runs on bare `node`, no TS toolchain).
const ARTIFACT_UI_ALLOWED_KEYS = new Set(["abiVersion", "sdkAbiRange", "renderers", "registryItems"]);
const ARTIFACT_UI_RENDERER_ALLOWED_KEYS = new Set(["entry", "propsApiVersion", "representations"]);
// cinatra#1623 (S5): the presentational-only registryItems DECLARATION keys.
const ARTIFACT_UI_REGISTRY_ITEM_ALLOWED_KEYS = new Set(["name", "entry", "type", "description"]);
// Mirror of REGISTRY_COMPONENT_NAME_RE (leaf artifact-contract.ts) — a one-line
// grammar hand-mirrored as JS (like `isUiEntryContained` mirrors the leaf's
// `isContainedEntryPath`). Drift here can only produce a false CI signal, never
// a security gap; the leaf schema stays the runtime authority.
const REGISTRY_COMPONENT_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isUiEntryContained(entry) {
  if (typeof entry !== "string" || entry.length === 0) return false;
  if (!entry.startsWith("./")) return false;
  if (entry.includes("\\")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(entry)) return false; // protocol / URL
  const segments = entry.slice(2).split("/");
  return !segments.some((s) => s === "" || s === "." || s === "..");
}

function checkArtifactUi(pkgDir, pkg, rules) {
  const findings = [];
  const file = "package.json";
  const artifact = pkg?.cinatra?.artifact;
  const ui = artifact && typeof artifact === "object" ? artifact.ui : undefined;
  if (ui === undefined) return findings; // ui is optional
  if (typeof ui !== "object" || ui === null || Array.isArray(ui)) {
    findings.push({
      rule: "manifest.artifact-ui-shape",
      file,
      detail: "cinatra.artifact.ui must be an object ({ abiVersion, sdkAbiRange, renderers }).",
    });
    return findings;
  }
  // Reject extra TOP-LEVEL ui keys, matching the leaf schema's `.strict()` (so
  // the gate is never LOOSER than the boot/handler verdict).
  const extraUiKeys = Object.keys(ui).filter((k) => !ARTIFACT_UI_ALLOWED_KEYS.has(k));
  if (extraUiKeys.length > 0) {
    findings.push({
      rule: "manifest.artifact-ui-extraneous-key",
      file,
      detail: `cinatra.artifact.ui may only declare { abiVersion, sdkAbiRange, renderers }; unexpected key(s): ${extraUiKeys.join(", ")}.`,
    });
  }
  if (ui.abiVersion !== rules.artifactUiAbiVersion) {
    findings.push({
      rule: "manifest.artifact-ui-abi-version",
      file,
      detail: `cinatra.artifact.ui.abiVersion must be exactly ${rules.artifactUiAbiVersion} (got ${JSON.stringify(ui.abiVersion)}).`,
    });
  }
  if (ui.sdkAbiRange !== rules.artifactUiSdkAbiRange) {
    findings.push({
      rule: "manifest.artifact-ui-sdk-abi-range",
      file,
      detail: `cinatra.artifact.ui.sdkAbiRange must be the GENERATED value "${rules.artifactUiSdkAbiRange}" (computed from the canonical SDK ABI — never hand-written); got ${JSON.stringify(ui.sdkAbiRange)}.`,
    });
  }
  const renderers = ui.renderers;
  const registryItems = ui.registryItems;
  // cinatra#1623 (S5): `renderers` is now OPTIONAL — a ui block may declare
  // renderers, registryItems, or both, but at least one non-empty (mirrors the
  // leaf's at-least-one-of refinement).
  if (renderers === undefined && registryItems === undefined) {
    findings.push({
      rule: "manifest.artifact-ui-empty",
      file,
      detail: `cinatra.artifact.ui must declare at least one of \`renderers\` (a non-empty v1 slot map over {${[...rules.artifactUiSlots].join(", ")}}) or \`registryItems\` (a non-empty list).`,
    });
    return findings;
  }
  const renderersIsValidMap =
    renderers !== undefined &&
    typeof renderers === "object" &&
    renderers !== null &&
    !Array.isArray(renderers) &&
    Object.keys(renderers).length > 0;
  if (renderers !== undefined && !renderersIsValidMap) {
    findings.push({
      rule: "manifest.artifact-ui-renderers-empty",
      file,
      detail: `cinatra.artifact.ui.renderers, when present, must be a NON-EMPTY partial map over the v1 slot enum {${[...rules.artifactUiSlots].join(", ")}}.`,
    });
  }
  if (renderersIsValidMap) {
    findings.push(...checkArtifactUiRenderers(pkgDir, pkg, renderers, rules));
  }
  findings.push(...checkArtifactUiRegistryItems(pkgDir, pkg, registryItems, rules));
  return findings;
}

// Per-slot renderer checks (cinatra#1621), extracted so the registryItems
// addition (cinatra#1623) keeps `checkArtifactUi` linear. Only runs when
// `renderers` is a valid non-empty slot map.
function checkArtifactUiRenderers(pkgDir, pkg, renderers, rules) {
  const findings = [];
  const file = "package.json";
  for (const [slot, renderer] of Object.entries(renderers)) {
    const at = `cinatra.artifact.ui.renderers.${slot}`;
    if (!rules.artifactUiSlots.has(slot)) {
      const reserved = rules.artifactUiReservedSlots.has(slot);
      findings.push({
        rule: "manifest.artifact-ui-unknown-slot",
        file,
        detail: `${slot} is not a v1 renderer slot (v1 = ${[...rules.artifactUiSlots].join(", ")})${reserved ? " — RESERVED for a later wave and rejected in v1" : ""}.`,
      });
      continue;
    }
    if (typeof renderer !== "object" || renderer === null || Array.isArray(renderer)) {
      findings.push({
        rule: "manifest.artifact-ui-renderer-shape",
        file,
        detail: `${at} must be an object ({ entry, propsApiVersion[, representations] }).`,
      });
      continue;
    }
    const extra = Object.keys(renderer).filter((k) => !ARTIFACT_UI_RENDERER_ALLOWED_KEYS.has(k));
    if (extra.length > 0) {
      findings.push({
        rule: "manifest.artifact-ui-renderer-ports",
        file,
        detail: `${at} declares disallowed field(s) [${extra.join(", ")}] — v1 renderers request NO host ports and carry only { entry, propsApiVersion, representations? } (a read-only renderer port needs an ABI-major process).`,
      });
    }
    if (typeof renderer.entry !== "string" || !isUiEntryContained(renderer.entry)) {
      findings.push({
        rule: "manifest.artifact-ui-entry-uncontained",
        file,
        detail: `${at}.entry must be a package-relative, path-contained subpath ("./…", no "..", no absolute path or URL); got ${JSON.stringify(renderer.entry)}.`,
      });
    } else {
      const rel = renderer.entry.replace(/^\.\//, "");
      const resolved = existsSync(join(pkgDir, rel))
        ? rel
        : candidateFile(pkgDir, rel.replace(/\.[^./]+$/, ""));
      if (!resolved) {
        findings.push({
          rule: "manifest.artifact-ui-entry-unresolved",
          file,
          detail: `${at}.entry "${renderer.entry}" does not resolve to a file in the package (must resolve via the package's exports/files).`,
        });
      } else if (!isInScope(resolved, pkg.files)) {
        findings.push({
          rule: "manifest.artifact-ui-entry-out-of-scope",
          file,
          detail: `${at}.entry "${renderer.entry}" resolves outside the published "files" allowlist — it would not ship in the package tarball.`,
        });
      }
    }
    if (
      typeof renderer.propsApiVersion !== "number" ||
      !Number.isInteger(renderer.propsApiVersion) ||
      renderer.propsApiVersion < 1
    ) {
      findings.push({
        rule: "manifest.artifact-ui-props-api-version",
        file,
        detail: `${at}.propsApiVersion must be an integer >= 1 (got ${JSON.stringify(renderer.propsApiVersion)}).`,
      });
    }
    if (renderer.representations !== undefined) {
      const reps = renderer.representations;
      if (
        !Array.isArray(reps) ||
        reps.length === 0 ||
        !reps.every((r) => typeof r === "string" && r.length > 0)
      ) {
        findings.push({
          rule: "manifest.artifact-ui-representations",
          file,
          detail: `${at}.representations, when present, must be a non-empty array of MIME pattern strings.`,
        });
      }
    }
  }
  return findings;
}

// cinatra#1623 (S5) — the presentational-only `registryItems` DECLARATION,
// FAIL-CLOSED at the publish/conformance gate. Mirrors the leaf's
// `artifactUiRegistryItemsSchema` (never LOOSER than the boot/handler verdict):
// each item is { name, entry, type, description } — name a strict-lowercase
// `<component>` token, entry a path-contained subpath that resolves within the
// published `files` scope, type one of the DERIVED item-type enum, description a
// non-empty string; item names are unique within the manifest.
function checkArtifactUiRegistryItems(pkgDir, pkg, registryItems, rules) {
  const findings = [];
  const file = "package.json";
  if (registryItems === undefined) return findings; // optional
  if (!Array.isArray(registryItems) || registryItems.length === 0) {
    findings.push({
      rule: "manifest.artifact-ui-registry-items-shape",
      file,
      detail: "cinatra.artifact.ui.registryItems, when present, must be a NON-EMPTY array of { name, entry, type, description } items.",
    });
    return findings;
  }
  const seenNames = new Set();
  for (const [i, item] of registryItems.entries()) {
    const at = `cinatra.artifact.ui.registryItems[${i}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      findings.push({
        rule: "manifest.artifact-ui-registry-item-shape",
        file,
        detail: `${at} must be an object ({ name, entry, type, description }).`,
      });
      continue;
    }
    const extra = Object.keys(item).filter((k) => !ARTIFACT_UI_REGISTRY_ITEM_ALLOWED_KEYS.has(k));
    if (extra.length > 0) {
      findings.push({
        rule: "manifest.artifact-ui-registry-item-extraneous-key",
        file,
        detail: `${at} declares disallowed field(s) [${extra.join(", ")}] — a registry item is presentational-only and carries ONLY { name, entry, type, description } (npm + registry deps are extracted from the item SOURCE by the publish pipeline, never declared here).`,
      });
    }
    if (typeof item.name !== "string" || !REGISTRY_COMPONENT_NAME_RE.test(item.name)) {
      findings.push({
        rule: "manifest.artifact-ui-registry-item-name",
        file,
        detail: `${at}.name (the \`<component>\` token) must be strict lowercase kebab ([a-z0-9], hyphen-joined); got ${JSON.stringify(item.name)}.`,
      });
    } else if (seenNames.has(item.name)) {
      findings.push({
        rule: "manifest.artifact-ui-registry-item-duplicate-name",
        file,
        detail: `${at}.name "${item.name}" duplicates an earlier registry item — item names must be unique within the manifest.`,
      });
    } else {
      seenNames.add(item.name);
    }
    if (typeof item.entry !== "string" || !isUiEntryContained(item.entry)) {
      findings.push({
        rule: "manifest.artifact-ui-registry-item-entry-uncontained",
        file,
        detail: `${at}.entry must be a package-relative, path-contained subpath ("./…", no "..", no absolute path or URL); got ${JSON.stringify(item.entry)}.`,
      });
    } else {
      const rel = item.entry.replace(/^\.\//, "");
      const resolved = existsSync(join(pkgDir, rel))
        ? rel
        : candidateFile(pkgDir, rel.replace(/\.[^./]+$/, ""));
      if (!resolved) {
        findings.push({
          rule: "manifest.artifact-ui-registry-item-entry-unresolved",
          file,
          detail: `${at}.entry "${item.entry}" does not resolve to a file in the package (must resolve via the package's exports/files).`,
        });
      } else if (!isInScope(resolved, pkg.files)) {
        findings.push({
          rule: "manifest.artifact-ui-registry-item-entry-out-of-scope",
          file,
          detail: `${at}.entry "${item.entry}" resolves outside the published "files" allowlist — it would not ship in the package tarball.`,
        });
      }
    }
    if (typeof item.type !== "string" || !rules.artifactUiRegistryItemTypes.has(item.type)) {
      findings.push({
        rule: "manifest.artifact-ui-registry-item-type",
        file,
        detail: `${at}.type must be one of {${[...rules.artifactUiRegistryItemTypes].join(", ")}}; got ${JSON.stringify(item.type)}.`,
      });
    }
    if (typeof item.description !== "string" || item.description.length === 0) {
      findings.push({
        rule: "manifest.artifact-ui-registry-item-description",
        file,
        detail: `${at}.description must be a non-empty string.`,
      });
    }
  }
  return findings;
}

function checkConnectorAccessConfig(pkgDir, rules) {
  const findings = [];
  const configPath = join(pkgDir, "cinatra", "config.json");
  if (!existsSync(configPath)) {
    findings.push({
      rule: "manifest.connector-missing-access-config",
      file: "cinatra/config.json",
      detail: "connector extensions must ship cinatra/config.json with a valid access block.",
    });
    return findings;
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    findings.push({
      rule: "manifest.connector-access-config-invalid-json",
      file: "cinatra/config.json",
      detail: `not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    });
    return findings;
  }
  if (raw.formatVersion !== rules.connectorAccessConfigFormatVersion) {
    findings.push({
      rule: "manifest.connector-access-config-format-version",
      file: "cinatra/config.json",
      detail: `formatVersion must be exactly ${rules.connectorAccessConfigFormatVersion} (got ${JSON.stringify(raw.formatVersion)}).`,
    });
  }
  const scope = raw?.access?.scope;
  const hasDefault = scope && scope.default !== undefined;
  const hasOnly = scope && scope.only !== undefined;
  if (hasDefault === hasOnly) {
    findings.push({
      rule: "manifest.connector-access-config-scope-xor",
      file: "cinatra/config.json",
      detail: `access.scope must declare EXACTLY ONE of "default"/"only" (${hasDefault && hasOnly ? "both present" : "neither present"}).`,
    });
  }
  return findings;
}

// Mirrors `validateWebhooksDeclaration` in generate-extension-manifest.mjs
// (cinatra#340's `cinatra.webhooks` shape: `{ hooks: [{id, handler, factory,
// label?, rejectStatus?, schemaVersion?}] }`) — a connector's ONLY sanctioned
// inbound-hook declaration; a bespoke receiver (a hand-rolled route/handler
// not reachable through this manifest key) is what #979 requirement (2)'s
// "never a bespoke receiver" clause bans.
const WEBHOOK_HOOK_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const WEBHOOK_FACTORY_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const WEBHOOK_HANDLER_SUBPATH_RE = /^\.\/[A-Za-z0-9._/-]+$/;

function checkWebhooksDeclaration(pkg) {
  const findings = [];
  const decl = pkg?.cinatra?.webhooks;
  if (decl === undefined) return findings;
  if (typeof decl !== "object" || decl === null || Array.isArray(decl)) {
    findings.push({ rule: "manifest.webhooks-shape", file: "package.json", detail: "cinatra.webhooks must be an object ({ hooks: [...] })." });
    return findings;
  }
  if (!Array.isArray(decl.hooks) || decl.hooks.length === 0) {
    findings.push({ rule: "manifest.webhooks-shape", file: "package.json", detail: "cinatra.webhooks.hooks must be a non-empty array." });
    return findings;
  }
  const seen = new Set();
  for (const [i, hook] of decl.hooks.entries()) {
    const at = `cinatra.webhooks.hooks[${i}]`;
    if (!hook || typeof hook !== "object") {
      findings.push({ rule: "manifest.webhooks-shape", file: "package.json", detail: `${at} must be an object.` });
      continue;
    }
    if (typeof hook.id !== "string" || !WEBHOOK_HOOK_ID_RE.test(hook.id)) {
      findings.push({ rule: "manifest.webhooks-shape", file: "package.json", detail: `${at}.id must be a kebab-case hook id.` });
    } else if (seen.has(hook.id)) {
      findings.push({ rule: "manifest.webhooks-shape", file: "package.json", detail: `${at}.id: duplicate hook id "${hook.id}".` });
    } else {
      seen.add(hook.id);
    }
    if (typeof hook.handler !== "string" || !WEBHOOK_HANDLER_SUBPATH_RE.test(hook.handler)) {
      findings.push({
        rule: "manifest.webhooks-shape",
        file: "package.json",
        detail: `${at}.handler must be a package-relative subpath (e.g. "./src/webhooks/post").`,
      });
    }
    if (typeof hook.factory !== "string" || !WEBHOOK_FACTORY_RE.test(hook.factory)) {
      findings.push({ rule: "manifest.webhooks-shape", file: "package.json", detail: `${at}.factory must be a non-empty identifier.` });
    }
  }
  return findings;
}

function checkAgentManifest(pkgDir) {
  const findings = [];
  const materializedAgentJson = join(pkgDir, "agent.json");
  if (existsSync(materializedAgentJson)) {
    // Materialized mode (core CI over extensions/cinatra-ai/<slug>): the
    // build pipeline has written the root agent.json payload — assert its
    // format version.
    try {
      const parsed = JSON.parse(readFileSync(materializedAgentJson, "utf8"));
      if (parsed.formatVersion !== AGENT_JSON_FORMAT_VERSION) {
        findings.push({
          rule: "manifest.agent-json-format-version",
          file: "agent.json",
          detail: `materialized root agent.json must declare formatVersion:${AGENT_JSON_FORMAT_VERSION} (got ${JSON.stringify(parsed.formatVersion)}).`,
        });
      }
    } catch (err) {
      findings.push({
        rule: "manifest.agent-json-invalid",
        file: "agent.json",
        detail: `not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return findings;
  }
  // Pre-materialization mode (a standalone agent-extension repo's own CI):
  // there is no root agent.json yet — that's HOST build output, not authored
  // source. The authored proxy is cinatra/oas.json; require it to exist and
  // parse, and note the formatVersion:2 check is host-materialization-time
  // only.
  const oasPath = join(pkgDir, "cinatra", "oas.json");
  if (!existsSync(oasPath)) {
    findings.push({
      rule: "manifest.agent-missing-oas",
      file: "cinatra/oas.json",
      detail: "agent extensions must ship cinatra/oas.json (the source the host materializes into the root agent.json formatVersion:2 payload at build time).",
    });
    return findings;
  }
  try {
    JSON.parse(readFileSync(oasPath, "utf8"));
  } catch (err) {
    findings.push({
      rule: "manifest.agent-oas-invalid-json",
      file: "cinatra/oas.json",
      detail: `not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  findings.push({
    rule: "manifest.agent-json-format-version-deferred",
    file: "agent.json",
    severity: "info",
    detail: "no materialized root agent.json in this checkout (pre-materialization mode) — the formatVersion:2 check runs at core CI time over the materialized tree instead.",
  });
  return findings;
}

// ---------------------------------------------------------------------------
// 3. ctx-port discipline — register(ctx) uses documented ports only.
// ---------------------------------------------------------------------------

const CTX_ACCESS_RE = /\bctx\.([A-Za-z_$][\w$]*)/g;

/**
 * Resolve `cinatra.serverEntry` (an exports-map key, e.g. "./register") to
 * the on-disk file it points at, the same resolution
 * `runtime-loader.resolveDeclaredServerEntry` performs host-side. Returns
 * null when it can't be resolved (reported as a separate, distinct finding
 * by the caller — a dangling serverEntry is itself a real problem, but not
 * this check's job to report twice).
 */
function candidateFile(pkgDir, relNoExt) {
  const candidates = [relNoExt, ...SOURCE_EXTENSIONS.map((ext) => `${relNoExt}${ext}`)];
  return candidates.find((c) => existsSync(join(pkgDir, c))) ?? null;
}

function resolveServerEntryFile(pkgDir, pkg) {
  const entry = pkg?.cinatra?.serverEntry;
  if (typeof entry !== "string") return null;
  const target = pkg.exports?.[entry];
  if (typeof target === "string") {
    const rel = target.replace(/^\.\//, "");
    return existsSync(join(pkgDir, rel)) ? rel : candidateFile(pkgDir, rel.replace(/\.[^./]+$/, ""));
  }
  // `target` can also be a CONDITIONAL exports subtree ({types, default, ...})
  // rather than a bare string — resolveDeclaredServerEntry's host-side
  // authority handles the full conditions algorithm; this is a lighter mirror
  // that just takes the conditional entry's "default" (or first string value)
  // as the best-effort target.
  if (target && typeof target === "object") {
    const candidate = target.default ?? Object.values(target).find((v) => typeof v === "string");
    if (typeof candidate === "string") {
      const rel = candidate.replace(/^\.\//, "");
      if (existsSync(join(pkgDir, rel))) return rel;
    }
  }
  // Literal-fallback: `serverEntry` not found in (or package has no)
  // `exports` — treat it as a direct relative path (with a source extension
  // guessed), the same fallback the host's `resolveDeclaredServerEntry`
  // applies when an extension omits an exports map entirely.
  const literal = entry.replace(/^\.\//, "");
  return candidateFile(pkgDir, literal);
}

/**
 * ctx-port discipline: register(ctx)/bootstrap(ctx)/destroy(ctx) may only
 * use documented `ExtensionHostContext` ports. SCOPE, deliberately narrow: a
 * static regex scan of ONLY the resolved `cinatra.serverEntry` module (the
 * one file the SDK ABI guarantees receives `ExtensionHostContext` — see
 * `register.ts`'s `ExtensionServerEntry`). Any other `ctx`-named parameter
 * elsewhere in the package (a webhook handler's `WebhookContext`, a devSetup
 * hook's own ctx shape, an MCP tool handler's ctx) is a DIFFERENT type this
 * check must not confuse with the host port surface — scanning the whole
 * source tree for a bare `ctx.` produced exactly that false-positive class
 * during this checker's own fleet spot-check. This is a heuristic, not a
 * type-aware call-graph analysis: a ctx-taking helper imported into
 * serverEntry and called with a RENAMED ctx parameter is not followed. It
 * DOES follow one level of local relative RE-EXPORT from the entry file
 * (`export {bootstrap} from "./bootstrap"` / `export * from "./lifecycle"`)
 * — the `register`/`bootstrap`/`destroy` ABI hooks are commonly split across
 * sibling files and re-exported from the declared serverEntry, and missing
 * that entirely would be a material blind spot on exactly the lifecycle
 * hooks this check exists for.
 */
const LOCAL_REEXPORT_RE = /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+["'](\.\.?\/[^"']+)["']/g;

function checkCtxPorts(pkgDir, rules, pkg) {
  const findings = [];
  const entryFile = resolveServerEntryFile(pkgDir, pkg);
  if (!entryFile) return findings;

  const filesToScan = [entryFile];
  const entryText = stripComments(readFileSync(join(pkgDir, entryFile), "utf8"));
  for (const m of entryText.matchAll(LOCAL_REEXPORT_RE)) {
    const resolved = candidateFile(pkgDir, join(dirname(entryFile), m[1]).replace(/\.[^./]+$/, ""));
    if (resolved && !filesToScan.includes(resolved)) filesToScan.push(resolved);
  }

  const seen = new Set();
  for (const file of filesToScan) {
    const text = file === entryFile ? entryText : stripComments(readFileSync(join(pkgDir, file), "utf8"));
    for (const m of text.matchAll(CTX_ACCESS_RE)) {
      const name = m[1];
      if (rules.hostPortNames.has(name) || CTX_NON_PORT_KEYS.has(name)) continue;
      const key = `${file}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        rule: "ctx-ports.undocumented-access",
        file,
        detail: `ctx.${name} is not one of the documented host ports (${[...rules.hostPortNames].join(", ")}) — register(ctx) may only use documented ports.`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// 4. Packaging — the published tarball contains exactly the intended files.
// ---------------------------------------------------------------------------

const FORBIDDEN_PACK_PATTERNS = [
  { re: /(^|\/)\.env(\..+)?$|\.env$/, label: "an env file" },
  { re: /(^|\/)\.git(\/|$)/, label: "a .git path" },
  { re: /(^|\/)node_modules(\/|$)/, label: "a vendored node_modules path" },
  { re: /(^|\/)coverage(\/|$)/, label: "a coverage report" },
  { re: /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/, label: "a test file" },
  { re: /(^|\/)__tests__(\/|$)/, label: "a __tests__ directory" },
  { re: /(^|\/)\.DS_Store$/, label: "a .DS_Store artifact" },
  { re: /\.log$/, label: "a log file" },
  { re: /(^|\/)\.planning(\/|$)/, label: "a .planning working file" },
];

function checkPacklist(pkgDir, pkg) {
  const findings = [];
  let report;
  try {
    // --ignore-scripts: `npm pack` runs `prepack`/`prepare`/`postpack`
    // lifecycle scripts by default — this checker must never execute
    // arbitrary code from a package it is merely INSPECTING (core CI runs
    // this over every pinned extension on every PR; a compromised or
    // malicious extension's lifecycle script must not get a free execution
    // there).
    const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: pkgDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    report = JSON.parse(out);
  } catch (err) {
    findings.push({
      rule: "packlist.pack-dry-run-failed",
      file: "package.json",
      detail: `\`npm pack --dry-run\` failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return findings;
  }
  const files = (report[0]?.files ?? []).map((f) => f.path);
  for (const path of files) {
    for (const { re, label } of FORBIDDEN_PACK_PATTERNS) {
      if (re.test(path)) {
        findings.push({
          rule: "packlist.forbidden-file",
          file: path,
          detail: `published tarball contains ${label} ("${path}") — repo-internal files must never leak into the published package.`,
        });
      }
    }
  }
  if (!pkg.files && !existsSync(join(pkgDir, ".npmignore"))) {
    findings.push({
      rule: "packlist.no-files-allowlist",
      file: "package.json",
      severity: "advisory",
      detail: 'no package.json "files" allowlist and no .npmignore — npm falls back to its default ignore rules, which is how a regression class (repo-internal files leaking into the package) has happened before. Declare "files" explicitly.',
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// 5. Hygiene for public repos — no private-repo / internal-hostname refs.
// ---------------------------------------------------------------------------

function checkHygiene(pkgDir, allRelFiles) {
  const findings = [];
  for (const rel of allRelFiles) {
    let text;
    try {
      text = readFileSync(join(pkgDir, rel), "utf8");
    } catch {
      continue;
    }
    for (const slug of PRIVATE_ORG_REPO_SLUGS) {
      if (text.includes(slug)) {
        findings.push({
          rule: "hygiene.private-repo-reference",
          file: rel,
          detail: `references non-public org repo "${slug}" — a public extension repo must not name it.`,
        });
      }
    }
    for (const pattern of INTERNAL_HOSTNAME_PATTERNS) {
      if (pattern.test(text)) {
        findings.push({
          rule: "hygiene.internal-hostname-reference",
          file: rel,
          detail: `matches internal-infra hostname pattern ${pattern} — must not appear in a public repo.`,
        });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// #981/#982 deny-by-default: node:fs and process.env.
// ---------------------------------------------------------------------------

// Covers static import/require AND dynamic `await import("node:fs")` — the
// generic `checkImports` deliberately skips `node:` specifiers (this rule
// owns them instead), so this must be the ONLY place that catches every
// import FORM, static or dynamic.
const FS_IMPORT_RE = /(?:from\s+|require\(\s*|import\(\s*)["'](node:)?fs(\/promises)?["']/;

function checkFsAndEnvBans(pkg, relFiles) {
  const findings = [];
  for (const rel of relFiles) {
    const key = `${pkg.name}:${rel}`;
    const text = stripComments(readFileSync(join(pkg.__dir, rel), "utf8"));
    if (FS_IMPORT_RE.test(text) && !NODE_FS_ALLOWLIST.has(key)) {
      findings.push({
        rule: "fs-ban.direct-filesystem-access",
        file: rel,
        detail: 'imports "node:fs"/"fs" — extension source must not perform direct filesystem logging/IO; use ctx.logger.capture (or the relevant host port) instead (cinatra#981).',
      });
    }
    if (/\bprocess\.env\b/.test(text) && !PROCESS_ENV_ALLOWLIST.has(key)) {
      findings.push({
        rule: "env-ban.direct-process-env-access",
        file: rel,
        detail: "reads process.env directly — the manifest-declared env-override mapping on the settings/secrets ports is the only channel (cinatra#982).",
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Baseline.
// ---------------------------------------------------------------------------

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function findingKey(f) {
  return `${f.rule}::${f.file}`;
}

function partitionAgainstBaseline(pkgName, findings, baseline, strict) {
  const advisory = findings.filter((f) => f.severity === "advisory" || f.severity === "info");
  const hard = findings.filter((f) => !advisory.includes(f));
  const baselined = new Set(baseline[pkgName] ?? []);
  const blocking = [];
  const known = [];
  for (const f of hard) {
    if (!strict && baselined.has(findingKey(f))) {
      known.push(f);
    } else {
      blocking.push(f);
    }
  }
  return { blocking, known, advisory };
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { json: false, strict: false, writeBaseline: false, sdkRoot: DEFAULT_SDK_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--package") args.package = argv[++i];
    else if (a === "--sdk-root") args.sdkRoot = resolve(argv[++i]);
    else if (a === "--json") args.json = true;
    else if (a === "--strict") args.strict = true;
    else if (a === "--write-baseline") args.writeBaseline = true;
  }
  return args;
}

export function runConformanceGate({ packageDir, sdkRoot, strict = false }) {
  const rules = loadLiveRules(sdkRoot);
  if (!rules.ok) {
    return {
      infra: true,
      message: rules.missing?.length
        ? `rule derivation failed: missing source file(s): ${rules.missing.join(", ")}`
        : `rule derivation failed: could not extract ${rules.derivationFailed} from its live source.`,
    };
  }
  const pkg = readPackageJson(packageDir);
  if (!pkg) {
    return { infra: true, message: `unreadable/missing package.json under ${packageDir}` };
  }
  pkg.__dir = packageDir;
  const allFiles = walkAllFiles(packageDir).map((f) => relative(packageDir, f));
  // Every check below runs over the PUBLISHED-PACKAGE scope (package.json
  // `files`, or src/+cinatra/ by default) — a repo's dev-only tooling
  // (eslint.config.mjs, tools/, root-level test configs) is real content but
  // outside the extension→host boundary this gate polices. See `isInScope`.
  const inScope = scopedFiles(allFiles, pkg);
  const inScopeSource = inScope.filter(isSourceFile);
  // Hygiene additionally covers the always-published root README/LICENSE
  // even when a narrow `files` allowlist would otherwise exclude them.
  const hygieneScope = [...new Set([...inScope, "README.md", "package.json"].filter((f) => existsSync(join(packageDir, f))))];

  const findings = [
    ...checkImports(packageDir, pkg, rules, inScopeSource),
    ...checkManifest(packageDir, pkg, rules),
    ...checkCtxPorts(packageDir, rules, pkg),
    ...checkPacklist(packageDir, pkg),
    ...checkHygiene(packageDir, hygieneScope),
    ...checkFsAndEnvBans(pkg, inScopeSource),
  ];

  const baseline = loadBaseline();
  const { blocking, known, advisory } = partitionAgainstBaseline(pkg.name, findings, baseline, strict);

  return {
    infra: false,
    checkerVersion: CONFORMANCE_GATE_VERSION,
    packageName: pkg.name,
    kind: pkg.cinatra?.kind ?? null,
    blocking,
    known,
    advisory,
    conform: blocking.length === 0,
  };
}

function printHumanReport(result) {
  console.log(`[conformance-gate v${CONFORMANCE_GATE_VERSION}] ${result.packageName} (kind=${result.kind ?? "unknown"})`);
  for (const f of result.blocking) {
    console.log(`  FAIL  [${f.rule}] ${f.file}: ${f.detail}`);
  }
  for (const f of result.known) {
    console.log(`  KNOWN [${f.rule}] ${f.file}: ${f.detail} (baselined)`);
  }
  for (const f of result.advisory) {
    console.log(`  WARN  [${f.rule}] ${f.file}: ${f.detail}`);
  }
  if (result.conform) console.log("  conform");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.package) {
    console.error("usage: node conformance-gate.mjs --package <dir> [--sdk-root <dir>] [--json] [--strict]");
    process.exit(2);
  }
  const packageDir = resolve(args.package);
  if (!existsSync(packageDir) || !statSync(packageDir).isDirectory()) {
    console.error(`::error::extension-conformance-gate: package dir does not exist: ${packageDir}`);
    process.exit(2);
  }

  const result = runConformanceGate({ packageDir, sdkRoot: args.sdkRoot, strict: args.strict });
  if (result.infra) {
    console.error(`::error::extension-conformance-gate: ${result.message}`);
    process.exit(2);
  }
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHumanReport(result);
  }
  process.exit(result.conform ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
