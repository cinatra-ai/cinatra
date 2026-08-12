// ---------------------------------------------------------------------------
// /assistants DIRECTORY resolver (cinatra#1878 W3, AC#4). Builds the rows the
// /assistants page renders: exactly the assistants in the ACTOR's audience, one
// row each. A local assistant offers a single "Chat" action; a remote-capable
// assistant expands per AUTHORIZED instance with "Chat locally" (a site-scoped
// chat inside cinatra) and "Remote chat" (the jump-out to the site itself). Every
// remote instance is re-authorized through the actor-scoped
// listAuthorizedInstances authority, and every remote link is built from the
// instance record's own siteUrl by the first-party resolver (never a manifest
// URL). The build LOGIC is dependency-injected so it is unit-testable without a
// session, a DB, or connector clients.

import {
  buildChatPath,
  packageNameToVendorSlug,
} from "@cinatra-ai/chat/chat-path-codec";
import type {
  AssistantAudienceGrant,
  AssistantRegistryEntry,
} from "@/lib/assistant-registry-reader";
// TYPE-ONLY, deliberately. This module sits in the reachable graph of /chat and
// the a2a / llm-bridge / mcp API routes, all of which are route-graph-ratcheted.
// A VALUE import of the scope-filter helpers would add a module to every one of
// those budgets to serve a filter only /assistants uses, so the predicate is
// INJECTED by the caller instead (see `AssistantsDirectoryOptions.scopeMatch`)
// and only the erased types cross this boundary.
import type { NormalizedResourceScope } from "@/lib/scope-filter";
import {
  remoteConnectorKindForProvider,
  resolveRemoteChatDestination,
  type RemoteConnectorKind,
  type RemoteInstanceRecord,
} from "@/lib/assistant-remote-target";

/** One authorized remote instance's actions in a directory row. */
export type DirectoryRemoteInstance = {
  instanceId: string;
  name: string;
  /** Site-scoped chat INSIDE cinatra: `/chat/<vendor>/<slug>/<instance>`. */
  localChatHref: string;
  /** The jump-out to the connected site (ExternalLink). */
  remoteHref: string;
};

/** One assistant row in the /assistants directory. */
export type AssistantDirectoryRow = {
  packageName: string;
  vendor: string;
  slug: string;
  displayName: string;
  /** The canonical mention tag (primary handle). */
  handle: string;
  /** The claimed nicknames (aliases). */
  aliases: string[];
  isBuiltin: boolean;
  /** True for a `remote`-launch assistant (expands per authorized instance). */
  remoteCapable: boolean;
  /** The single local "Chat" action: `/chat/<vendor>/<slug>`. */
  localChatHref: string;
  /** Authorized instances (remote-capable rows only; [] when none/authorized). */
  remoteInstances: DirectoryRemoteInstance[];
  /**
   * The row's scope footprint (cinatra#2688), folded from the assistant's
   * `assistant_audience` grants by `assistantAudienceScopeEntries`. The
   * `?scope=` filter OR-matches the selection against THESE entries, exactly as
   * /connectors matches its granted-connection entries.
   */
  scopeEntries: NormalizedResourceScope[];
};

// ---------------------------------------------------------------------------
// Audience → scope-filter fold (cinatra#2688).
// ---------------------------------------------------------------------------

/**
 * Fold an assistant's `assistant_audience` grants into the shared
 * `NormalizedResourceScope` vocabulary the `?scope=` filter matches against.
 *
 * The two grammars already align (the URL filter's `org:` is the audience
 * table's `organization`; `scopeSelectionMatches` bridges that itself), so the
 * fold is a straight per-kind mapping:
 *
 *   workspace                 → { locus: "workspace" }
 *   admin                     → { locus: "workspace", adminOnly: true }
 *   organization/team/project → { locus: …, locusId: subjectId }
 *
 * FAIL-CLOSED, mirroring cinatra#953 W3: a grant of an unknown kind, or an
 * org/team/project grant with NO `subjectId`, yields no entry — so it can never
 * over-match an id-carrying selection. An assistant with no usable grant at all
 * therefore shows only under the default ("workspace") view.
 *
 * The builtin Cinatra descriptor carries no grant rows because it is
 * unconditionally visible; it is normalized to the workspace locus from
 * `isBuiltin`, so it behaves like a workspace-granted assistant rather than
 * vanishing under every non-default selection.
 *
 * There is deliberately NO "personal" mapping: `assistant_audience` has no
 * per-user subject kind, so no assistant matches the `personal` token today.
 */
export function assistantAudienceScopeEntries(entry: {
  isBuiltin: boolean;
  audience?: readonly AssistantAudienceGrant[];
}): NormalizedResourceScope[] {
  const entries: NormalizedResourceScope[] = [];
  if (entry.isBuiltin) entries.push({ locus: "workspace" });
  for (const grant of entry.audience ?? []) {
    switch (grant.subjectKind) {
      case "workspace":
        entries.push({ locus: "workspace" });
        break;
      case "admin":
        entries.push({ locus: "workspace", adminOnly: true });
        break;
      case "organization":
        if (grant.subjectId) entries.push({ locus: "organization", locusId: grant.subjectId });
        break;
      case "team":
        if (grant.subjectId) entries.push({ locus: "team", locusId: grant.subjectId });
        break;
      case "project":
        if (grant.subjectId) entries.push({ locus: "project", locusId: grant.subjectId });
        break;
      // Unknown kinds fold to nothing (fail-closed, mirroring the reader's own
      // unknown-kind handling in `matchesAssistantAudience`).
    }
  }
  return entries;
}

/** Build options — the `?scope=` narrowing the /assistants page resolved. */
export type AssistantsDirectoryOptions = {
  /**
   * The `?scope=` predicate (cinatra#2688): does a row's scope footprint match
   * the reader's selection? Built by the /assistants page from the ONE shared
   * canonical parser + OR-predicate, and INJECTED here rather than imported, so
   * the scope-filter module never enters the route budgets of the other
   * surfaces that reach this resolver.
   *
   * OMITTED means the broadest view — every row the audience gate admitted,
   * unnarrowed. The caller omits it for the default selection, which is where
   * the default short-circuit lives on /connectors too, so a row carrying NO
   * scope entries still shows under the default view.
   */
  scopeMatch?: (scopeEntries: readonly NormalizedResourceScope[]) => boolean;
};

/** The injectable data sources. */
export type AssistantsDirectoryDeps = {
  readVisibleRegistry(): Promise<AssistantRegistryEntry[]>;
  /** The actor-authorized instances of a remote connector kind (already filtered
   *  by the listAuthorizedInstances authority — actor A never sees actor B's). */
  listAuthorizedInstances(kind: RemoteConnectorKind): Promise<RemoteInstanceRecord[]>;
};

/**
 * Build the directory rows for an actor. Pure given `deps`. Rows are sorted by
 * display name (builtin Cinatra first) for a stable directory.
 *
 * `options.scopeMatch` applies the `?scope=` OR-filter (cinatra#2688) on top of
 * the audience gate — it can only ever NARROW what the actor already sees, never
 * widen it. An omitted predicate is the broadest view, so a row that carries no
 * scope entries at all still shows there.
 */
export async function buildAssistantsDirectory(
  deps: AssistantsDirectoryDeps,
  options: AssistantsDirectoryOptions = {},
): Promise<AssistantDirectoryRow[]> {
  const entries = await deps.readVisibleRegistry();
  const scopeMatch = options.scopeMatch;

  const rows: AssistantDirectoryRow[] = [];
  for (const entry of entries) {
    const vs = packageNameToVendorSlug(entry.packageName);
    if (!vs) continue; // a non-scoped package can never be a /chat route target
    const { vendor, slug } = vs;
    const remoteCapable = entry.launch.kind === "remote";

    // Scope-filter BEFORE the per-row instance authority runs: a row the
    // selection excludes must not cost a `listAuthorizedInstances` round trip.
    const scopeEntries = assistantAudienceScopeEntries(entry);
    if (scopeMatch && !scopeMatch(scopeEntries)) continue;

    const remoteInstances: DirectoryRemoteInstance[] = [];
    if (remoteCapable) {
      const kind = remoteConnectorKindForProvider(entry.launch.targetProvider);
      if (kind) {
        const instances = await deps.listAuthorizedInstances(kind);
        for (const instance of instances) {
          const dest = resolveRemoteChatDestination(entry.launch.targetProvider, instance);
          if (!dest) continue; // invalid siteUrl → drop the row (no broken link)
          remoteInstances.push({
            instanceId: instance.id,
            name: instance.name ?? instance.siteUrl,
            localChatHref: buildChatPath({ vendor, slug, instance: instance.id }),
            remoteHref: dest.href,
          });
        }
      }
    }

    rows.push({
      packageName: entry.packageName,
      vendor,
      slug,
      displayName: entry.displayName,
      handle: entry.handle,
      aliases: entry.aliases,
      isBuiltin: entry.isBuiltin,
      remoteCapable,
      localChatHref: buildChatPath({ vendor, slug }),
      remoteInstances,
      scopeEntries,
    });
  }

  return rows.sort((a, b) => {
    if (a.isBuiltin !== b.isBuiltin) return a.isBuiltin ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });
}

// ---------------------------------------------------------------------------
// Default (production) deps — lazily import the heavy host graph.
// ---------------------------------------------------------------------------

async function readVisibleRegistryForCurrentActor(): Promise<AssistantRegistryEntry[]> {
  const { getAuthSession, isPlatformAdmin } = await import("@/lib/auth-session");
  const { resolveAssistantAudienceContext, readAssistantRegistryForActor } = await import(
    "@/lib/assistant-registry-reader"
  );
  const session = await getAuthSession();
  if (!session) {
    const entries = await readAssistantRegistryForActor({
      userId: "",
      isPlatformAdmin: false,
      orgIds: new Set(),
      teamIds: new Set(),
      projectIds: new Set(),
    });
    return entries.filter((e) => e.isBuiltin);
  }
  const activeOrgId =
    (session.session as { activeOrganizationId?: string | null } | undefined)?.activeOrganizationId ??
    null;
  const ctx = await resolveAssistantAudienceContext({
    userId: session.user.id,
    activeOrgId,
    isPlatformAdmin: isPlatformAdmin(session),
  });
  return readAssistantRegistryForActor(ctx);
}

/** List the raw instance rows for a remote kind, then keep only those the current
 *  actor is authorized to `use` (the listAuthorizedInstances authority). */
async function listAuthorizedInstancesForCurrentActor(
  kind: RemoteConnectorKind,
): Promise<RemoteInstanceRecord[]> {
  const { resolveWordPressInstanceAdmin, resolveDrupalInstanceAdmin } = await import(
    "@/lib/connector-client-providers"
  );
  const { createInstanceListAuthority } = await import("@/lib/connector-instance-write-authority");

  let raw: RemoteInstanceRecord[] = [];
  if (kind === "wordpress") {
    const admin = resolveWordPressInstanceAdmin();
    const rows = admin ? await admin.listWordPressInstances() : [];
    raw = rows.map((r) => ({ id: r.id, name: r.name, siteUrl: r.siteUrl }));
  } else {
    const admin = resolveDrupalInstanceAdmin();
    const rows = admin ? admin.listInstances() : [];
    raw = rows.map((r) => ({ id: r.id, name: r.name, siteUrl: r.siteUrl }));
  }
  if (raw.length === 0) return [];
  const filter = createInstanceListAuthority(kind);
  return filter(raw);
}

/** The production deps (used by the /assistants page). */
export const DEFAULT_ASSISTANTS_DIRECTORY_DEPS: AssistantsDirectoryDeps = {
  readVisibleRegistry: readVisibleRegistryForCurrentActor,
  listAuthorizedInstances: listAuthorizedInstancesForCurrentActor,
};

/** Build the directory for the current actor — the entry the /assistants page calls. */
export function buildAssistantsDirectoryForCurrentActor(
  options: AssistantsDirectoryOptions = {},
): Promise<AssistantDirectoryRow[]> {
  return buildAssistantsDirectory(DEFAULT_ASSISTANTS_DIRECTORY_DEPS, options);
}

/**
 * Resolve the "Remote chat" destination for a single bound remote route (the
 * flyout href the /chat page passes to the composer). Returns null for a
 * non-remote assistant, an unknown provider, an unauthorized/unknown instance,
 * or an invalid siteUrl. Reuses the directory's authorized-instance listing so
 * the flyout link can only ever point at an instance the actor may use.
 */
export async function resolveRemoteChatForBoundRoute(
  args: { targetProvider: string | null; instanceId: string },
  deps: AssistantsDirectoryDeps = DEFAULT_ASSISTANTS_DIRECTORY_DEPS,
): Promise<{ href: string } | null> {
  const kind = remoteConnectorKindForProvider(args.targetProvider);
  if (!kind) return null;
  const instances = await deps.listAuthorizedInstances(kind);
  const instance = instances.find((i) => i.id === args.instanceId);
  if (!instance) return null;
  const dest = resolveRemoteChatDestination(args.targetProvider, instance);
  return dest ? { href: dest.href } : null;
}
