import { describe, expect, it, vi } from "vitest";

/**
 * A READ probe must survive an identity store that cannot answer.
 *
 * The instance identity lives in Postgres. When no database is configured — or
 * one is configured and refuses the connection — reading it throws. The read
 * resolvers answer `null` on a miss, so a vendor-segment lookup for a READ has
 * to degrade to the first-party default instead of turning an unrelated
 * handler call into an uncaught connection error. (The WRITE-side resolver
 * stays fail-closed: a write must not land under a segment nobody named.)
 */
const identity = vi.hoisted(() => ({
  readInstanceIdentity: vi.fn(() => {
    throw new Error("ECONNREFUSED");
  }),
}));

vi.mock("@/lib/instance-identity-store", () => identity);

import {
  DEFAULT_VENDOR_SEGMENT,
  resolveInstanceVendorSegment,
  safeVendorSegmentsForRead,
} from "../mcp/agent-source-paths";

describe("vendor-segment resolution when the identity store cannot answer", () => {
  it("degrades the READ candidates to the first-party default", () => {
    expect(safeVendorSegmentsForRead()).toEqual([DEFAULT_VENDOR_SEGMENT]);
    expect(identity.readInstanceIdentity).toHaveBeenCalled();
  });

  it("leaves the WRITE-side resolver fail-closed", () => {
    expect(() => resolveInstanceVendorSegment()).toThrow();
  });
});
