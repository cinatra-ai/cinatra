import { describe, it, expect, afterEach } from "vitest";
import {
  registerCapabilityProvider,
  resolveCapabilityProviders,
  invalidateProvidersForPackage,
  __resetCapabilityRegistry,
  recordLoadedExtensionIdentity, isLoadedExtensionIdentityCurrent,
  capabilityProviderLoadedIdentity,
  bindGuardedRunDispatch, isGuardedRunDispatch, isGuardedRunLeaf,
} from "@/lib/extension-capabilities-registry";
import { bindArtifactGuardedMcpHandler } from "@/lib/extension-host-context";

describe("extension-capabilities-registry", () => {
  afterEach(() => __resetCapabilityRegistry());

  it("registers + resolves providers per capability; unknown capability resolves to []", () => {
    registerCapabilityProvider("email-send", { packageName: "@cinatra-ai/resend-connector", impl: { id: "resend" } });
    const providers = resolveCapabilityProviders("email-send");
    expect(providers).toHaveLength(1);
    expect(providers[0]?.packageName).toBe("@cinatra-ai/resend-connector");
    expect(resolveCapabilityProviders("unknown-capability")).toEqual([]);
  });

  it("dedupes by packageName — re-registration REPLACES (idempotent, boot re-activate safe)", () => {
    registerCapabilityProvider("email-send", { packageName: "@cinatra-ai/x", impl: { v: 1 } });
    registerCapabilityProvider("email-send", { packageName: "@cinatra-ai/x", impl: { v: 2 } });
    const providers = resolveCapabilityProviders("email-send");
    expect(providers).toHaveLength(1);
    // This test exercises the generic registry dedupe/replace semantics with an
    // opaque placeholder impl, not the email-send surface — cast through unknown
    // (the typed `resolveProviders("email-send")` overload now narrows `impl` to
    // the mapped EmailConnector surface, which the placeholder doesn't satisfy).
    expect((providers[0]?.impl as unknown as { v: number }).v).toBe(2);
  });

  it("rejects a provider with no packageName", () => {
    expect(() =>
      registerCapabilityProvider("email-send", { packageName: "", impl: {} }),
    ).toThrow(/no packageName/);
  });

  it("invalidateProvidersForPackage drops every provider that package registered, across capabilities (teardown)", () => {
    registerCapabilityProvider("email-send", { packageName: "@cinatra-ai/a", impl: {} });
    registerCapabilityProvider("email-send", { packageName: "@cinatra-ai/b", impl: {} });
    registerCapabilityProvider("crm-sync", { packageName: "@cinatra-ai/a", impl: {} });

    invalidateProvidersForPackage("@cinatra-ai/a");

    expect(resolveCapabilityProviders("email-send").map((p) => p.packageName)).toEqual(["@cinatra-ai/b"]);
    expect(resolveCapabilityProviders("crm-sync")).toEqual([]);
  });
});


describe("actual loaded CHECK and handler identity",()=>{
 afterEach(()=>__resetCapabilityRegistry());
 const owner=()=>recordLoadedExtensionIdentity({packageName:"pack",version:"1",installId:"install",digest:"a".repeat(64)});
 it("stamps only the exact loaded owner; diagnostic/package-name claims have no authority",()=>{
  const i=owner();registerCapabilityProvider("artifact-action-check/v1",{packageName:"pack",impl:{check:()=>({kind:"refused",reason:"uncovered"})}},i);
  expect(capabilityProviderLoadedIdentity(resolveCapabilityProviders("artifact-action-check/v1")[0]!)).toEqual(i);
  expect(capabilityProviderLoadedIdentity({packageName:"pack",impl:{}})).toBeUndefined();
  expect(()=>registerCapabilityProvider("artifact-action-check/v1",{packageName:"other",impl:{check:()=>({kind:"refused",reason:"uncovered"})}},i)).toThrow("action_provider_identity_mismatch");
 });
 it("freezes actual registered methods and rejects accessors without evaluating them",()=>{
  const impl={check:()=>({kind:"refused",reason:"uncovered"})};registerCapabilityProvider("artifact-action-check/v1",{packageName:"pack",impl},owner());expect(Object.isFrozen(impl)).toBe(true);
  let called=0;const getter=Object.defineProperty({},"check",{get(){called++;return ()=>({kind:"checked"});}});
  expect(()=>registerCapabilityProvider("artifact-action-check/v1",{packageName:"other",impl:getter})).toThrow("action_checker_registration_incompatible");expect(called).toBe(0);
 });
 it("refuses ambiguous replacement and invalidates old generation on teardown",()=>{
  const i=owner();const impl={check:()=>({kind:"refused",reason:"uncovered"})};registerCapabilityProvider("artifact-action-check/v1",{packageName:"pack",impl},i);
  registerCapabilityProvider("artifact-action-check/v1",{packageName:"pack",impl},i);
  expect(()=>registerCapabilityProvider("artifact-action-check/v1",{packageName:"pack",impl:{check:()=>({kind:"refused",reason:"different"})}},i)).toThrow("action_checker_registration_ambiguous");
  expect(resolveCapabilityProviders("artifact-action-check/v1")).toEqual([]);invalidateProvidersForPackage("pack");expect(isLoadedExtensionIdentityCurrent(i)).toBe(false);expect(owner().generation).not.toBe(i.generation);
 });
 it("a copied raw handler is never a guarded bridge; only a captured guarded leaf brands its bridge",()=>{
  const raw=async()=>"ordinary";const guarded=bindArtifactGuardedMcpHandler("publish",raw,owner());
  expect(isGuardedRunLeaf(raw)).toBe(false);expect(isGuardedRunLeaf(guarded)).toBe(true);
  expect(isGuardedRunDispatch(bindGuardedRunDispatch(async()=>raw(),raw))).toBe(false);
  expect(isGuardedRunDispatch(bindGuardedRunDispatch(async()=>guarded({}),guarded))).toBe(true);
 });
});
