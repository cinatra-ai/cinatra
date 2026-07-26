#!/usr/bin/env node
// ---------------------------------------------------------------------------
// wordpress-fixture-pins-gate — pinned community-stack fixture pin-integrity
// gate (issue #2016, S1).
//
// A PURELY-OFFLINE static consistency check (no download). It asserts that the
// version / release-URL / sha256 / base-image-digest literals in the three WP
// fixture substrate files —
//   docker/wordpress/Dockerfile
//   docker-compose.yml (the WordPress build block)
//   scripts/wordpress-entrypoint.sh
// — all agree with docker/wordpress/pins.lock (the single source of truth), that
// NO pin value is still a placeholder token (`<resolved…>`, `<64hex>`, `<VERIFY…>`),
// and that the mcp-adapter `bundlesVendor` boolean matches the Dockerfile's
// chosen vendor path (bundlesVendor=true ⇒ no `composer install` in the bake).
//
// SCOPE (the honest box/CI split): this does NOT download or hash any remote
// artifact — the REAL remote-artifact hashes are verified at IMAGE-BUILD time on
// runners (the Dockerfile RUN does `sha256sum -c`, and the base image is pulled
// BY DIGEST). This gate closes the DRIFT gap: it makes it impossible to merge a
// Dockerfile/compose/entrypoint whose pin literals disagree with pins.lock, or a
// pins.lock that still carries an unresolved placeholder. Modeled on the
// conformance / schema-migration pin-integrity gates: "re-copy verbatim + update
// the pin in the same commit".
//
// WIRING: runs inside build-image.yml's required `perpetual-loops-invariants`
// audit job (so it inherits required-ness without a branch-protection change).
// It no-ops cleanly (exit 0) when docker/wordpress/pins.lock is absent, so PRs
// that predate S1 / do not touch the fixture are unaffected.
//
// Zero runtime dependencies (node: builtins only) so the CI job stays lean — no
// `pnpm install` needed. Exports checkPins(root) for the companion node:test.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT_DEFAULT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const PINS_LOCK_REL = "docker/wordpress/pins.lock";
const DOCKERFILE_REL = "docker/wordpress/Dockerfile";
const COMPOSE_REL = "docker-compose.yml";
const ENTRYPOINT_REL = "scripts/wordpress-entrypoint.sh";

const SHA256_RE = /^[0-9a-f]{64}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
// A placeholder token like <resolved by bring-up>, <64hex>, <VERIFY…>, <bool>.
const PLACEHOLDER_RE = /<[^>\n]{1,80}>/;

/**
 * Static pin-integrity check. Returns { ok, errors } — never throws for a
 * content problem (only for genuinely unreadable required files once pins.lock
 * is present).
 *
 * @param {string} root Repo root to resolve the substrate files against.
 * @returns {{ ok: boolean, errors: string[], skipped?: boolean }}
 */
export function checkPins(root = REPO_ROOT_DEFAULT) {
  const errors = [];
  const pinsPath = path.join(root, PINS_LOCK_REL);

  // No-op cleanly before the pinned fixture lands (or on unrelated repo states).
  if (!existsSync(pinsPath)) {
    return { ok: true, errors, skipped: true };
  }

  let pins;
  const pinsRaw = readFileSync(pinsPath, "utf8");
  try {
    pins = JSON.parse(pinsRaw);
  } catch (e) {
    return { ok: false, errors: [`${PINS_LOCK_REL}: not valid JSON — ${e.message}`] };
  }

  // 1. No unresolved placeholder tokens anywhere in pins.lock.
  const placeholder = pinsRaw.match(PLACEHOLDER_RE);
  if (placeholder) {
    errors.push(
      `${PINS_LOCK_REL}: contains an unresolved placeholder token "${placeholder[0]}" — resolve every pin via the capture bring-up before merge (design §0.1).`,
    );
  }

  // 2. Required fields + shapes.
  const req = (obj, keyPath) => {
    const val = keyPath.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (val === undefined || val === null || val === "") {
      errors.push(`${PINS_LOCK_REL}: missing required field "${keyPath}"`);
      return undefined;
    }
    return val;
  };

  const baseRef = req(pins, "baseImage.ref");
  const baseDigest = req(pins, "baseImage.digest");
  const adapterVersion = req(pins, "mcpAdapter.version");
  const adapterSha = req(pins, "mcpAdapter.sha256");
  const adapterUrl = req(pins, "mcpAdapter.url");
  const bundlesVendor = pins?.mcpAdapter?.bundlesVendor;
  const eafmVersion = req(pins, "enableAbilitiesForMcp.version");
  const eafmSha = req(pins, "enableAbilitiesForMcp.sha256");
  const eafmUrl = req(pins, "enableAbilitiesForMcp.url");
  const wpcliVersion = req(pins, "wpCli.version");
  const wpcliSha = req(pins, "wpCli.sha256");
  const wpcliUrl = req(pins, "wpCli.url");

  if (baseDigest !== undefined && !DIGEST_RE.test(baseDigest)) {
    errors.push(`${PINS_LOCK_REL}: baseImage.digest "${baseDigest}" is not a valid sha256:<64hex> digest`);
  }
  for (const [label, sha] of [
    ["mcpAdapter.sha256", adapterSha],
    ["enableAbilitiesForMcp.sha256", eafmSha],
    ["wpCli.sha256", wpcliSha],
  ]) {
    if (sha !== undefined && !SHA256_RE.test(sha)) {
      errors.push(`${PINS_LOCK_REL}: ${label} "${sha}" is not a valid 64-char lowercase hex sha256`);
    }
  }
  if (typeof bundlesVendor !== "boolean") {
    errors.push(`${PINS_LOCK_REL}: mcpAdapter.bundlesVendor must be a boolean (got ${JSON.stringify(bundlesVendor)})`);
  }

  // 3. pins.lock internal consistency: each release URL carries its own version.
  if (adapterUrl !== undefined && adapterVersion !== undefined && !adapterUrl.includes(adapterVersion)) {
    errors.push(`${PINS_LOCK_REL}: mcpAdapter.url does not contain version "${adapterVersion}"`);
  }
  if (eafmUrl !== undefined && eafmVersion !== undefined && !eafmUrl.includes(eafmVersion)) {
    errors.push(`${PINS_LOCK_REL}: enableAbilitiesForMcp.url does not contain version "${eafmVersion}"`);
  }
  if (wpcliUrl !== undefined && wpcliVersion !== undefined && !wpcliUrl.includes(wpcliVersion)) {
    errors.push(`${PINS_LOCK_REL}: wpCli.url does not contain version "${wpcliVersion}"`);
  }

  // If pins.lock itself is malformed, further cross-file checks are noise.
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Helper: read a required substrate file (missing = hard error once pins exist).
  const readFile = (rel) => {
    const p = path.join(root, rel);
    if (!existsSync(p)) {
      errors.push(`${rel}: required substrate file is missing while ${PINS_LOCK_REL} is present`);
      return null;
    }
    return readFileSync(p, "utf8");
  };
  const mustInclude = (text, rel, needle, why) => {
    if (text !== null && !text.includes(needle)) {
      errors.push(`${rel}: expected to contain \`${needle}\` (${why}); pin drift vs ${PINS_LOCK_REL}`);
    }
  };
  // The "must NOT contain" bans target ACTIVE code, not prose — an explanatory
  // comment may freely say "the abilities-api plugin is dropped" / "the
  // no-`composer install` path". So strip `#`-line/trailing comments first
  // (Dockerfile / shell / YAML all use `#`; none of our pin literals — sha256,
  // URLs, versions, digest — contain a `#`, so this never elides a real pin).
  const stripComments = (text) =>
    text
      .split("\n")
      .map((line) => {
        const m = line.match(/(^|\s)#/);
        return m ? line.slice(0, m.index + m[1].length) : line;
      })
      .join("\n");
  const mustNotInclude = (text, rel, needle, why) => {
    if (text !== null && stripComments(text).includes(needle)) {
      errors.push(`${rel}: must NOT contain \`${needle}\` in active (non-comment) content (${why})`);
    }
  };

  // Derive the wp/php minor for the dev image tag from the base ref
  // (e.g. wordpress:6.9-php8.3-apache -> cinatra-wordpress-dev:6.9-php8.3).
  let imageTag = null;
  const refMatch = typeof baseRef === "string" ? baseRef.match(/wordpress:([0-9.]+)-php([0-9.]+)/) : null;
  if (refMatch) {
    imageTag = `cinatra-wordpress-dev:${refMatch[1]}-php${refMatch[2]}`;
  }

  // 4. Dockerfile.
  const dockerfile = readFile(DOCKERFILE_REL);
  mustInclude(dockerfile, DOCKERFILE_REL, `${baseRef}@${baseDigest}`, "digest-pinned FROM matches pins.lock baseImage");
  mustInclude(dockerfile, DOCKERFILE_REL, `MCP_ADAPTER_VERSION=${adapterVersion}`, "mcp-adapter version pin");
  mustInclude(dockerfile, DOCKERFILE_REL, `MCP_ADAPTER_SHA256=${adapterSha}`, "mcp-adapter sha256 pin");
  mustInclude(dockerfile, DOCKERFILE_REL, `EAFM_VERSION=${eafmVersion}`, "enable-abilities-for-mcp version pin");
  mustInclude(dockerfile, DOCKERFILE_REL, `EAFM_SHA256=${eafmSha}`, "enable-abilities-for-mcp sha256 pin");
  mustInclude(dockerfile, DOCKERFILE_REL, `WP_CLI_VERSION=${wpcliVersion}`, "wp-cli version pin");
  mustInclude(dockerfile, DOCKERFILE_REL, `WP_CLI_SHA256=${wpcliSha}`, "wp-cli sha256 pin");
  mustNotInclude(dockerfile, DOCKERFILE_REL, "abilities-api", "the WordPress/abilities-api plugin is dropped on WP 6.9 (core Abilities API)");
  mustNotInclude(dockerfile, DOCKERFILE_REL, "ABILITIES_API", "the abilities-api build-arg is dropped on WP 6.9");
  // bundlesVendor path invariant: true ⇒ the single resolved no-composer bake.
  if (bundlesVendor === true) {
    mustNotInclude(dockerfile, DOCKERFILE_REL, "composer install", "mcpAdapter.bundlesVendor=true ⇒ the ZIP ships vendor/, so the bake takes the no-`composer install` path (design §1.1)");
  } else if (bundlesVendor === false) {
    mustInclude(dockerfile, DOCKERFILE_REL, "composer install", "mcpAdapter.bundlesVendor=false ⇒ the bake MUST run `composer install` after unzip");
  }

  // 5. docker-compose.yml (WordPress build block).
  const compose = readFile(COMPOSE_REL);
  mustInclude(compose, COMPOSE_REL, `MCP_ADAPTER_VERSION: "${adapterVersion}"`, "compose mcp-adapter build-arg");
  mustInclude(compose, COMPOSE_REL, `EAFM_VERSION: "${eafmVersion}"`, "compose enable-abilities-for-mcp build-arg");
  mustInclude(compose, COMPOSE_REL, `WP_CLI_VERSION: "${wpcliVersion}"`, "compose wp-cli build-arg");
  if (imageTag) {
    mustInclude(compose, COMPOSE_REL, imageTag, "dev image tag reflects the pinned WP/PHP minor");
  }
  mustNotInclude(compose, COMPOSE_REL, "ABILITIES_API_VERSION", "the abilities-api build-arg is dropped on WP 6.9");

  // 6. scripts/wordpress-entrypoint.sh (fallback pins + drop + activation order).
  const entrypoint = readFile(ENTRYPOINT_REL);
  mustInclude(entrypoint, ENTRYPOINT_REL, `MCP_ADAPTER_VERSION:-${adapterVersion}`, "entrypoint mcp-adapter version default");
  mustInclude(entrypoint, ENTRYPOINT_REL, `MCP_ADAPTER_SHA256:-${adapterSha}`, "entrypoint mcp-adapter sha256 default");
  mustInclude(entrypoint, ENTRYPOINT_REL, `EAFM_VERSION:-${eafmVersion}`, "entrypoint enable-abilities-for-mcp version default");
  mustInclude(entrypoint, ENTRYPOINT_REL, `EAFM_SHA256:-${eafmSha}`, "entrypoint enable-abilities-for-mcp sha256 default");
  mustInclude(entrypoint, ENTRYPOINT_REL, `WP_CLI_VERSION:-${wpcliVersion}`, "entrypoint wp-cli version default");
  mustInclude(entrypoint, ENTRYPOINT_REL, `WP_CLI_SHA256:-${wpcliSha}`, "entrypoint wp-cli sha256 default");
  mustNotInclude(entrypoint, ENTRYPOINT_REL, "ensure_abilities_api", "the abilities-api ensure function is dropped on WP 6.9");
  mustNotInclude(entrypoint, ENTRYPOINT_REL, "ABILITIES_API", "the abilities-api pins are dropped on WP 6.9");
  mustNotInclude(entrypoint, ENTRYPOINT_REL, "abilities-api", "the abilities-api plugin is dropped on WP 6.9");

  // activate_plugins deterministic order: mcp-adapter -> fixture -> eafm -> cinatra.
  if (entrypoint !== null) {
    const order = [
      "plugin activate mcp-adapter",
      "plugin activate fixture-thirdparty-mcp",
      "plugin activate enable-abilities-for-mcp",
      "plugin activate cinatra",
    ];
    const idx = order.map((needle) => entrypoint.indexOf(needle));
    const missing = order.filter((_, i) => idx[i] < 0);
    if (missing.length > 0) {
      errors.push(`${ENTRYPOINT_REL}: activate_plugins missing activation for: ${missing.join(", ")}`);
    } else {
      for (let i = 1; i < idx.length; i++) {
        if (idx[i] <= idx[i - 1]) {
          errors.push(
            `${ENTRYPOINT_REL}: activate_plugins order is wrong — expected ${order.map((o) => o.replace("plugin activate ", "")).join(" -> ")} (fixture must activate BEFORE enable-abilities-for-mcp; design §1.3)`,
          );
          break;
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// CLI entry: run against WP_PINS_GATE_ROOT (default repo root).
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const root = process.env.WP_PINS_GATE_ROOT || REPO_ROOT_DEFAULT;
  const { ok, errors, skipped } = checkPins(root);
  if (skipped) {
    console.log(`wordpress-fixture-pins-gate: ${PINS_LOCK_REL} absent — nothing to check (pre-S1 / unrelated PR).`);
    process.exit(0);
  }
  if (ok) {
    console.log("wordpress-fixture-pins-gate: OK — Dockerfile + compose + entrypoint pins agree with pins.lock; no placeholders; bundlesVendor path consistent.");
    process.exit(0);
  }
  console.error("wordpress-fixture-pins-gate: FAILED\n");
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  console.error(`\nFix: re-copy the resolved values from ${PINS_LOCK_REL} into the three substrate files in the SAME commit (design §1.1).`);
  process.exit(1);
}
