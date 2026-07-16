// Shared rule-derivation for the #979 extension-side conformance checker.
//
// DESIGN PRINCIPLE (cinatra#979 checker-rules addendum, captured codex
// convergence): the checker must DERIVE its rules from the LIVE kind-gates /
// host constants, never from a hand-copied prose list. The #978 fleet audit's
// prose checklist contradicted the live artifact gate on the `sdkAbiRange`
// question and only a mass-fix judge caught it — this module exists so that
// mistake structurally can't repeat.
//
// Every function below reads the CURRENT source text of the SDK file that
// owns a given rule and extracts the rule from it (a regex over an `export
// const X = [...]`/`= new Set([...])` literal), rather than re-declaring the
// list as a second, independently-maintained literal in this file. When the
// SDK file changes the list, the checker picks it up on the next run with NO
// checker-side edit required. This mirrors the existing static-source-read
// idiom already used elsewhere in this script family (e.g.
// `generate-extension-manifest.mjs` reading `tsconfig.json` text directly).
//
// Deliberately dependency-free (no TypeScript compilation): these are plain
// regexes over `.ts` source text. Both enforcement points run this file with
// nothing but a bare `node` — the per-repo reusable workflow (cinatra#979
// enforcement point 2) has NO `tsx`/TypeScript toolchain guaranteed, only a
// pinned-SHA checkout of this script family plus the handful of SDK files
// that own the constants it reads.

import { readFileSync, existsSync } from "node:fs";

/**
 * Extract a `export const NAME = [ "a", "b", ... ] as const;`-shaped string
 * array literal from TS source text. Tolerant of trailing commas, single or
 * double quotes, and an optional `as const`.
 */
export function extractStringArrayConst(sourceText, constName) {
  const re = new RegExp(
    `export const ${constName}\\s*(?::[^=]+)?=\\s*\\[([\\s\\S]*?)\\]`,
    "m",
  );
  const m = sourceText.match(re);
  if (!m) return null;
  const body = m[1];
  const items = [...body.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
  return items;
}

/**
 * Extract a `export const NAME: ReadonlySet<string> = new Set([ ... ]);` (or
 * plain `new Set([...])`) string-set literal from TS source text.
 */
export function extractStringSetConst(sourceText, constName) {
  const re = new RegExp(
    `export const ${constName}[^=]*=\\s*new Set\\(\\s*\\[([\\s\\S]*?)\\]\\s*\\)`,
    "m",
  );
  const m = sourceText.match(re);
  if (!m) return null;
  const body = m[1];
  const items = [...body.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
  return new Set(items);
}

/** Extract a bare numeric `export const NAME = <int>;` literal. */
export function extractNumberConst(sourceText, constName) {
  const re = new RegExp(`export const ${constName}\\s*=\\s*(\\d+)`, "m");
  const m = sourceText.match(re);
  return m ? Number(m[1]) : null;
}

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/**
 * Load every rule this checker derives from live SDK source, given the
 * absolute path to the checked-out cinatra repo root that owns
 * `packages/sdk-extensions` (the current repo in core-CI mode; a pinned-SHA
 * sparse checkout in per-repo reusable-workflow mode — cinatra#979
 * enforcement point 2).
 *
 * Every field is nullable: a missing/renamed source file is an INFRA failure
 * (surfaced by the caller as exit code 2), never a silent skip.
 */
export function loadLiveRules(sdkRepoRoot) {
  const hostContextPath = `${sdkRepoRoot}/packages/sdk-extensions/src/host-context.ts`;
  const artifactContractPath = `${sdkRepoRoot}/packages/sdk-extensions/src/artifact-contract.ts`;
  const accessConfigPath = `${sdkRepoRoot}/packages/sdk-extensions/src/access-config.ts`;
  const sdkExtensionsPkgPath = `${sdkRepoRoot}/packages/sdk-extensions/package.json`;
  const sdkUiPkgPath = `${sdkRepoRoot}/packages/sdk-ui/package.json`;

  const hostContextSrc = readIfExists(hostContextPath);
  const artifactContractSrc = readIfExists(artifactContractPath);
  const accessConfigSrc = readIfExists(accessConfigPath);
  const sdkExtensionsPkgRaw = readIfExists(sdkExtensionsPkgPath);
  const sdkUiPkgRaw = readIfExists(sdkUiPkgPath);

  const missing = [];
  if (!hostContextSrc) missing.push(hostContextPath);
  if (!artifactContractSrc) missing.push(artifactContractPath);
  if (!accessConfigSrc) missing.push(accessConfigPath);
  if (!sdkExtensionsPkgRaw) missing.push(sdkExtensionsPkgPath);
  if (!sdkUiPkgRaw) missing.push(sdkUiPkgPath);
  if (missing.length > 0) {
    return { ok: false, missing };
  }

  const sdkExtensionsPkg = JSON.parse(sdkExtensionsPkgRaw);
  const sdkUiPkg = JSON.parse(sdkUiPkgRaw);

  const hostPortNames = extractStringArrayConst(hostContextSrc, "HOST_PORT_NAMES");
  const artifactAllowedCinatraKeys = extractStringSetConst(
    artifactContractSrc,
    "ARTIFACT_ALLOWED_CINATRA_KEYS",
  );
  const connectorAccessConfigFormatVersion = extractNumberConst(
    accessConfigSrc,
    "CONNECTOR_ACCESS_CONFIG_FORMAT_VERSION",
  );
  // artifact-ui (cinatra#1621): DERIVED from live source — the slot enum + the
  // `ui` ABI version from the leaf's artifact-contract.ts, and the canonical SDK
  // ABI from `packages/sdk-extensions/package.json`'s `cinatra.sdkAbiVersion`.
  // We read the canonical ABI from the package.json (already in this checker's
  // minimal sparse checkout) rather than register.ts (which is NOT) so a
  // per-repo reusable-workflow run never hits a missing-file infra failure. The
  // `sdk-abi-readme-gate` pins package.json `cinatra.sdkAbiVersion` byte-equal to
  // register.ts's `SDK_EXTENSIONS_ABI_VERSION` (the value the leaf's
  // `generateArtifactUiSdkAbiRange` uses at runtime), so this derived pin always
  // matches the leaf. Never a re-listed literal (#979 addendum principle).
  const artifactUiSlots = extractStringArrayConst(artifactContractSrc, "ARTIFACT_UI_SLOTS");
  const artifactUiReservedSlots = extractStringArrayConst(
    artifactContractSrc,
    "ARTIFACT_UI_RESERVED_SLOTS",
  );
  const artifactUiAbiVersion = extractNumberConst(artifactContractSrc, "ARTIFACT_UI_ABI_VERSION");
  // artifact-ui registryItems (cinatra#1623, S5): the closed shadcn item-TYPE
  // enum, DERIVED from the live leaf source (never a re-listed copy). The
  // `<component>`-name grammar is a one-line regex hand-mirrored in the gate
  // (like `isUiEntryContained` mirrors `isContainedEntryPath`); only the enum is
  // a data literal, so only it is derived here.
  const artifactUiRegistryItemTypes = extractStringArrayConst(
    artifactContractSrc,
    "ARTIFACT_UI_REGISTRY_ITEM_TYPES",
  );
  const sdkAbiVersion =
    typeof sdkExtensionsPkg?.cinatra?.sdkAbiVersion === "string"
      ? sdkExtensionsPkg.cinatra.sdkAbiVersion
      : null;

  if (!hostPortNames || hostPortNames.length === 0) {
    return { ok: false, missing: [], derivationFailed: "HOST_PORT_NAMES" };
  }
  if (!artifactAllowedCinatraKeys || artifactAllowedCinatraKeys.size === 0) {
    return { ok: false, missing: [], derivationFailed: "ARTIFACT_ALLOWED_CINATRA_KEYS" };
  }
  if (connectorAccessConfigFormatVersion === null) {
    return { ok: false, missing: [], derivationFailed: "CONNECTOR_ACCESS_CONFIG_FORMAT_VERSION" };
  }
  if (!artifactUiSlots || artifactUiSlots.length === 0) {
    return { ok: false, missing: [], derivationFailed: "ARTIFACT_UI_SLOTS" };
  }
  if (!artifactUiReservedSlots) {
    return { ok: false, missing: [], derivationFailed: "ARTIFACT_UI_RESERVED_SLOTS" };
  }
  if (artifactUiAbiVersion === null) {
    return { ok: false, missing: [], derivationFailed: "ARTIFACT_UI_ABI_VERSION" };
  }
  if (!artifactUiRegistryItemTypes || artifactUiRegistryItemTypes.length === 0) {
    return { ok: false, missing: [], derivationFailed: "ARTIFACT_UI_REGISTRY_ITEM_TYPES" };
  }
  // Mirror `generateArtifactUiSdkAbiRange` (leaf): caret over maj.min.patch of
  // the canonical SDK ABI. The generation RULE is one line — drift here can only
  // produce a false CI signal, never a security gap.
  const abiTriple = /^(\d+)\.(\d+)\.(\d+)/.exec(sdkAbiVersion ?? "");
  if (!abiTriple) {
    return { ok: false, missing: [], derivationFailed: "cinatra.sdkAbiVersion" };
  }
  const artifactUiSdkAbiRange = `^${abiTriple[1]}.${abiTriple[2]}.${abiTriple[3]}`;

  return {
    ok: true,
    hostPortNames: new Set(hostPortNames),
    artifactAllowedCinatraKeys,
    connectorAccessConfigFormatVersion,
    artifactUiSlots: new Set(artifactUiSlots),
    artifactUiReservedSlots: new Set(artifactUiReservedSlots),
    artifactUiAbiVersion,
    artifactUiRegistryItemTypes: new Set(artifactUiRegistryItemTypes),
    artifactUiSdkAbiRange,
    sdkExtensionsExports: Object.keys(sdkExtensionsPkg.exports ?? {}),
    sdkUiExports: Object.keys(sdkUiPkg.exports ?? {}),
  };
}

/**
 * The extension-manifest package.json cinatra.formatVersion:2 marker
 * (materialized agent.json payload, closure-manifest install-refusal —
 * `hot-install-canary-harness.test.ts` CG-2, `agent-transfer.ts` "Unsupported
 * agent.json formatVersion"). Unlike the constants above, this is a BARE
 * literal repeated inline at every one of those call sites today — there is
 * no single named export to derive it from, so it is pinned here as one
 * documented literal instead of re-deriving a nonexistent source.
 */
export const AGENT_JSON_FORMAT_VERSION = 2;

/**
 * Non-port keys on `ExtensionHostContext` that are identity fields, not
 * ports — never flagged by the ctx-port-discipline check.
 */
export const CTX_NON_PORT_KEYS = new Set(["abiVersion", "packageName"]);

/**
 * Deny-by-default source rules (cinatra#981 node:fs ban, cinatra#982
 * process.env ban). Each entry is `"<packageName>:<posix-relative-path>"` —
 * an explicit, auditable, single-place exception list rather than a
 * scattered inline-comment mechanism. Every entry MUST cite the tracking
 * issue that owns the remediation.
 *
 * NON-EXHAUSTIVE BY CONSTRUCTION: this checker's own first fleet-wide run
 * found the node:fs pattern in MORE connectors than #981's text names
 * (#981 names only gemini/openai; a local spot-check while building this
 * checker also found it in apollo-connector's identical log-retention.ts,
 * plus a distinct devSetup-hook use in drupal-mcp-connector/
 * wordpress-mcp-connector). This is exactly why the core-CI materialized-
 * tree job (enforcement point 1) runs in REPORT posture first: the real,
 * full-fleet baseline gets generated from a live CI run with `clone-extensions`
 * access to all 82 repos, not from this session's partial local checkout.
 * `--write-baseline` (per-package, monotonic-shrink-only, same convention as
 * `extension-import-ban.mjs`) is how that gets captured for real.
 */
export const NODE_FS_ALLOWLIST = new Set([
  // Tracked by cinatra#981 (ctx.logger.capture port + migration). Remove the
  // entry the moment that PR lands — the checker will then correctly flag a
  // regression.
  "@cinatra-ai/gemini-connector:src/log-retention.ts",
  "@cinatra-ai/gemini-connector:src/index.ts",
  "@cinatra-ai/openai-connector:src/log-retention.ts",
  "@cinatra-ai/openai-connector:src/index.ts",
  "@cinatra-ai/openai-connector:src/openai-skills.ts",
  "@cinatra-ai/apollo-connector:src/log-retention.ts",
  "@cinatra-ai/apollo-connector:src/index.ts",
  // Tracked by cinatra#976 (connector-owned devSetup hook, epic #978 wave
  // W-D) — a distinct dev-boot-only provisioning use, not the #981 log
  // capture pattern, but still under this deny-by-default rule as written.
  "@cinatra-ai/drupal-mcp-connector:src/dev-setup.ts",
  "@cinatra-ai/wordpress-mcp-connector:src/dev-setup.ts",
]);

export const PROCESS_ENV_ALLOWLIST = new Set([
  // Tracked by cinatra#982 (manifest-declared env-override layer). Remove
  // once nango-connector migrates to the settings/secrets ports.
  "@cinatra-ai/nango-connector:src/nango.ts",
  "@cinatra-ai/nango-connector:src/pages/nango-settings-page.tsx",
  // Same env-first-else-default pattern #982 targets (a dev-mode A2A URL
  // override), found in a connector #982's text doesn't name.
  "@cinatra-ai/drupal-mcp-connector:src/mcp/handlers.ts",
  // A local spot-check while building this checker found `process.env` reads
  // in SEVERAL more connectors than #982's text names (drupal/wordpress-mcp-
  // connector, google-oauth-connector, resend-connector, tailscale-connector,
  // plane-connector, drupal/wordpress-assistant-connector — mostly runtime-
  // mode / feature-flag reads, not #982's credential-precedence pattern
  // specifically). None are individually re-verified/allowlisted here — see
  // the NODE_FS_ALLOWLIST comment above for why: the real, full-fleet list
  // is a job for the live core-CI materialized-tree run (`clone-extensions`
  // access to all 82), not this session's partial local checkout. This is
  // exactly why the core-CI job ships in REPORT posture first.
]);

/**
 * Non-public org repos: a public extension repo may never reference these.
 * Verified against live visibility (`gh repo view <slug> --json isPrivate`),
 * not assumed from informal shorthand — `cinatra-ai/ci` and
 * `cinatra-ai/extension-release-tooling` are themselves PUBLIC (they are
 * exactly the shared-tooling repos a public extension repo legitimately
 * references, e.g. `extension-kind-gate.mjs`'s single-source-of-truth repo),
 * so they are deliberately NOT on this list.
 */
export const PRIVATE_ORG_REPO_SLUGS = [
  "cinatra-ai/engineering",
  "cinatra-ai/cinatra-business",
  "cinatra-ai/design",
  "cinatra-ai/ops",
];

/** Internal-infra hostname fragments that must never leak into a public repo. */
export const INTERNAL_HOSTNAME_PATTERNS = [
  /\.internal\.cinatra\.ai\b/,
  /konsoleh/i,
  /coolify/i,
  /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
  /\b192\.168\.\d{1,3}\.\d{1,3}\b/,
];
