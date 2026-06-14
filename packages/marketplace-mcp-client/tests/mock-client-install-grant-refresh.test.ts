/**
 * Exercises the mock client's `extensionInstallGrantRefresh` (gatekept install
 * grant REFRESH, #162). The mock auto-extends a deterministic stub when no
 * fixture matches, supports per-grant fixtures, throws a supplied
 * MarketplaceMcpError to simulate a refusal, and invokes the spy.
 *
 * The contract under test (matching the PHP ability): the refresh output has NO
 * `kind`, and `expires_at` is an INTEGER (Unix epoch SECONDS), not an ISO string.
 */

import { describe, it, expect, vi } from "vitest";

import { createMockMarketplaceMcpClient, MarketplaceMcpError } from "../src/client";
import type { MarketplaceExtensionInstallGrantRefreshOutput } from "../src/types";

describe("mock client — extensionInstallGrantRefresh", () => {
  it("auto-extends a deterministic stub when no fixture matches (epoch-seconds expiry, sha256-empty closure_hash)", async () => {
    const out = await createMockMarketplaceMcpClient().extensionInstallGrantRefresh({
      grant: "current.grant",
    });
    expect(typeof out.grant).toBe("string");
    expect(out.grant.length).toBeGreaterThan(0);
    expect(out.broker_base_url).toContain("/install/v1");
    expect(out.closure).toEqual([]);
    // expires_at is an INTEGER (epoch seconds), NOT an ISO string.
    expect(typeof out.expires_at).toBe("number");
    expect(Number.isInteger(out.expires_at)).toBe(true);
    expect(out.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
    // The empty-closure binding hash is sha256("").
    expect(out.closure_hash).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(typeof out.op).toBe("string");
    // The refresh output has NO `kind`.
    expect("kind" in out).toBe(false);
  });

  it("returns a per-grant fixture verbatim", async () => {
    const fixture: MarketplaceExtensionInstallGrantRefreshOutput = {
      grant: "fixed.refreshed.grant",
      resolved_version: "2.0.0",
      broker_base_url: "https://mk.test/install/v1",
      closure: [{ name: "@scope/dep", version: "1.0.0" }],
      expires_at: 1_780_000_000,
      closure_hash: "b".repeat(64),
      op: "op-fixed",
    };
    const client = createMockMarketplaceMcpClient({
      installGrantRefreshes: { "current.grant": fixture },
    });
    const out = await client.extensionInstallGrantRefresh({ grant: "current.grant" });
    expect(out).toEqual(fixture);
  });

  it("throws a supplied MarketplaceMcpError to simulate a refusal (e.g. 409 closure_changed)", async () => {
    const client = createMockMarketplaceMcpClient({
      installGrantRefreshes: {
        "current.grant": new MarketplaceMcpError("closure_changed", 409, ""),
      },
    });
    const err = await client
      .extensionInstallGrantRefresh({ grant: "current.grant" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(MarketplaceMcpError);
    expect((err as MarketplaceMcpError).httpStatus).toBe(409);
  });

  it("invokes the onInstallGrantRefresh spy with the input", async () => {
    const spy = vi.fn();
    const client = createMockMarketplaceMcpClient({ onInstallGrantRefresh: spy });
    await client.extensionInstallGrantRefresh({ grant: "current.grant" });
    expect(spy).toHaveBeenCalledWith({ grant: "current.grant" });
  });
});
