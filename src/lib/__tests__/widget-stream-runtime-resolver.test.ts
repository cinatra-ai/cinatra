import { createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";

// Widget-stream runtime trust, slice 2 — the UNION resolver (build-time map ∪
// admin-approved runtime metadata grants), the pinned ResolvedWidgetStreamGrant
// descriptor, and the POINT-OF-USE re-asserts (before OBO-carrier run creation
// on the relay path; before widget-chat-tool load/factory invocation). Every
// case is FAIL-CLOSED: a single failed/ambiguous factor → null / false /
// throw-before-load. Hermetic: every authority is injected via
// WidgetStreamRuntimeResolveDeps; hashes are computed with the REAL slice-1
// canonicalizer so hash agreement/drift is exercised for real.

vi.mock("@/lib/generated/extensions.server", () => ({
  GENERATED_WIDGET_STREAM_AGENTS: {
    "wordpress-content-editor": {
      resolution: "guardedOptional",
      load: async () => ({}),
      packageName: "@cinatra-ai/wordpress-mcp-connector",
      factory: "createWordPressWidgetChatTool",
      label: "WordPress",
      subjectNoun: "post",
      skillCapability: "widget-chat.wordpress-content-editor",
      relayAgentPackage: "@cinatra-ai/wordpress-agent",
      contextFields: [],
      auth: {
        tokenConfigKey: "wordpress_widget_auth",
        instancesConfigKey: "wordpress",
        requiredInstanceFields: [],
      },
    },
  },
}));

import {
  buildWidgetChatTool,
  reassertWidgetStreamGrantBeforeOboRun,
  resolveWidgetStreamAgent,
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

const PKG = "@cinatra-ai/wordpress-mcp-connector";
const OTHER = "@cinatra-ai/squatter-connector";
const SLUG = "wordpress-runtime-editor";
const BUILD_SLUG = "wordpress-content-editor";
const TOKEN_KEY = "wordpress_widget_auth";
const RELAY = "@cinatra-ai/wordpress-agent";
const DIGEST = "a".repeat(64);

// ---------------------------------------------------------------------------
// Canon / claim fixtures (REAL canonicalization + hashing from slice 1)
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
    contextFields: [
      { key: "href", maxLength: 500 },
      { key: "instanceId", maxLength: 64 },
      { key: "postId", maxLength: 32 },
    ],
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
// Fake grant-row store driven by the module's raw SQL (dispatch by
// distinguishing SQL features — same harness discipline as the slice-1 suite).
// ---------------------------------------------------------------------------

type Row = {
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

function makeRow(overrides?: Partial<Row>): Row {
  const canon = makeCanon();
  return {
    id: "g-1",
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

function grantQueryFor(rows: () => Row[]) {
  return async <T>(text: string, values?: readonly unknown[]): Promise<T[]> => {
    if (text.includes("ORDER BY agent_slug")) {
      // listApprovedWidgetStreamMetadataGrants (global scope)
      return rows().filter((r) => r.org_id === null && r.status === "approved") as T[];
    }
    if (text.includes("agent_slug = $1 AND org_id IS NULL AND status = 'approved'")) {
      // resolveApprovedWidgetStreamMetadataGrant (global arm, LIMIT 2)
      return rows()
        .filter((r) => r.agent_slug === values?.[0] && r.org_id === null && r.status === "approved")
        .slice(0, 2) as T[];
    }
    if (text.includes("package_name = $1 AND agent_slug = $2")) {
      // readWidgetStreamMetadataGrant (exact scope, org IS NULL here)
      return rows()
        .filter(
          (r) =>
            r.package_name === values?.[0] && r.agent_slug === values?.[1] && r.org_id === null,
        )
        .slice(0, 1) as T[];
    }
    throw new Error(`unexpected metadata-grant SQL: ${text}`);
  };
}

function ownershipQueryFor(owners: () => Map<string, string>) {
  return async <T>(text: string, values?: readonly unknown[]): Promise<T[]> => {
    if (text.includes("token_config_key = $1 AND org_id IS NULL AND status = 'approved'")) {
      const owner = owners().get(String(values?.[0]));
      return (owner ? [{ package_name: owner }] : []) as T[];
    }
    throw new Error(`unexpected ownership SQL: ${text}`);
  };
}

// ---------------------------------------------------------------------------
// The full happy-path dependency harness; each test overrides one factor.
// ---------------------------------------------------------------------------

type Harness = {
  deps: WidgetStreamRuntimeResolveDeps;
  rows: Row[];
  owners: Map<string, string>;
  signed: Set<string>;
  anchor: InstallTrustAnchor | null;
  verified: { storeDir: string; digest: string } | null;
  claims: WidgetStreamMetadataGrantClaim[];
};

function makeHarness(overrides?: {
  rows?: Row[];
  owners?: Map<string, string>;
  signed?: Set<string>;
  anchor?: InstallTrustAnchor | null;
  verified?: { storeDir: string; digest: string } | null;
  claims?: WidgetStreamMetadataGrantClaim[];
}): Harness {
  const h: Harness = {
    rows: overrides?.rows ?? [makeRow()],
    owners: overrides?.owners ?? new Map([[TOKEN_KEY, PKG]]),
    signed: overrides?.signed ?? new Set([PKG, RELAY]),
    anchor:
      overrides?.anchor === undefined
        ? {
            integrity: "sha512-trusted",
            contentHash: "trusted-content-hash",
            registryUrl: null,
            digest: DIGEST,
            kind: "connector",
          }
        : overrides.anchor,
    verified:
      overrides?.verified === undefined
        ? { storeDir: "/data/extensions/packages/connector/x/" + DIGEST, digest: DIGEST }
        : overrides.verified,
    claims: overrides?.claims ?? [makeClaim(makeCanon())],
    deps: undefined as unknown as WidgetStreamRuntimeResolveDeps,
  };
  h.deps = {
    metadataGrantDeps: { query: grantQueryFor(() => h.rows) },
    ownershipGrantDeps: { query: ownershipQueryFor(() => h.owners) },
    isSignedActivated: (pkg) => h.signed.has(pkg),
    resolveInstallAnchor: async () => h.anchor,
    resolveVerifiedStoreDir: async () => h.verified,
    readClaimsFromStore: async () => h.claims,
  };
  return h;
}

// ---------------------------------------------------------------------------
// Union resolver — build arm precedence + the runtime serve-time matrix
// ---------------------------------------------------------------------------

describe("resolveWidgetStreamAgentUnion — build-time arm", () => {
  it("returns the build entry with grant:null (baked trust, no runtime lookups)", async () => {
    const lookups = vi.fn();
    const h = makeHarness();
    h.deps.metadataGrantDeps = {
      query: async (...args) => {
        lookups(...args);
        throw new Error("must not be consulted for a build slug");
      },
    };
    const resolved = await resolveWidgetStreamAgentUnion(BUILD_SLUG, h.deps);
    expect(resolved).not.toBeNull();
    expect(resolved!.grant).toBeNull();
    expect(resolved!.entry.packageName).toBe(PKG);
    expect(lookups).not.toHaveBeenCalled();
  });

  it("build-slug collision defers to build: a stray approved runtime row for a build slug is ignored", async () => {
    const h = makeHarness({ rows: [makeRow({ agent_slug: BUILD_SLUG, package_name: OTHER })] });
    const resolved = await resolveWidgetStreamAgentUnion(BUILD_SLUG, h.deps);
    expect(resolved).not.toBeNull();
    expect(resolved!.grant).toBeNull(); // the BUILD entry, not the runtime row
    expect(resolved!.entry.packageName).toBe(PKG);
  });

  it("the sync build-arm resolver stays fail-closed for runtime-only slugs", () => {
    expect(resolveWidgetStreamAgent(BUILD_SLUG)).not.toBeNull();
    expect(resolveWidgetStreamAgent(SLUG)).toBeNull();
  });
});

describe("resolveWidgetStreamAgentUnion — runtime arm (serve-time re-verification)", () => {
  it("resolves a fully-verified runtime entry and pins the grant descriptor", async () => {
    const h = makeHarness();
    const resolved = await resolveWidgetStreamAgentUnion(SLUG, h.deps);
    expect(resolved).not.toBeNull();
    const { entry, grant } = resolved!;
    expect(grant).toEqual({
      agentSlug: SLUG,
      packageName: PKG,
      bindingHashV2: makeRow().binding_hash_v2,
      anchorDigest: DIGEST,
      grantRowVersion: 1,
      tokenConfigKey: TOKEN_KEY,
    });
    expect(entry.packageName).toBe(PKG);
    expect(entry.factory).toBe("createWordPressWidgetChatTool");
    expect(entry.relayAgentPackage).toBe(RELAY);
    expect(entry.skillCapability).toBe(`widget-chat.${SLUG}`);
    expect(entry.contextFields).toEqual([
      { key: "href", maxLength: 500 },
      { key: "instanceId", maxLength: 64 },
      { key: "postId", maxLength: 32 },
    ]);
    // The flat pilot rule: a runtime entry ALWAYS enforces the per-user token.
    expect(entry.auth.requireUserToken).toBe(true);
    // NO module loading in this slice: the runtime entry's load fails loudly.
    await expect(entry.load()).rejects.toThrow(/not\s+available yet/);
  });

  it("no approved grant → null (fail closed)", async () => {
    const h = makeHarness({ rows: [] });
    expect(await resolveWidgetStreamAgentUnion(SLUG, h.deps)).toBeNull();
  });

  it("a pending/revoked row never resolves", async () => {
    for (const status of ["pending", "revoked"]) {
      const h = makeHarness({ rows: [makeRow({ status })] });
      expect(await resolveWidgetStreamAgentUnion(SLUG, h.deps)).toBeNull();
    }
  });

  it(">1 approved rows for the slug → null (ambiguous, fail closed)", async () => {
    const h = makeHarness({
      rows: [makeRow(), makeRow({ id: "g-2", package_name: OTHER })],
    });
    expect(await resolveWidgetStreamAgentUnion(SLUG, h.deps)).toBeNull();
  });

  it("on-disk hash drift → null (a re-published canon must be re-approved)", async () => {
    const h = makeHarness({ claims: [makeClaim(makeCanon({ label: "WordPress EDITED" }))] });
    expect(await resolveWidgetStreamAgentUnion(SLUG, h.deps)).toBeNull();
  });

  it("no on-disk claim for the slug → null", async () => {
    const h = makeHarness({ claims: [] });
    expect(await resolveWidgetStreamAgentUnion(SLUG, h.deps)).toBeNull();
  });

  it("on-disk claim owned by a DIFFERENT package → null (checked before hash agreement)", async () => {
    // Hand-built claim: the slug AND hash agree with the approved row, but the
    // claim names another package — the package identity check alone refuses.
    const canon = makeCanon();
    const foreign: WidgetStreamMetadataGrantClaim = {
      agentSlug: SLUG,
      packageName: OTHER,
      canon,
      canonJson: canonicalJsonStringify(canon),
      bindingHashV2: computeWidgetStreamBindingHashV2(canon),
    };
    const h = makeHarness({ claims: [foreign] });
    expect(await resolveWidgetStreamAgentUnion(SLUG, h.deps)).toBeNull();
  });

  it("package not trusted-signed + activated → null", async () => {
    const h = makeHarness({ signed: new Set([RELAY]) });
    expect(await resolveWidgetStreamAgentUnion(SLUG, h.deps)).toBeNull();
  });

  it("no trusted install anchor → null; digest-unbound anchor → null", async () => {
    const noAnchor = makeHarness({ anchor: null });
    expect(await resolveWidgetStreamAgentUnion(SLUG, noAnchor.deps)).toBeNull();
    const unbound = makeHarness({
      anchor: {
        integrity: "sha512-trusted",
        contentHash: "trusted-content-hash",
        registryUrl: null,
        digest: null,
      },
    });
    expect(await resolveWidgetStreamAgentUnion(SLUG, unbound.deps)).toBeNull();
  });

  it("store record missing / integrity-vs-anchor failure → null", async () => {
    const h = makeHarness({ verified: null });
    expect(await resolveWidgetStreamAgentUnion(SLUG, h.deps)).toBeNull();
  });

  it("ownership conjunction: token key owned by another package (or nobody) → null", async () => {
    const foreignOwner = makeHarness({ owners: new Map([[TOKEN_KEY, OTHER]]) });
    expect(await resolveWidgetStreamAgentUnion(SLUG, foreignOwner.deps)).toBeNull();
    const noOwner = makeHarness({ owners: new Map() });
    expect(await resolveWidgetStreamAgentUnion(SLUG, noOwner.deps)).toBeNull();
  });

  it("requireUserToken !== true in the on-disk canon → null even at hash agreement (flat pilot rule)", async () => {
    // Simulate a row recorded outside the slice-1 guards: the approved hash
    // EQUALS the (invalid) false-canon hash, so only the explicit serve-time
    // requireUserToken assert stands between it and being served. The hash is
    // computed directly (the real compute helper refuses this canon — proving
    // the slice-1 write path can never mint it in the first place).
    const badCanon = makeCanon();
    (badCanon.auth as { requireUserToken: boolean }).requireUserToken = false;
    expect(() => computeWidgetStreamBindingHashV2(badCanon)).toThrow(/requireUserToken/);
    const canonJson = canonicalJsonStringify(badCanon);
    const rawHash = createHash("sha256").update(canonJson).digest("hex");
    const claim: WidgetStreamMetadataGrantClaim = {
      agentSlug: SLUG,
      packageName: PKG,
      canon: badCanon,
      canonJson,
      bindingHashV2: rawHash,
    };
    const h = makeHarness({
      rows: [makeRow({ binding_hash_v2: rawHash, canon_json: canonJson })],
      claims: [claim],
    });
    expect(await resolveWidgetStreamAgentUnion(SLUG, h.deps)).toBeNull();
  });

  it("a RELAY-LESS runtime canon is refused in THIS slice (no servable surface until the loader slice)", async () => {
    const relayless = makeCanon({ relayAgentPackage: null });
    const claim = makeClaim(relayless);
    const h = makeHarness({
      rows: [makeRow({ binding_hash_v2: claim.bindingHashV2, canon_json: claim.canonJson })],
      claims: [claim],
    });
    expect(await resolveWidgetStreamAgentUnion(SLUG, h.deps)).toBeNull();
  });

  it("a thrown lookup error fails closed (null), never propagates", async () => {
    const h = makeHarness();
    h.deps.metadataGrantDeps = {
      query: async () => {
        throw new Error("db down");
      },
    };
    expect(await resolveWidgetStreamAgentUnion(SLUG, h.deps)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Point-of-use re-assert — before OBO-carrier agent_run creation (relay path)
// ---------------------------------------------------------------------------

async function resolveRuntime(h: Harness): Promise<ResolvedWidgetStreamAgent> {
  const resolved = await resolveWidgetStreamAgentUnion(SLUG, h.deps);
  expect(resolved).not.toBeNull();
  expect(resolved!.grant).not.toBeNull();
  return resolved!;
}

describe("reassertWidgetStreamGrantBeforeOboRun (point-of-use, B-series linearization)", () => {
  it("build-time resolution passes with NO grant lookups (baked trust)", async () => {
    const h = makeHarness();
    const resolved = await resolveWidgetStreamAgentUnion(BUILD_SLUG, h.deps);
    h.deps.metadataGrantDeps = {
      query: async () => {
        throw new Error("must not be consulted for a build entry");
      },
    };
    expect(await reassertWidgetStreamGrantBeforeOboRun(resolved!, h.deps)).toBe(true);
  });

  it("unchanged grant + signed relay target → true", async () => {
    const h = makeHarness();
    const resolved = await resolveRuntime(h);
    expect(await reassertWidgetStreamGrantBeforeOboRun(resolved, h.deps)).toBe(true);
  });

  it("REVOKED-MID-SERVE refuses: a row revoked after resolution fails the re-assert", async () => {
    const h = makeHarness();
    const resolved = await resolveRuntime(h);
    h.rows = [makeRow({ status: "revoked", row_version: 2 })];
    expect(await reassertWidgetStreamGrantBeforeOboRun(resolved, h.deps)).toBe(false);
  });

  it("a rowVersion bump refuses even when the row is again `approved` at the same hash (re-pend/re-approve cycle)", async () => {
    const h = makeHarness();
    const resolved = await resolveRuntime(h);
    h.rows = [makeRow({ row_version: 3 })];
    expect(await reassertWidgetStreamGrantBeforeOboRun(resolved, h.deps)).toBe(false);
  });

  it("a hash change (re-published + re-approved canon) refuses the pinned descriptor", async () => {
    const h = makeHarness();
    const resolved = await resolveRuntime(h);
    const changed = makeClaim(makeCanon({ label: "Renamed" }));
    h.rows = [makeRow({ binding_hash_v2: changed.bindingHashV2, canon_json: changed.canonJson })];
    expect(await reassertWidgetStreamGrantBeforeOboRun(resolved, h.deps)).toBe(false);
  });

  it("a row deleted from under the request refuses", async () => {
    const h = makeHarness();
    const resolved = await resolveRuntime(h);
    h.rows = [];
    expect(await reassertWidgetStreamGrantBeforeOboRun(resolved, h.deps)).toBe(false);
  });

  it("a de-signed package refuses; a moved ownership conjunction refuses", async () => {
    const h1 = makeHarness();
    const r1 = await resolveRuntime(h1);
    h1.signed.delete(PKG);
    expect(await reassertWidgetStreamGrantBeforeOboRun(r1, h1.deps)).toBe(false);

    const h2 = makeHarness();
    const r2 = await resolveRuntime(h2);
    h2.owners.set(TOKEN_KEY, OTHER);
    expect(await reassertWidgetStreamGrantBeforeOboRun(r2, h2.deps)).toBe(false);
  });

  it("an unsigned RELAY TARGET refuses at OBO-creation time", async () => {
    const h = makeHarness();
    const resolved = await resolveRuntime(h);
    h.signed.delete(RELAY);
    expect(await reassertWidgetStreamGrantBeforeOboRun(resolved, h.deps)).toBe(false);
  });

  it("a re-assert lookup error fails closed (false)", async () => {
    const h = makeHarness();
    const resolved = await resolveRuntime(h);
    h.deps.metadataGrantDeps = {
      query: async () => {
        throw new Error("db down");
      },
    };
    expect(await reassertWidgetStreamGrantBeforeOboRun(resolved, h.deps)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Point-of-use re-assert — before widget-chat-tool load/factory invocation
// ---------------------------------------------------------------------------

function toolEntryResolved(h: Harness, load: () => Promise<unknown>): ResolvedWidgetStreamAgent {
  const canon = makeCanon();
  return {
    agentSlug: SLUG,
    entry: {
      resolution: "guardedOptional",
      load,
      packageName: canon.packageName,
      factory: canon.factory,
      label: canon.label,
      subjectNoun: canon.subjectNoun,
      skillCapability: canon.skillCapability,
      relayAgentPackage: canon.relayAgentPackage ?? undefined,
      contextFields: canon.contextFields,
      auth: { ...canon.auth },
    },
    grant: {
      agentSlug: SLUG,
      packageName: PKG,
      bindingHashV2: computeWidgetStreamBindingHashV2(canon),
      anchorDigest: DIGEST,
      grantRowVersion: 1,
      tokenConfigKey: TOKEN_KEY,
    },
  };
}

const WIDGET_TOOL = {
  name: "wp_widget_tool",
  description: "edit the post",
  parameters: { type: "object" },
  execute: async () => "ok",
};

describe("buildWidgetChatTool — pre-factory re-assert (runtime entries)", () => {
  it("re-asserts BEFORE load: a revoked grant never loads or invokes the module", async () => {
    const h = makeHarness();
    const load = vi.fn(async () => ({ createWordPressWidgetChatTool: () => WIDGET_TOOL }));
    const resolved = toolEntryResolved(h, load);
    h.rows = [makeRow({ status: "revoked", row_version: 2 })];
    await expect(buildWidgetChatTool(resolved, {}, h.deps)).rejects.toThrow(
      /pre-factory grant re-assert failed/,
    );
    expect(load).not.toHaveBeenCalled();
  });

  it("refuses when the trusted anchor moved to a NEW digest mid-request (pinned anchorDigest)", async () => {
    const h = makeHarness();
    const load = vi.fn(async () => ({ createWordPressWidgetChatTool: () => WIDGET_TOOL }));
    const resolved = toolEntryResolved(h, load);
    h.anchor = { ...h.anchor!, digest: "b".repeat(64) };
    await expect(buildWidgetChatTool(resolved, {}, h.deps)).rejects.toThrow(
      /anchor re-check failed/,
    );
    expect(load).not.toHaveBeenCalled();
  });

  it("refuses when integrity re-verification against the anchor fails", async () => {
    const h = makeHarness();
    const load = vi.fn(async () => ({ createWordPressWidgetChatTool: () => WIDGET_TOOL }));
    const resolved = toolEntryResolved(h, load);
    h.verified = null;
    await expect(buildWidgetChatTool(resolved, {}, h.deps)).rejects.toThrow(
      /integrity re-verification failed/,
    );
    expect(load).not.toHaveBeenCalled();
  });

  it("a live, unchanged grant loads the module and builds the validated tool", async () => {
    const h = makeHarness();
    const load = vi.fn(async () => ({ createWordPressWidgetChatTool: () => WIDGET_TOOL }));
    const resolved = toolEntryResolved(h, load);
    const tool = await buildWidgetChatTool(resolved, { postId: "1" }, h.deps);
    expect(tool.name).toBe("wp_widget_tool");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("build-time entries (grant:null) build with no grant machinery", async () => {
    const load = vi.fn(async () => ({ createWordPressWidgetChatTool: () => WIDGET_TOOL }));
    const canon = makeCanon();
    const resolved: ResolvedWidgetStreamAgent = {
      agentSlug: BUILD_SLUG,
      entry: {
        resolution: "guardedOptional",
        load,
        packageName: canon.packageName,
        factory: canon.factory,
        label: canon.label,
        subjectNoun: canon.subjectNoun,
        skillCapability: canon.skillCapability,
        contextFields: canon.contextFields,
        auth: { ...canon.auth },
      },
      grant: null,
    };
    const tool = await buildWidgetChatTool(resolved, {});
    expect(tool.name).toBe("wp_widget_tool");
  });
});
