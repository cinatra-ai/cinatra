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

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
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

  // cinatra.views chat renderable-view providers (cinatra#1626, S9): CROSS-KIND
  // (the carrier kinds are extendable), so this runs regardless of kind —
  // fail-closed on a malformed block, exactly as the host path degrades it.
  findings.push(...checkChatViews(pkgDir, pkg, rules));

  // cinatra.llmProvider LLM-provider declaration (cinatra#1712, S1 AC1):
  // OPTIONAL (no connector declares it yet — AC6 is a later cross-repo wave),
  // so an absent block yields zero findings; a present block validates
  // fail-closed against the leaf. Cross-kind for the same reason checkChatViews
  // is (the carrier is a connector, but running it regardless is strictly safe).
  findings.push(...checkLlmProvider(pkg, rules));

  // cinatra.logo self-declared card glyph (cinatra#2469): CROSS-KIND by the
  // maintainer decision "every extension kind must be able to self-define
  // cinatra.logo". Absent → zero findings (the documented default); declared →
  // fail-closed, including the PACKAGING check that no other layer can make.
  findings.push(...checkDeclaredLogo(pkgDir, pkg));

  return findings;
}

// ---------------------------------------------------------------------------
// cinatra.logo — the self-declared card glyph (cinatra#2469, follow-up to
// #1482/#2467).
//
// SCOPE, stated precisely (codex round-8): this gate polices the DECLARATION and
// its PACKAGING. For the declaration it mirrors `resolveDeclaredLogo`'s rules
// rule-for-rule — trimmed `.svg` suffix test, RAW path resolution, lexical AND
// realpath containment — because an extension repo's own CI runs this checker
// with no host generator to lean on and must reach the same verdict on the same
// manifest.
//
// It deliberately does NOT reproduce the CONTENT half: the SVG sanitizer verdict
// and the inline size budget stay solely with `resolveDeclaredLogo`, which is
// the only producer of the data URI anything renders. So this gate is a
// NECESSARY, not sufficient, condition — a logo that passes here can still be
// rejected at manifest generation on content grounds, which is the correct
// direction for the asymmetry (the gate never green-lights something the
// generator would then render unsafely).
//
// The `files`-scope check has NO counterpart anywhere else, and it is the one
// this gate uniquely can make (codex round-7). A package with
// `files: ["src","cinatra"]` that declares `cinatra.logo: "./logo.svg"` is
// perfectly resolvable ON DISK — the generator is happy, the file exists — but
// `npm pack` obeys `files`, so the published tarball carries the POINTER and not
// the ASSET. Every consumer then resolves nothing and silently falls back to the
// generic kind emblem: the dangling-logo state, arriving through packaging
// rather than through a bad path. Mirrors the existing
// `manifest.artifact-ui-entry-out-of-scope` / `manifest.chat-views-entry-out-of-scope`
// rules, which police exactly this boundary for their own declared entries.
// ---------------------------------------------------------------------------
function checkDeclaredLogo(pkgDir, pkg) {
  const findings = [];
  const file = "package.json";
  const raw = pkg?.cinatra?.logo;
  // ABSENT (missing or explicit null) is the documented default — byte-mirroring
  // resolveDeclaredLogo, which returns no error for exactly those two.
  if (raw === undefined || raw === null) return findings;

  if (typeof raw !== "string" || raw.trim().length === 0) {
    findings.push({
      rule: "manifest.logo-malformed",
      file,
      detail: `cinatra.logo must be a non-empty package-relative ".svg" path (got ${
        typeof raw === "string" ? "an empty/blank string" : typeof raw
      }).`,
    });
    return findings;
  }
  // Suffix tested on the TRIMMED value, path resolved RAW — the split
  // resolveDeclaredLogo documents explicitly (trimming before resolve would
  // silently START resolving `" ./logo.svg "`, which must stay a failure).
  if (!raw.trim().toLowerCase().endsWith(".svg")) {
    findings.push({
      rule: "manifest.logo-not-svg",
      file,
      detail: `cinatra.logo "${raw}" is not a ".svg" path — the host inlines a sanitized SVG, no other format is read.`,
    });
    return findings;
  }

  const pkgRoot = resolve(pkgDir);
  const abs = resolve(pkgRoot, raw);
  // `sep`, not a hardcoded "/" — the same containment idiom `resolveDeclaredLogo`
  // uses. A hardcoded separator rejects every valid NESTED logo on Windows
  // (codex round-9).
  if (abs !== pkgRoot && !abs.startsWith(pkgRoot + sep)) {
    findings.push({
      rule: "manifest.logo-escapes-package",
      file,
      detail: `cinatra.logo "${raw}" escapes the package directory.`,
    });
    return findings;
  }

  // npm reports package-relative POSIX paths with no leading "./" — fold the
  // platform separator to match that form exactly.
  const rel = relative(pkgRoot, abs).split(sep).join("/");
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    findings.push({
      rule: "manifest.logo-unresolved",
      file,
      detail: `cinatra.logo "${raw}" does not resolve to a readable file inside the package.`,
    });
    return findings;
  }
  // Realpath containment — `existsSync`/`statSync` FOLLOW symlinks, so the
  // lexical check above cannot see a symlinked PARENT directory pointing out of
  // the package. resolveDeclaredLogo performs the same second pass.
  try {
    const realRoot = realpathSync(pkgRoot);
    if (!realpathSync(abs).startsWith(realRoot + sep)) {
      findings.push({
        rule: "manifest.logo-escapes-package",
        file,
        detail: `cinatra.logo "${raw}" resolves (through a symlink) outside the package directory.`,
      });
      return findings;
    }
  } catch {
    findings.push({
      rule: "manifest.logo-unresolved",
      file,
      detail: `cinatra.logo "${raw}" does not resolve to a readable file inside the package.`,
    });
    return findings;
  }

  // SHIPMENT — proved against npm's OWN packlist, not a `files` heuristic
  // (codex round-8). `isInScope` models only the `files` array; npm additionally
  // applies root AND NESTED `.npmignore` files, its built-in ignores, and full
  // glob semantics. `files:["assets"]` + `assets/.npmignore` containing `*.svg`
  // passes the heuristic and ships NO logo — the dangling state, straight
  // through the release path. The heuristic survives only as a FLOOR for the
  // case where the dry run could not be performed at all (reported separately
  // and once, by `checkPacklist`), so an infra failure degrades to the weaker
  // check instead of to a silent pass.
  const { files: packed } = resolvePacklist(pkgDir);
  const ships = packed === null ? isInScope(rel, pkg.files) : packed.includes(rel);
  if (!ships) {
    findings.push({
      rule: "manifest.logo-out-of-scope",
      file,
      detail:
        `cinatra.logo "${raw}" resolves on disk but does NOT ship in the published package` +
        `${packed === null ? ' (per the "files" allowlist; `npm pack --dry-run` was unavailable)' : " (per `npm pack --dry-run`)"}` +
        ` — every consumer would install the declaration WITHOUT the asset and fall back to the generic kind ` +
        `emblem. Add "${rel}" to package.json "files" and make sure no .npmignore excludes it.`,
    });
  }
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

// cinatra.views (cinatra#1626, S9): the closed v1 entry keys + the viewType
// grammar, hand-mirrored from the leaf `chat-views-contract.ts` (its
// `chatViewEntrySchema`/`CHAT_VIEW_TYPE_RE`) — the checker runs on bare `node`,
// no TS toolchain. The `abiVersion` literal is DERIVED (loadLiveRules), never
// re-listed. Drift here can only produce a false CI signal, never a security
// gap; the leaf schema stays the runtime authority.
const CHAT_VIEW_ENTRY_ALLOWED_KEYS = new Set(["viewType", "entry", "propsApiVersion"]);
const CHAT_VIEW_TYPE_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

// cinatra.llmProvider (cinatra#1712, epic #1711 S1 AC1): the closed object-key
// sets at each strict level, hand-mirrored from the leaf `llm-provider-contract.ts`
// (its `LlmProvider*Schema` `.strict()` shapes) — the checker runs on bare
// `node`, no TS toolchain. The abiVersion literal + the provider / capability /
// native_mcp-status / approval VOCABULARIES are DERIVED (loadLiveRules), never
// re-listed. Drift in these structural key sets can only produce a false CI
// signal, never a security gap; the leaf schema stays the runtime authority.
// ABI v2 (cinatra#2093, epic #2086 S6) adds the two setup-time provider-choice
// flags. Kept as a hand-mirror of the leaf's `.strict()` key set, exactly like
// the nested key sets below — only the DATA literals (abi version + the four
// vocabularies) are derived.
const LLM_PROVIDER_ALLOWED_KEYS = new Set([
  "abiVersion",
  "provider",
  "capabilities",
  "models",
  "defaultCapable",
  "wizardEligible",
]);
const LLM_PROVIDER_NATIVE_MCP_ALLOWED_KEYS = new Set(["status", "transports", "approval"]);
const LLM_PROVIDER_MODELS_ALLOWED_KEYS = new Set(["default", "allowed"]);

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

// THE PACKAGING RULE (cinatra#3025, plan `PLAN: Agents Lifecycle (C)` §4.1
// item 0.8 / §8.5): "every artifact extension declares its display through its
// own `exports`". A renderer entry that is only a deep INTERNAL source path
// (`@vendor/pkg/src/renderers/detail`) cannot be imported by a consumer at all
// unless the host keeps a hand-maintained per-extension path alias alive — "a
// host edit per extension is exactly the coupling the program removes". So the
// display must sit at a declared, literal `exports` subpath, and the host
// imports the bare specifier the package publishes.
//
// SCOPE: artifact-kind packages only (`checkArtifactUi` runs under
// `kind === "artifact"`). The aliases that AGENT extensions use for their form
// field renderers are untouched by this rule, exactly as item 0.8 says — agent
// extensions are deliberately excluded from the workspace and cannot resolve a
// bare specifier.
//
// SELECTION, NOT PRESENCE. Node resolves a subpath to exactly ONE target: the
// first matching key of an ORDERED conditions object, the first valid entry of
// a fallback array. A check that merely asked "does some leaf under this
// subpath name the renderer" would pass
// `{"./renderers/detail": {"default": "./src/index.ts", "types": "./src/detail.tsx"}}`,
// whose bare import resolves to index.ts. So the gate SIMULATES the host's own
// resolution (`selectExportTargets` below) and requires the display to be the
// only thing that resolution can land on, and to be guaranteed to land at all.
//
// AT THE GENERATOR'S KEY. The manifest generator already derives ONE key from
// the renderer entry — the entry minus its source extension — and refuses to
// generate unless a tsconfig alias or that exact `exports` key resolves it. The
// gate checks the SAME key, so a package that passes here still generates once
// item 0.8 deletes the aliases; accepting any other subpath would not.

/** True for an `exports` node that is a CONDITIONS object (`{ import, default }`)
 * rather than a subpath map — Node's own rule: a subpath map's keys all start
 * with ".". An empty object is neither and carries no target. */
function isExportsConditionsObject(node) {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return false;
  const keys = Object.keys(node);
  return keys.length > 0 && !keys.some((k) => k.startsWith("."));
}

/** TypeScript's DECLARATION conditions — `types` and its versioned
 * `types@{selector}` form. They name declarations, never the module a consumer
 * executes, so they take no part in runtime selection. */
function isDeclarationOnlyCondition(key) {
  return key === "types" || key.startsWith("types@");
}

/** Conditions the host's resolution can never take. The generated build map
 * emits `import()` (scripts/extensions/generate-extension-manifest.mjs), and
 * `import` and `require` are mutually exclusive, so a subpath reachable only
 * through `require` is not importable by the host at all. */
function isImportUnreachableCondition(key) {
  return key === "require";
}

/** A stand-in for a target Node would reject outright. It is not a string, so
 * it can never resolve to the display, which is exactly the effect wanted. */
const INVALID_PACKAGE_TARGET = Object.freeze({ invalidPackageTarget: true });

/** Conditions that ALWAYS match an import-side resolution. Node takes the FIRST
 * matching key, so every later key of the same conditions object is
 * unreachable once one of these is reached. */
function isAlwaysMatchedCondition(key) {
  return key === "import" || key === "default";
}

/** Resolve an `exports` target to the package-relative file it names, using the
 * SAME resolution the entry check uses (an extension-less target resolves
 * through the source-extension candidates), or null. */
function resolveExportTargetFile(pkgDir, target) {
  if (typeof target !== "string" || !isUiEntryContained(target)) return null;
  const rel = target.replace(/^\.\//, "");
  if (existsSync(join(pkgDir, rel))) return rel;
  return candidateFile(pkgDir, rel.replace(/\.[^./]+$/, ""));
}

/** Walk an `exports` subpath value the way NODE resolves it, and report:
 *   `targets`    — every target the host could end up selecting;
 *   `guaranteed` — whether selection is certain to land on one of them.
 *
 * Node takes ONE target: the first matching condition key in DECLARATION ORDER,
 * or the first valid entry of a fallback array. So:
 *  - declaration-only and import-unreachable conditions are skipped outright;
 *  - reaching an always-matched condition (`import`, `default`) whose value
 *    always resolves ENDS the walk — later keys cannot be selected, which is why
 *    `{ "default": <display>, "node": <other> }` is conformant while the reverse
 *    order is not; an always-matched branch that resolves nowhere does NOT end
 *    it, because Node falls through to the next key;
 *  - any other condition (`node`, `browser`, a custom one) MIGHT match, so its
 *    target joins the candidate set and the walk continues;
 *  - a conditions object with no always-matched branch is NOT guaranteed to
 *    resolve at all (a `require`-only or custom-condition-only subpath is not
 *    importable), and a `null` target is a deliberately BLOCKED subpath.
 * Depth-capped: a malformed manifest must produce a finding, never a hang. */
function selectExportTargets(pkgDir, node, depth = 0) {
  if (depth > 8) return { targets: [], guaranteed: false };
  if (node === null) return { targets: [null], guaranteed: false };
  if (typeof node === "string") return { targets: [node], guaranteed: true };
  if (Array.isArray(node)) {
    // A fallback array resolves to the first target Node can USE. Node walks
    // past a malformed entry, a `null` entry, and a branch that yields nothing
    // — but NOT past a well-formed target whose file happens to be missing:
    // that one is selected and the import then fails. Testing existence here
    // would wrongly pass `["./src/missing.tsx", "./src/detail.tsx"]`; skipping
    // nulls is what keeps `[null, "./src/detail.tsx"]` conformant.
    const fallbackTargets = [];
    let fallbackGuaranteed = false;
    for (const entry of node) {
      if (entry === null) continue;
      if (typeof entry === "string" && !isUiEntryContained(entry)) continue;
      const selected = selectExportTargets(pkgDir, entry, depth + 1);
      fallbackTargets.push(...selected.targets);
      if (selected.guaranteed) {
        // This entry always resolves, so nothing after it is reachable.
        fallbackGuaranteed = true;
        break;
      }
      // This entry MIGHT be skipped (a conditions branch that need not match),
      // so a later entry can still be the one selected: keep both in the
      // candidate set and walk on. `[{ node: X }, X]` selects X either way and
      // is conformant; `[{ node: Y }, X]` could select either and is not.
    }
    return { targets: fallbackTargets, guaranteed: fallbackGuaranteed };
  }
  // An invalid package target (a number, a boolean) is not "no target": Node
  // THROWS when it selects one. Carry it so it can never resolve, rather than
  // letting a later branch stand in for it.
  if (typeof node !== "object") return { targets: [node], guaranteed: false };
  if (Object.keys(node).some((k) => /^\d+$/.test(k))) {
    // Node rejects a numeric key in a conditions object as an invalid package
    // configuration and throws — the object publishes nothing, however good its
    // other branches look.
    return { targets: [INVALID_PACKAGE_TARGET], guaranteed: false };
  }
  const targets = [];
  let guaranteed = false;
  for (const [condition, value] of Object.entries(node)) {
    if (isDeclarationOnlyCondition(condition)) continue;
    if (isImportUnreachableCondition(condition)) continue;
    const r = selectExportTargets(pkgDir, value, depth + 1);
    targets.push(...r.targets);
    if (isAlwaysMatchedCondition(condition) && r.guaranteed) {
      // The condition matches AND its value always resolves, so every later key
      // is unreachable. When the value does NOT always resolve — an `import`
      // branch that is itself a `require`-only object, say — Node falls through
      // to the next key, and so does this walk.
      guaranteed = true;
      break;
    }
  }
  return { targets, guaranteed };
}

/** An `exports` key a consumer can actually import: "." or a contained "./…".
 * A key such as ".not-a-subpath" or "./../x" names no importable specifier, so
 * it can never publish the display however it resolves on disk. Kept SEPARATE
 * from the shape classification below, which counts every dot-prefixed key to
 * decide whether the map is a subpath map at all. */
function isImportableSubpathKey(key) {
  return key === "." || isUiEntryContained(key);
}

/** Read the package's `exports` field the way Node does:
 *   "absent"   — no map at all;
 *   "sugar"    — a string / array / conditions object: the "." subpath alone;
 *   "subpaths" — a subpath map (every key starts with ".");
 *   "mixed"    — an object mixing subpath keys with condition keys, which Node
 *                REJECTS outright; the map is unusable and is reported as such
 *                rather than half-read.
 * PATTERN subpaths (any key containing "*") are excluded from the map: the gate
 * must be able to name the exact specifier the host will import, and a pattern
 * makes that specifier a function of the package's internal path — the coupling
 * item 0.8 removes. A pattern is therefore not a declaration OF THIS DISPLAY,
 * however narrow it is. */
function readExportsField(pkgDir, exportsField) {
  if (exportsField === undefined || exportsField === null) {
    return { kind: "absent", map: new Map(), offending: [] };
  }
  if (
    typeof exportsField === "string" ||
    Array.isArray(exportsField) ||
    isExportsConditionsObject(exportsField)
  ) {
    return {
      kind: "sugar",
      map: new Map([[".", selectExportTargets(pkgDir, exportsField)]]),
      offending: [],
    };
  }
  if (typeof exportsField !== "object") {
    return { kind: "absent", map: new Map(), offending: [] };
  }
  const keys = Object.keys(exportsField);
  const dotted = keys.filter((k) => k.startsWith("."));
  if (dotted.length > 0 && dotted.length !== keys.length) {
    return { kind: "mixed", map: new Map(), offending: keys.filter((k) => !k.startsWith(".")) };
  }
  const map = new Map();
  for (const [subpath, node] of Object.entries(exportsField)) {
    if (subpath.includes("*")) continue; // pattern — see above
    if (!isImportableSubpathKey(subpath)) continue; // names no importable specifier
    map.set(subpath, selectExportTargets(pkgDir, node));
  }
  return { kind: "subpaths", map, offending: [] };
}

/** The `exports` key the HOST'S GENERATOR derives for a renderer entry: the
 * entry path minus its source extension. This is not a choice the gate makes —
 * scripts/extensions/generate-extension-manifest.mjs computes exactly this key
 * (`importSubpath` / `exportsKey`) and refuses to generate when neither a
 * tsconfig path alias nor `package.json exports[<key>]` resolves it. The gate
 * is that check's PUBLISH-TIME MIRROR: it refuses at publish what generation
 * would refuse at build, minus the per-extension alias escape hatch item 0.8
 * deletes. Accepting some OTHER subpath would pass a package here that breaks
 * generation the moment its alias goes.
 *
 * `generatorResolvesEntryFile` above mirrors the generator's own, NARROWER entry
 * candidates — the literal path, then `.ts`, then `.tsx`. The gate's general
 * `candidateFile` strips any extension and tries the whole source-extension set,
 * so an entry `./src/detail.js` backed by `src/detail.ts` resolves there and not
 * in the generator; the packaging rule asks the generator's question. */
function generatorResolvesEntryFile(pkgDir, entry) {
  const rel = entry.replace(/^\.\//, "");
  for (const candidate of [rel, `${rel}.ts`, `${rel}.tsx`]) {
    if (existsSync(join(pkgDir, candidate))) return candidate;
  }
  return null;
}

function generatorExportsKeyForEntry(entry) {
  const rel = entry.replace(/^\.\//, "");
  return `./${rel.replace(/\.(ts|tsx)$/, "")}`;
}

/** Whether the package publishes `resolvedRel` AT THE GENERATOR'S KEY. A subpath
 * publishes the display only when its resolution is GUARANTEED to land
 * somewhere, lands on at least one target, and every target it could land on is
 * this module — if two branches disagree, WHICH module draws the artifact is a
 * function of the consumer's condition set, and that is not a declaration. */
function publishesDisplayAtGeneratorKey(pkgDir, exportedSubpaths, entry, resolvedRel) {
  // The generator must be able to resolve the entry FILE at all, by its own
  // candidate list — otherwise generation throws whatever the exports say.
  if (generatorResolvesEntryFile(pkgDir, entry) !== resolvedRel) return null;
  const key = generatorExportsKeyForEntry(entry);
  const selection = exportedSubpaths.get(key);
  if (!selection) return null;
  // POLICY, stated rather than simulated: the display must be reachable under a
  // PORTABLE always-matched condition (`import` or `default`). A branch behind
  // `node` alone would resolve for today's server-only build map and for nobody
  // else, and the same package must draw the artifact for every consumer of
  // that map.
  if (!selection.guaranteed) return null;
  if (selection.targets.length === 0) return null;
  if (!selection.targets.every((t) => resolveExportTargetFile(pkgDir, t) === resolvedRel)) {
    return null;
  }
  return key;
}

// Per-slot renderer checks (cinatra#1621), extracted so the registryItems
// addition (cinatra#1623) keeps `checkArtifactUi` linear. Only runs when
// `renderers` is a valid non-empty slot map.
function checkArtifactUiRenderers(pkgDir, pkg, renderers, rules) {
  const findings = [];
  const file = "package.json";
  // THE PACKAGING RULE (cinatra#3025, item 0.8): read once per package.
  const exportsInfo = readExportsField(pkgDir, pkg.exports);
  if (exportsInfo.kind === "mixed") {
    findings.push({
      rule: "manifest.artifact-ui-exports-invalid",
      file,
      detail:
        `package.json "exports" mixes subpath keys with condition key(s) [${exportsInfo.offending.join(", ")}] — ` +
        `Node REJECTS such a map outright, so nothing it appears to publish resolves. Declare one shape: a subpath ` +
        `map whose keys all start with "." (conditions go INSIDE a subpath's value).`,
    });
  }
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
      // THE PACKAGING RULE (cinatra#3025, item 0.8). Only asked of an entry
      // that RESOLVED — an unresolved entry already carries its own finding and
      // one defect must not raise two.
      if (
        resolved &&
        exportsInfo.kind !== "mixed" &&
        publishesDisplayAtGeneratorKey(pkgDir, exportsInfo.map, renderer.entry, resolved) === null
      ) {
        if (exportsInfo.kind === "absent") {
          findings.push({
            rule: "manifest.artifact-ui-exports-missing",
            file,
            detail:
              `${at} declares a display but the package declares NO "exports" subpath map — an artifact extension ` +
              `publishes its display through its OWN exports, so a consumer imports ` +
              `"${pkg.name}/${generatorExportsKeyForEntry(renderer.entry).slice(2)}" rather than a deep internal path the ` +
              `host has to keep alive with a per-extension alias. Add ` +
              `"exports": { "${generatorExportsKeyForEntry(renderer.entry)}": "${renderer.entry}" }.`,
          });
        } else {
          findings.push({
            rule: "manifest.artifact-ui-entry-not-exported",
            file,
            detail:
              `${at}.entry "${renderer.entry}" is not published at "${generatorExportsKeyForEntry(renderer.entry)}" — ` +
              `the exact key the manifest generator derives from the entry and demands (literal subpaths declared: ` +
              `${[...exportsInfo.map.keys()].join(", ") || "none"}). A PATTERN subpath ("./*", "./renderers/*") does not ` +
              `count, because the specifier it yields is a function of the package's internal path rather than a ` +
              `declaration of this display; the key's target must resolve to this module under a portable ` +
              `always-matched condition ("import" or "default"), and every branch it could select must be this module. ` +
              `Add "exports": { "${generatorExportsKeyForEntry(renderer.entry)}": "${renderer.entry}" }.`,
          });
        }
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

// cinatra.views chat renderable-view declaration (cinatra#1626, epic #1620
// S9/M4): the top-level provider field, FAIL-CLOSED at the publish/conformance
// gate (the host path degrades an unsupported block to RenderableViewFallback on
// the SAME shape). Cross-kind (the carrier kinds are extendable), so this runs
// for every kind. Rules mirror the leaf `chat-views-contract.ts` schema; the
// abiVersion literal is DERIVED (loadLiveRules), never re-listed — the #979
// addendum principle, exactly as checkArtifactUi does.
function checkChatViews(pkgDir, pkg, rules) {
  const findings = [];
  const file = "package.json";
  const views = pkg?.cinatra?.views;
  if (views === undefined) return findings; // views is optional
  if (typeof views !== "object" || views === null || Array.isArray(views)) {
    findings.push({
      rule: "manifest.chat-views-shape",
      file,
      detail: "cinatra.views must be an object ({ abiVersion, entries: [...] }).",
    });
    return findings;
  }
  // Reject extra TOP-LEVEL keys, matching the leaf schema's `.strict()` (so the
  // gate is never LOOSER than the host/publish verdict).
  const extraKeys = Object.keys(views).filter((k) => k !== "abiVersion" && k !== "entries");
  if (extraKeys.length > 0) {
    findings.push({
      rule: "manifest.chat-views-extraneous-key",
      file,
      detail: `cinatra.views may only declare { abiVersion, entries }; unexpected key(s): ${extraKeys.join(", ")}.`,
    });
  }
  if (views.abiVersion !== rules.chatViewsAbiVersion) {
    findings.push({
      rule: "manifest.chat-views-abi-version",
      file,
      detail: `cinatra.views.abiVersion must be exactly ${rules.chatViewsAbiVersion} (got ${JSON.stringify(views.abiVersion)}).`,
    });
  }
  if (!Array.isArray(views.entries) || views.entries.length === 0) {
    findings.push({
      rule: "manifest.chat-views-empty",
      file,
      detail: "cinatra.views.entries must be a NON-EMPTY array of { viewType, entry, propsApiVersion } entries.",
    });
    return findings;
  }
  const seen = new Set();
  for (const [i, entry] of views.entries.entries()) {
    const at = `cinatra.views.entries[${i}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      findings.push({ rule: "manifest.chat-views-entry-shape", file, detail: `${at} must be an object ({ viewType, entry, propsApiVersion }).` });
      continue;
    }
    const extra = Object.keys(entry).filter((k) => !CHAT_VIEW_ENTRY_ALLOWED_KEYS.has(k));
    if (extra.length > 0) {
      findings.push({ rule: "manifest.chat-views-entry-extraneous-key", file, detail: `${at} may only declare { viewType, entry, propsApiVersion }; unexpected key(s): ${extra.join(", ")}.` });
    }
    if (typeof entry.viewType !== "string" || !CHAT_VIEW_TYPE_RE.test(entry.viewType)) {
      findings.push({ rule: "manifest.chat-views-viewtype", file, detail: `${at}.viewType must be strict lowercase snake_case (e.g. "chart", "content_change_proposal").` });
    } else if (seen.has(entry.viewType)) {
      findings.push({ rule: "manifest.chat-views-duplicate-viewtype", file, detail: `${at}.viewType "${entry.viewType}" duplicates an earlier entry — one effective provider per viewType.` });
    } else {
      seen.add(entry.viewType);
    }
    if (typeof entry.entry !== "string" || !isUiEntryContained(entry.entry)) {
      findings.push({ rule: "manifest.chat-views-entry-path", file, detail: `${at}.entry must be a package-relative, path-contained subpath ("./…", no "..", no absolute path or URL).` });
    } else {
      // Verify the renderer module actually SHIPS (resolves to a real file
      // within the published `files` allowlist) — mirrors checkArtifactUiRenderers
      // so the gate is as rigorous for a chat-view entry as for an artifact-ui
      // renderer entry (the generated literal import would otherwise fail).
      const rel = entry.entry.replace(/^\.\//, "");
      const resolved = existsSync(join(pkgDir, rel)) ? rel : candidateFile(pkgDir, rel.replace(/\.[^./]+$/, ""));
      if (!resolved) {
        findings.push({ rule: "manifest.chat-views-entry-unresolved", file, detail: `${at}.entry "${entry.entry}" does not resolve to a file in the package (must resolve via the package's exports/files).` });
      } else if (!isInScope(resolved, pkg.files)) {
        findings.push({ rule: "manifest.chat-views-entry-out-of-scope", file, detail: `${at}.entry "${entry.entry}" resolves outside the published "files" allowlist — it would not ship in the package tarball.` });
      }
    }
    if (!Number.isInteger(entry.propsApiVersion) || entry.propsApiVersion < 1) {
      findings.push({ rule: "manifest.chat-views-props-api-version", file, detail: `${at}.propsApiVersion must be an integer >= 1.` });
    }
  }
  return findings;
}

// cinatra.llmProvider LLM-provider declaration (cinatra#1712, epic #1711 S1
// AC1): the top-level provider field an LLM connector (openai/anthropic/gemini)
// ships to declare its OWN capability matrix + model catalog. FAIL-CLOSED at the
// publish/conformance gate (the host path degrades an unsupported block to
// core's build-known catalog on the SAME shape). OPTIONAL: no connector declares
// it yet (the cross-repo connector-block wave is AC6, a later slice), so an
// ABSENT block yields ZERO findings; a PRESENT block must validate against the
// leaf. Rules mirror the leaf `llm-provider-contract.ts` schema (the EXACT
// public mirror of the host `llm-provider-policy.ts` declaration model); every
// DATA literal (abiVersion + the four vocabularies) is DERIVED (loadLiveRules),
// never re-listed — the #979 addendum principle, exactly as checkArtifactUi /
// checkChatViews do. Run cross-kind (returns [] when absent) so it is never
// LOOSER than the leaf/host verdict.
function checkLlmProvider(pkg, rules) {
  const findings = [];
  const file = "package.json";
  const decl = pkg?.cinatra?.llmProvider;
  if (decl === undefined) return findings; // llmProvider is optional
  if (typeof decl !== "object" || decl === null || Array.isArray(decl)) {
    findings.push({
      rule: "manifest.llm-provider-shape",
      file,
      detail:
        "cinatra.llmProvider must be an object ({ abiVersion, provider, capabilities, models, defaultCapable, wizardEligible }).",
    });
    return findings;
  }
  // Reject extra TOP-LEVEL keys, matching the leaf schema's `.strict()` (so the
  // gate is never LOOSER than the host/publish verdict).
  const extraKeys = Object.keys(decl).filter((k) => !LLM_PROVIDER_ALLOWED_KEYS.has(k));
  if (extraKeys.length > 0) {
    findings.push({
      rule: "manifest.llm-provider-extraneous-key",
      file,
      detail: `cinatra.llmProvider may only declare { ${[...LLM_PROVIDER_ALLOWED_KEYS].join(", ")} }; unexpected key(s): ${extraKeys.join(", ")}.`,
    });
  }
  if (decl.abiVersion !== rules.llmProviderAbiVersion) {
    findings.push({
      rule: "manifest.llm-provider-abi-version",
      file,
      detail: `cinatra.llmProvider.abiVersion must be exactly ${rules.llmProviderAbiVersion} (got ${JSON.stringify(decl.abiVersion)}).`,
    });
  }
  // --- ABI v2 flags (cinatra#2093, epic #2086 S6) -------------------------
  // REQUIRED booleans, plus the cross-field subset rule: the setup wizard's
  // only act is committing the stored default, so offering a provider that
  // could never BE the default is incoherent and is rejected here rather than
  // discovered at setup time. FAIL-CLOSED at publish: a connector RELEASE must
  // carry v2 (the host's transitional v1 acceptance is host-side only and is
  // gated by an allowlist that this gate deliberately does not honour).
  for (const flag of ["defaultCapable", "wizardEligible"]) {
    if (typeof decl[flag] !== "boolean") {
      findings.push({
        rule: "manifest.llm-provider-flag-type",
        file,
        detail: `cinatra.llmProvider.${flag} must be a boolean (got ${JSON.stringify(decl[flag])}).`,
      });
    }
  }
  if (decl.wizardEligible === true && decl.defaultCapable !== true) {
    findings.push({
      rule: "manifest.llm-provider-wizard-subset",
      file,
      detail:
        "cinatra.llmProvider.wizardEligible requires defaultCapable: wizard eligibility is a strict subset of default capability (the wizard's only act is committing the stored default).",
    });
  }
  if (typeof decl.provider !== "string" || !rules.llmProviders.has(decl.provider)) {
    findings.push({
      rule: "manifest.llm-provider-provider",
      file,
      detail: `cinatra.llmProvider.provider must be one of ${[...rules.llmProviders].join(", ")} (got ${JSON.stringify(decl.provider)}).`,
    });
  }

  // capabilities — the closed { function_tools, media_input, native_mcp } shape.
  const caps = decl.capabilities;
  if (typeof caps !== "object" || caps === null || Array.isArray(caps)) {
    findings.push({
      rule: "manifest.llm-provider-capabilities-shape",
      file,
      detail: `cinatra.llmProvider.capabilities must be an object declaring { ${rules.llmCapabilities.join(", ")} }.`,
    });
  } else {
    const capKeys = new Set(Object.keys(caps));
    // Required-and-only: exactly the derived capability vocabulary keys (missing
    // OR extra both fail — the leaf's `.strict()` object with three required
    // fields).
    const missingCaps = rules.llmCapabilities.filter((k) => !capKeys.has(k));
    const extraCaps = [...capKeys].filter((k) => !rules.llmCapabilities.includes(k));
    if (missingCaps.length > 0) {
      findings.push({
        rule: "manifest.llm-provider-capabilities-missing",
        file,
        detail: `cinatra.llmProvider.capabilities is missing required key(s): ${missingCaps.join(", ")}.`,
      });
    }
    if (extraCaps.length > 0) {
      findings.push({
        rule: "manifest.llm-provider-capabilities-extraneous-key",
        file,
        detail: `cinatra.llmProvider.capabilities may only declare { ${rules.llmCapabilities.join(", ")} }; unexpected key(s): ${extraCaps.join(", ")}.`,
      });
    }
    // Every capability EXCEPT the structured `native_mcp` is a plain boolean
    // flag. The boolean-flag key set is DERIVED (llmCapabilities minus the one
    // structured capability), never re-listed — so a future vocabulary addition
    // automatically gets boolean type-validation (the #979 addendum principle;
    // the native_mcp special-case is a SHAPE distinction inherent to the leaf's
    // `LlmProviderCapabilitiesSchema`, not a re-listed data literal).
    const booleanCapKeys = rules.llmCapabilities.filter((k) => k !== "native_mcp");
    for (const flag of booleanCapKeys) {
      if (flag in caps && typeof caps[flag] !== "boolean") {
        findings.push({
          rule: "manifest.llm-provider-capability-flag",
          file,
          detail: `cinatra.llmProvider.capabilities.${flag} must be a boolean (got ${JSON.stringify(caps[flag])}).`,
        });
      }
    }
    // native_mcp — { status (required), transports? (nonempty string[]),
    // approval? } with derived status/approval vocabularies.
    const nm = caps.native_mcp;
    if ("native_mcp" in caps) {
      if (typeof nm !== "object" || nm === null || Array.isArray(nm)) {
        findings.push({
          rule: "manifest.llm-provider-native-mcp-shape",
          file,
          detail: "cinatra.llmProvider.capabilities.native_mcp must be an object ({ status, transports?, approval? }).",
        });
      } else {
        const nmExtra = Object.keys(nm).filter((k) => !LLM_PROVIDER_NATIVE_MCP_ALLOWED_KEYS.has(k));
        if (nmExtra.length > 0) {
          findings.push({
            rule: "manifest.llm-provider-native-mcp-extraneous-key",
            file,
            detail: `cinatra.llmProvider.capabilities.native_mcp may only declare { status, transports, approval }; unexpected key(s): ${nmExtra.join(", ")}.`,
          });
        }
        if (typeof nm.status !== "string" || !rules.nativeMcpStatuses.has(nm.status)) {
          findings.push({
            rule: "manifest.llm-provider-native-mcp-status",
            file,
            detail: `cinatra.llmProvider.capabilities.native_mcp.status must be one of ${[...rules.nativeMcpStatuses].join(", ")} (got ${JSON.stringify(nm.status)}).`,
          });
        }
        if ("transports" in nm) {
          const ts = nm.transports;
          if (!Array.isArray(ts) || ts.length === 0 || !ts.every((t) => typeof t === "string" && t.length > 0)) {
            findings.push({
              rule: "manifest.llm-provider-native-mcp-transports",
              file,
              detail: "cinatra.llmProvider.capabilities.native_mcp.transports, when present, must be a NON-EMPTY array of non-empty strings.",
            });
          }
        }
        if ("approval" in nm && (typeof nm.approval !== "string" || !rules.mcpApprovalModes.has(nm.approval))) {
          findings.push({
            rule: "manifest.llm-provider-native-mcp-approval",
            file,
            detail: `cinatra.llmProvider.capabilities.native_mcp.approval, when present, must be one of ${[...rules.mcpApprovalModes].join(", ")} (got ${JSON.stringify(nm.approval)}).`,
          });
        }
      }
    }
  }

  // models — the closed { default, allowed[] } catalog with the
  // default ∈ allowed cross-field rule.
  const models = decl.models;
  if (typeof models !== "object" || models === null || Array.isArray(models)) {
    findings.push({
      rule: "manifest.llm-provider-models-shape",
      file,
      detail: "cinatra.llmProvider.models must be an object ({ default, allowed: [...] }).",
    });
  } else {
    const modelExtra = Object.keys(models).filter((k) => !LLM_PROVIDER_MODELS_ALLOWED_KEYS.has(k));
    if (modelExtra.length > 0) {
      findings.push({
        rule: "manifest.llm-provider-models-extraneous-key",
        file,
        detail: `cinatra.llmProvider.models may only declare { default, allowed }; unexpected key(s): ${modelExtra.join(", ")}.`,
      });
    }
    const allowed = models.allowed;
    const allowedOk = Array.isArray(allowed) && allowed.length > 0 && allowed.every((m) => typeof m === "string" && m.length > 0);
    if (!allowedOk) {
      findings.push({
        rule: "manifest.llm-provider-models-allowed",
        file,
        detail: "cinatra.llmProvider.models.allowed must be a NON-EMPTY array of non-empty model-id strings.",
      });
    }
    if (typeof models.default !== "string" || models.default.length === 0) {
      findings.push({
        rule: "manifest.llm-provider-models-default",
        file,
        detail: "cinatra.llmProvider.models.default must be a non-empty model-id string.",
      });
    } else if (allowedOk && !allowed.includes(models.default)) {
      // The leaf's `.refine()` cross-field rule — a default the connector does
      // not declare as routable would fall back to a model it never listed.
      findings.push({
        rule: "manifest.llm-provider-models-default-not-allowed",
        file,
        detail: `cinatra.llmProvider.models.default must be a member of models.allowed (default ${JSON.stringify(models.default)} is not in the allowlist).`,
      });
    }
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

// npm's AUTHORITATIVE "what actually ships" list for a package dir, memoized per
// run (cinatra#2469, codex round-8). `npm pack --dry-run` is the only thing that
// resolves the FULL rule stack — `files`, root and NESTED `.npmignore`, npm's
// built-in ignores, glob semantics, symlink handling — none of which the
// `isInScope` heuristic models. Two checks consume it now (`checkPacklist` and
// `checkDeclaredLogo`), and `npm pack` is the slowest thing this gate does, so
// the result is computed once.
//
// Returns `{ files: string[] }` on success or `{ files: null, error }` — never
// throws. A failure is reported ONCE, by `checkPacklist`
// (`packlist.pack-dry-run-failed`), so consumers degrade without double-flagging
// the same infra problem.
const _packlistCache = new Map();
function resolvePacklist(pkgDir) {
  if (_packlistCache.has(pkgDir)) return _packlistCache.get(pkgDir);
  let result;
  try {
    // --ignore-scripts: never execute lifecycle scripts from a package this
    // checker is merely INSPECTING (see checkPacklist's note).
    const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: pkgDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const report = JSON.parse(out);
    result = { files: (report[0]?.files ?? []).map((f) => f.path), error: null };
  } catch (err) {
    result = { files: null, error: err instanceof Error ? err.message : String(err) };
  }
  _packlistCache.set(pkgDir, result);
  return result;
}

function checkPacklist(pkgDir, pkg) {
  const findings = [];
  // Shared, memoized (`resolvePacklist`) — the SAME list `checkDeclaredLogo`
  // proves the declared logo against, so the two can never disagree about what
  // ships. This is the sole reporter of a dry-run failure.
  const { files, error } = resolvePacklist(pkgDir);
  if (files === null) {
    findings.push({
      rule: "packlist.pack-dry-run-failed",
      file: "package.json",
      detail: `\`npm pack --dry-run\` failed: ${error}`,
    });
    return findings;
  }
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
