// Owner ruling 2026-07-23 (widget-auth delivery fix, path B) — the
// marketplace-install-PROVENANCE owner arm (arm (c)) of the widget-auth
// resolver.
//
// Simulates a RELEASED IMAGE with NO baked widget connector by mocking an EMPTY
// `GENERATED_WIDGET_STREAM_AGENTS` (build arm → null) AND no admin ownership
// grant (grant arm → null), so the build ∪ grant union is empty and the
// install-provenance FALLBACK is the only arm that can resolve — the exact
// released-image rider gap. The matrix pins the fail-closed rule (P1–P6): a
// provenance owner resolves ONLY when it has a live guarded provider (P1),
// classifies trusted-signed+activated (P2), has a trusted install anchor bound
// to a digest (P3), whose materialized store integrity-verifies (P4) and whose
// verified manifest declares this exact token key (P5), and is UNIQUE (P6).
// Every missing/ambiguous/tampered factor fails closed, and an infra error
// fails closed (null, never throw-through).

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
import type { InstallProvenanceDeps } from "@/lib/widget-auth-install-provenance";
import type { InstallTrustAnchor } from "@/lib/extension-package-store";

const CAPABILITY = "@cinatra-ai/host:wordpress-widget-auth";
const TOKEN_KEY = "wordpress_widget_auth";
const RPKG = "@acme/wordpress-runtime-connector";
const DIGEST = "sha256:deadbeef";

const validStore = {
  read: () => ({ apiKey: "rk", webhookSecret: "rs", generatedAt: "2026-03-01T00:00:00Z" }),
  generate: () => ({ apiKey: "rk2", webhookSecret: "rs2", generatedAt: "2026-03-02T00:00:00Z" }),
};

/** A trusted install anchor bound to a concrete digest (its shape is inert here —
 * `resolveVerifiedStoreDir` is injected — but `.digest` truthiness gates P3). */
function anchor(digest: string | undefined = DIGEST): InstallTrustAnchor {
  return {
    digest,
    kind: "connector",
    integrity: "sha512-abc",
    contentHash: "sha256-def",
    registryUrl: null,
  } as unknown as InstallTrustAnchor;
}

/** Grant arm ALWAYS null here (no approved grant) so the union is empty and the
 * provenance fallback is exercised. Provenance seams default to a full happy
 * path; each test overrides exactly the factor under test. */
function deps(prov?: Partial<InstallProvenanceDeps>): WidgetAuthResolveDeps {
  return {
    ownershipGrantDeps: { schema: "cinatra", query: async () => [] },
    installProvenanceDeps: {
      resolveInstallAnchor: async () => anchor(),
      resolveVerifiedStoreDir: async () => ({ storeDir: "/verified/store", digest: DIGEST }),
      readDeclaredTokenKeys: async () => [TOKEN_KEY],
      ...prov,
    },
  };
}

describe("widget-auth-provider — install-provenance arm (empty tree + no grant / released-image rider)", () => {
  beforeEach(() => {
    __resetCapabilityRegistry();
    __resetSignedTrustedRegistry();
  });

  it("resolves a signed, live-provider, anchor+integrity-verified, store-declaring owner (P1–P6 all hold)", async () => {
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    markPackageSignedActivated(RPKG);
    const store = await requireWordPressWidgetAuth(deps());
    expect(store.read()?.apiKey).toBe("rk");
    expect(store.generate().webhookSecret).toBe("rs2");
  });

  it("P1 — REJECTS when there is NO live provider (a bare grant/manifest is not enough) → fail closed", async () => {
    // signed + full provenance seams, but no registered provider ⇒ no candidate.
    markPackageSignedActivated(RPKG);
    expect(await resolveWordPressWidgetAuth(deps())).toBeNull();
  });

  it("P2 — REJECTS a provider-backed, provenance-complete package that is NOT trusted-signed → fail closed", async () => {
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    // no markPackageSignedActivated(RPKG)
    expect(await resolveWordPressWidgetAuth(deps())).toBeNull();
  });

  it("P3 — REJECTS when NO trusted install anchor resolves (unfinalized/legacy row) → fail closed", async () => {
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    markPackageSignedActivated(RPKG);
    expect(await resolveWordPressWidgetAuth(deps({ resolveInstallAnchor: async () => null }))).toBeNull();
  });

  it("P3 — REJECTS when the anchor carries NO bound digest (placeholder integrity) → fail closed", async () => {
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    markPackageSignedActivated(RPKG);
    const noDigest = { kind: "connector", integrity: "x", contentHash: "y", registryUrl: null } as unknown as InstallTrustAnchor;
    expect(
      await resolveWordPressWidgetAuth(deps({ resolveInstallAnchor: async () => noDigest })),
    ).toBeNull();
  });

  it("P4 — REJECTS when the anchor-bound store fails INTEGRITY verification (tampered/swapped store) → fail closed", async () => {
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    markPackageSignedActivated(RPKG);
    // resolveVerifiedStoreDir returns null on any integrity/kind/digest mismatch.
    expect(await resolveWordPressWidgetAuth(deps({ resolveVerifiedStoreDir: async () => null }))).toBeNull();
  });

  it("P5 — REJECTS when the integrity-verified manifest does NOT declare this token key → fail closed", async () => {
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    markPackageSignedActivated(RPKG);
    expect(
      await resolveWordPressWidgetAuth(deps({ readDeclaredTokenKeys: async () => ["some_other_key"] })),
    ).toBeNull();
  });

  it("P6 — REJECTS when TWO distinct signed packages both declare the store key (ambiguous) → fail closed", async () => {
    const other = "@acme/other-wp-connector";
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    registerCapabilityProvider(CAPABILITY, { packageName: other, impl: validStore });
    markPackageSignedActivated(RPKG);
    markPackageSignedActivated(other);
    // Both resolve a digest-bound, integrity-verified store declaring the key.
    expect(await resolveWordPressWidgetAuth(deps())).toBeNull();
  });

  it("P5 — REJECTS when integrity RE-VERIFY after the declaration read drifts (P4->P5 TOCTOU defense)", async () => {
    // The store passes the first verify + declares the key, but a second verify
    // (immediately after the declaration read) returns a DIFFERENT digest — a
    // package.json swapped to fake the declaration would fail to re-hash. The
    // candidate must be refused.
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    markPackageSignedActivated(RPKG);
    let call = 0;
    const drifting = deps({
      resolveVerifiedStoreDir: async () => {
        call += 1;
        return call === 1
          ? { storeDir: "/verified/store", digest: DIGEST }
          : { storeDir: "/verified/store", digest: "sha256:SWAPPED" };
      },
    });
    expect(await resolveWordPressWidgetAuth(drifting)).toBeNull();
  });

  it("FAILS CLOSED (null, not throw-through) when the provenance lookup itself errors", async () => {
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    markPackageSignedActivated(RPKG);
    const boom = deps({
      resolveInstallAnchor: async () => {
        throw new Error("simulated install-anchor store outage");
      },
    });
    expect(await resolveWordPressWidgetAuth(boom)).toBeNull();
    await expect(requireWordPressWidgetAuth(boom)).rejects.toThrow(/no unique trusted owner/);
  });

  it("requireWordPressWidgetAuth throws the descriptive fail-closed error naming the provenance path", async () => {
    // No provider at all ⇒ no owner from any arm.
    await expect(requireWordPressWidgetAuth(deps())).rejects.toThrow(
      /marketplace-installed connector with a trusted install anchor/,
    );
  });

  it("resolves the SAME package the provider registered — never a same-id provider from another package (anti-spoof)", async () => {
    const spoofer = "@evil/widget-spoofer";
    // The spoofer is signed + has a provider, but its verified manifest does NOT
    // declare the token key (P5) — only the real RPKG does.
    registerCapabilityProvider(CAPABILITY, { packageName: spoofer, impl: validStore });
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    markPackageSignedActivated(spoofer);
    markPackageSignedActivated(RPKG);
    const store = await requireWordPressWidgetAuth(
      deps({
        readDeclaredTokenKeys: async (storeDir) => (storeDir === "/verified/real" ? [TOKEN_KEY] : []),
        resolveVerifiedStoreDir: async (pkg) =>
          pkg === RPKG ? { storeDir: "/verified/real", digest: DIGEST } : { storeDir: "/verified/spoof", digest: DIGEST },
      }),
    );
    expect(store.read()?.apiKey).toBe("rk");
  });
});

describe("widget-auth-provider — grant-decision veto (an explicit revoked/pending grant is NOT overridden by provenance)", () => {
  beforeEach(() => {
    __resetCapabilityRegistry();
    __resetSignedTrustedRegistry();
  });

  // A full provenance owner (P1–P6 all hold) BUT with a grant-store query that
  // returns NO approved owner for arm (b) (so the union is empty and arm (c)
  // runs) while `readOwnershipGrant` returns a row of the given status for the
  // resolved owner.
  function vetoDeps(status: "revoked" | "pending" | "approved" | "none"): WidgetAuthResolveDeps {
    return {
      installProvenanceDeps: {
        resolveInstallAnchor: async () => anchor(),
        resolveVerifiedStoreDir: async () => ({ storeDir: "/verified/store", digest: DIGEST }),
        readDeclaredTokenKeys: async () => [TOKEN_KEY],
      },
      ownershipGrantDeps: {
        schema: "cinatra",
        query: async <T>(text: string): Promise<T[]> => {
          // arm (b) approved-owner probe → never an approved owner (union empty).
          if (text.includes("status = 'approved'")) return [] as T[];
          // readOwnershipGrant row read (SELECT id, package_name, …).
          if (text.includes("SELECT id, package_name") && status !== "none") {
            return [
              {
                id: "g1",
                package_name: RPKG,
                org_id: null,
                token_config_key: TOKEN_KEY,
                manifest_binding_hash: "h",
                status,
                approved_by: status === "approved" ? "admin" : null,
              },
            ] as T[];
          }
          return [] as T[];
        },
      },
    };
  }

  it("VETOES a provenance owner whose global grant is explicitly REVOKED → fail closed", async () => {
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    markPackageSignedActivated(RPKG);
    expect(await resolveWordPressWidgetAuth(vetoDeps("revoked"))).toBeNull();
  });

  it("VETOES a provenance owner whose global grant is still PENDING (admin has not approved) → fail closed", async () => {
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    markPackageSignedActivated(RPKG);
    expect(await resolveWordPressWidgetAuth(vetoDeps("pending"))).toBeNull();
  });

  it("RESOLVES a provenance owner when NO grant row exists (the auto-staged rider — never requested)", async () => {
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    markPackageSignedActivated(RPKG);
    const store = await requireWordPressWidgetAuth(vetoDeps("none"));
    expect(store.read()?.apiKey).toBe("rk");
  });
});

describe("widget-auth-provider — fallback ordering (grant arm wins; provenance is consulted only when the union is empty)", () => {
  beforeEach(() => {
    __resetCapabilityRegistry();
    __resetSignedTrustedRegistry();
  });

  it("uses the GRANT owner and does NOT consult provenance when an admin grant resolves", async () => {
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    markPackageSignedActivated(RPKG);
    // A provenance seam that would THROW if consulted proves the fallback is
    // short-circuited by a present grant.
    const provenanceMustNotRun: WidgetAuthResolveDeps = {
      ownershipGrantDeps: {
        schema: "cinatra",
        query: async <T>(text: string): Promise<T[]> =>
          (text.includes("SELECT package_name") && text.includes("org_id IS NULL")
            ? [{ package_name: RPKG }]
            : []) as T[],
      },
      installProvenanceDeps: {
        resolveInstallAnchor: async () => {
          throw new Error("provenance arm must NOT run when the grant arm resolves");
        },
      },
    };
    const store = await requireWordPressWidgetAuth(provenanceMustNotRun);
    expect(store.read()?.apiKey).toBe("rk");
  });
});
