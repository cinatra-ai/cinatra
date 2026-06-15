import { describe, it, expect, expectTypeOf } from "vitest";

import { asConnectorVendorKey } from "../index";
import type { ConnectorVendorKey, NangoConnectorKey } from "../index";

// ConnectorVendorKey (#12 12a) — a TYPE-ONLY branded vendor-key SHAPE plus a PURE
// (non-validating) cast. These assertions pin the load-bearing invariants:
//   1. read-compat: a ConnectorVendorKey is assignable back to NangoConnectorKey
//      and to string (the brand only narrows the other direction),
//   2. asConnectorVendorKey is identity at runtime (=== round-trip),
//   3. a bare string is NOT a ConnectorVendorKey without the cast.
//
// The SDK holds NO authoritative vendor roster and performs NO runtime membership
// validation — vendor identity is validated at the host manifest/gate boundary.
// There is deliberately nothing to assert about roster CONTENTS here.
describe("ConnectorVendorKey (branded vendor-key shape + pure cast)", () => {
  it("is assignable back to NangoConnectorKey and to string (read-compat)", () => {
    expectTypeOf<ConnectorVendorKey>().toMatchTypeOf<NangoConnectorKey>();
    expectTypeOf<ConnectorVendorKey>().toMatchTypeOf<string>();

    // A branded value flows into a NangoConnectorKey / string slot with no cast.
    const branded = asConnectorVendorKey("github");
    const asNango: NangoConnectorKey = branded;
    const asString: string = branded;
    expect(asNango).toBe("github");
    expect(asString).toBe("github");
  });

  it("asConnectorVendorKey returns the same value (=== round-trip, zero runtime footprint)", () => {
    const key: NangoConnectorKey = "linkedin";
    const branded = asConnectorVendorKey(key);
    expect(branded).toBe(key);
    expect(branded === ("linkedin" as ConnectorVendorKey)).toBe(true);
    // identity for every member — the cast never transforms the value.
    for (const k of ["a2aServer", "openai", "wordpress"] as NangoConnectorKey[]) {
      expect(asConnectorVendorKey(k)).toBe(k);
    }
  });

  it("a bare string is NOT a ConnectorVendorKey without the cast (the brand narrows one direction)", () => {
    // A plain string / NangoConnectorKey is NOT assignable to ConnectorVendorKey
    // (it lacks the phantom brand) — only the cast produces one.
    expectTypeOf<string>().not.toMatchTypeOf<ConnectorVendorKey>();
    expectTypeOf<NangoConnectorKey>().not.toMatchTypeOf<ConnectorVendorKey>();

    // @ts-expect-error — a bare NangoConnectorKey cannot be assigned without the cast.
    const _bad: ConnectorVendorKey = "github" as NangoConnectorKey;
    void _bad;
  });

  it("the brand is type-only — asConnectorVendorKey adds no runtime members", () => {
    const branded = asConnectorVendorKey("gmail");
    expect(typeof branded).toBe("string");
    // No brand property exists at runtime (it is a phantom unique-symbol key).
    expect(Object.getOwnPropertySymbols(Object(branded)).length).toBe(0);
  });
});
