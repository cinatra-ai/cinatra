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
// CANONICAL RECORD (`installed_extension.widget_auth_token_keys`, surfaced on the
// anchor) declares this exact token key (P5 — the TAMPER-PROOF declaration
// source, owner ruling 2026-07-23), and is UNIQUE (P6). Every missing/ambiguous/
// tampered factor fails closed, and an infra error fails closed (null, never
// throw-through).

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

/** A trusted install anchor bound to a concrete digest. Carries the CANONICAL
 * RECORD's recorded widget-auth token keys (P5's tamper-proof source) and the
 * derived org (the org-scope veto axis). Both default to the happy path; each
 * test overrides exactly the factor under test. */
function anchor(opts?: {
  digest?: string | undefined;
  orgId?: string | null;
  tokenKeys?: string[] | null;
}): InstallTrustAnchor {
  return {
    digest: "digest" in (opts ?? {}) ? opts!.digest : DIGEST,
    kind: "connector",
    integrity: "sha512-abc",
    contentHash: "sha256-def",
    registryUrl: null,
    orgId: opts?.orgId ?? null,
    // A recorded declaration including the token key by default; `null` models a
    // LEGACY row (pre-recorder) → arm (c) must fail closed on it.
    widgetAuthTokenKeys: opts && "tokenKeys" in opts ? opts.tokenKeys ?? null : [TOKEN_KEY],
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
      ...prov,
    },
  };
}

describe("widget-auth-provider — install-provenance arm (empty tree + no grant / released-image rider)", () => {
  beforeEach(() => {
    __resetCapabilityRegistry();
    __resetSignedTrustedRegistry();
  });

  it("resolves a signed, live-provider, anchor+integrity-verified, RECORD-declaring owner (P1–P6 all hold)", async () => {
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
    expect(
      await resolveWordPressWidgetAuth(deps({ resolveInstallAnchor: async () => anchor({ digest: undefined }) })),
    ).toBeNull();
  });

  it("P4 — REJECTS when the anchor-bound store fails INTEGRITY verification (tampered/swapped store) → fail closed", async () => {
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    markPackageSignedActivated(RPKG);
    // resolveVerifiedStoreDir returns null on any integrity/kind/digest mismatch.
    expect(await resolveWordPressWidgetAuth(deps({ resolveVerifiedStoreDir: async () => null }))).toBeNull();
  });

  it("P5 — REJECTS when the CANONICAL RECORD does NOT declare this token key → fail closed", async () => {
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    markPackageSignedActivated(RPKG);
    expect(
      await resolveWordPressWidgetAuth(
        deps({ resolveInstallAnchor: async () => anchor({ tokenKeys: ["some_other_key"] }) }),
      ),
    ).toBeNull();
  });

  it("P5 (LEGACY ROW) — REJECTS when the canonical `widget_auth_token_keys` column is NULL (pre-recorder) → fail closed, never guessed", async () => {
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    markPackageSignedActivated(RPKG);
    // A legacy row installed before the recorder: null column. Even though the
    // store integrity-verifies (P4 passes), the resolver NEVER falls back to
    // re-reading the store — a null record is fail-closed.
    expect(
      await resolveWordPressWidgetAuth(deps({ resolveInstallAnchor: async () => anchor({ tokenKeys: null }) })),
    ).toBeNull();
  });

  it("P5 (TAMPER-PROOF) — the RECORD is authoritative: a store that would declare the key cannot override a record that does not", async () => {
    // Models the P4→P5 TOCTOU an on-disk attacker previously raced: the store dir
    // (P4) verifies AND would declare the key if re-read, but the canonical record
    // (the DB) does NOT declare it. Reading the record — not the store — fails
    // closed. `resolveVerifiedStoreDir` succeeds (store present + integrity ok);
    // the anchor's record declares a different key.
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    markPackageSignedActivated(RPKG);
    expect(
      await resolveWordPressWidgetAuth(
        deps({
          resolveVerifiedStoreDir: async () => ({ storeDir: "/tampered/store/declares/key", digest: DIGEST }),
          resolveInstallAnchor: async () => anchor({ tokenKeys: [] }),
        }),
      ),
    ).toBeNull();
  });

  it("P6 — REJECTS when TWO distinct signed packages both declare the store key (ambiguous) → fail closed", async () => {
    const other = "@acme/other-wp-connector";
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    registerCapabilityProvider(CAPABILITY, { packageName: other, impl: validStore });
    markPackageSignedActivated(RPKG);
    markPackageSignedActivated(other);
    // Both resolve a digest-bound, integrity-verified anchor whose record declares the key.
    expect(await resolveWordPressWidgetAuth(deps())).toBeNull();
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
    // The spoofer is signed + has a provider, but its CANONICAL RECORD does NOT
    // declare the token key (P5) — only the real RPKG's record does.
    registerCapabilityProvider(CAPABILITY, { packageName: spoofer, impl: validStore });
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    markPackageSignedActivated(spoofer);
    markPackageSignedActivated(RPKG);
    const store = await requireWordPressWidgetAuth(
      deps({
        resolveInstallAnchor: async (pkg) =>
          pkg === RPKG ? anchor({ tokenKeys: [TOKEN_KEY] }) : anchor({ tokenKeys: ["not_this_store"] }),
      }),
    );
    expect(store.read()?.apiKey).toBe("rk");
  });
});

// ---------------------------------------------------------------------------
// GRANT-DECISION VETO — a provenance owner whose ownership grant is explicitly
// revoked/pending is NOT overridden. Vetoed at the anchor's derived ORG scope
// AND global (owner ruling 2026-07-23): an org-anchored install writes its grant
// at its org, so a global-only veto would miss an org-scoped revoke/pending.
// ---------------------------------------------------------------------------

/** Build ownershipGrantDeps whose grant-store query returns a row of `status`
 * at the requested SCOPE (`"org"` binds org_id=$3 to `orgId`; `"global"` binds
 * org_id IS NULL), and never an approved arm-(b) owner (so the union is empty and
 * arm (c) runs). `"none"` returns no grant row at any scope. */
function vetoGrantDeps(opts: {
  scope: "org" | "global";
  status: "revoked" | "pending" | "approved";
  orgId: string | null;
}): NonNullable<WidgetAuthResolveDeps["ownershipGrantDeps"]> {
  return {
    schema: "cinatra",
    query: async <T = unknown>(text: string, values?: readonly unknown[]): Promise<T[]> => {
      // arm (b) approved-owner probe → never an approved owner (union empty).
      if (text.includes("status = 'approved'")) return [] as T[];
      // readOwnershipGrant row read (SELECT id, package_name, …).
      if (!text.includes("SELECT id, package_name")) return [] as T[];
      const isGlobalQuery = text.includes("org_id IS NULL");
      const wantGlobal = opts.scope === "global";
      const matchesScope = isGlobalQuery
        ? wantGlobal
        : !wantGlobal && (values?.[2] ?? null) === opts.orgId;
      if (!matchesScope) return [] as T[];
      return [
        {
          id: "g1",
          package_name: RPKG,
          org_id: isGlobalQuery ? null : opts.orgId,
          token_config_key: TOKEN_KEY,
          manifest_binding_hash: "h",
          status: opts.status,
          approved_by: opts.status === "approved" ? "admin" : null,
        },
      ] as T[];
    },
  };
}

function vetoDeps(
  grant: NonNullable<WidgetAuthResolveDeps["ownershipGrantDeps"]>,
  anchorOrgId: string | null,
): WidgetAuthResolveDeps {
  return {
    installProvenanceDeps: {
      resolveInstallAnchor: async () => anchor({ orgId: anchorOrgId }),
      resolveVerifiedStoreDir: async () => ({ storeDir: "/verified/store", digest: DIGEST }),
    },
    ownershipGrantDeps: grant,
  };
}

describe("widget-auth-provider — grant-decision veto (GLOBAL scope)", () => {
  beforeEach(() => {
    __resetCapabilityRegistry();
    __resetSignedTrustedRegistry();
  });

  it("VETOES a provenance owner whose GLOBAL grant is explicitly REVOKED → fail closed", async () => {
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    markPackageSignedActivated(RPKG);
    expect(
      await resolveWordPressWidgetAuth(vetoDeps(vetoGrantDeps({ scope: "global", status: "revoked", orgId: null }), null)),
    ).toBeNull();
  });

  it("VETOES a provenance owner whose GLOBAL grant is still PENDING → fail closed", async () => {
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    markPackageSignedActivated(RPKG);
    expect(
      await resolveWordPressWidgetAuth(vetoDeps(vetoGrantDeps({ scope: "global", status: "pending", orgId: null }), null)),
    ).toBeNull();
  });

  it("RESOLVES a provenance owner when NO grant row exists at any scope (the auto-staged rider — never requested)", async () => {
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    markPackageSignedActivated(RPKG);
    const store = await requireWordPressWidgetAuth(
      vetoDeps({ schema: "cinatra", query: async () => [] }, "org-anchored-1"),
    );
    expect(store.read()?.apiKey).toBe("rk");
  });
});

describe("widget-auth-provider — grant-decision veto (ORG scope — owner ruling 2026-07-23)", () => {
  const ORG = "org-anchored-1";
  beforeEach(() => {
    __resetCapabilityRegistry();
    __resetSignedTrustedRegistry();
  });

  it("VETOES a provenance owner whose ORG-scoped grant (at the anchor's derived org) is REVOKED → fail closed (was missed by a global-only veto)", async () => {
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    markPackageSignedActivated(RPKG);
    expect(
      await resolveWordPressWidgetAuth(vetoDeps(vetoGrantDeps({ scope: "org", status: "revoked", orgId: ORG }), ORG)),
    ).toBeNull();
  });

  it("VETOES a provenance owner whose ORG-scoped grant is still PENDING → fail closed", async () => {
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    markPackageSignedActivated(RPKG);
    expect(
      await resolveWordPressWidgetAuth(vetoDeps(vetoGrantDeps({ scope: "org", status: "pending", orgId: ORG }), ORG)),
    ).toBeNull();
  });

  it("does NOT veto when the ORG-scoped grant is APPROVED and no non-approved global row exists → resolves", async () => {
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    markPackageSignedActivated(RPKG);
    const store = await requireWordPressWidgetAuth(
      vetoDeps(vetoGrantDeps({ scope: "org", status: "approved", orgId: ORG }), ORG),
    );
    expect(store.read()?.apiKey).toBe("rk");
  });

  it("a GLOBAL-only anchor (orgId null) reads ONLY the global scope (no spurious org query) → resolves with no grant row", async () => {
    registerCapabilityProvider(CAPABILITY, { packageName: RPKG, impl: validStore });
    markPackageSignedActivated(RPKG);
    let sawOrgQuery = false;
    const spyGrant: NonNullable<WidgetAuthResolveDeps["ownershipGrantDeps"]> = {
      schema: "cinatra",
      query: async <T>(text: string): Promise<T[]> => {
        if (text.includes("SELECT id, package_name") && text.includes("org_id = $3")) sawOrgQuery = true;
        return [] as T[];
      },
    };
    const store = await requireWordPressWidgetAuth(vetoDeps(spyGrant, null));
    expect(store.read()?.apiKey).toBe("rk");
    expect(sawOrgQuery).toBe(false);
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
