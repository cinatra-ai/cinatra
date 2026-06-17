import { describe, it, expect, expectTypeOf } from "vitest";

import { asConnectorVendorKey } from "../index";
import type { ConnectorVendorKey, NangoConnectorKey } from "../index";

// ConnectorVendorKey (#12 connector vendor-identity end-state) — the SDK exposes
// an OPEN vendor-key shape plus a TYPE-ONLY brand and a PURE (non-validating)
// cast. These assertions pin the load-bearing invariants:
//   1. OPEN shape: `NangoConnectorKey` is a plain `string` — the SDK no longer
//      hardcodes an enumerated vendor union, so a NOVEL vendor key (one no
//      first-party connector ships) is a valid `NangoConnectorKey`. Vendor
//      identity is declared per-connector in its manifest and verified at the
//      marketplace publish gate, NOT frozen into the SDK.
//   2. read-compat: a ConnectorVendorKey is assignable back to NangoConnectorKey
//      and to string (the brand only narrows the other direction),
//   3. asConnectorVendorKey is identity at runtime (=== round-trip),
//   4. a bare string is NOT a ConnectorVendorKey without the cast.
//
// The SDK holds NO authoritative vendor roster and performs NO runtime membership
// validation — vendor identity is validated at the host manifest/gate boundary.
// There is deliberately nothing to assert about roster CONTENTS here.
describe("ConnectorVendorKey (open vendor-key shape + branded cast)", () => {
  it("the vendor key is OPEN — the SDK hardcodes no enumerated vendor union", () => {
    // `NangoConnectorKey` is a plain `string` shape, not a closed literal union:
    // `string` is assignable TO it and it is assignable to `string`. A frozen
    // union ('openai' | 'github' | …) would FAIL `string -> union` assignment.
    expectTypeOf<NangoConnectorKey>().toMatchTypeOf<string>();
    expectTypeOf<string>().toMatchTypeOf<NangoConnectorKey>();

    // A NOVEL key no first-party connector ships is a valid vendor key — the
    // open marketplace: a connector declares its own key in its manifest.
    const novel: NangoConnectorKey = "acme-crm";
    expect(novel).toBe("acme-crm");
    const brandedNovel = asConnectorVendorKey("acme-crm");
    expect(brandedNovel).toBe("acme-crm");
  });

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
    // identity for every value — the cast never transforms the value, and it
    // accepts arbitrary strings (no roster), including a never-before-seen key.
    for (const k of ["a2aServer", "openai", "wordpress", "acme-crm"]) {
      expect(asConnectorVendorKey(k)).toBe(k);
    }
  });

  it("a bare string is NOT a ConnectorVendorKey without the cast (the brand narrows one direction)", () => {
    // A plain string / NangoConnectorKey is NOT assignable to ConnectorVendorKey
    // (it lacks the phantom brand) — only the cast produces one.
    expectTypeOf<string>().not.toMatchTypeOf<ConnectorVendorKey>();
    expectTypeOf<NangoConnectorKey>().not.toMatchTypeOf<ConnectorVendorKey>();

    // @ts-expect-error — a bare string cannot be assigned without the cast.
    const _bad: ConnectorVendorKey = "github" as string;
    void _bad;
  });

  it("the brand is type-only — asConnectorVendorKey adds no runtime members", () => {
    const branded = asConnectorVendorKey("gmail");
    expect(typeof branded).toBe("string");
    // No brand property exists at runtime (it is a phantom unique-symbol key).
    expect(Object.getOwnPropertySymbols(Object(branded)).length).toBe(0);
  });
});
