// cinatra#951 — parity pin between the canonical-types STRUCTURAL MIRROR of
// the resolved connector access declaration and the authoritative SDK shape
// (`@cinatra-ai/sdk-extensions/access-config`). This package deliberately
// imports no SDK module at runtime (same decoupling as
// BUNDLED_SOURCE_DIGEST_RE) — this test is the ONE place the two meet, so a
// drift in either vocabulary fails here instead of silently disagreeing at
// the jsonb round-trip.

import { describe, it, expect } from "vitest";

import {
  CONNECTOR_ACCESS_DECLARATION_SCOPES,
  isResolvedConnectorAccessDeclaration as mirrorGuard,
} from "../canonical-types";
import {
  CONNECTOR_ACCESS_SCOPES,
  CONNECTOR_ACCESS_CONFIG_FORMAT_VERSION,
  isResolvedConnectorAccessDeclaration as sdkGuard,
  parseConnectorAccessConfig,
  resolveAbsentConnectorAccessConfig,
} from "@cinatra-ai/sdk-extensions/access-config";

describe("access-declaration mirror parity (canonical-types ↔ sdk access-config)", () => {
  it("the scope vocabularies are identical", () => {
    expect([...CONNECTOR_ACCESS_DECLARATION_SCOPES]).toEqual([...CONNECTOR_ACCESS_SCOPES]);
  });

  it("every declaration the SDK can produce passes the mirror guard (jsonb round-trip)", () => {
    for (const scope of CONNECTOR_ACCESS_SCOPES) {
      for (const key of ["default", "only"] as const) {
        const resolved = parseConnectorAccessConfig(
          { formatVersion: CONNECTOR_ACCESS_CONFIG_FORMAT_VERSION, access: { scope: { [key]: scope } } },
          { packageName: "@cinatra-ai/github-connector" },
        );
        const roundTripped = JSON.parse(JSON.stringify(resolved));
        expect(mirrorGuard(roundTripped)).toBe(true);
        expect(sdkGuard(roundTripped)).toBe(true);
      }
    }
    const absent = resolveAbsentConnectorAccessConfig({
      packageName: "@cinatra-ai/openai-connector",
      surface: "install",
    });
    expect(mirrorGuard(JSON.parse(JSON.stringify(absent)))).toBe(true);
  });

  it("both guards reject the same malformed shapes", () => {
    const bad: unknown[] = [
      null,
      [],
      {},
      { formatVersion: 2, mode: "only", scope: "admin", source: "absent" },
      { formatVersion: 1, mode: "required", scope: "admin", source: "absent" },
      { formatVersion: 1, mode: "only", scope: "app", source: "absent" },
      { formatVersion: 1, mode: "only", scope: "admin", source: "seeded" },
      { formatVersion: 1, mode: "only", scope: "admin", source: "absent", extra: true },
    ];
    for (const value of bad) {
      expect(mirrorGuard(value)).toBe(false);
      expect(sdkGuard(value)).toBe(false);
    }
  });
});
