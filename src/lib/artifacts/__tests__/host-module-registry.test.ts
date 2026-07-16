/**
 * Host module-registry shim (epic #1620 M1 Slice A — cinatra#1630, plan
 * §2.2–§2.3 / AC-10): one shared React identity across host + renderer,
 * init-before-import, and the single-React-identity conformance assertion.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  _resetHostModuleRegistryForTests,
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

function initWithHost() {
  initHostModuleRegistry({
    react: hostReact,
    "react/jsx-runtime": jsxRuntime,
    "react-dom": hostReactDom,
    "react-dom/client": reactDomClient,
    designTokens,
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
    });
    expect(getHostModule("react")).toBe(hostReact); // unchanged
  });

  it("only serves sanctioned external specifiers", () => {
    expect(isAllowedSharedSpecifier("react")).toBe(true);
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
