import { describe, it, expect } from "vitest";
// The build-time manifest generator is a plain .mjs (it runs under bare Node and
// cannot import the TS SDK), so it keeps LITERAL MIRRORS of two host-port facts:
//   - VALID_HOST_PORTS    — mirrors HOST_PORT_NAMES
//   - RESERVED_HOST_PORTS — mirrors the SDK's derived RESERVED_HOST_PORTS
//                           (the ports whose HOST_PORT_TIER is "reserved")
// The TS HOST_PORT_TIER table in host-context.ts is the CANONICAL source. This
// test is the PARITY GUARD that makes the mirror trustworthy: it asserts the
// generator's copies exactly equal the canonical TS values, so any drift (a tier
// flip in the TS table not reflected in the generator, or vice versa) fails CI
// rather than silently desyncing the build-time warning from the runtime gate.
import {
  VALID_HOST_PORTS,
  RESERVED_HOST_PORTS as GENERATOR_RESERVED_HOST_PORTS,
} from "../generate-extension-manifest.mjs";
// Canonical TS source of truth. Imported by RELATIVE path to the SDK source so
// the parity check binds the actual authored table, independent of alias config.
import {
  HOST_PORT_NAMES,
  HOST_PORT_TIER,
  RESERVED_HOST_PORTS as SDK_RESERVED_HOST_PORTS,
} from "../../../packages/sdk-extensions/src/host-context";

describe("generate-extension-manifest port mirrors stay in parity with the SDK ABI table", () => {
  it("VALID_HOST_PORTS exactly mirrors HOST_PORT_NAMES (no drift)", () => {
    expect([...VALID_HOST_PORTS].sort()).toEqual([...HOST_PORT_NAMES].sort());
  });

  it("the generator's RESERVED_HOST_PORTS exactly mirrors the SDK's derived reserved set", () => {
    expect([...GENERATOR_RESERVED_HOST_PORTS].sort()).toEqual(
      [...SDK_RESERVED_HOST_PORTS].sort(),
    );
  });

  it("the generator's reserved set is precisely the `reserved`-tier ports of HOST_PORT_TIER", () => {
    // Re-derive straight from the canonical tier table — this is the assertion
    // that makes a future tier flip impossible to merge without updating the
    // generator's literal mirror.
    const reservedFromTier = HOST_PORT_NAMES.filter(
      (p) => HOST_PORT_TIER[p] === "reserved",
    );
    expect([...GENERATOR_RESERVED_HOST_PORTS].sort()).toEqual(
      [...reservedFromTier].sort(),
    );
  });

  it("every generator reserved port is also a valid host-port name (reserved ⊆ valid)", () => {
    for (const port of GENERATOR_RESERVED_HOST_PORTS) {
      expect(VALID_HOST_PORTS.has(port)).toBe(true);
    }
  });
});
