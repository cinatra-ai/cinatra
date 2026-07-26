// wordpress-fixture-pins-gate — companion tests (pure node:test, no pnpm).
//
// Drives checkPins(root) against temp fixture trees: a consistent Dockerfile +
// docker-compose.yml + entrypoint + pins.lock passes; each drift class (digest
// mismatch, sha mismatch, placeholder, bundlesVendor path, dropped-plugin
// reference, wrong activation order, missing build-arg, absent substrate file)
// fails. Mirrors the actions-pinned-gate / schema-migration-gate companion-test
// pattern (node --test; the executable form of the pin-integrity convention).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkPins } from "../wordpress-fixture-pins-gate.mjs";

const DIGEST = "sha256:" + "a".repeat(64);
const ADAPTER_SHA = "b".repeat(64);
const EAFM_SHA = "c".repeat(64);
const WPCLI_SHA = "d".repeat(64);

function consistentPins() {
  return {
    baseImage: { ref: "wordpress:6.9-php8.3-apache", digest: DIGEST },
    mcpAdapter: {
      version: "0.5.0",
      url: "https://github.com/WordPress/mcp-adapter/releases/download/v0.5.0/mcp-adapter.zip",
      sha256: ADAPTER_SHA,
      bundlesVendor: true,
    },
    enableAbilitiesForMcp: {
      version: "2.0.20",
      url: "https://downloads.wordpress.org/plugin/enable-abilities-for-mcp.2.0.20.zip",
      sha256: EAFM_SHA,
    },
    wpCli: {
      version: "2.12.0",
      url: "https://github.com/wp-cli/wp-cli/releases/download/v2.12.0/wp-cli-2.12.0.phar",
      sha256: WPCLI_SHA,
    },
  };
}

const CONSISTENT_DOCKERFILE = `FROM wordpress:6.9-php8.3-apache@${DIGEST}
ARG MCP_ADAPTER_VERSION=0.5.0
ARG MCP_ADAPTER_SHA256=${ADAPTER_SHA}
ARG EAFM_VERSION=2.0.20
ARG EAFM_SHA256=${EAFM_SHA}
ARG WP_CLI_VERSION=2.12.0
ARG WP_CLI_SHA256=${WPCLI_SHA}
RUN echo bake
`;

const CONSISTENT_COMPOSE = `services:
  wordpress:
    build:
      args:
        MCP_ADAPTER_VERSION: "0.5.0"
        EAFM_VERSION: "2.0.20"
        WP_CLI_VERSION: "2.12.0"
    image: cinatra-wordpress-dev:6.9-php8.3
`;

const CONSISTENT_ENTRYPOINT = `#!/usr/bin/env bash
MCP_ADAPTER_VERSION="\${MCP_ADAPTER_VERSION:-0.5.0}"
MCP_ADAPTER_SHA256="\${MCP_ADAPTER_SHA256:-${ADAPTER_SHA}}"
EAFM_VERSION="\${EAFM_VERSION:-2.0.20}"
EAFM_SHA256="\${EAFM_SHA256:-${EAFM_SHA}}"
WP_CLI_VERSION="\${WP_CLI_VERSION:-2.12.0}"
WP_CLI_SHA256="\${WP_CLI_SHA256:-${WPCLI_SHA}}"
activate_plugins() {
  wp plugin activate mcp-adapter
  wp plugin activate fixture-thirdparty-mcp
  wp plugin activate enable-abilities-for-mcp
  wp plugin activate cinatra
}
`;

function writeTree(overrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "wp-pins-gate-"));
  mkdirSync(path.join(root, "docker", "wordpress"), { recursive: true });
  mkdirSync(path.join(root, "scripts"), { recursive: true });

  const pins = overrides.pins === null ? null : overrides.pins ?? consistentPins();
  if (pins !== null) {
    writeFileSync(
      path.join(root, "docker", "wordpress", "pins.lock"),
      typeof pins === "string" ? pins : JSON.stringify(pins, null, 2),
    );
  }
  if (overrides.dockerfile !== null) {
    writeFileSync(path.join(root, "docker", "wordpress", "Dockerfile"), overrides.dockerfile ?? CONSISTENT_DOCKERFILE);
  }
  if (overrides.compose !== null) {
    writeFileSync(path.join(root, "docker-compose.yml"), overrides.compose ?? CONSISTENT_COMPOSE);
  }
  if (overrides.entrypoint !== null) {
    writeFileSync(path.join(root, "scripts", "wordpress-entrypoint.sh"), overrides.entrypoint ?? CONSISTENT_ENTRYPOINT);
  }
  return root;
}

function run(overrides) {
  const root = writeTree(overrides);
  try {
    return checkPins(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("passes a fully consistent tree", () => {
  const r = run({});
  assert.equal(r.ok, true, r.errors.join("\n"));
});

test("no-ops (skipped) when pins.lock is absent", () => {
  const r = run({ pins: null });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
});

test("fails on an unresolved placeholder token in pins.lock", () => {
  const pins = consistentPins();
  pins.mcpAdapter.sha256 = "<resolved by bring-up>";
  const r = run({ pins });
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /placeholder/i);
});

test("fails when the Dockerfile FROM digest drifts from pins.lock", () => {
  const df = CONSISTENT_DOCKERFILE.replace(DIGEST, "sha256:" + "e".repeat(64));
  const r = run({ dockerfile: df });
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /Dockerfile/);
});

test("fails when the Dockerfile mcp-adapter sha256 drifts", () => {
  const df = CONSISTENT_DOCKERFILE.replace(ADAPTER_SHA, "f".repeat(64));
  const r = run({ dockerfile: df });
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /MCP_ADAPTER_SHA256/);
});

test("fails bundlesVendor=true but Dockerfile runs composer install", () => {
  const df = CONSISTENT_DOCKERFILE + "RUN composer install --no-dev\n";
  const r = run({ dockerfile: df });
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /composer install/);
});

test("passes bundlesVendor=false with composer install present", () => {
  const pins = consistentPins();
  pins.mcpAdapter.bundlesVendor = false;
  const df = CONSISTENT_DOCKERFILE + "RUN composer install --no-dev\n";
  const r = run({ pins, dockerfile: df });
  assert.equal(r.ok, true, r.errors.join("\n"));
});

test("fails bundlesVendor=false WITHOUT composer install", () => {
  const pins = consistentPins();
  pins.mcpAdapter.bundlesVendor = false;
  const r = run({ pins });
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /composer install/);
});

test("fails when the Dockerfile still references abilities-api", () => {
  const df = CONSISTENT_DOCKERFILE + "RUN git clone abilities-api\n";
  const r = run({ dockerfile: df });
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /abilities-api/);
});

test("fails when compose is missing the EAFM build-arg", () => {
  const compose = CONSISTENT_COMPOSE.replace('EAFM_VERSION: "2.0.20"\n', "");
  const r = run({ compose });
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /EAFM_VERSION/);
});

test("fails when the dev image tag does not reflect the pinned WP minor", () => {
  const compose = CONSISTENT_COMPOSE.replace("cinatra-wordpress-dev:6.9-php8.3", "cinatra-wordpress-dev:6.8-php8.3");
  const r = run({ compose });
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /cinatra-wordpress-dev:6\.9-php8\.3/);
});

test("fails when activate_plugins order puts the fixture AFTER eafm", () => {
  const bad = `#!/usr/bin/env bash
MCP_ADAPTER_VERSION="\${MCP_ADAPTER_VERSION:-0.5.0}"
MCP_ADAPTER_SHA256="\${MCP_ADAPTER_SHA256:-${ADAPTER_SHA}}"
EAFM_VERSION="\${EAFM_VERSION:-2.0.20}"
EAFM_SHA256="\${EAFM_SHA256:-${EAFM_SHA}}"
WP_CLI_VERSION="\${WP_CLI_VERSION:-2.12.0}"
WP_CLI_SHA256="\${WP_CLI_SHA256:-${WPCLI_SHA}}"
activate_plugins() {
  wp plugin activate mcp-adapter
  wp plugin activate enable-abilities-for-mcp
  wp plugin activate fixture-thirdparty-mcp
  wp plugin activate cinatra
}
`;
  const r = run({ entrypoint: bad });
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /order is wrong/);
});

test("fails when the entrypoint still defines ensure_abilities_api", () => {
  const bad = CONSISTENT_ENTRYPOINT + "ensure_abilities_api() { :; }\n";
  const r = run({ entrypoint: bad });
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /ensure_abilities_api|abilities-api|ABILITIES_API/);
});

test("fails when a substrate file is missing while pins.lock is present", () => {
  const r = run({ dockerfile: null });
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /required substrate file is missing/);
});
