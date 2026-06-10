#!/usr/bin/env node
/**
 * Bypass-prevention static gate for the marketplace-gatekept install path.
 *
 * The gatekept-install contract routes EVERY install/detail registry read
 * through sanctioned seams:
 *
 *   - the gatekept resolver  src/lib/gatekept-install.ts
 *     (`resolveGatekeptInstallConfig` → broker-pointed VerdaccioConfig + grant)
 *   - the host config loaders src/lib/verdaccio-config.ts
 *     (`loadVerdaccioConfigForServer` / `loadVerdaccioConfigForReads`)
 *   - the registries config loaders packages/registries/src/verdaccio/config.ts
 *     (`loadVerdaccioConfig` / `loadVerdaccioConfigAsync`)
 *   - the registries pacote wrapper packages/registries/src/verdaccio/client.ts
 *     (`pacoteOptions(config, …)` — the single place a `{ registry, token }`
 *     pacote options object is built, FROM a threaded `VerdaccioConfig`)
 *   - the deployment-registry config loader src/lib/deployment-registry-config.ts
 *
 * The instance must NEVER construct a registry URL or a registry auth token
 * DIRECTLY on the install/detail code path — that would bypass the broker
 * read-proxy (and, when `CINATRA_GATEKEPT_INSTALL` is ON, the per-install
 * grant). This gate scans the install/detail modules and FAILS if any of them
 * (outside the allowlisted seams) does one of:
 *
 *   1. Hardcodes the literal production registry host `registry.cinatra.ai`.
 *   2. Builds a raw pacote options object literal with BOTH a `registry:` and a
 *      `token:` key (the `pacote.extract`/`packument`/`tarball` options shape)
 *      outside the allowlisted `pacoteOptions` helper.
 *   3. Builds an npm auth-token CLI flag literal (`…:_authToken=<interpolated>`)
 *      — the direct registry-credential injection shape.
 *   4. Reads `loadDeploymentRegistryConfig().publicReadToken` (the deployment-
 *      wide public-read token) on the install path outside the allowlisted
 *      seams — the legacy direct-read credential the gatekept path replaces.
 *
 * **Allowlist (sanctioned seams).** The files in ALLOWLIST below are the ONLY
 * files where direct registry URL/token construction is permitted whole-file,
 * because they ARE a sanctioned seam end-to-end (config loaders, the gatekept
 * resolver, the pacote wrapper, the deployment-registry loader) or are
 * non-shipping (fixtures, tests). A WHOLE-FILE allowlist of a MIXED handler
 * file (one that also carries unrelated install/detail logic) is forbidden — it
 * would let a future bypass land alongside the one sanctioned line and pass
 * silently. The legacy install-path read seam `destination-resolver.ts` stays
 * whole-file allowlisted because the entire module IS the flag-OFF read seam
 * (it exists only to build the `_authToken=` install flags the gatekept resolver
 * supersedes). `mcp/handlers.ts` is NO LONGER whole-file allowlisted (it mixes
 * the search/browse config with install/detail dispatch); its single sanctioned
 * browse-path construction is covered by a LINE-SCOPED exception instead (see
 * `ALLOW_DIRECTIVE`). New install/detail code must NOT add such constructions —
 * it must thread a `VerdaccioConfig` from a loader (or, when gatekept, from
 * `resolveGatekeptInstallConfig`).
 *
 * **Line-scoped exceptions.** A single sanctioned construction inside an
 * otherwise-scanned (NON-allowlisted) file is exempted with an inline directive
 * comment `gatekept-install-allow-direct-registry: <reason>` on the SAME line or
 * the line IMMEDIATELY above the construction. This keeps the bypass surface
 * minimal — every new direct construction in the file is still flagged unless it
 * is individually, visibly justified — instead of blessing the whole file.
 *
 * **Fail-closed.** A target file the scanner cannot read is a LOUD failure
 * (not a silent skip) — the gate refuses to certify a path it could not
 * inspect.
 *
 * Usage:
 *   node scripts/audit/gatekept-install-no-direct-registry.mjs
 *
 * Exit codes:
 *   0  no direct-registry construction in any non-allowlisted install/detail
 *      module
 *   1  one or more direct-registry constructions found in a non-allowlisted
 *      install/detail module
 *   2  the scanner could not classify a target (read error) — fail-closed
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(/\/+$/, "");

/**
 * The install/detail surface this gate inspects. Each entry is a repo-relative
 * POSIX path — either a directory (scanned recursively) or a single file. These
 * are the modules where a bypass would matter (they construct or consume the
 * registry read path). Scoping the scan keeps the gate precise: it does not
 * flag legitimate registry-URL literals elsewhere in the repo (docs, ops
 * scripts, the publish path).
 */
export const TARGET_PATHS = Object.freeze([
  "packages/extensions/src",
  "packages/agents/src/extension-handler.ts",
  // The agent-detail reader (RegistryEntryDetailSections + resolveDetailReadConfig)
  // and the registry install/update/uninstall server actions — the REAL
  // transitive install/detail consumers. RegistryEntryDetailSections renders the
  // marketplace detail body (delegated from the [scope]/[name] route), so a
  // direct loadVerdaccioConfigForReads()/getAgentPackage() here would defeat the
  // broker read-proxy on the detail path; actions.ts drives install/update.
  "packages/agents/src/screens.tsx",
  "packages/agents/src/actions.ts",
  "src/lib/extension-install-pipeline.ts",
  "packages/registries/src",
  "src/app/configuration/marketplace/[scope]/[name]/page.tsx",
]);

/**
 * Sanctioned seams — the ONLY files where direct registry URL/token
 * construction is allowed. Every entry is a repo-relative POSIX path.
 *
 * Categories (documented inline so the allowlist stays auditable):
 *   - The gatekept resolver: the single seam that mints a broker-pointed
 *     config + opaque grant.
 *   - The verdaccio config loaders (host + registries package): turn an
 *     identity row / env into a `VerdaccioConfig`. They are ALLOWED to hold
 *     the production registry-URL default + read tokens.
 *   - The registries pacote wrapper (`client.ts`): the single place a
 *     `{ registry, token }` pacote options object is built, always FROM a
 *     threaded `VerdaccioConfig`.
 *   - The deployment-registry config loader + its fixture: the deployment-wide
 *     registry config source.
 *   - Legacy install-path read seam (`destination-resolver.ts`): the entire
 *     module IS the current-state flag-OFF read seam the gatekept resolver
 *     supersedes when `CINATRA_GATEKEPT_INSTALL` is ON — it exists only to build
 *     the `_authToken=` install flags / read `publicReadToken` by design.
 *   - Tests + fixtures: non-shipping; they plant registry literals on purpose.
 *
 * `mcp/handlers.ts` is intentionally NOT here — it is a mixed handler file
 * (search/browse + install/detail dispatch) so its single sanctioned browse-path
 * construction uses a LINE-SCOPED `gatekept-install-allow-direct-registry`
 * directive instead of a whole-file pass.
 */
export const ALLOWLIST = Object.freeze([
  // The gatekept resolver — the sanctioned broker-pointed config + grant seam.
  "src/lib/gatekept-install.ts",
  // Host-app verdaccio config loaders (compose identity → VerdaccioConfig).
  "src/lib/verdaccio-config.ts",
  // Deployment-registry config loader + fixture (deployment-wide config source).
  "src/lib/deployment-registry-config.ts",
  "src/lib/__fixtures__/deployment-registry-config.fixture.ts",
  // Registries package config loaders (env / identity → VerdaccioConfig;
  // holds the PROD_DEFAULT_REGISTRY_URL default).
  "packages/registries/src/verdaccio/config.ts",
  // The single pacote options wrapper — builds { registry, token } from a
  // threaded VerdaccioConfig (the sanctioned pacote seam).
  "packages/registries/src/verdaccio/client.ts",
  // The registries dependency-tree install seam. Its defaultFetchPackument
  // builds pacote options from a THREADED VerdaccioConfig (the caller resolves
  // the config — host loader today, broker-pointed resolveGatekeptInstallConfig
  // when the flag is ON), so it does not bypass the seam.
  "packages/registries/src/install/install-with-deps.ts",
  // Deployment-registry fixture lives under the extensions package.
  "packages/extensions/src/__fixtures__/deployment-registry-config.fixture.ts",
  // Legacy install-path read seam (current-state, flag-OFF). The whole module
  // exists to build the _authToken= flags / read publicReadToken the gatekept
  // resolver supersedes when the master flag is ON — so it is a sanctioned seam
  // end-to-end, not a mixed file.
  "packages/extensions/src/destination-resolver.ts",
  // NOTE: packages/extensions/src/mcp/handlers.ts is deliberately NOT
  // allowlisted — it is a mixed handler file. Its one sanctioned browse-path
  // construction carries an inline `gatekept-install-allow-direct-registry`
  // line-scoped exception instead (see ALLOW_DIRECTIVE).
]);

/**
 * Directory names pruned anywhere in the walk (build artifacts, caches).
 * `__tests__` and `__fixtures__` are pruned because tests + fixtures are
 * non-shipping and intentionally plant registry literals.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  "coverage",
  "__tests__",
  "__fixtures__",
]);

/** Only source/config text files are scanned. */
const SCANNED_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

/** Test files are non-shipping — skipped even outside __tests__ dirs. */
function isTestFile(repoRelative) {
  return /\.test\.[mc]?[jt]sx?$/.test(repoRelative) || /\.spec\.[mc]?[jt]sx?$/.test(repoRelative);
}

// ---------------------------------------------------------------------------
// Banned construction shapes. Each is a distinct DIRECT-registry construction.
// Kept narrow + line-oriented so the violation message can name the line.
// ---------------------------------------------------------------------------

/**
 * 1. Hardcoded production registry host. The sanctioned default lives in the
 *    config loaders (allowlisted); any other module embedding it is bypassing
 *    the config seam. Matches the bare host so it catches both
 *    `https://registry.cinatra.ai` and a quoted host literal.
 */
const PROD_REGISTRY_HOST = /registry\.cinatra\.ai/;

/**
 * 2. Raw pacote options object literal. The sanctioned `pacoteOptions(config)`
 *    wrapper is the only place a `{ registry, token }` object is built. We flag
 *    a line that assigns `registry:` to something AND a sibling `token:` key in
 *    the same module — the pacote-options fingerprint. To stay line-oriented
 *    and low-false-positive we flag the `registry:` key when it is paired with
 *    a `token:` key on the same or an adjacent line (handled in the scanner).
 */
const PACOTE_REGISTRY_KEY = /\bregistry\s*:/;
const PACOTE_TOKEN_KEY = /\btoken\s*:/;

/**
 * 3. npm auth-token CLI flag literal with interpolation — the direct
 *    registry-credential injection shape (`…:_authToken=${…}`). This is exactly
 *    what `destination-resolver.ts` (allowlisted) builds; ANY other module
 *    doing it is bypassing the resolver.
 */
const AUTHTOKEN_FLAG = /:_authToken=\$\{/;

/**
 * 4. Deployment public-read token use on the install path. The gatekept
 *    resolver replaces this legacy direct-read credential; reading
 *    `.publicReadToken` (or `.publicPublishToken`) outside the allowlisted
 *    seams is a bypass.
 */
const PUBLIC_REGISTRY_TOKEN = /\.public(?:Read|Publish)Token\b/;

/**
 * Inline line-scoped exception directive. A single sanctioned direct-registry
 * construction inside an otherwise-scanned (non-allowlisted) file is exempted by
 * placing `gatekept-install-allow-direct-registry: <reason>` in a comment on the
 * SAME line OR the line IMMEDIATELY above the construction. This keeps the
 * bypass surface minimal — every OTHER direct construction in the same file is
 * still flagged — instead of blessing the entire mixed file via the allowlist.
 *
 * A reason after the colon is required (the directive must be self-documenting);
 * a bare directive with no reason does NOT suppress.
 */
const ALLOW_DIRECTIVE = /gatekept-install-allow-direct-registry:\s*\S/;

/**
 * Strip comment content from each line so the prose-prone rules
 * (`hardcoded-registry-host`, `public-read-token-use`) do NOT trip on doc
 * comments — e.g. a JSDoc line that merely NAMES `deployConfig.publicPublishToken`
 * while explaining the publish path. Returns a parallel array of "code-only"
 * lines (comment spans replaced with spaces so column-agnostic regex tests on
 * the remaining code still work).
 *
 * Handles `// line comments`, `/* block comments *​/` (incl. multi-line), and
 * JSDoc continuation lines (a `*`-prefixed line inside a block comment).
 *
 * `//` inside a string is NOT comment-stripped (the heuristic only treats `//`
 * as a comment when it is not preceded by a `:` — so URL/authToken literals like
 * `//host/:_authToken=` survive). The structural rules run against the RAW line,
 * not this stripped output, so that heuristic only ever relaxes the prose rules.
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
function stripComments(lines) {
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    let code = "";
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf("*/", i);
        if (end === -1) {
          i = line.length; // whole rest of line is comment
        } else {
          i = end + 2;
          inBlock = false;
        }
        continue;
      }
      const two = line.slice(i, i + 2);
      if (two === "/*") {
        inBlock = true;
        i += 2;
        continue;
      }
      if (two === "//") {
        // Treat as a line comment UNLESS it looks like the host portion of a
        // URL / npm authToken flag (`…://host`, `//host/:_authToken=`), which
        // is preceded by `:` or `=`. In that case it is code, not a comment.
        const prev = code.length > 0 ? code[code.length - 1] : "";
        if (prev !== ":" && prev !== "=") {
          break; // rest of line is a comment
        }
      }
      code += line[i];
      i += 1;
    }
    out.push(code);
  }
  return out;
}

/**
 * Scan one file's text for direct-registry construction. Returns an array of
 * `{ line, kind, text }` hits.
 *
 * @param {string} text
 * @returns {Array<{line:number, kind:string, text:string}>}
 */
function scanText(text) {
  const lines = text.split(/\r?\n/);
  const code = stripComments(lines);
  const hits = [];
  // A construction is suppressed when the inline allow-directive appears on the
  // SAME line or the line immediately above it. Checked against the RAW lines
  // (the directive lives in a comment, which stripComments would remove).
  const isSuppressed = (idx) =>
    ALLOW_DIRECTIVE.test(lines[idx] ?? "") ||
    ALLOW_DIRECTIVE.test(lines[idx - 1] ?? "");
  const push = (idx, kind) => {
    if (isSuppressed(idx)) return;
    hits.push({ line: idx + 1, kind, text: lines[idx].trim().slice(0, 200) });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const codeLine = code[i];

    // Prose-prone rules run against comment-stripped code so doc comments that
    // merely NAME these tokens don't trip the gate.
    if (PROD_REGISTRY_HOST.test(codeLine)) push(i, "hardcoded-registry-host");
    if (PUBLIC_REGISTRY_TOKEN.test(codeLine)) push(i, "public-read-token-use");

    // Structural rules run against the raw line — they match an interpolation /
    // object-literal shape that does not occur in prose.
    if (AUTHTOKEN_FLAG.test(raw)) push(i, "raw-authtoken-flag");

    // Raw pacote options fingerprint: a `registry:` key paired with a `token:`
    // key on the same OR an adjacent line (a 3-line window covers the common
    // multi-line object-literal layout). Pairing keeps it from flagging a
    // lone `registry:` property used for unrelated config.
    if (PACOTE_REGISTRY_KEY.test(codeLine)) {
      const win = [code[i - 1] ?? "", codeLine, code[i + 1] ?? ""].join("\n");
      if (PACOTE_TOKEN_KEY.test(win)) push(i, "raw-pacote-options");
    }
  }
  return hits;
}

/**
 * Walk a directory recursively, yielding scannable source files.
 *
 * @param {string} absDir
 * @returns {Generator<string>}
 */
function* walkDir(absDir) {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkDir(full);
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf(".");
      const ext = dot >= 0 ? entry.name.slice(dot) : "";
      if (!SCANNED_EXTS.has(ext)) continue;
      yield full;
    }
  }
}

/**
 * Expand the TARGET_PATHS list into concrete absolute file paths to scan.
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
function collectTargetFiles(repoRoot) {
  const files = [];
  for (const target of TARGET_PATHS) {
    const abs = join(repoRoot, target);
    let st;
    try {
      st = statSync(abs);
    } catch {
      // A configured target that does not exist is itself a fail-closed
      // condition — the gate is meant to track these exact modules.
      throw new Error(
        `target path not found: ${target} — the gatekept-install gate's ` +
          "TARGET_PATHS list is stale; update it to match the install/detail surface.",
      );
    }
    if (st.isDirectory()) {
      for (const f of walkDir(abs)) files.push(f);
    } else {
      files.push(abs);
    }
  }
  return files;
}

/**
 * Main scan.
 *
 * @param {string} repoRoot
 * @returns {{
 *   ok: boolean,
 *   violations: Array<{path:string, hits:Array<{line:number, kind:string, text:string}>}>,
 *   unreadable: string[],
 *   scannedFileCount: number,
 * }}
 */
export function scan(repoRoot = REPO_ROOT) {
  const allowlist = new Set(ALLOWLIST);
  const violations = [];
  const unreadable = [];
  let scannedFileCount = 0;

  const targetFiles = collectTargetFiles(repoRoot);

  for (const absPath of targetFiles) {
    const repoRelative = relative(repoRoot, absPath).split(sep).join("/");
    if (isTestFile(repoRelative)) continue;
    if (allowlist.has(repoRelative)) continue;

    let text;
    try {
      text = readFileSync(absPath, "utf8");
    } catch {
      // Fail-closed: a target we cannot read is a loud failure, never a skip.
      unreadable.push(repoRelative);
      continue;
    }
    scannedFileCount += 1;

    const hits = scanText(text);
    if (hits.length > 0) {
      violations.push({ path: repoRelative, hits });
    }
  }

  return {
    ok: violations.length === 0 && unreadable.length === 0,
    violations,
    unreadable,
    scannedFileCount,
  };
}

// ---------------------------------------------------------------------------
// CLI entry — only when run directly.
// ---------------------------------------------------------------------------
const isMain =
  typeof process.argv[1] === "string" &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  let result;
  try {
    result = scan();
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  if (result.unreadable.length > 0) {
    console.error(
      "ERROR: the gatekept-install gate could not read one or more target files " +
        "(fail-closed — refusing to certify an uninspected install path):",
    );
    for (const p of result.unreadable) console.error(`  ${p}`);
    process.exit(2);
  }

  if (result.ok) {
    console.log(
      `ok: no direct-registry URL/token construction in ${result.scannedFileCount} ` +
        "non-allowlisted install/detail module(s).",
    );
    process.exit(0);
  }

  console.error(
    "ERROR: direct-registry URL/token construction found on the install/detail path.",
  );
  console.error("");
  console.error(
    "Install/detail code must route registry reads through the sanctioned seams:",
  );
  console.error(
    "  - gatekept install: resolveGatekeptInstallConfig() (src/lib/gatekept-install.ts)",
  );
  console.error(
    "  - config loaders:   loadVerdaccioConfigForServer/ForReads, loadVerdaccioConfig(Async)",
  );
  console.error(
    "  - pacote options:   pacoteOptions(config) in packages/registries/src/verdaccio/client.ts",
  );
  console.error(
    "Do NOT hardcode registry.cinatra.ai, build a raw { registry, token } pacote",
  );
  console.error(
    "options object, interpolate an :_authToken= flag, or read publicReadToken directly.",
  );
  console.error(
    "If a file is a genuine new sanctioned seam, add it to ALLOWLIST in",
  );
  console.error(
    "scripts/audit/gatekept-install-no-direct-registry.mjs (and document why).",
  );
  console.error("");
  for (const { path, hits } of result.violations) {
    console.error(`  ${path}`);
    for (const hit of hits) {
      console.error(`    L${hit.line} [${hit.kind}]: ${hit.text}`);
    }
  }
  process.exit(1);
}
