// engineering#534 S1 — the per-process signed-activated registry (co-located in
// extension-capabilities-registry) that gives the unauthenticated widget-auth
// resolver an actor-free "is this package currently trusted-signed AND
// successfully activated?" signal. Fail-closed by construction: an unmarked
// package is not trusted-signed; teardown clears the marker in lockstep with the
// capability providers it guards.

import { describe, expect, it, beforeEach } from "vitest";

import {
  markPackageSignedActivated,
  clearPackageSignedActivated,
  isPackageSignedActivated,
  __resetSignedTrustedRegistry,
} from "@/lib/extension-capabilities-registry";

const PKG = "@acme/wordpress-runtime-connector";

describe("extension-signed-trusted-registry", () => {
  beforeEach(() => __resetSignedTrustedRegistry());

  it("an unmarked package is NOT signed-activated (fail closed)", () => {
    expect(isPackageSignedActivated(PKG)).toBe(false);
  });

  it("mark then query returns true; clear returns to false", () => {
    markPackageSignedActivated(PKG);
    expect(isPackageSignedActivated(PKG)).toBe(true);
    clearPackageSignedActivated(PKG);
    expect(isPackageSignedActivated(PKG)).toBe(false);
  });

  it("ignores an empty package name (never marks a blank owner)", () => {
    markPackageSignedActivated("");
    expect(isPackageSignedActivated("")).toBe(false);
  });

  it("clear is a safe no-op for an unmarked package", () => {
    expect(() => clearPackageSignedActivated("@acme/never-marked")).not.toThrow();
    expect(isPackageSignedActivated("@acme/never-marked")).toBe(false);
  });

  it("marking is idempotent and per-package", () => {
    markPackageSignedActivated(PKG);
    markPackageSignedActivated(PKG);
    markPackageSignedActivated("@acme/other");
    expect(isPackageSignedActivated(PKG)).toBe(true);
    expect(isPackageSignedActivated("@acme/other")).toBe(true);
    clearPackageSignedActivated(PKG);
    expect(isPackageSignedActivated(PKG)).toBe(false);
    expect(isPackageSignedActivated("@acme/other")).toBe(true);
  });

  it("__resetSignedTrustedRegistry clears everything", () => {
    markPackageSignedActivated(PKG);
    markPackageSignedActivated("@acme/other");
    __resetSignedTrustedRegistry();
    expect(isPackageSignedActivated(PKG)).toBe(false);
    expect(isPackageSignedActivated("@acme/other")).toBe(false);
  });
});
