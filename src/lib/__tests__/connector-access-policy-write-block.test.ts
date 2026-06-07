// The legacy connector_access_policy write helpers are blocked.
// New connector access config must go through the polymorphic model
// (setExtensionInstallAccess / saveExtensionAccessPolicy); these throw loud so
// a stray new caller is caught immediately instead of silently writing to the
// deprecated authority.

import { describe, expect, it } from "vitest";

import {
  upsertConnectorAccessPolicy,
  batchUpsertConnectorPoliciesForFixture,
  deleteConnectorAccessPolicy,
} from "@/lib/connector-policy-store";

describe("connector_access_policy write block", () => {
  it("upsertConnectorAccessPolicy throws", () => {
    expect(() =>
      upsertConnectorAccessPolicy({
        orgId: "o1",
        packageId: "@cinatra-ai/x-connector",
        ownerUserId: "u1",
        visibility: "workspace",
      }),
    ).toThrow(/deprecated/i);
  });

  it("batchUpsertConnectorPoliciesForFixture throws", () => {
    expect(() => batchUpsertConnectorPoliciesForFixture([], "dev-fixture-v1")).toThrow(
      /deprecated/i,
    );
  });

  it("deleteConnectorAccessPolicy throws", () => {
    expect(() => deleteConnectorAccessPolicy("o1", "@cinatra-ai/x-connector")).toThrow(
      /deprecated/i,
    );
  });
});
