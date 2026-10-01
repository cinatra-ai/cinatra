/**
 * Host module-registry shim (epic #1620 M1 Slice A — cinatra#1630, plan
 * §2.2–§2.3 / AC-10): one shared React identity across host + renderer,
 * init-before-import, and the single-React-identity conformance assertion.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  DESIGN_PRIMITIVES_CONTRACT_MISMATCH,
  HOST_DESIGN_PRIMITIVES_CONTRACT_VERSION,
  HOST_DESIGN_PRIMITIVES_EXPORTS,
  HOST_DESIGN_PRIMITIVES_MODULE,
} from "@cinatra-ai/sdk-extensions/design-primitives-contract";

import {
  _resetHostModuleRegistryForTests,
  assertDesignPrimitivesBundleConformance,
  assertSingleDesignPrimitivesIdentity,
  assertSingleReactIdentity,
  getHostModule,
  initHostModuleRegistry,
  isAllowedSharedSpecifier,
  isHostModuleRegistryInitialized,
} from "../host-module-registry";

// Sentinel objects standing in for the host's real module instances — identity
// (reference equality) is the whole point, so plain unique objects suffice.
const hostReact = { __id: "host-react" };
const hostReactDom = { __id: "host-react-dom" };
const jsxRuntime = { __id: "jsx-runtime" };
const reactDomClient = { __id: "react-dom-client" };
const designTokens = { __id: "design-tokens" };
const designPrimitives = { __id: "design-primitives" };

// A stand-in for the host's REAL barrel: one unique member per frozen export, so
// per-export reference identity is what the assertions actually judge.
const hostPrimitiveMembers: Record<string, unknown> = Object.fromEntries(
  HOST_DESIGN_PRIMITIVES_EXPORTS.map((name) => [name, () => null]),
);

function initWithMemberPrimitives() {
  initHostModuleRegistry({
    react: hostReact,
    "react/jsx-runtime": jsxRuntime,
    "react-dom": hostReactDom,
    "react-dom/client": reactDomClient,
    designTokens,
    designPrimitives: hostPrimitiveMembers,
  });
}

function initWithHost() {
  initHostModuleRegistry({
    react: hostReact,
    "react/jsx-runtime": jsxRuntime,
    "react-dom": hostReactDom,
    "react-dom/client": reactDomClient,
    designTokens,
    designPrimitives,
  });
}

afterEach(() => _resetHostModuleRegistryForTests());

describe("init-before-import + shared identity", () => {
  it("is uninitialized until init, then exposes the EXACT host instances", () => {
    expect(isHostModuleRegistryInitialized()).toBe(false);
    expect(getHostModule("react")).toBeUndefined();
    initWithHost();
    expect(isHostModuleRegistryInitialized()).toBe(true);
    // Reference identity — the renderer gets the SAME object, not a copy.
    expect(getHostModule("react")).toBe(hostReact);
    expect(getHostModule("react-dom")).toBe(hostReactDom);
    expect(getHostModule("react/jsx-runtime")).toBe(jsxRuntime);
    expect(getHostModule("react-dom/client")).toBe(reactDomClient);
    expect(getHostModule("@cinatra-ai/design")).toBe(designTokens);
    // cinatra#3471 slice 2: the shared design PRIMITIVES take the SAME road.
    expect(getHostModule(HOST_DESIGN_PRIMITIVES_MODULE)).toBe(designPrimitives);
  });

  it("defaults jsx-dev-runtime to the jsx-runtime instance when omitted", () => {
    initWithHost();
    expect(getHostModule("react/jsx-dev-runtime")).toBe(jsxRuntime);
  });

  it("is idempotent — the first init wins (cold-load-race guard)", () => {
    initWithHost();
    initHostModuleRegistry({
      react: { __id: "second-react" },
      "react/jsx-runtime": jsxRuntime,
      "react-dom": hostReactDom,
      "react-dom/client": reactDomClient,
      designTokens,
      designPrimitives,
    });
    expect(getHostModule("react")).toBe(hostReact); // unchanged
  });

  it("only serves sanctioned external specifiers", () => {
    expect(isAllowedSharedSpecifier("react")).toBe(true);
    expect(isAllowedSharedSpecifier(HOST_DESIGN_PRIMITIVES_MODULE)).toBe(true);
    expect(isAllowedSharedSpecifier("@cinatra-ai/design-primitives/button")).toBe(false);
    expect(isAllowedSharedSpecifier("lodash")).toBe(false);
    initWithHost();
    expect(getHostModule("lodash")).toBeUndefined();
  });
});

describe("AC-10 — single React identity conformance", () => {
  it("passes when the renderer observed the host React", () => {
    initWithHost();
    expect(assertSingleReactIdentity(hostReact)).toBe(hostReact);
  });

  it("THROWS when a renderer observed a different React (a second copy)", () => {
    initWithHost();
    expect(() => assertSingleReactIdentity({ __id: "renderer-bundled-react" })).toThrow(/DIFFERENT React instance/);
  });

  it("THROWS if the identity check runs before init (init-before-import)", () => {
    expect(() => assertSingleReactIdentity(hostReact)).toThrow(/before the shim was initialized/);
  });
});

describe("cinatra#3471 slice 2 — single design-primitives identity", () => {
  it("passes when the renderer observed the host primitives module", () => {
    initWithHost();
    expect(assertSingleDesignPrimitivesIdentity(designPrimitives)).toBe(designPrimitives);
  });

  it("THROWS when a renderer observed a SECOND copy of the primitives", () => {
    initWithHost();
    expect(() => assertSingleDesignPrimitivesIdentity({ __id: "vendored-copy" })).toThrow(
      /a second copy of the design primitives was mounted/,
    );
  });

  it("THROWS if the identity check runs before init (init-before-import)", () => {
    expect(() => assertSingleDesignPrimitivesIdentity(designPrimitives)).toThrow(
      /before the shim was initialized/,
    );
  });
});

describe("cinatra#3471 slice 2 — the LOAD-BOUNDARY conformance (the convergence round)", () => {
  // The façade the host serves re-exports the registered module, so a renderer
  // observes an ESM NAMESPACE wrapper — a different object carrying the host's
  // OWN component identities. That is ONE copy and must be accepted.
  const facadeNamespace = Object.fromEntries(
    HOST_DESIGN_PRIMITIVES_EXPORTS.map((name) => [name, hostPrimitiveMembers[name]]),
  );

  it("accepts a façade NAMESPACE re-export of the host module (one copy, not two)", () => {
    initWithMemberPrimitives();
    expect(assertSingleDesignPrimitivesIdentity(facadeNamespace)).toBe(hostPrimitiveMembers);
  });

  it("still THROWS on a namespace whose members are a SECOND copy", () => {
    initWithMemberPrimitives();
    const vendored = Object.fromEntries(
      HOST_DESIGN_PRIMITIVES_EXPORTS.map((name) => [name, () => null]),
    );
    expect(() => assertSingleDesignPrimitivesIdentity(vendored)).toThrow(
      /a second copy of the design primitives was mounted/,
    );
  });

  it("passes a bundle that declares NEITHER preamble field (it does not use the module)", () => {
    initWithMemberPrimitives();
    expect(() => assertDesignPrimitivesBundleConformance({ default: () => null })).not.toThrow();
  });

  it("FAILS CLOSED with the NAMED error on a bundle built against another MAJOR", () => {
    initWithMemberPrimitives();
    try {
      assertDesignPrimitivesBundleConformance({ __cinatraDesignPrimitivesContract: "2.0.0" });
      throw new Error("expected the load-boundary check to refuse");
    } catch (error) {
      expect((error as Error).name).toBe(DESIGN_PRIMITIVES_CONTRACT_MISMATCH);
      expect((error as Error).message).toMatch(/rebuild the bundle against the host's contract/);
    }
  });

  it("FAILS CLOSED on an unreadable declared contract version", () => {
    initWithMemberPrimitives();
    expect(() =>
      assertDesignPrimitivesBundleConformance({ __cinatraDesignPrimitivesContract: "^1.0.0" }),
    ).toThrow(/unreadable/);
  });

  it("refuses a bundle whose observed primitives are a second copy", () => {
    initWithMemberPrimitives();
    expect(() =>
      assertDesignPrimitivesBundleConformance({
        __cinatraDesignPrimitivesContract: HOST_DESIGN_PRIMITIVES_CONTRACT_VERSION,
        __cinatraDesignPrimitives: { Button: () => null },
      }),
    ).toThrow(/a second copy of the design primitives was mounted/);
  });

  it("admits a conforming bundle (host contract + the façade namespace)", () => {
    initWithMemberPrimitives();
    expect(() =>
      assertDesignPrimitivesBundleConformance({
        __cinatraDesignPrimitivesContract: HOST_DESIGN_PRIMITIVES_CONTRACT_VERSION,
        __cinatraDesignPrimitives: facadeNamespace,
      }),
    ).not.toThrow();
  });
});
