import { describe, it, expect, afterEach } from "vitest";

import {
  getNamespaceMutabilityCopy,
  getNetworkParticipationCopy,
  isMarketplaceManagedInstance,
} from "../instance-identity-copy";

describe("getNamespaceMutabilityCopy", () => {
  it("never asserts the namespace cannot be changed", () => {
    for (const managed of [true, false]) {
      const copy = getNamespaceMutabilityCopy(managed);
      expect(copy.toLowerCase()).not.toContain("cannot be changed");
      expect(copy.toLowerCase()).not.toContain("can't be changed");
    }
  });

  it("states all four mutability states for an ordinary install", () => {
    const copy = getNamespaceMutabilityCopy(false);
    expect(copy).toMatch(/Administration/); // (1) freely editable post-setup
    expect(copy).toMatch(/pending or approved/); // (2) locked while vendor app pending/approved
    expect(copy).toMatch(/publish your first extension/); // (4) frozen at first publish
    expect(copy).toMatch(/rename flow/); // the escape stays reachable
  });

  it("adds the marketplace-managed non-renameable state for a marketplace-managed install", () => {
    const ordinary = getNamespaceMutabilityCopy(false);
    const managed = getNamespaceMutabilityCopy(true);
    expect(managed).toMatch(/marketplace-managed/i);
    expect(managed).toMatch(/isn.t supported yet/i);
    expect(managed).not.toBe(ordinary);
  });
});

describe("getNetworkParticipationCopy", () => {
  it("states local provisioning + opt-in vendor registration for an ordinary install", () => {
    const copy = getNetworkParticipationCopy(false);
    expect(copy).toMatch(/provisions your namespace locally/);
    expect(copy).toMatch(/registers nothing by itself/);
    expect(copy).toMatch(/anonymously/);
    expect(copy).toMatch(/opt-in/);
  });

  it("states marketplace reservation/registration for a marketplace-managed install", () => {
    const copy = getNetworkParticipationCopy(true);
    expect(copy).toMatch(/reserves and registers/);
    expect(copy).toMatch(/Cinatra Marketplace/);
  });

  it("the two modes render different copy", () => {
    expect(getNetworkParticipationCopy(true)).not.toBe(getNetworkParticipationCopy(false));
  });
});

describe("isMarketplaceManagedInstance", () => {
  const originalToken = process.env.MARKETPLACE_INSTANCE_TOKEN;

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.MARKETPLACE_INSTANCE_TOKEN;
    } else {
      process.env.MARKETPLACE_INSTANCE_TOKEN = originalToken;
    }
  });

  it("is false when the env var is unset", () => {
    delete process.env.MARKETPLACE_INSTANCE_TOKEN;
    expect(isMarketplaceManagedInstance()).toBe(false);
  });

  it("is false for a whitespace-only value", () => {
    process.env.MARKETPLACE_INSTANCE_TOKEN = "   ";
    expect(isMarketplaceManagedInstance()).toBe(false);
  });

  it("is true when a non-empty token is set", () => {
    process.env.MARKETPLACE_INSTANCE_TOKEN = "mkt_abc123";
    expect(isMarketplaceManagedInstance()).toBe(true);
  });
});
