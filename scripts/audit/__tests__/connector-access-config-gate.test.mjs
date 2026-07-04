// connector-access-config-gate (cinatra#951) — gate-rule tests + the
// AGREEMENT PIN: the gate's self-contained mirror and the authoritative SDK
// validator (`packages/sdk-extensions/src/access-config.ts`) must accept and
// reject the SAME fixture matrix (the dev-fixtures-gate precedent). Do not
// change one validator without the other.

import { describe, it, expect } from "vitest";

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
