import "server-only";

// Manifest-driven discovery of widget-stream agents. The generated manifest
// (scripts/extensions/generate-extension-manifest.mjs) carries agentSlug-keyed
// entries — a literal dynamic import of the connector's `widget-chat-tool`
// subpath, the factory export name, and the declared stream metadata
// (label/subjectNoun/skillCapability/contextFields/auth) — so the host's
// /api/agents/[agentSlug]/stream route serves any widget-bearing extension
// WITHOUT importing a connector package or branching on slugs. Same posture as
// src/lib/connector-mcp-registration.server.ts: the manifest is the single
// place a connector is named; the host consumes shapes.
//
// FAIL LOUDLY: an entry whose loader cannot be imported, whose recorded factory
// is missing/not a function, or whose factory returns a non-tool shape throws —
// exactly like the static import it replaces. A silently skipped tool would
// turn the widget into a chat-only surface with no failure signal.
//
// RUNTIME RESOLVER ARM (widget-stream runtime trust, slice 2). The build-time
// map above only ever sees connectors BAKED into the image, so on a released
// image a MARKETPLACE-installed connector's widget agent 404s even after an
// admin approved its metadata grant (slice 1). This slice adds the UNION
// resolver: build-time map ∪ the admin-approved runtime metadata grants, with
// SERVE-TIME re-verification and POINT-OF-USE re-assertion. A runtime slug
// resolves ONLY when, at this request:
//   (i)   a UNIQUE `approved` metadata grant exists for the slug at global
//         scope (the pilot's recording scope; zero/ambiguous → null → 404);
//   (ii)  the connector's CURRENT on-disk materialized manifest re-canonicalizes
//         to the EXACT bindingHashV2 the admin approved (a re-published canon
//         drifts the hash → fail closed until re-approved);
//   (iii) the grant package IS the currently-approved credential-store owner of
//         the canon's declared tokenConfigKey (the ownership-axis conjunction —
//         the sibling runtime-owner arm in widget-auth-provider.ts — so a
//         package can never serve a widget riding another package's store);
//   (iv)  the package currently classifies trusted-signed + activated
//         (isPackageSignedActivated) AND its materialized store dir
//         integrity-verifies against the TRUSTED install anchor at the
//         anchor-bound digest (never the in-store sidecar);
//   (v)   the slug does not collide with the build-time map (build wins
//         absolutely — a stray runtime row for a build slug is ignored).
// Resolution pins ONE immutable ResolvedWidgetStreamGrant descriptor per
// request; live authorization is RE-ASSERTED at every later side-effect
// boundary (immediately before OBO-carrier agent_run creation on the relay
// path, and immediately before widget-chat-tool factory invocation). A
// revocation takes effect at the next such re-check: a request that already
// passed its pre-side-effect re-check may complete that single bounded
// operation, and no NEW side effect starts after the revocation is observed.
// Every check fails CLOSED (null/refuse), and a runtime-arm lookup error never
// disturbs the build-time arm (mirrors the widget-auth-provider posture).
//
// GATED RUNTIME MODULE LOADING (widget-stream runtime trust, slice 3 — the
// loader slice). `buildWidgetChatTool`, for a runtime grant, loads the approved
// connector's `widget-chat-tool` module from its integrity-verified, anchor-
// pinned store dir — but ONLY after the point-of-use re-assert (pinned grant
// still approved at the same hash + rowVersion + ownership + trust — the
// revocation linearization) AND an integrity re-verification against the
// TRUSTED install anchor at the PINNED anchorDigest performed IMMEDIATELY before
// the module read (an anchor that moved to a new digest, or a store dir that no
// longer hashes to the trusted content, refuses — no read, no factory call).
// The load re-resolves the approved `moduleExportKey` against the CURRENT
// materialized `package.json` exports and realpath-binds the resolved entry
// INSIDE the verified store dir (link-escape refused), mirroring the runtime
// package loader's `importModule`.
//
// The W3 HOT-INSTALL PROHIBITION holds for everything OUTSIDE an approved +
// serve-time-verified + point-of-use-re-asserted grant: a runtime entry's own
// `load()` is a fail-closed backstop that refuses outright (the ONLY runtime
// load path is the gated `buildWidgetChatTool` above), the resolver still
// operates purely on the already-materialized, anchor-pinned store (never a hot
// install/activation), and a build-time entry is unchanged baked host trust.
// The relay stream route never loads (it is a relay, not an LLM), so runtime
// relay widgets serve via the relay path while a runtime host-side widget-chat-
// tool loads only through this gate.

import type { LlmFunctionTool } from "@cinatra-ai/llm";
import {
  GENERATED_WIDGET_STREAM_AGENTS,
  type GeneratedWidgetStreamAgentEntry,
} from "@/lib/generated/extensions.server";
import {
  ExtensionModuleAbsentError,
  isDegradedExtensionLoad,
} from "@/lib/extension-load-guard";
import {
  listApprovedWidgetStreamMetadataGrants,
  parseJsonRejectingDuplicateKeys,
  readWidgetStreamMetadataClaimsFromStore,
  readWidgetStreamMetadataGrant,
  resolveApprovedWidgetStreamMetadataGrant,
  resolveOwnershipOwner,
  resolveSingleStringExport,
  type OwnershipGrantDeps,
  type WidgetStreamMetadataGrantClaim,
  type WidgetStreamMetadataGrantDeps,
} from "@/lib/extension-capability-ownership-grants";
import { isPackageSignedActivated } from "@/lib/extension-capabilities-registry";
import type { InstallTrustAnchor } from "@/lib/extension-package-store";

export type WidgetStreamAgent = GeneratedWidgetStreamAgentEntry;

/**
 * Resolve a widget-stream agent from the BUILD-TIME generated map only
 * (null = not baked). This is the build arm + the collision backstop — for any
 * slug present here the union resolver returns THIS entry and ignores any
 * stray runtime grant row (build wins absolutely). Callers serving requests
 * must use `resolveWidgetStreamAgentUnion` so approved runtime entries resolve
 * too; this stays fail-closed for them (a runtime-only slug is null here).
 */
export function resolveWidgetStreamAgent(agentSlug: string): WidgetStreamAgent | null {
  return GENERATED_WIDGET_STREAM_AGENTS[agentSlug] ?? null;
}

// ---------------------------------------------------------------------------
// The union resolver (runtime resolver arm) + point-of-use pinning
// ---------------------------------------------------------------------------

/**
 * The immutable per-request authorization descriptor pinned when a RUNTIME
 * entry resolves. Later side-effect boundaries re-assert live authorization
 * against EXACTLY these pinned values — a row whose hash OR rowVersion moved
 * (revoke, re-pend, re-approve — every transition bumps the version) refuses,
 * so a revocation between resolution and use always fails closed.
 */
export type ResolvedWidgetStreamGrant = {
  agentSlug: string;
  packageName: string;
  /** The approved (and serve-time re-verified) canonical binding hash. */
  bindingHashV2: string;
  /** The trusted install anchor's tarball digest at resolution time — the
   * pre-factory re-assert re-verifies integrity at THIS digest. */
  anchorDigest: string;
  /** The grant row's optimistic-concurrency version at resolution time. */
  grantRowVersion: number;
  /** The canon's declared credential-store key — re-checked for the ownership
   * conjunction at every point of use. */
  tokenConfigKey: string;
  /** The canon's `package.json` `exports` key for the widget-chat-tool module
   * (bound by `bindingHashV2`, so the serve-time hash equality pins it). The
   * gated loader (`buildWidgetChatTool`, runtime branch) re-resolves EXACTLY
   * this key against the CURRENT materialized package.json at load. */
  moduleExportKey: string;
};

/** A resolved widget-stream agent: the entry plus its pinned runtime grant
 * descriptor (`grant: null` = build-time arm; baked-into-the-image state is
 * host-trusted, so it carries no grant and no point-of-use re-assert). */
export type ResolvedWidgetStreamAgent = {
  agentSlug: string;
  entry: WidgetStreamAgent;
  grant: ResolvedWidgetStreamGrant | null;
};

/** A store dir that was located via the trusted anchor (kind- and
 * digest-bound) AND integrity-verified against that anchor. */
export type VerifiedWidgetStreamStoreDir = {
  storeDir: string;
  digest: string;
};

/**
 * Injectable seams for the runtime resolver arm — unit-testable without a pg
 * pool or an on-disk store. Production callers pass nothing; every default
 * resolves the real authority (lazily, so the module import graph carries no
 * eager pool/store work). Every hook failure is treated as fail-closed.
 */
export type WidgetStreamRuntimeResolveDeps = {
  /** Threaded into the metadata-grant reads (resolve/read/list). */
  metadataGrantDeps?: WidgetStreamMetadataGrantDeps;
  /** Threaded into `resolveOwnershipOwner` (the conjunction axis). */
  ownershipGrantDeps?: OwnershipGrantDeps;
  /** Trust classification (default `isPackageSignedActivated`). */
  isSignedActivated?: (packageName: string) => boolean;
  /** The TRUSTED install anchor, from OUTSIDE the writable store (default:
   * the canonical install-record resolver at platform-global scope — the
   * widget surfaces are unauthenticated and org-agnostic, like the
   * widget-auth runtime owner arm). */
  resolveInstallAnchor?: (packageName: string) => Promise<InstallTrustAnchor | null>;
  /** Locate the anchor-bound materialized store record (kind + digest binding,
   * fail-closed like the runtime loader) AND integrity-verify it against the
   * anchor. Null on any missing/ambiguous/failed factor. */
  resolveVerifiedStoreDir?: (
    packageName: string,
    anchor: InstallTrustAnchor,
  ) => Promise<VerifiedWidgetStreamStoreDir | null>;
  /** Re-read the CURRENT on-disk widget-stream claims (default: the slice-1
   * strict canonicalizing reader — any invalid entry means NO claims). */
  readClaimsFromStore?: (storeDir: string) => Promise<WidgetStreamMetadataGrantClaim[]>;
  /** Import the runtime widget-chat-tool module from the integrity-verified
   * store dir. Default order (security contract): re-verify integrity at the
   * pinned digest FIRST (the last store-content gate), then — bound to that
   * verified snapshot — strict-parse the materialized package.json, re-resolve
   * `moduleExportKey`, realpath-bind INSIDE the store dir rejecting link-escape,
   * and `file://`-import. Nothing read before the gate determines the import.
   * Injected in tests; production loads the real module. Any failure throws
   * (fail loud — never a silent skip). */
  importRuntimeModule?: (args: {
    storeDir: string;
    moduleExportKey: string;
    packageName: string;
    agentSlug: string;
    /** Re-hash the store dir vs the trusted anchor at the pinned digest,
     * IMMEDIATELY before the module read (closes the resolve-time TOCTOU
     * window). Returns false on any drift/miss → the importer refuses. */
    reverifyPinnedIntegrity: () => Promise<boolean>;
  }) => Promise<unknown>;
};

async function defaultResolveInstallAnchor(
  packageName: string,
): Promise<InstallTrustAnchor | null> {
  const { makeDefaultInstallAnchorResolver } = await import("@/lib/extension-install-anchor");
  const resolver = await makeDefaultInstallAnchorResolver(null, "platform-global");
  return resolver(packageName);
}

async function defaultResolveVerifiedStoreDir(
  packageName: string,
  anchor: InstallTrustAnchor,
): Promise<VerifiedWidgetStreamStoreDir | null> {
  // A runtime widget entry only ever comes from a real marketplace install,
  // whose finalized journal binds the anchor to a tarball digest — an unbound
  // (legacy) anchor digest is REFUSED here (stricter than the loader's
  // legacy-row tolerance; this is a NEW surface with no legacy rows).
  if (!anchor.digest) return null;
  const { resolveExtensionDataRoot } = await import("@/lib/extension-data-root");
  const { discoverStoreRecordsV2, realStoreFs } = await import("@/lib/extension-store-io");
  const { isExtensionStoreKind } = await import("@/lib/extension-package-store-core");
  const { verifyMaterializedPackageIntegrity } = await import("@/lib/extension-package-store");
  const records = await discoverStoreRecordsV2(resolveExtensionDataRoot(), realStoreFs);
  const candidates = records.filter((r) => {
    if (r.packageName !== packageName) return false;
    // Anchor-kind binding (mirrors the runtime loader): a bound kind must be a
    // known store kind AND equal the record's PATH kind — else refuse.
    if (anchor.kind != null && (!isExtensionStoreKind(anchor.kind) || anchor.kind !== r.kind)) {
      return false;
    }
    return r.declaredDigest === anchor.digest;
  });
  // Exactly one anchor-digest-bound record or fail closed.
  if (candidates.length !== 1) return null;
  const record = candidates[0]!;
  const ok = await verifyMaterializedPackageIntegrity(record, {
    trustedIntegrity: anchor.integrity,
    trustedContentHash: anchor.contentHash,
  });
  if (!ok) return null;
  return { storeDir: record.storeDir, digest: anchor.digest };
}

/**
 * Load the runtime widget-chat-tool module from an integrity-verified,
 * anchor-pinned store dir. The integrity re-verify runs FIRST, and EVERY
 * import-determining read is then bound to that verified snapshot — nothing
 * captured before the gate is reused.
 *
 * Sequence (fail-loud on every branch — a silently skipped tool would be
 * fail-open): (1) `reverifyPinnedIntegrity()` — the store dir's bytes re-hashed
 * against the trusted anchor at the pinned digest, the LAST store-content gate;
 * (2) on the now-verified store, re-read `<storeDir>/package.json` with the SAME
 * duplicate-key-REJECTING parser the record-time approval gate used (a last-wins
 * `JSON.parse` would accept a manifest shape — e.g. duplicate `exports` keys —
 * the gate refuses) and re-resolve the approved `moduleExportKey` to a single
 * plain contained string target; (3) realpath-bind the resolved entry INSIDE the
 * store dir (link-escape refused), mirroring the runtime package loader, and
 * `file://`-import it. Because the export target AND the realpaths are computed
 * ONLY after the gate, a store dir swapped-and-restored during an earlier read
 * can never leave a stale external path to import; the only residual window is
 * the gate -> import read itself (the irreducible one the runtime loader carries).
 */
async function defaultImportRuntimeWidgetChatToolModule(args: {
  storeDir: string;
  moduleExportKey: string;
  packageName: string;
  agentSlug: string;
  reverifyPinnedIntegrity: () => Promise<boolean>;
}): Promise<unknown> {
  const { storeDir, moduleExportKey, packageName, agentSlug, reverifyPinnedIntegrity } = args;
  const { readFile, realpath } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { isContainedRealpath } = await import("@/lib/fs-safety");

  // (1) FINAL integrity re-verify at the pinned digest FIRST — the LAST
  // store-content gate. Every import-determining read below is bound to THIS
  // verified snapshot; no path/target captured before the gate is reused.
  if (!(await reverifyPinnedIntegrity())) {
    throw new Error(
      `[widget-stream:${agentSlug}] store integrity drifted between resolution and read for ` +
        `${packageName} — refusing the runtime widget-chat-tool load (fail closed)`,
    );
  }

  // (2) On the now-verified store: strict-parse package.json (duplicate-key-
  // REJECTING, identical to the record-time gate) and re-resolve the approved
  // export key to a single plain contained string target (conditional/patterned/
  // missing mapping refused — never guessed).
  let exportsField: unknown;
  try {
    const raw = await readFile(join(storeDir, "package.json"), "utf8");
    const manifest = parseJsonRejectingDuplicateKeys(raw);
    exportsField =
      typeof manifest === "object" && manifest !== null
        ? (manifest as { exports?: unknown }).exports
        : undefined;
  } catch (err) {
    throw new Error(
      `[widget-stream:${agentSlug}] cannot read/parse package.json for ${packageName} in the ` +
        "verified store dir — refusing the runtime widget-chat-tool load (fail closed): " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  const target = resolveSingleStringExport(exportsField, moduleExportKey);
  if (target === null) {
    throw new Error(
      `[widget-stream:${agentSlug}] moduleExportKey "${moduleExportKey}" no longer resolves in ` +
        `${packageName} package.json exports to a single contained string target — refusing ` +
        "the runtime widget-chat-tool load (fail closed)",
    );
  }

  // (3) realpath-bind (mirrors runtime-package-loader.ts importModule) — the
  // resolved entry must stay INSIDE the verified store dir even after following
  // filesystem links. Computed AFTER the gate, so the imported path can never be
  // one captured while the store was compromised.
  const abs = join(storeDir, target);
  let realAbs: string;
  let realStore: string;
  try {
    [realAbs, realStore] = await Promise.all([realpath(abs), realpath(storeDir)]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      throw new Error(
        `[widget-stream:${agentSlug}] the widget-chat-tool entry "${target}" (or its store dir) ` +
          `for ${packageName} is missing — the runtime store serves BUILT artifacts only; publish ` +
          "a built ESM widget-chat-tool export and reinstall from the marketplace (fail closed)",
      );
    }
    throw err;
  }
  if (!isContainedRealpath(realAbs, realStore)) {
    throw new Error(
      `[widget-stream:${agentSlug}] widget-chat-tool entry for ${packageName} resolves OUTSIDE its ` +
        "verified store dir — refusing import (fail closed)",
    );
  }
  return import(/* webpackIgnore: true */ /* @vite-ignore */ pathToFileURL(realAbs).href);
}

type ResolvedRuntimeDeps = {
  metadataGrantDeps?: WidgetStreamMetadataGrantDeps;
  ownershipGrantDeps?: OwnershipGrantDeps;
  isSignedActivated: (packageName: string) => boolean;
  resolveInstallAnchor: (packageName: string) => Promise<InstallTrustAnchor | null>;
  resolveVerifiedStoreDir: (
    packageName: string,
    anchor: InstallTrustAnchor,
  ) => Promise<VerifiedWidgetStreamStoreDir | null>;
  readClaimsFromStore: (storeDir: string) => Promise<WidgetStreamMetadataGrantClaim[]>;
  importRuntimeModule: (args: {
    storeDir: string;
    moduleExportKey: string;
    packageName: string;
    agentSlug: string;
    reverifyPinnedIntegrity: () => Promise<boolean>;
  }) => Promise<unknown>;
};

function withRuntimeDefaults(deps?: WidgetStreamRuntimeResolveDeps): ResolvedRuntimeDeps {
  return {
    metadataGrantDeps: deps?.metadataGrantDeps,
    ownershipGrantDeps: deps?.ownershipGrantDeps,
    isSignedActivated: deps?.isSignedActivated ?? isPackageSignedActivated,
    resolveInstallAnchor: deps?.resolveInstallAnchor ?? defaultResolveInstallAnchor,
    resolveVerifiedStoreDir: deps?.resolveVerifiedStoreDir ?? defaultResolveVerifiedStoreDir,
    readClaimsFromStore: deps?.readClaimsFromStore ?? readWidgetStreamMetadataClaimsFromStore,
    importRuntimeModule: deps?.importRuntimeModule ?? defaultImportRuntimeWidgetChatToolModule,
  };
}

/** Build the servable entry for a serve-time-verified runtime claim. The
 * entry's own `load()` is a FAIL-CLOSED BACKSTOP that refuses outright: a
 * runtime widget-chat-tool module loads ONLY through the gated
 * `buildWidgetChatTool` path (point-of-use re-assert + integrity re-verify at
 * the pinned anchor digest immediately before the read), NEVER by a bare
 * `entry.load()` that would bypass those gates — that is the W3 hot-install
 * prohibition made structural (silently skipping the tool would be fail-open). */
function runtimeEntryFromClaim(claim: WidgetStreamMetadataGrantClaim): WidgetStreamAgent {
  const canon = claim.canon;
  return {
    resolution: "guardedOptional",
    load: async () => {
      throw new Error(
        `[widget-stream:${canon.agentSlug}] a runtime widget-chat-tool module must load through ` +
          "the gated buildWidgetChatTool path (point-of-use re-assert + integrity re-verify at the " +
          "pinned anchor digest) — a direct entry.load() is refused (fail closed)",
      );
    },
    packageName: canon.packageName,
    factory: canon.factory,
    label: canon.label,
    subjectNoun: canon.subjectNoun,
    skillCapability: canon.skillCapability,
    relayAgentPackage: canon.relayAgentPackage ?? undefined,
    contextFields: canon.contextFields.map((f) => ({ key: f.key, maxLength: f.maxLength })),
    auth: {
      tokenConfigKey: canon.auth.tokenConfigKey,
      instancesConfigKey: canon.auth.instancesConfigKey,
      requiredInstanceFields: [...canon.auth.requiredInstanceFields],
      // Pinned true for every runtime entry (the flat pilot prohibition —
      // asserted again below before the entry is built).
      requireUserToken: true,
    },
  };
}

/**
 * The RUNTIME arm: resolve an admin-approved, serve-time-re-verified runtime
 * widget-stream agent for a slug. Null on ANY failed/ambiguous factor (the
 * caller 404s). Never consults the build map — the union wrapper owns
 * precedence. FAIL CLOSED on any lookup error (logged; the build arm is never
 * affected by a runtime-arm failure).
 */
async function resolveRuntimeWidgetStreamAgent(
  agentSlug: string,
  deps: ResolvedRuntimeDeps,
): Promise<ResolvedWidgetStreamAgent | null> {
  try {
    // (i) the UNIQUE approved metadata grant at global scope (the pilot's
    // recording scope) — zero or ambiguous is null by construction.
    const grant = await resolveApprovedWidgetStreamMetadataGrant(
      { agentSlug, orgId: null },
      deps.metadataGrantDeps,
    );
    if (!grant) return null;

    // (iv-a) current trust classification: trusted-signed AND activated.
    if (!deps.isSignedActivated(grant.packageName)) return null;

    // (iv-b) trusted install anchor + anchor-bound, integrity-verified store dir.
    const anchor = await deps.resolveInstallAnchor(grant.packageName);
    if (!anchor || !anchor.digest) return null;
    const verified = await deps.resolveVerifiedStoreDir(grant.packageName, anchor);
    if (!verified) return null;

    // (ii) serve-time re-verification: re-read the CURRENT on-disk claims
    // (strict canonicalization — any invalid entry yields no claims) and
    // require the recomputed hash to equal the APPROVED row's hash exactly.
    const claims = await deps.readClaimsFromStore(verified.storeDir);
    const claim = claims.find((c) => c.agentSlug === agentSlug) ?? null;
    if (!claim) return null;
    if (claim.packageName !== grant.packageName) return null;
    if (claim.bindingHashV2 !== grant.bindingHashV2) return null;

    // Flat pilot prohibition, re-asserted at serve time: a runtime entry may
    // never opt out of the fail-closed per-user-token 401.
    if (claim.canon.auth.requireUserToken !== true) return null;

    // A relay-less runtime canon is still refused here (opaque 404). The gated
    // loader below makes the host-LLM widget-tool path VERIFIABLE, but it has no
    // production caller yet: the stream route is relay-only and returns a
    // descriptive error for a relay-less resolved agent. Lifting this refusal is
    // therefore COUPLED to wiring the host-LLM serving surface (a separate
    // serving-surface slice) — lifting it alone would resolve a relay-less canon
    // straight into that descriptive public error. Lift + serve land together.
    if (claim.canon.relayAgentPackage === null) return null;

    // (iii) ownership conjunction: the grant package must BE the currently-
    // approved credential-store owner of the canon's declared token key.
    const owner = await resolveOwnershipOwner(
      { tokenConfigKey: claim.canon.auth.tokenConfigKey, orgId: null },
      deps.ownershipGrantDeps,
    );
    if (owner !== grant.packageName) return null;

    return {
      agentSlug,
      entry: runtimeEntryFromClaim(claim),
      grant: {
        agentSlug,
        packageName: grant.packageName,
        bindingHashV2: grant.bindingHashV2,
        anchorDigest: verified.digest,
        grantRowVersion: grant.rowVersion,
        tokenConfigKey: claim.canon.auth.tokenConfigKey,
        moduleExportKey: claim.canon.moduleExportKey,
      },
    };
  } catch (err) {
    // Constant format string: agentSlug is request-controlled and must never
    // sit in console's printf position (tainted-format-string).
    console.error(
      "[widget-stream:%s] runtime resolver arm failed (failing closed on the " +
        "runtime arm; the build-time arm is unaffected):",
      agentSlug,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * The UNION resolver — the single entry point every serving surface uses.
 * Build-time arm wins absolutely for its slugs (a stray runtime grant row for
 * a build slug is ignored, never a null); otherwise the runtime arm resolves
 * with full serve-time re-verification. Null = 404 (fail closed).
 */
export async function resolveWidgetStreamAgentUnion(
  agentSlug: string,
  deps?: WidgetStreamRuntimeResolveDeps,
): Promise<ResolvedWidgetStreamAgent | null> {
  const build = GENERATED_WIDGET_STREAM_AGENTS[agentSlug];
  if (build) return { agentSlug, entry: build, grant: null };
  return resolveRuntimeWidgetStreamAgent(agentSlug, withRuntimeDefaults(deps));
}

/**
 * The shared live-authorization re-check behind every point of use: the grant
 * row must STILL be `approved` at the EXACT pinned hash and rowVersion (any
 * transition — revoke, re-pend, re-approve — bumps the version and refuses),
 * the ownership conjunction must still hold, and the package must still
 * classify trusted-signed + activated. Any error → false (fail closed).
 */
async function isPinnedGrantStillAuthorized(
  grant: ResolvedWidgetStreamGrant,
  deps: ResolvedRuntimeDeps,
): Promise<boolean> {
  try {
    const row = await readWidgetStreamMetadataGrant(
      { packageName: grant.packageName, orgId: null, agentSlug: grant.agentSlug },
      deps.metadataGrantDeps,
    );
    if (!row) return false;
    if (row.status !== "approved") return false;
    if (row.bindingHashV2 !== grant.bindingHashV2) return false;
    if (row.rowVersion !== grant.grantRowVersion) return false;
    if (!deps.isSignedActivated(grant.packageName)) return false;
    const owner = await resolveOwnershipOwner(
      { tokenConfigKey: grant.tokenConfigKey, orgId: null },
      deps.ownershipGrantDeps,
    );
    if (owner !== grant.packageName) return false;
    return true;
  } catch (err) {
    console.error(
      "[widget-stream:%s] point-of-use grant re-assert errored — refusing (fail closed):",
      grant.agentSlug,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * POINT-OF-USE RE-ASSERT — call IMMEDIATELY before pre-creating the
 * OBO-carrier agent_run on the relay path. Build-time entries (`grant: null`)
 * are baked host trust and pass unchanged. Runtime entries re-assert the
 * pinned grant (approved + same hash + same rowVersion + conjunction + trust)
 * AND the relay target's own live trust (the relayed agent package must be
 * trusted-signed + activated at OBO-creation time). False → create NO run
 * (respond 401/404). A revocation linearizes here: no NEW side effect starts
 * after it is observed.
 */
export async function reassertWidgetStreamGrantBeforeOboRun(
  resolved: ResolvedWidgetStreamAgent,
  deps?: WidgetStreamRuntimeResolveDeps,
): Promise<boolean> {
  if (!resolved.grant) return true; // build-time arm: baked trust, no grant to re-assert
  const runtimeDeps = withRuntimeDefaults(deps);
  if (!(await isPinnedGrantStillAuthorized(resolved.grant, runtimeDeps))) return false;
  const relayPackage = resolved.entry.relayAgentPackage;
  if (relayPackage && !runtimeDeps.isSignedActivated(relayPackage)) return false;
  return true;
}

/**
 * Import the entry's widget-chat-tool module and build the function tool from
 * the recorded factory. The factory contract is `factory({ context })` →
 * LlmFunctionTool-shaped object (validated structurally here: the route gates
 * its `changes` SSE frame on this tool's `name`).
 *
 * POINT-OF-USE RE-ASSERT + GATED LOAD (runtime entries): BEFORE the module is
 * read or the factory invoked, the pinned grant is re-asserted live (approved +
 * same hash + same rowVersion + conjunction + trust — the revocation
 * linearization) PLUS the store integrity is re-verified against the trusted
 * anchor at the PINNED anchorDigest (an anchor that moved to a new digest
 * mid-request refuses — the next request re-resolves freshly). ONLY THEN is the
 * runtime widget-chat-tool module read — from the store dir JUST verified, via
 * the gated importer that re-resolves the approved `moduleExportKey` and
 * realpath-binds the entry inside that dir (never the runtime entry's own
 * fail-closed `load()` backstop). Any failure throws — no load, no factory
 * call, no partial tool. A revoked-but-still-module-cache-resident package can
 * therefore never be invoked. Build-time entries (`grant: null`) are unchanged
 * baked trust (the manifest's literal dynamic import via `entry.load()`).
 */
export async function buildWidgetChatTool(
  resolved: ResolvedWidgetStreamAgent,
  context: Record<string, unknown>,
  deps?: WidgetStreamRuntimeResolveDeps,
): Promise<LlmFunctionTool> {
  const { agentSlug, entry, grant } = resolved;
  let loaded: unknown;
  if (grant) {
    const runtimeDeps = withRuntimeDefaults(deps);
    // (a) REVOCATION LINEARIZATION: the pinned grant must STILL be approved at
    // the exact hash + rowVersion, the ownership conjunction still hold, and the
    // package still classify trusted-signed + activated. A revocation observed
    // here refuses — no NEW side effect (no load, no factory) starts after it.
    if (!(await isPinnedGrantStillAuthorized(grant, runtimeDeps))) {
      throw new Error(
        `[widget-stream:${agentSlug}] pre-factory grant re-assert failed — refusing to load ` +
          "or invoke the widget-chat-tool (fail closed)",
      );
    }
    // (b) the trusted anchor must still bind the SAME pinned digest (an anchor
    // that moved to a new digest mid-request refuses).
    const anchor = await runtimeDeps.resolveInstallAnchor(grant.packageName).catch(() => null);
    if (!anchor || anchor.digest !== grant.anchorDigest) {
      throw new Error(
        `[widget-stream:${agentSlug}] pre-factory anchor re-check failed (anchor missing or ` +
          "digest moved) — refusing to load or invoke the widget-chat-tool (fail closed)",
      );
    }
    // (c) INTEGRITY RE-VERIFY the store bytes against the trusted anchor at the
    // PINNED digest — IMMEDIATELY before the module read below, with no
    // observation gap. Byte drift (a re-materialized store) fails here.
    const verified = await runtimeDeps
      .resolveVerifiedStoreDir(grant.packageName, anchor)
      .catch(() => null);
    if (!verified || verified.digest !== grant.anchorDigest) {
      throw new Error(
        `[widget-stream:${agentSlug}] pre-factory integrity re-verification failed — refusing ` +
          "to load or invoke the widget-chat-tool (fail closed)",
      );
    }
    // (d) GATED MODULE READ. The importer re-verifies integrity at the pinned
    // digest via `reverifyPinnedIntegrity` FIRST, then binds every
    // import-determining read (package.json, export target, realpath) to that
    // verified snapshot — so no path/target captured while the store was
    // compromised is ever reused (a swapped-and-restored store dir cannot leave a
    // stale external path to import). A runtime widget-chat-tool loads ONLY here —
    // the runtime entry's own entry.load() is a fail-closed backstop that is
    // never taken (the W3 hot-install prohibition holds outside this gate).
    loaded = await runtimeDeps.importRuntimeModule({
      storeDir: verified.storeDir,
      moduleExportKey: grant.moduleExportKey,
      packageName: grant.packageName,
      agentSlug,
      reverifyPinnedIntegrity: async () => {
        const rv = await runtimeDeps
          .resolveVerifiedStoreDir(grant.packageName, anchor)
          .catch(() => null);
        return !!rv && rv.digest === grant.anchorDigest && rv.storeDir === verified.storeDir;
      },
    });
  } else {
    // Build-time entry (`grant: null`): unchanged baked host trust — the
    // manifest's literal dynamic import, no point-of-use grant to re-assert.
    loaded = await entry.load();
  }
  if (isDegradedExtensionLoad(loaded)) {
    // cinatra#7: an absent optional widget-chat-tool module throws the
    // TYPED absent error — the stream route catches it and responds with a
    // defined degraded status (not a generic 500).
    throw new ExtensionModuleAbsentError(loaded.specifier, loaded.reason);
  }
  const ns = loaded as Record<string, unknown>;
  const factory = ns[entry.factory];
  if (typeof factory !== "function") {
    throw new Error(
      `[widget-stream:${agentSlug}] manifest factory "${entry.factory}" is not an exported function of the widget-chat-tool module`,
    );
  }
  const tool = (factory as (opts: { context: Record<string, unknown> }) => unknown)({ context });
  const candidate = tool as
    | { name?: unknown; description?: unknown; parameters?: unknown; execute?: unknown }
    | null;
  if (
    !candidate ||
    typeof candidate.name !== "string" ||
    candidate.name.length === 0 ||
    typeof candidate.description !== "string" ||
    !candidate.parameters ||
    typeof candidate.parameters !== "object" ||
    typeof candidate.execute !== "function"
  ) {
    throw new Error(
      `[widget-stream:${agentSlug}] factory "${entry.factory}" did not return a function tool ` +
        "(name + description + parameters + execute required)",
    );
  }
  return tool as LlmFunctionTool;
}

// ---------------------------------------------------------------------------
// Content-editor relay targets (cinatra#246).
//
// The widget-stream route is a RELAY, not an LLM: it forwards the user's prompt
// + trusted CMS context to the content-editor agent's A2A endpoint. THAT agent
// is the single LLM with the cinatra MCP server injected, steered by its
// SKILL.md to call the read/update primitives — the host runs no LLM and
// exposes no function tool for this path. `agentPackageName` lets the host
// pre-create the OBO-carrier agent_run (the agent_templates row is keyed by
// package name) so the downstream CMS write authorizes via the real agent-run
// OBO path; `agentUrl` is the WayFlow A2A endpoint (per-connector env override
// with a localhost default, preserving the prior connector behavior).
//
// `agentPackageName` is data-driven from the connector's
// `cinatra.widgetStream.relayAgentPackage` (carried through the generated
// manifest OR the serve-time-verified approved runtime canon — NEVER the raw
// on-disk manifest), so the host names NO specific extension instance
// (core→extension instance-coupling ban); `agentUrl` is derived from that
// package by convention, env-overridable per agent.
export type ContentEditorRelayTarget = {
  agentPackageName: string;
  agentUrl: string;
};

/**
 * Per-agent env override key for the relay A2A URL, derived from the slug so no
 * extension-instance literal lives in core. e.g. `wordpress-content-editor` →
 * `CONTENT_EDITOR_A2A_URL__WORDPRESS_CONTENT_EDITOR`.
 */
function relayA2aUrlEnvKey(agentSlug: string): string {
  return `CONTENT_EDITOR_A2A_URL__${agentSlug.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}`;
}

/**
 * Resolve the relay target (agent package + A2A URL) for a RESOLVED
 * widget-stream agent. Takes the union-resolution result — NOT a slug — so the
 * relay package is read off the SAME pinned entry the request resolved
 * (build-time manifest or serve-time-verified approved runtime canon), never a
 * second observation of mutable state and never the raw on-disk manifest. The
 * A2A URL is derived from that package by convention (the live WayFlow route),
 * env-overridable per agent for dev. Returns null for an entry that is not a
 * relay-bearing widget-stream agent.
 */
export function resolveContentEditorRelay(
  resolved: ResolvedWidgetStreamAgent,
): ContentEditorRelayTarget | null {
  const agentPackageName = resolved.entry.relayAgentPackage;
  if (!agentPackageName) return null;
  // `@scope/name` → `http://localhost:3010/agents/<scope>/<name>/`. The trailing
  // slash is REQUIRED — the A2A SDK card resolver drops the final path segment
  // without it.
  const [scope, name] = agentPackageName.replace(/^@/, "").split("/");
  const defaultUrl = `http://localhost:3010/agents/${scope}/${name}/`;
  return {
    agentPackageName,
    agentUrl: process.env[relayA2aUrlEnvKey(resolved.agentSlug)] ?? defaultUrl,
  };
}

/**
 * The set of in-admin CMS content-editor agent packages (#1214) — every
 * `relayAgentPackage` declared by a widget-stream agent entry, derived from
 * the SAME union the serving surfaces resolve: the generated build-time map ∪
 * the approved-and-serve-time-verified runtime entries (full re-verification
 * per approved grant — hash equality, ownership conjunction, trust, integrity;
 * a build-colliding runtime row contributes nothing because build wins). NEVER
 * the raw on-disk manifest. Data-driven, so core names NO specific extension
 * instance (core→extension instance-coupling ban): an in-admin CMS content
 * editor IS, by definition, the relay target of an in-admin content-editor
 * widget. A runtime-arm enumeration failure logs and contributes nothing (the
 * build-time set is never disturbed — same posture as the resolver arm).
 */
export async function inAdminCmsContentEditorAgentPackages(
  deps?: WidgetStreamRuntimeResolveDeps,
): Promise<ReadonlySet<string>> {
  const packages = new Set<string>();
  for (const entry of Object.values(GENERATED_WIDGET_STREAM_AGENTS)) {
    if (entry.relayAgentPackage) packages.add(entry.relayAgentPackage);
  }
  const runtimeDeps = withRuntimeDefaults(deps);
  try {
    const approved = await listApprovedWidgetStreamMetadataGrants(
      { orgId: null },
      runtimeDeps.metadataGrantDeps,
    );
    for (const grant of approved) {
      if (GENERATED_WIDGET_STREAM_AGENTS[grant.agentSlug]) continue; // build wins
      const resolved = await resolveRuntimeWidgetStreamAgent(grant.agentSlug, runtimeDeps);
      if (resolved?.entry.relayAgentPackage && resolved.grant?.packageName === grant.packageName) {
        packages.add(resolved.entry.relayAgentPackage);
      }
    }
  } catch (err) {
    console.error(
      "[widget-stream] runtime in-admin content-editor enumeration failed (build-time set " +
        "unaffected; runtime packages contribute nothing this call):",
      err instanceof Error ? err.message : err,
    );
  }
  return packages;
}

/**
 * True when a dispatched agent run's template package is an in-admin CMS
 * content-editor agent — i.e. the relay target of an in-admin content-editor
 * widget — so its cinatra self-MCP access must be pinned to the MCP-backed CMS
 * primitives (#1214). Fail-closed on an empty / unknown package (a general
 * agent is never accidentally restricted; the tool allowlist itself fails
 * closed for the matched agents). The host feeds this boolean into
 * `resolveAgentRunCinatraMcpAllowedTools` — no extension package is named in
 * the mcp-server policy module.
 */
export async function isInAdminCmsContentEditorPackage(
  packageName: string | null | undefined,
  deps?: WidgetStreamRuntimeResolveDeps,
): Promise<boolean> {
  return (
    typeof packageName === "string" &&
    packageName.length > 0 &&
    (await inAdminCmsContentEditorAgentPackages(deps)).has(packageName)
  );
}
