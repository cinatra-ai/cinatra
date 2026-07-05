// connector-access-config-gate (cinatra#951) — gate-rule tests + the
// AGREEMENT PIN: the gate's self-contained mirror and the authoritative SDK
// validator (`packages/sdk-extensions/src/access-config.ts`) must accept and
// reject the SAME fixture matrix (the dev-fixtures-gate precedent). Do not
// change one validator without the other.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  validateAccessConfig,
  accessSlugFromPackageName,
  ACCESS_SCOPES,
  PROTECTED_SLUGS,
} from "../connector-access-config-gate.mjs";
import {
  CONNECTOR_ACCESS_SCOPES,
  PROTECTED_CONNECTOR_SLUGS,
  connectorAccessSlugFromPackageName,
  parseConnectorAccessConfig,
} from "../../../packages/sdk-extensions/src/access-config.ts";

const PKG = "@cinatra-ai/github-connector";
const wrap = (scope) => ({ formatVersion: 1, access: { scope } });

/** The shared proof-fixture matrix — every entry names an expected verdict. */
const FIXTURES = [
  // valid
  { raw: wrap({ default: "user" }), pkg: PKG, ok: true },
  { raw: wrap({ only: "admin" }), pkg: PKG, ok: true },
  { raw: { formatVersion: 1 }, pkg: PKG, ok: true }, // scope-less file -> default:admin
  { raw: { formatVersion: 1, access: {} }, pkg: PKG, ok: true },
  { raw: wrap({ only: "admin" }), pkg: "@cinatra-ai/openai-connector", ok: true },
  // invalid — structure
  { raw: null, pkg: PKG, ok: false },
  { raw: [], pkg: PKG, ok: false },
  { raw: { access: { scope: { default: "user" } } }, pkg: PKG, ok: false }, // no formatVersion
  { raw: { formatVersion: 2, access: { scope: { default: "user" } } }, pkg: PKG, ok: false },
  { raw: { formatVersion: 1, telemetry: {}, access: { scope: { default: "user" } } }, pkg: PKG, ok: false },
  { raw: { formatVersion: 1, access: { scpoe: { default: "user" } } }, pkg: PKG, ok: false }, // misspelled nested key
  { raw: wrap({ defualt: "user" }), pkg: PKG, ok: false },
  { raw: wrap({ default: "user", extra: 1 }), pkg: PKG, ok: false },
  { raw: wrap({ default: "user", only: "admin" }), pkg: PKG, ok: false }, // both (XOR)
  { raw: wrap({}), pkg: PKG, ok: false }, // neither (XOR)
  { raw: wrap({ default: "app" }), pkg: PKG, ok: false }, // non-vocabulary token
  { raw: wrap({ only: "everyone" }), pkg: PKG, ok: false },
  // invalid — protected slugs
  { raw: wrap({ default: "admin" }), pkg: "@cinatra-ai/openai-connector", ok: false },
  { raw: wrap({ only: "workspace" }), pkg: "@cinatra-ai/anthropic-connector", ok: false },
  { raw: wrap({ default: "user" }), pkg: "@cinatra-ai/gemini-connector", ok: false },
  { raw: { formatVersion: 1 }, pkg: "@cinatra-ai/openai-connector", ok: false }, // scope-less protected
  // gmail is NOT validator-forced in W1
  { raw: wrap({ default: "admin" }), pkg: "@cinatra-ai/gmail-connector", ok: true },
];

describe("connector-access-config-gate — mirror rules", () => {
  it("normalizes package names to access slugs exactly like the SDK", () => {
    for (const name of [
      "@cinatra-ai/openai-connector",
      "openai-connector",
      "openai",
      "@acme/acme-crm-connector",
    ]) {
      expect(accessSlugFromPackageName(name)).toBe(connectorAccessSlugFromPackageName(name));
    }
  });

  it("shares the scope vocabulary + protected-slug set with the SDK", () => {
    expect([...ACCESS_SCOPES]).toEqual([...CONNECTOR_ACCESS_SCOPES]);
    expect(Object.keys(PROTECTED_SLUGS).sort()).toEqual(
      Object.keys(PROTECTED_CONNECTOR_SLUGS).sort(),
    );
    for (const [slug, scope] of Object.entries(PROTECTED_SLUGS)) {
      expect(PROTECTED_CONNECTOR_SLUGS[slug]).toEqual({ mode: "only", scope });
    }
  });

  it("AGREEMENT PIN: the gate mirror and the SDK validator agree on every proof fixture", () => {
    for (const { raw, pkg, ok } of FIXTURES) {
      const gateErrors = validateAccessConfig(raw, pkg);
      let sdkOk = true;
      try {
        parseConnectorAccessConfig(raw, { packageName: pkg });
      } catch {
        sdkOk = false;
      }
      const label = `${pkg} ${JSON.stringify(raw)}`;
      expect(gateErrors.length === 0, `gate verdict for ${label}`).toBe(ok);
      expect(sdkOk, `sdk verdict for ${label}`).toBe(ok);
    }
  });
});

// ---------------------------------------------------------------------------
// SEEDED-VIOLATION PROOF (cinatra#955 closing wave): the gate hard-fails on a
// config-less connector — no flag, no WARN staging. Spawn the real gate
// against a synthetic extensions/ tree.
// ---------------------------------------------------------------------------

const GATE = resolve(process.cwd(), "scripts/audit/connector-access-config-gate.mjs");

function runGateAgainst(build) {
  const root = mkdtempSync(join(tmpdir(), "cacg-955-"));
  try {
    const dir = join(root, "extensions", "test-scope", "foo-connector");
    mkdirSync(dir, { recursive: true });
    build(dir);
    const out = spawnSync(process.execPath, [GATE], { cwd: root, encoding: "utf8" });
    return { status: out.status, stdout: out.stdout, stderr: out.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("connector-access-config-gate — absence hard-fails (no staging flag)", () => {
  it("FAILS (exit 1) when a kind=connector package ships no cinatra/config.json", () => {
    const { status, stderr } = runGateAgainst((dir) => {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "@test-scope/foo-connector", cinatra: { kind: "connector" } }),
      );
    });
    expect(status).toBe(1);
    expect(stderr).toMatch(/cinatra\/config\.json is MISSING for kind=connector/);
  });

  it("PASSES (exit 0) when the config is shipped and valid", () => {
    const { status, stdout } = runGateAgainst((dir) => {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "@test-scope/foo-connector", cinatra: { kind: "connector" } }),
      );
      mkdirSync(join(dir, "cinatra"));
      writeFileSync(
        join(dir, "cinatra", "config.json"),
        JSON.stringify({ formatVersion: 1, access: { scope: { default: "workspace" } } }),
      );
    });
    expect(status).toBe(0);
    expect(stdout).toMatch(/OK/);
  });

  it("FAILS (exit 1) when package.json#files omits the cinatra dir (packlist presence)", () => {
    const { status, stderr } = runGateAgainst((dir) => {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "@test-scope/foo-connector",
          files: ["dist"],
          cinatra: { kind: "connector" },
        }),
      );
      mkdirSync(join(dir, "cinatra"));
      writeFileSync(
        join(dir, "cinatra", "config.json"),
        JSON.stringify({ formatVersion: 1, access: { scope: { default: "workspace" } } }),
      );
    });
    expect(status).toBe(1);
    expect(stderr).toMatch(/does not include "cinatra"/);
  });

  it("FAILS (exit 1) on a protected-slug violation in a SHIPPED config", () => {
    const root = mkdtempSync(join(tmpdir(), "cacg-955p-"));
    try {
      const dir = join(root, "extensions", "test-scope", "openai-connector");
      mkdirSync(join(dir, "cinatra"), { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "@test-scope/openai-connector", cinatra: { kind: "connector" } }),
      );
      writeFileSync(
        join(dir, "cinatra", "config.json"),
        JSON.stringify({ formatVersion: 1, access: { scope: { default: "workspace" } } }),
      );
      const out = spawnSync(process.execPath, [GATE], { cwd: root, encoding: "utf8" });
      expect(out.status).toBe(1);
      expect(out.stderr).toMatch(/protected slug "openai"/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
