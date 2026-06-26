import { describe, it, expect, expectTypeOf } from "vitest";

import type {
  HostCapabilitiesPort,
  CapabilityContractMap,
  KnownCapabilityId,
  ResolvedCapabilityProvider,
  NangoSystemSurface,
  EmailConnector,
  CrmConnector,
  SocialMediaConnector,
} from "../index";

// P11b — the typed capability-id -> contract-surface map.
//
// These are COMPILE-TIME assertions (the map is type-only ergonomics; it changes
// nothing at runtime). They pin the three load-bearing invariants:
//   1. a KNOWN id narrows `resolveProviders` `impl` to the mapped surface,
//   2. the OPEN `string` path is preserved (any id -> `impl: unknown`),
//   3. `registerProvider` stays open (`impl: unknown`) — the registry never
//      becomes a closed roster, so third-party capabilities keep working.
describe("CapabilityContractMap (typed capability-id -> contract surface)", () => {
  it("maps known capability ids to their contract surface types", () => {
    expectTypeOf<CapabilityContractMap["nango-system"]>().toEqualTypeOf<NangoSystemSurface>();
    expectTypeOf<CapabilityContractMap["email-send"]>().toEqualTypeOf<EmailConnector>();
    // The additive provider-registry ids — each resolves to one typed surface.
    expectTypeOf<CapabilityContractMap["crm-provider"]>().toEqualTypeOf<CrmConnector>();
    expectTypeOf<CapabilityContractMap["social-post"]>().toEqualTypeOf<SocialMediaConnector>();
  });

  it("KnownCapabilityId is the union of the mapped first-party ids (open string is NOT collapsed into it)", () => {
    // The literal ids are members…
    expectTypeOf<"nango-system">().toMatchTypeOf<KnownCapabilityId>();
    expectTypeOf<"email-send">().toMatchTypeOf<KnownCapabilityId>();
    expectTypeOf<"crm-provider">().toMatchTypeOf<KnownCapabilityId>();
    expectTypeOf<"social-post">().toMatchTypeOf<KnownCapabilityId>();
    // …but an arbitrary third-party id is NOT a KnownCapabilityId (stays open).
    expectTypeOf<"some-third-party-cap">().not.toMatchTypeOf<KnownCapabilityId>();
  });

  it("ResolvedCapabilityProvider narrows impl for known ids and stays unknown otherwise", () => {
    expectTypeOf<ResolvedCapabilityProvider<"nango-system">["impl"]>().toEqualTypeOf<NangoSystemSurface>();
    expectTypeOf<
      ResolvedCapabilityProvider<"some-third-party-cap">["impl"]
    >().toEqualTypeOf<unknown>();
  });

  it("HostCapabilitiesPort.resolveProviders: known id -> typed impl; open string -> unknown; register stays open", () => {
    type Port = HostCapabilitiesPort;

    // A never-invoked typed probe: the typechecker still resolves the overload
    // chosen for each argument, so these assertions verify overload SELECTION
    // (the known-id overload vs. the open `string` fallback) without executing.
    function _probe(port: Port) {
      // Known id: the known-id overload is selected -> typed `impl`.
      expectTypeOf(port.resolveProviders("nango-system")).toEqualTypeOf<
        ResolvedCapabilityProvider<"nango-system">[]
      >();
      expectTypeOf(port.resolveProviders("nango-system")[0].impl).toEqualTypeOf<NangoSystemSurface>();

      // The additive provider-registry ids narrow each element's `impl` to the
      // mapped provider surface (the host bridge no longer hand-casts).
      expectTypeOf(port.resolveProviders("crm-provider")[0].impl).toEqualTypeOf<CrmConnector>();
      expectTypeOf(port.resolveProviders("social-post")[0].impl).toEqualTypeOf<SocialMediaConnector>();

      // Open path: a non-mapped id falls to the open `string` overload -> unknown.
      expectTypeOf(port.resolveProviders("totally-custom-cap")).toEqualTypeOf<
        { packageName: string; impl: unknown }[]
      >();
    }
    void _probe; // never called — type-level only

    // registerProvider remains open (impl: unknown) — never a closed roster.
    expectTypeOf<Parameters<Port["registerProvider"]>[1]["impl"]>().toEqualTypeOf<unknown>();
  });

  it("is purely type-level — no value/runtime surface is added (smoke)", () => {
    // The module exports only types; importing them has no runtime footprint.
    const marker: KnownCapabilityId = "email-send";
    expect(marker).toBe("email-send");
  });
});
