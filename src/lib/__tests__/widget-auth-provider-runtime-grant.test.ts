// engineering#534 S1 — the RUNTIME owner arm of the widget-auth resolver.
//
// Simulates a RELEASED IMAGE with NO baked widget connector by mocking an EMPTY
// `GENERATED_WIDGET_STREAM_AGENTS` (the build-time arm resolves to null), so a
// MARKETPLACE-installed connector must become the owner purely via the
// admin-approved capability-ownership grant (S0). This is the exact gap the
// issue exists to close. The matrix pins the fail-closed contract: a runtime
// owner resolves ONLY when it holds the unique approved GLOBAL grant AND has a
// live registered provider AND currently classifies trusted-signed+activated;
// every missing factor (unsigned/bootstrap, no provider, no grant, org-only
// grant, lookup error) fails closed.

import { describe, expect, it, beforeEach, vi } from "vitest";

// Released-image posture: nothing baked into the generated widget-stream tree.
vi.mock("@/lib/generated/extensions.server", () => ({
  GENERATED_WIDGET_STREAM_AGENTS: {},
}));

import {
  registerCapabilityProvider,
  __resetCapabilityRegistry,
  markPackageSignedActivated,
  __resetSignedTrustedRegistry,
} from "@/lib/extension-capabilities-registry";
import {
  resolveWordPressWidgetAuth,
  requireWordPressWidgetAuth,
  type WidgetAuthResolveDeps,
} from "@/lib/widget-auth-provider";

const CAPABILITY = "@cinatra-ai/host:wordpress-widget-auth";
const RPKG = "@acme/wordpress-runtime-connector";

const validStore = {
  read: () => ({ apiKey: "rk", webhookSecret: "rs", generatedAt: "2026-02-01T00:00:00Z" }),
  generate: () => ({ apiKey: "rk2", webhookSecret: "rs2", generatedAt: "2026-02-02T00:00:00Z" }),
};

// Grant-store stub. `approvedGlobal` = the package the GLOBAL approved-owner
// SELECT returns; `approvedOrg` = a package returned ONLY by the org-scoped
// SELECT (used to prove org-scoped grants are ignored at these org-agnostic
// callers). The real resolveOwnershipOwner queries org first ONLY when orgId is
// non-null; S1 always passes orgId:null, so only the global branch runs.
function deps(opts: { approvedGlobal?: string | null; approvedOrg?: string | null }): WidgetAuthResolveDeps {
  return {
    ownershipGrantDeps: {
      schema: "cinatra",
      query: async <T>(text: string): Promise<T[]> => {
        const isOwnerSelect = text.includes("SELECT package_name") && text.includes("status = 'approved'");
        if (!isOwnerSelect) return [] as T[];
        if (text.includes("org_id IS NULL")) {
          return (opts.approvedGlobal ? [{ package_name: opts.approvedGlobal }] : []) as T[];
        }
        // org-scoped branch (org_id = $2) — only reached if orgId were non-null.
        return (opts.approvedOrg ? [{ package_name: opts.approvedOrg }] : []) as T[];
      },
    },
  };
}

const depsThrowing: WidgetAuthResolveDeps = {
  ownershipGrantDeps: {
    schema: "cinatra",
    query: async () => {
      throw new Error("simulated grant-store outage");
    },
  },
};

describe("widget-auth-provider — runtime grant arm (empty generated tree / released image)", () => {
  beforeEach(() => {
    __resetCapabilityRegistry();
    __resetSignedTrustedRegistry();
  });

  it("resolves a runtime owner that is signed-activated + provider-backed + approved-granted", async () => {
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    markPackageSignedActivated(RPKG);
    const store = await requireWordPressWidgetAuth(deps({ approvedGlobal: RPKG }));
    expect(store.read()?.apiKey).toBe("rk");
    expect(store.generate().webhookSecret).toBe("rs2");
  });

  it("REJECTS a granted, provider-backed owner that is NOT trusted-signed (bootstrap/untrusted) → fail closed", async () => {
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    // no markPackageSignedActivated(RPKG)
    expect(await resolveWordPressWidgetAuth(deps({ approvedGlobal: RPKG }))).toBeNull();
    await expect(requireWordPressWidgetAuth(deps({ approvedGlobal: RPKG }))).rejects.toThrow(
      /no unique trusted owner/,
    );
  });

  it("REJECTS a signed, granted owner that has NO live provider → fail closed", async () => {
    markPackageSignedActivated(RPKG);
    // no provider registered
    expect(await resolveWordPressWidgetAuth(deps({ approvedGlobal: RPKG }))).toBeNull();
  });

  it("REJECTS when there is NO approved grant, even with a signed provider present → fail closed", async () => {
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    markPackageSignedActivated(RPKG);
    expect(await resolveWordPressWidgetAuth(deps({ approvedGlobal: null }))).toBeNull();
  });

  it("IGNORES an ORG-SCOPED grant at these org-agnostic callers (global scope only) → fail closed", async () => {
    // The package is the approved owner ONLY at an org scope; the global SELECT
    // returns nothing. S1 resolves at orgId:null, so the org grant never applies.
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    markPackageSignedActivated(RPKG);
    expect(await resolveWordPressWidgetAuth(deps({ approvedGlobal: null, approvedOrg: RPKG }))).toBeNull();
  });

  it("FAILS CLOSED (null, not throw-through) when the grant lookup itself throws", async () => {
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    markPackageSignedActivated(RPKG);
    expect(await resolveWordPressWidgetAuth(depsThrowing)).toBeNull();
    await expect(requireWordPressWidgetAuth(depsThrowing)).rejects.toThrow(/no unique trusted owner/);
  });

  it("REJECTS a signed provider under a DIFFERENT package than the approved grant (anti-spoof)", async () => {
    // The grant approves RPKG, but only a same-id provider from a DIFFERENT
    // package is live and signed → the RPKG candidate has no provider → null.
    const spoofer = "@evil/widget-spoofer";
    registerCapabilityProvider(CAPABILITY, { packageName: spoofer, impl: validStore });
    markPackageSignedActivated(spoofer);
    expect(await resolveWordPressWidgetAuth(deps({ approvedGlobal: RPKG }))).toBeNull();
  });
});
