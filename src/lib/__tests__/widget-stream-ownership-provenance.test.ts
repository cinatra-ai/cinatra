// Owner ruling 2026-07-23 (widget-auth delivery fix, path B — slice 2): the
// widget SESSION MINT (`POST /api/widget-auth/token` → `resolveWidgetStreamAgentUnion`
// → `resolveRuntimeWidgetStreamAgent`) ownership conjunction honors sanctioned
// marketplace-install PROVENANCE for a released-image rider whose store has no
// admin ownership grant.
//
// RELEASED-IMAGE POSTURE. `GENERATED_WIDGET_STREAM_AGENTS` is mocked EMPTY
// (nothing baked → the build arm never resolves → the runtime arm runs), the
// admin-approved widget METADATA grant EXISTS (the pilot's admin approval), but
// the approved ownership GRANT is ABSENT (`resolveOwnershipOwner` → null) — the
// exact auto-staged-rider gap. Before this slice the ownership conjunction (iii)
// fails closed forever (an approved metadata grant alone never mints); this
// matrix pins that the provenance fallback substitutes for the OWNERSHIP-GRANT
// arm ONLY (rule P1–P6 + the org+global veto), that the METADATA-grant gate is
// untouched, and that every factor fails closed. The point-of-use re-asserts
// (`reassertWidgetStreamGrantBeforeOboRun` / `buildWidgetChatTool`) re-derive the
// same provenance ownership live, so an ownership revocation after mint bites.

import { describe, it, expect, vi, type Mock } from "vitest";

// Released image: NOTHING baked → the build arm is empty for every slug.
vi.mock("@/lib/generated/extensions.server", () => ({
  GENERATED_WIDGET_STREAM_AGENTS: {},
}));

import {
  buildWidgetChatTool,
  reassertWidgetStreamGrantBeforeOboRun,
  resolveWidgetStreamAgentUnion,
  type ResolvedWidgetStreamAgent,
  type WidgetStreamRuntimeResolveDeps,
} from "@/lib/widget-stream-agents.server";
import {
  canonicalJsonStringify,
  computeWidgetStreamBindingHashV2,
  type WidgetStreamMetadataCanonV2,
  type WidgetStreamMetadataGrantClaim,
} from "@/lib/extension-capability-ownership-grants";
import type { InstallTrustAnchor } from "@/lib/extension-package-store";
import type { InstallProvenanceDeps } from "@/lib/widget-auth-install-provenance";
import {
  resolveWidgetStreamStoreOwner,
  WIDGET_AUTH_STORE_PROVENANCE_CANDIDATES,
} from "@/lib/widget-stream-ownership-provenance";

// A marketplace RIDER (non-baked vendor). Its own-instances namespace derives to
// `wordpress` (strip `-mcp-connector`), so the canon's tokenConfigKey is the
// reviewed `wordpress_widget_auth` store key.
const PKG = "@acme/wordpress-mcp-connector";
const OTHER = "@acme/squatter-connector";
const SLUG = "wordpress-runtime-editor";
// MUST be the reviewed store key so the provenance-candidate registry has an
// honest (capability, guard) entry — an unknown key gets no fallback.
const TOKEN_KEY = "wordpress_widget_auth";
const RELAY = "@acme/wordpress-agent";
const DIGEST = "a".repeat(64);
const CAP = "@cinatra-ai/host:wordpress-widget-auth";
const ORG = "org-anchored-1";

// ---------------------------------------------------------------------------
// Canon / claim fixtures (REAL canonicalization + hashing)
// ---------------------------------------------------------------------------

function makeCanon(overrides?: Partial<WidgetStreamMetadataCanonV2>): WidgetStreamMetadataCanonV2 {
  return {
    v: 2,
    agentSlug: SLUG,
    packageName: PKG,
    moduleExportKey: "./widget-chat-tool",
    factory: "createWordPressWidgetChatTool",
    relayAgentPackage: RELAY,
    skillCapability: `widget-chat.${SLUG}`,
    contextFields: [{ key: "href", maxLength: 500 }],
    label: "WordPress",
    subjectNoun: "post",
    auth: {
      tokenConfigKey: TOKEN_KEY,
      instancesConfigKey: "wordpress",
      requiredInstanceFields: ["applicationPassword", "id", "name", "username"],
      requireUserToken: true,
    },
    ...overrides,
  };
}

function makeClaim(canon: WidgetStreamMetadataCanonV2): WidgetStreamMetadataGrantClaim {
  return {
    agentSlug: canon.agentSlug,
    packageName: canon.packageName,
    canon,
    canonJson: canonicalJsonStringify(canon),
    bindingHashV2: computeWidgetStreamBindingHashV2(canon),
  };
}

// ---------------------------------------------------------------------------
// METADATA-grant row store (the admin approval that provenance does NOT touch)
// ---------------------------------------------------------------------------

type MetaRow = {
  id: string;
  package_name: string;
  org_id: string | null;
  agent_slug: string;
  binding_hash_v2: string;
  canon_json: string;
  status: string;
  approved_by: string | null;
  revoked_by: string | null;
  revoked_at: string | null;
  row_version: number;
};

function makeMetaRow(overrides?: Partial<MetaRow>): MetaRow {
  const canon = makeCanon();
  return {
    id: "m-1",
    package_name: PKG,
    org_id: null,
    agent_slug: SLUG,
    binding_hash_v2: computeWidgetStreamBindingHashV2(canon),
    canon_json: canonicalJsonStringify(canon),
    status: "approved",
    approved_by: "admin-1",
    revoked_by: null,
    revoked_at: null,
    row_version: 1,
    ...overrides,
  };
}

function metadataQueryFor(rows: () => MetaRow[]) {
  return async <T>(text: string, values?: readonly unknown[]): Promise<T[]> => {
    if (text.includes("ORDER BY agent_slug")) {
      return rows().filter((r) => r.org_id === null && r.status === "approved") as T[];
    }
    if (text.includes("agent_slug = $1 AND org_id IS NULL AND status = 'approved'")) {
      return rows()
        .filter((r) => r.agent_slug === values?.[0] && r.org_id === null && r.status === "approved")
        .slice(0, 2) as T[];
    }
    if (text.includes("package_name = $1 AND agent_slug = $2")) {
      return rows()
        .filter((r) => r.package_name === values?.[0] && r.agent_slug === values?.[1] && r.org_id === null)
        .slice(0, 1) as T[];
    }
    throw new Error(`unexpected metadata-grant SQL: ${text}`);
  };
}

// ---------------------------------------------------------------------------
// OWNERSHIP-grant store: NEVER an approved owner (the grant arm is empty so the
// provenance fallback runs) + a configurable revoked/pending/approved VETO row
// bound to a scope, exactly like the slice-1 veto harness.
// ---------------------------------------------------------------------------

type Veto = { scope: "org" | "global"; status: "revoked" | "pending" | "approved"; orgId: string | null } | null;

function ownershipQueryFor(veto: () => Veto) {
  return async <T>(text: string, values?: readonly unknown[]): Promise<T[]> => {
    // arm (b) approved-owner probe → NEVER an approved owner (union empty).
    if (text.includes("status = 'approved'")) return [] as T[];
    // readOwnershipGrant (SELECT id, package_name, …) — the veto row read.
    if (!text.includes("SELECT id, package_name")) return [] as T[];
    const v = veto();
    if (!v) return [] as T[];
    const isGlobalQuery = text.includes("org_id IS NULL");
    const wantGlobal = v.scope === "global";
    const matches = isGlobalQuery ? wantGlobal : !wantGlobal && (values?.[2] ?? null) === v.orgId;
    if (!matches) return [] as T[];
    return [
      {
        id: "o-1",
        package_name: PKG,
        org_id: isGlobalQuery ? null : v.orgId,
        token_config_key: TOKEN_KEY,
        manifest_binding_hash: "h",
        status: v.status,
        approved_by: v.status === "approved" ? "admin" : null,
      },
    ] as T[];
  };
}

// ---------------------------------------------------------------------------
// The full RELEASED-IMAGE harness: an approved metadata grant + a rider that
// owns the store via PROVENANCE (no ownership grant). Each test overrides one
// factor.
// ---------------------------------------------------------------------------

type ProvControls = {
  /** distinct P1 provider packages the loader activated (default: [PKG]). */
  providerPackages: string[];
  /** provenance trust classification (default: {PKG}). */
  provSigned: Set<string>;
  /** anchor per package (default: a digest-bound anchor declaring TOKEN_KEY). */
  anchorFor: (pkg: string) => InstallTrustAnchor | null;
  /** verified store per package (default: a verified dir at DIGEST). */
  verifiedFor: (pkg: string) => { storeDir: string; digest: string } | null;
};

function anchor(opts?: { digest?: string | undefined; orgId?: string | null; tokenKeys?: string[] | null }): InstallTrustAnchor {
  return {
    digest: opts && "digest" in opts ? opts.digest : DIGEST,
    kind: "connector",
    integrity: "sha512-trusted",
    contentHash: "trusted-content-hash",
    registryUrl: null,
    orgId: opts?.orgId ?? null,
    widgetAuthTokenKeys: opts && "tokenKeys" in opts ? opts.tokenKeys ?? null : [TOKEN_KEY],
  } as unknown as InstallTrustAnchor;
}

type Harness = {
  deps: WidgetStreamRuntimeResolveDeps;
  metaRows: MetaRow[];
  veto: Veto;
  wsSigned: Set<string>;
  claims: WidgetStreamMetadataGrantClaim[];
  prov: ProvControls;
  importModule: Mock<(args: ImportRuntimeModuleArgs) => Promise<unknown>>;
};

type ImportRuntimeModuleArgs = {
  storeDir: string;
  moduleExportKey: string;
  packageName: string;
  agentSlug: string;
  reverifyPinnedIntegrity: () => Promise<boolean>;
};

function makeHarness(overrides?: {
  metaRows?: MetaRow[];
  veto?: Veto;
  wsSigned?: Set<string>;
  claims?: WidgetStreamMetadataGrantClaim[];
  prov?: Partial<ProvControls>;
}): Harness {
  const prov: ProvControls = {
    providerPackages: overrides?.prov?.providerPackages ?? [PKG],
    provSigned: overrides?.prov?.provSigned ?? new Set([PKG]),
    anchorFor: overrides?.prov?.anchorFor ?? (() => anchor()),
    verifiedFor: overrides?.prov?.verifiedFor ?? (() => ({ storeDir: "/verified/store", digest: DIGEST })),
  };
  const h: Harness = {
    metaRows: overrides?.metaRows ?? [makeMetaRow()],
    veto: overrides?.veto ?? null,
    wsSigned: overrides?.wsSigned ?? new Set([PKG, RELAY]),
    claims: overrides?.claims ?? [makeClaim(makeCanon())],
    prov,
    importModule: vi.fn(async (): Promise<unknown> => ({
      createWordPressWidgetChatTool: () => ({
        name: "wp_widget_tool",
        description: "edit the post",
        parameters: { type: "object" },
        execute: async () => "ok",
      }),
    })),
    deps: undefined as unknown as WidgetStreamRuntimeResolveDeps,
  };
  const installProvenanceDeps: InstallProvenanceDeps = {
    listGuardedProviderPackages: () => h.prov.providerPackages,
    isSignedActivated: (pkg) => h.prov.provSigned.has(pkg),
    resolveInstallAnchor: async (pkg) => h.prov.anchorFor(pkg),
    resolveVerifiedStoreDir: async (pkg) => h.prov.verifiedFor(pkg),
  };
  h.deps = {
    metadataGrantDeps: { query: metadataQueryFor(() => h.metaRows) },
    ownershipGrantDeps: { query: ownershipQueryFor(() => h.veto) },
    installProvenanceDeps,
    isSignedActivated: (pkg) => h.wsSigned.has(pkg),
    // The metadata-grant package's OWN anchor/store trust (iv-a/iv-b): the same
    // rider, resolving the same digest-bound, integrity-verified store.
    resolveInstallAnchor: async () => anchor(),
    resolveVerifiedStoreDir: async () => ({ storeDir: "/verified/store", digest: DIGEST }),
    readClaimsFromStore: async () => h.claims,
    importRuntimeModule: (args) => h.importModule(args),
  };
  return h;
}

// ---------------------------------------------------------------------------
// The mint seam — the union resolver's ownership conjunction, provenance arm
// ---------------------------------------------------------------------------

describe("widget-stream session mint — install-provenance ownership arm (released-image rider, no ownership grant)", () => {
  it("SUCCESS: an approved metadata grant + a signed, live-provider, anchor+integrity-verified, RECORD-declaring, UNIQUE rider mints (the conjunction now resolves)", async () => {
    const h = makeHarness();
    const resolved = await resolveWidgetStreamAgentUnion(SLUG, h.deps);
    expect(resolved).not.toBeNull();
    expect(resolved!.grant).not.toBeNull();
    expect(resolved!.grant!.packageName).toBe(PKG);
    expect(resolved!.entry.auth.tokenConfigKey).toBe(TOKEN_KEY);
    // The visitor session token mints off THIS resolved entry's client.
    expect(resolved!.entry.auth.instancesConfigKey).toBe("wordpress");
  });

  it("P1 — no live guarded provider (bare metadata grant, nothing activated) → null (fail closed)", async () => {
    const h = makeHarness({ prov: { providerPackages: [] } });
    expect(await resolveWidgetStreamAgentUnion(SLUG, h.deps)).toBeNull();
  });

  it("P2 — provider-backed + provenance-complete but NOT trusted-signed (provenance axis) → null", async () => {
    const h = makeHarness({ prov: { provSigned: new Set() } });
    expect(await resolveWidgetStreamAgentUnion(SLUG, h.deps)).toBeNull();
  });

  it("P3 — no trusted install anchor (unfinalized/legacy) → null; digest-unbound anchor → null", async () => {
    const noAnchor = makeHarness({ prov: { anchorFor: () => null } });
    expect(await resolveWidgetStreamAgentUnion(SLUG, noAnchor.deps)).toBeNull();
    const unbound = makeHarness({ prov: { anchorFor: () => anchor({ digest: undefined }) } });
    expect(await resolveWidgetStreamAgentUnion(SLUG, unbound.deps)).toBeNull();
  });

  it("P4 — anchor-bound store fails INTEGRITY (tampered/swapped store) → null", async () => {
    const h = makeHarness({ prov: { verifiedFor: () => null } });
    expect(await resolveWidgetStreamAgentUnion(SLUG, h.deps)).toBeNull();
  });

  it("P5 — the CANONICAL RECORD does NOT declare this token key → null", async () => {
    const h = makeHarness({ prov: { anchorFor: () => anchor({ tokenKeys: ["some_other_key"] }) } });
    expect(await resolveWidgetStreamAgentUnion(SLUG, h.deps)).toBeNull();
  });

  it("P5 (LEGACY ROW) — a NULL `widget_auth_token_keys` column (pre-recorder) → null, never guessed / never re-read from the store", async () => {
    const h = makeHarness({ prov: { anchorFor: () => anchor({ tokenKeys: null }) } });
    expect(await resolveWidgetStreamAgentUnion(SLUG, h.deps)).toBeNull();
  });

  it("P5 (TAMPER-PROOF) — the RECORD is authoritative: an integrity-verified store that WOULD declare the key cannot override a record that does not", async () => {
    const h = makeHarness({
      prov: {
        verifiedFor: () => ({ storeDir: "/tampered/store/declares/key", digest: DIGEST }),
        anchorFor: () => anchor({ tokenKeys: [] }),
      },
    });
    expect(await resolveWidgetStreamAgentUnion(SLUG, h.deps)).toBeNull();
  });

  it("P6 — TWO distinct signed packages both declare the store key (ambiguous) → null", async () => {
    const h = makeHarness({
      prov: {
        providerPackages: [PKG, OTHER],
        provSigned: new Set([PKG, OTHER]),
      },
    });
    expect(await resolveWidgetStreamAgentUnion(SLUG, h.deps)).toBeNull();
  });

  it("ANTI-SPOOF — resolves the rider whose RECORD declares the key, never a same-capability squatter whose record does not", async () => {
    // The squatter is signed + a live provider, but only PKG's canonical record
    // declares the token key → PKG is the unique owner; it also holds the metadata
    // grant, so the conjunction resolves to PKG.
    const h = makeHarness({
      prov: {
        providerPackages: [OTHER, PKG],
        provSigned: new Set([PKG, OTHER]),
        anchorFor: (pkg) => (pkg === PKG ? anchor({ tokenKeys: [TOKEN_KEY] }) : anchor({ tokenKeys: ["not_this_store"] })),
      },
    });
    const resolved = await resolveWidgetStreamAgentUnion(SLUG, h.deps);
    expect(resolved).not.toBeNull();
    expect(resolved!.grant!.packageName).toBe(PKG);
  });

  it("CONJUNCTION — a provenance owner that is NOT the metadata-grant package refuses (a package can never ride another package's store)", async () => {
    // Provenance resolves OTHER as the unique store owner, but the metadata grant
    // is held by PKG → owner(OTHER) !== grant.packageName(PKG) → null.
    const h = makeHarness({
      prov: {
        providerPackages: [OTHER],
        provSigned: new Set([OTHER]),
      },
    });
    expect(await resolveWidgetStreamAgentUnion(SLUG, h.deps)).toBeNull();
  });

  it("FAILS CLOSED (null, not throw-through) when the provenance lookup itself errors", async () => {
    const h = makeHarness({
      prov: {
        anchorFor: () => {
          throw new Error("simulated install-anchor store outage");
        },
      },
    });
    expect(await resolveWidgetStreamAgentUnion(SLUG, h.deps)).toBeNull();
  });

  it("METADATA-GATE UNTOUCHED — no approved metadata grant → null even when provenance ownership is perfect (provenance never mints a metadata grant)", async () => {
    const h = makeHarness({ metaRows: [] });
    expect(await resolveWidgetStreamAgentUnion(SLUG, h.deps)).toBeNull();
  });

  it("METADATA-GATE UNTOUCHED — a PENDING/REVOKED metadata grant never resolves even with perfect provenance ownership", async () => {
    for (const status of ["pending", "revoked"]) {
      const h = makeHarness({ metaRows: [makeMetaRow({ status })] });
      expect(await resolveWidgetStreamAgentUnion(SLUG, h.deps)).toBeNull();
    }
  });

});

// ---------------------------------------------------------------------------
// The ownership resolver directly (the P1-candidate registry / honest
// enumeration / fallback ordering / veto — decoupled from the metadata machinery)
// ---------------------------------------------------------------------------

describe("resolveWidgetStreamStoreOwner — honest P1-candidate registry (no wildcard trust)", () => {
  it("the registry contains the reviewed wordpress store key with the wordpress widget-auth capability", () => {
    const entry = WIDGET_AUTH_STORE_PROVENANCE_CANDIDATES.find((c) => c.tokenConfigKey === TOKEN_KEY);
    expect(entry).toBeDefined();
    expect(entry!.capability).toBe(CAP);
    expect(typeof entry!.providerGuard).toBe("function");
  });

  it("an UNKNOWN tokenConfigKey (no reviewed candidate) NEVER consults provenance → null", async () => {
    // A provenance seam that THROWS if consulted proves the registry gates it.
    const owner = await resolveWidgetStreamStoreOwner(
      { tokenConfigKey: "drupal_widget_auth", orgId: null },
      {
        ownershipGrantDeps: { query: async () => [] }, // grant arm empty
        installProvenanceDeps: {
          listGuardedProviderPackages: () => {
            throw new Error("provenance must NOT run for an unregistered store key");
          },
        },
      },
    );
    expect(owner).toBeNull();
  });

  it("the GRANT arm wins for a known key — provenance is never consulted", async () => {
    const owner = await resolveWidgetStreamStoreOwner(
      { tokenConfigKey: TOKEN_KEY, orgId: null },
      {
        ownershipGrantDeps: {
          query: async <T>(text: string): Promise<T[]> =>
            (text.includes("status = 'approved'") ? [{ package_name: PKG }] : []) as T[],
        },
        installProvenanceDeps: {
          listGuardedProviderPackages: () => {
            throw new Error("provenance must NOT run when the grant arm resolves");
          },
        },
      },
    );
    expect(owner).toBe(PKG);
  });

  it("the PROVENANCE fallback resolves a known key when the grant arm is empty", async () => {
    const owner = await resolveWidgetStreamStoreOwner(
      { tokenConfigKey: TOKEN_KEY, orgId: null },
      {
        ownershipGrantDeps: { query: async () => [] },
        installProvenanceDeps: {
          listGuardedProviderPackages: () => [PKG],
          isSignedActivated: () => true,
          resolveInstallAnchor: async () => anchor(),
          resolveVerifiedStoreDir: async () => ({ storeDir: "/verified/store", digest: DIGEST }),
        },
      },
    );
    expect(owner).toBe(PKG);
  });

  it("a provenance infra error fails CLOSED to null (never throw-through)", async () => {
    const owner = await resolveWidgetStreamStoreOwner(
      { tokenConfigKey: TOKEN_KEY, orgId: null },
      {
        ownershipGrantDeps: { query: async () => [] },
        installProvenanceDeps: {
          listGuardedProviderPackages: () => [PKG],
          isSignedActivated: () => true,
          resolveInstallAnchor: async () => {
            throw new Error("db outage");
          },
        },
      },
    );
    expect(owner).toBeNull();
  });

  // AUTHORITY EQUIVALENCE (codex security round). A BAKED declarer means the
  // credential-store surface (build ∪ grant → provenance) trusts a baked owner;
  // provenance here must be SUPPRESSED so a runtime rider can never satisfy the
  // conjunction for a store a DIFFERENT baked package owns.
  it("a BAKED store owner SUPPRESSES the provenance fallback (grant empty + baked declarer → null; a runtime rider can never ride a baked store)", async () => {
    const owner = await resolveWidgetStreamStoreOwner(
      { tokenConfigKey: TOKEN_KEY, orgId: null },
      {
        ownershipGrantDeps: { query: async () => [] }, // no grant
        hasBuildTimeOwner: () => true, // a baked package declares this store
        installProvenanceDeps: {
          // Even a fully-perfect provenance seam (a distinct runtime rider) is
          // never consulted — it would THROW if it were.
          listGuardedProviderPackages: () => {
            throw new Error("provenance must NOT run when a baked owner exists");
          },
        },
      },
    );
    expect(owner).toBeNull();
  });

  it("with NO baked declarer, the released-image provenance fallback resolves (the gap this slice closes)", async () => {
    const owner = await resolveWidgetStreamStoreOwner(
      { tokenConfigKey: TOKEN_KEY, orgId: null },
      {
        ownershipGrantDeps: { query: async () => [] },
        hasBuildTimeOwner: () => false,
        installProvenanceDeps: {
          listGuardedProviderPackages: () => [PKG],
          isSignedActivated: () => true,
          resolveInstallAnchor: async () => anchor(),
          resolveVerifiedStoreDir: async () => ({ storeDir: "/verified/store", digest: DIGEST }),
        },
      },
    );
    expect(owner).toBe(PKG);
  });
});

// ---------------------------------------------------------------------------
// GRANT-DECISION VETO (org + global) — an explicit revoked/pending ownership
// decision is NOT overridden by provenance.
// ---------------------------------------------------------------------------

describe("widget-stream session mint — grant-decision veto over the provenance owner", () => {
  it("VETOES a GLOBAL revoked ownership decision → null (fail closed)", async () => {
    const h = makeHarness({ veto: { scope: "global", status: "revoked", orgId: null } });
    expect(await resolveWidgetStreamAgentUnion(SLUG, h.deps)).toBeNull();
  });

  it("VETOES a GLOBAL pending ownership decision → null", async () => {
    const h = makeHarness({ veto: { scope: "global", status: "pending", orgId: null } });
    expect(await resolveWidgetStreamAgentUnion(SLUG, h.deps)).toBeNull();
  });

  it("VETOES an ORG-scoped revoked decision at the anchor's derived org (missed by a global-only veto) → null", async () => {
    const h = makeHarness({
      veto: { scope: "org", status: "revoked", orgId: ORG },
      prov: { anchorFor: () => anchor({ orgId: ORG }) },
    });
    expect(await resolveWidgetStreamAgentUnion(SLUG, h.deps)).toBeNull();
  });

  it("VETOES an ORG-scoped pending decision → null", async () => {
    const h = makeHarness({
      veto: { scope: "org", status: "pending", orgId: ORG },
      prov: { anchorFor: () => anchor({ orgId: ORG }) },
    });
    expect(await resolveWidgetStreamAgentUnion(SLUG, h.deps)).toBeNull();
  });

  it("HONORS the rider when NO ownership grant row exists at any scope (the auto-staged rider — never requested)", async () => {
    const h = makeHarness({ veto: null, prov: { anchorFor: () => anchor({ orgId: ORG }) } });
    const resolved = await resolveWidgetStreamAgentUnion(SLUG, h.deps);
    expect(resolved).not.toBeNull();
    expect(resolved!.grant!.packageName).toBe(PKG);
  });
});

// ---------------------------------------------------------------------------
// FALLBACK ORDERING — a present approved ownership GRANT wins; provenance is
// consulted ONLY when the grant arm is empty.
// ---------------------------------------------------------------------------

describe("widget-stream session mint — grant arm wins; provenance consulted only when the grant arm is empty", () => {
  it("uses the approved ownership GRANT owner and does NOT consult provenance", async () => {
    const h = makeHarness();
    // An ownership store that DOES return an approved owner (PKG) — and a
    // provenance seam that THROWS if consulted proves the short-circuit.
    h.deps.ownershipGrantDeps = {
      query: async <T>(text: string): Promise<T[]> =>
        (text.includes("token_config_key = $1 AND org_id IS NULL AND status = 'approved'")
          ? [{ package_name: PKG }]
          : []) as T[],
    };
    h.deps.installProvenanceDeps = {
      resolveInstallAnchor: async () => {
        throw new Error("provenance must NOT run when the grant arm resolves");
      },
    };
    const resolved = await resolveWidgetStreamAgentUnion(SLUG, h.deps);
    expect(resolved).not.toBeNull();
    expect(resolved!.grant!.packageName).toBe(PKG);
  });
});

// ---------------------------------------------------------------------------
// POINT-OF-USE RE-ASSERTS — a provenance-owned rider that loses ownership after
// mint (an admin revokes the store ownership, OR a provenance factor drops) must
// fail the re-assert exactly as a revoked GRANTED owner does.
// ---------------------------------------------------------------------------

async function resolveRuntime(h: Harness): Promise<ResolvedWidgetStreamAgent> {
  const resolved = await resolveWidgetStreamAgentUnion(SLUG, h.deps);
  expect(resolved).not.toBeNull();
  expect(resolved!.grant).not.toBeNull();
  return resolved!;
}

describe("widget-stream session mint — point-of-use re-assert (provenance ownership)", () => {
  it("unchanged provenance ownership → reassertWidgetStreamGrantBeforeOboRun true", async () => {
    const h = makeHarness();
    const resolved = await resolveRuntime(h);
    expect(await reassertWidgetStreamGrantBeforeOboRun(resolved, h.deps)).toBe(true);
  });

  it("ownership REVOKED after mint (GLOBAL) → the OBO re-assert refuses (false)", async () => {
    const h = makeHarness();
    const resolved = await resolveRuntime(h);
    h.veto = { scope: "global", status: "revoked", orgId: null };
    expect(await reassertWidgetStreamGrantBeforeOboRun(resolved, h.deps)).toBe(false);
  });

  it("ownership REVOKED after mint (ORG scope) → the OBO re-assert refuses (false)", async () => {
    const h = makeHarness({ prov: { anchorFor: () => anchor({ orgId: ORG }) } });
    const resolved = await resolveRuntime(h);
    h.veto = { scope: "org", status: "revoked", orgId: ORG };
    expect(await reassertWidgetStreamGrantBeforeOboRun(resolved, h.deps)).toBe(false);
  });

  it("a provenance factor drops after mint (package de-signed on the provenance axis) → the OBO re-assert refuses", async () => {
    const h = makeHarness();
    const resolved = await resolveRuntime(h);
    h.prov.provSigned = new Set(); // de-signed → provenance resolves no owner
    expect(await reassertWidgetStreamGrantBeforeOboRun(resolved, h.deps)).toBe(false);
  });

  it("a provenance factor drops after mint (store integrity fails) → the OBO re-assert refuses", async () => {
    const h = makeHarness();
    const resolved = await resolveRuntime(h);
    h.prov.verifiedFor = () => null;
    expect(await reassertWidgetStreamGrantBeforeOboRun(resolved, h.deps)).toBe(false);
  });

  it("buildWidgetChatTool loads the tool for a live provenance owner (gated importer, not entry.load())", async () => {
    const h = makeHarness();
    const resolved = await resolveRuntime(h);
    const tool = await buildWidgetChatTool(resolved, { href: "https://site/x" }, h.deps);
    expect(tool.name).toBe("wp_widget_tool");
    expect(h.importModule).toHaveBeenCalledTimes(1);
  });

  it("buildWidgetChatTool REFUSES to load when ownership is revoked after mint (revocation linearization) — no import, no factory", async () => {
    const h = makeHarness();
    const resolved = await resolveRuntime(h);
    h.veto = { scope: "global", status: "revoked", orgId: null };
    await expect(buildWidgetChatTool(resolved, { href: "https://site/x" }, h.deps)).rejects.toThrow(
      /pre-factory grant re-assert failed/,
    );
    expect(h.importModule).not.toHaveBeenCalled();
  });

  it("buildWidgetChatTool REFUSES to load when a provenance factor drops after mint (de-signed) — no import", async () => {
    const h = makeHarness();
    const resolved = await resolveRuntime(h);
    h.prov.provSigned = new Set();
    await expect(buildWidgetChatTool(resolved, { href: "https://site/x" }, h.deps)).rejects.toThrow(
      /pre-factory grant re-assert failed/,
    );
    expect(h.importModule).not.toHaveBeenCalled();
  });
});
