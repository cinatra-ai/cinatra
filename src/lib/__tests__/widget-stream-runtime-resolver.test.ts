import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, type Mock } from "vitest";

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
  /** Spy for the injectable runtime module importer. Default returns a module
   * namespace exporting the happy-path widget-chat-tool factory; the loader
   * tests assert WHETHER it is reached (it must be the ONLY runtime load path,
   * and only after the full pre-factory gate). */
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
    importModule: vi.fn(async (args: ImportRuntimeModuleArgs): Promise<unknown> => {
      void args; // default spy ignores its args; individual tests assert the call shape
      return {
        createWordPressWidgetChatTool: () => ({
          name: "wp_widget_tool",
          description: "edit the post",
          parameters: { type: "object" },
          execute: async () => "ok",
        }),
      };
    }),
    deps: undefined as unknown as WidgetStreamRuntimeResolveDeps,
  };
  h.deps = {
    metadataGrantDeps: { query: grantQueryFor(() => h.rows) },
    ownershipGrantDeps: { query: ownershipQueryFor(() => h.owners) },
    isSignedActivated: (pkg) => h.signed.has(pkg),
    resolveInstallAnchor: async () => h.anchor,
    resolveVerifiedStoreDir: async () => h.verified,
    readClaimsFromStore: async () => h.claims,
    importRuntimeModule: (args) => h.importModule(args),
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
      moduleExportKey: "./widget-chat-tool",
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
    // The runtime entry's own load() is a FAIL-CLOSED backstop: a runtime
    // widget-chat-tool loads ONLY through the gated buildWidgetChatTool path, so
    // a bare entry.load() is refused (the W3 hot-install prohibition, structural).
    await expect(entry.load()).rejects.toThrow(/gated buildWidgetChatTool path/);
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

  it("a RELAY-LESS runtime canon is still refused (opaque 404) — lifting is coupled to the unwired host-LLM serving surface", async () => {
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

const WIDGET_TOOL = {
  name: "wp_widget_tool",
  description: "edit the post",
  parameters: { type: "object" },
  execute: async () => "ok",
};

/** A resolved RUNTIME widget-stream agent for the loader tests. `entry.load` is
 * a fail-closed BACKSTOP spy that must NEVER be reached — a runtime
 * widget-chat-tool loads ONLY through the gated importer. */
function runtimeResolved(): {
  resolved: ResolvedWidgetStreamAgent;
  loadBackstop: ReturnType<typeof vi.fn>;
} {
  const canon = makeCanon();
  const loadBackstop = vi.fn(async () => {
    throw new Error("entry.load() backstop must not be reached for a runtime entry");
  });
  return {
    loadBackstop,
    resolved: {
      agentSlug: SLUG,
      entry: {
        resolution: "guardedOptional",
        load: loadBackstop,
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
        moduleExportKey: "./widget-chat-tool",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// buildWidgetChatTool — pre-factory GATE + gated runtime load (loader slice).
// Every fail-closed factor must refuse BEFORE the module importer is reached;
// the happy path imports from the JUST-verified store dir and never touches the
// entry.load() backstop.
// ---------------------------------------------------------------------------

describe("buildWidgetChatTool — gated runtime load (injected importer)", () => {
  it("REVOKED-before-load: a revoked grant refuses BEFORE the module import", async () => {
    const h = makeHarness();
    const { resolved, loadBackstop } = runtimeResolved();
    h.rows = [makeRow({ status: "revoked", row_version: 2 })];
    await expect(buildWidgetChatTool(resolved, {}, h.deps)).rejects.toThrow(
      /pre-factory grant re-assert failed/,
    );
    expect(h.importModule).not.toHaveBeenCalled();
    expect(loadBackstop).not.toHaveBeenCalled();
  });

  it("DIGEST-mismatch: an anchor that moved to a NEW digest refuses before import", async () => {
    const h = makeHarness();
    const { resolved, loadBackstop } = runtimeResolved();
    h.anchor = { ...h.anchor!, digest: "b".repeat(64) };
    await expect(buildWidgetChatTool(resolved, {}, h.deps)).rejects.toThrow(/anchor re-check failed/);
    expect(h.importModule).not.toHaveBeenCalled();
    expect(loadBackstop).not.toHaveBeenCalled();
  });

  it("DRIFT-mid-load: integrity re-verification against the anchor fails → refuse before import", async () => {
    const h = makeHarness();
    const { resolved, loadBackstop } = runtimeResolved();
    h.verified = null; // resolveVerifiedStoreDir integrity failure
    await expect(buildWidgetChatTool(resolved, {}, h.deps)).rejects.toThrow(
      /integrity re-verification failed/,
    );
    expect(h.importModule).not.toHaveBeenCalled();
    expect(loadBackstop).not.toHaveBeenCalled();
  });

  it("DRIFT-mid-load: the re-verified store dir binds a DIFFERENT digest → refuse before import", async () => {
    const h = makeHarness();
    const { resolved, loadBackstop } = runtimeResolved();
    // Anchor still reports the pinned digest, but the re-resolved verified store
    // dir reports a different digest (a mid-request re-materialization) → refuse.
    h.verified = { storeDir: "/data/x", digest: "c".repeat(64) };
    await expect(buildWidgetChatTool(resolved, {}, h.deps)).rejects.toThrow(
      /integrity re-verification failed/,
    );
    expect(h.importModule).not.toHaveBeenCalled();
    expect(loadBackstop).not.toHaveBeenCalled();
  });

  it("UNSIGNED: a de-signed package refuses before import", async () => {
    const h = makeHarness();
    const { resolved, loadBackstop } = runtimeResolved();
    h.signed.delete(PKG);
    await expect(buildWidgetChatTool(resolved, {}, h.deps)).rejects.toThrow(
      /pre-factory grant re-assert failed/,
    );
    expect(h.importModule).not.toHaveBeenCalled();
    expect(loadBackstop).not.toHaveBeenCalled();
  });

  it("a rowVersion bump (re-pend/re-approve at the same hash) refuses before import", async () => {
    const h = makeHarness();
    const { resolved, loadBackstop } = runtimeResolved();
    h.rows = [makeRow({ row_version: 7 })];
    await expect(buildWidgetChatTool(resolved, {}, h.deps)).rejects.toThrow(
      /pre-factory grant re-assert failed/,
    );
    expect(h.importModule).not.toHaveBeenCalled();
    expect(loadBackstop).not.toHaveBeenCalled();
  });

  it("a moved ownership conjunction refuses before import", async () => {
    const h = makeHarness();
    const { resolved, loadBackstop } = runtimeResolved();
    h.owners.set(TOKEN_KEY, OTHER);
    await expect(buildWidgetChatTool(resolved, {}, h.deps)).rejects.toThrow(
      /pre-factory grant re-assert failed/,
    );
    expect(h.importModule).not.toHaveBeenCalled();
    expect(loadBackstop).not.toHaveBeenCalled();
  });

  it("a thrown pre-factory re-assert error refuses before import (fail closed)", async () => {
    const h = makeHarness();
    const { resolved, loadBackstop } = runtimeResolved();
    h.deps.metadataGrantDeps = {
      query: async () => {
        throw new Error("db down");
      },
    };
    await expect(buildWidgetChatTool(resolved, {}, h.deps)).rejects.toThrow(
      /pre-factory grant re-assert failed/,
    );
    expect(h.importModule).not.toHaveBeenCalled();
    expect(loadBackstop).not.toHaveBeenCalled();
  });

  it("HAPPY PATH: imports from the freshly-verified store dir with the pinned export key, builds the tool, never touches the backstop", async () => {
    const h = makeHarness();
    const { resolved, loadBackstop } = runtimeResolved();
    const tool = await buildWidgetChatTool(resolved, { postId: "1" }, h.deps);
    expect(tool.name).toBe("wp_widget_tool");
    expect(h.importModule).toHaveBeenCalledTimes(1);
    expect(h.importModule).toHaveBeenCalledWith({
      storeDir: h.verified!.storeDir,
      moduleExportKey: "./widget-chat-tool",
      packageName: PKG,
      agentSlug: SLUG,
      reverifyPinnedIntegrity: expect.any(Function),
    });
    expect(loadBackstop).not.toHaveBeenCalled();
  });

  it("the reverify thunk fails closed when the store dir drifts between the pre-read verify and the read", async () => {
    const h = makeHarness();
    const { resolved } = runtimeResolved();
    // First resolveVerifiedStoreDir (pre-read gate) succeeds; the SECOND call
    // (the importer's immediately-before-read re-verify) reports drift.
    let calls = 0;
    const good = h.verified;
    h.deps.resolveVerifiedStoreDir = async () => (++calls === 1 ? good : null);
    // The importer spy exercises the passed reverify thunk, as the real importer does.
    h.importModule.mockImplementation(async (args) =>
      (await args.reverifyPinnedIntegrity())
        ? { createWordPressWidgetChatTool: () => WIDGET_TOOL }
        : (() => {
            throw new Error("reverify said drift");
          })(),
    );
    await expect(buildWidgetChatTool(resolved, {}, h.deps)).rejects.toThrow(/reverify said drift/);
    expect(calls).toBe(2);
  });

  it("the importer is reached ONLY after the pre-read gate stages — ORDER: grant re-assert (incl. ownership/trust) → anchor → integrity → import", async () => {
    const h = makeHarness();
    const { resolved } = runtimeResolved();
    const order: string[] = [];
    const grantQuery = h.deps.metadataGrantDeps!.query!;
    h.deps.metadataGrantDeps = {
      query: async (t, v) => {
        if (String(t).includes("package_name = $1 AND agent_slug = $2")) order.push("grant-reassert");
        return grantQuery(t, v);
      },
    };
    const anchorFn = h.deps.resolveInstallAnchor!;
    h.deps.resolveInstallAnchor = async (p) => {
      order.push("anchor");
      return anchorFn(p);
    };
    const verifyFn = h.deps.resolveVerifiedStoreDir!;
    h.deps.resolveVerifiedStoreDir = async (p, a) => {
      order.push("integrity");
      return verifyFn(p, a);
    };
    h.importModule.mockImplementation(async () => {
      order.push("import");
      return { createWordPressWidgetChatTool: () => WIDGET_TOOL };
    });
    await buildWidgetChatTool(resolved, {}, h.deps);
    expect(order).toEqual(["grant-reassert", "anchor", "integrity", "import"]);
  });

  it("a factory that returns a non-tool shape throws AFTER a real gated import (no partial tool)", async () => {
    const h = makeHarness();
    const { resolved } = runtimeResolved();
    h.importModule.mockResolvedValue({ createWordPressWidgetChatTool: () => ({ nope: true }) });
    await expect(buildWidgetChatTool(resolved, {}, h.deps)).rejects.toThrow(/did not return a function tool/);
  });

  it("a missing factory export in the imported module throws", async () => {
    const h = makeHarness();
    const { resolved } = runtimeResolved();
    h.importModule.mockResolvedValue({ somethingElse: () => WIDGET_TOOL });
    await expect(buildWidgetChatTool(resolved, {}, h.deps)).rejects.toThrow(
      /is not an exported function of the widget-chat-tool module/,
    );
  });

  it("build-time entries (grant:null) load via entry.load(), no grant machinery, no runtime importer", async () => {
    const h = makeHarness();
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
    const tool = await buildWidgetChatTool(resolved, {}, h.deps);
    expect(tool.name).toBe("wp_widget_tool");
    expect(load).toHaveBeenCalledTimes(1);
    expect(h.importModule).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The DEFAULT runtime importer against a REAL materialized store dir on disk:
// package.json exports re-resolution, realpath containment (link-escape),
// missing-artifact refusal, and an end-to-end import of a built ESM factory.
// Exercised through the public buildWidgetChatTool with the real default
// importer (no injected importRuntimeModule) — the whole pre-factory gate is
// satisfied via injected authorities so only the on-disk load path varies.
// ---------------------------------------------------------------------------

function realLoaderDeps(
  storeDir: string,
  verifiedOverride?: () => Promise<{ storeDir: string; digest: string } | null>,
): WidgetStreamRuntimeResolveDeps {
  // No importRuntimeModule → the real defaultImportRuntimeWidgetChatToolModule runs.
  return {
    metadataGrantDeps: { query: grantQueryFor(() => [makeRow()]) },
    ownershipGrantDeps: { query: ownershipQueryFor(() => new Map([[TOKEN_KEY, PKG]])) },
    isSignedActivated: (pkg) => new Set([PKG, RELAY]).has(pkg),
    resolveInstallAnchor: async () => ({
      integrity: "sha512-trusted",
      contentHash: "trusted-content-hash",
      registryUrl: null,
      digest: DIGEST,
      kind: "connector",
    }),
    resolveVerifiedStoreDir: verifiedOverride ?? (async () => ({ storeDir, digest: DIGEST })),
    readClaimsFromStore: async () => [makeClaim(makeCanon())],
  };
}

function realResolved(): ResolvedWidgetStreamAgent {
  const canon = makeCanon();
  return {
    agentSlug: SLUG,
    entry: {
      resolution: "guardedOptional",
      load: async () => {
        throw new Error("backstop must not be reached");
      },
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
      moduleExportKey: "./widget-chat-tool",
    },
  };
}

const PKG_JSON = (exports: unknown): string =>
  JSON.stringify({ name: PKG, version: "0.1.0", exports });
const WCT_MJS =
  'export function createWordPressWidgetChatTool() {\n' +
  '  return { name: "wp_widget_tool", description: "edit", parameters: { type: "object" }, execute: async () => "ok" };\n' +
  "}\n";

describe("buildWidgetChatTool — default runtime importer (real on-disk store)", () => {
  it("resolves the exports key, realpath-contains, and imports the built factory end-to-end", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wct-good-"));
    try {
      await writeFile(join(dir, "package.json"), PKG_JSON({ "./widget-chat-tool": "./widget-chat-tool.mjs" }));
      await writeFile(join(dir, "widget-chat-tool.mjs"), WCT_MJS);
      const tool = await buildWidgetChatTool(realResolved(), { postId: "1" }, realLoaderDeps(dir));
      expect(tool.name).toBe("wp_widget_tool");
      expect(typeof tool.execute).toBe("function");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a moduleExportKey that no longer resolves in package.json exports fails loud (never guessed)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wct-noexport-"));
    try {
      // Only an unrelated export; the approved "./widget-chat-tool" key is gone.
      await writeFile(join(dir, "package.json"), PKG_JSON({ "./other": "./other.mjs" }));
      await writeFile(join(dir, "widget-chat-tool.mjs"), WCT_MJS);
      await expect(buildWidgetChatTool(realResolved(), {}, realLoaderDeps(dir))).rejects.toThrow(
        /no longer resolves/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a conditional (non-string) exports mapping is refused (single contained string only)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wct-conditional-"));
    try {
      await writeFile(
        join(dir, "package.json"),
        PKG_JSON({ "./widget-chat-tool": { import: "./widget-chat-tool.mjs" } }),
      );
      await writeFile(join(dir, "widget-chat-tool.mjs"), WCT_MJS);
      await expect(buildWidgetChatTool(realResolved(), {}, realLoaderDeps(dir))).rejects.toThrow(
        /no longer resolves/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a missing built entry throws the actionable BUILT-artifacts-only refusal (ENOENT)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wct-missing-"));
    try {
      await writeFile(join(dir, "package.json"), PKG_JSON({ "./widget-chat-tool": "./widget-chat-tool.mjs" }));
      // no widget-chat-tool.mjs written
      await expect(buildWidgetChatTool(realResolved(), {}, realLoaderDeps(dir))).rejects.toThrow(
        /serves BUILT artifacts only/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("an export target that symlinks OUTSIDE the verified store dir is refused (realpath containment)", async () => {
    const parent = await mkdtemp(join(tmpdir(), "wct-escape-"));
    try {
      const dir = join(parent, "store");
      await mkdir(dir);
      const outside = join(parent, "evil.mjs");
      await writeFile(outside, WCT_MJS);
      await writeFile(join(dir, "package.json"), PKG_JSON({ "./widget-chat-tool": "./widget-chat-tool.mjs" }));
      // The subpath is string-contained, but the file is a symlink escaping the
      // store dir — only the realpath containment guard catches it.
      await symlink(outside, join(dir, "widget-chat-tool.mjs"));
      await expect(buildWidgetChatTool(realResolved(), {}, realLoaderDeps(dir))).rejects.toThrow(
        /resolves OUTSIDE its/,
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("a package.json that cannot be read/parsed fails closed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wct-badjson-"));
    try {
      await writeFile(join(dir, "package.json"), "{ not valid json");
      await expect(buildWidgetChatTool(realResolved(), {}, realLoaderDeps(dir))).rejects.toThrow(
        /cannot read\/parse package\.json/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a package.json with DUPLICATE `exports` keys is refused (strict parse matching the record-time gate)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wct-dupkey-"));
    try {
      // A last-wins JSON.parse would silently take the SECOND exports block; the
      // record-time gate rejects duplicate keys, so the loader must too. Written
      // raw because JSON.stringify cannot emit duplicate keys.
      await writeFile(
        join(dir, "package.json"),
        '{"name":"' + PKG + '","version":"0.1.0",' +
          '"exports":{"./widget-chat-tool":"./a.mjs"},' +
          '"exports":{"./widget-chat-tool":"./widget-chat-tool.mjs"}}',
      );
      await writeFile(join(dir, "widget-chat-tool.mjs"), WCT_MJS);
      await expect(buildWidgetChatTool(realResolved(), {}, realLoaderDeps(dir))).rejects.toThrow(
        /cannot read\/parse package\.json/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("integrity that DRIFTS after the pre-read verify refuses at the gate BEFORE the module evaluates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wct-drift-"));
    try {
      await writeFile(join(dir, "package.json"), PKG_JSON({ "./widget-chat-tool": "./widget-chat-tool.mjs" }));
      // SENTINEL: this module THROWS on top-level evaluation. If the gate failed
      // to block the read, the rejection would carry THIS message — asserting the
      // /drifted/ message (and NOT the sentinel) independently proves the module
      // was never evaluated.
      await writeFile(
        join(dir, "widget-chat-tool.mjs"),
        'throw new Error("SENTINEL: widget-chat-tool module EVALUATED — the integrity gate failed to block the read");\n',
      );
      let calls = 0;
      const deps = realLoaderDeps(dir, async () => (++calls === 1 ? { storeDir: dir, digest: DIGEST } : null));
      const err = await buildWidgetChatTool(realResolved(), {}, deps).then(
        () => {
          throw new Error("expected buildWidgetChatTool to reject");
        },
        (e) => e as Error,
      );
      expect(err.message).toMatch(/integrity drifted between resolution and read/);
      expect(err.message).not.toMatch(/SENTINEL/);
      expect(calls).toBe(2); // step-c pre-read verify + the importer's first-gate re-verify
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("the integrity gate runs BEFORE the package.json READ — a MISSING manifest is never read when the gate fails (bind-to-verified-snapshot)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wct-gatefirst-"));
    try {
      // No package.json at all: a pre-gate READ would ENOENT and surface
      // /cannot read\/parse/. With the gate first, the read never happens, so the
      // rejection is /drifted/ — strictly proving no store read precedes the gate
      // (a malformed-but-present file would only fail at PARSE, not at READ, so it
      // could not distinguish read-order; an absent file fails at the read itself).
      let calls = 0;
      const deps = realLoaderDeps(dir, async () => (++calls === 1 ? { storeDir: dir, digest: DIGEST } : null));
      const err = await buildWidgetChatTool(realResolved(), {}, deps).then(
        () => {
          throw new Error("expected buildWidgetChatTool to reject");
        },
        (e) => e as Error,
      );
      expect(err.message).toMatch(/integrity drifted between resolution and read/);
      expect(err.message).not.toMatch(/cannot read\/parse/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
