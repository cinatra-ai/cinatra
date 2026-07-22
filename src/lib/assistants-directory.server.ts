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
import type { AssistantRegistryEntry } from "@/lib/assistant-registry-reader";
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
 */
export async function buildAssistantsDirectory(
  deps: AssistantsDirectoryDeps,
): Promise<AssistantDirectoryRow[]> {
  const entries = await deps.readVisibleRegistry();

  const rows: AssistantDirectoryRow[] = [];
  for (const entry of entries) {
    const vs = packageNameToVendorSlug(entry.packageName);
    if (!vs) continue; // a non-scoped package can never be a /chat route target
    const { vendor, slug } = vs;
    const remoteCapable = entry.launch.kind === "remote";

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
export function buildAssistantsDirectoryForCurrentActor(): Promise<AssistantDirectoryRow[]> {
  return buildAssistantsDirectory(DEFAULT_ASSISTANTS_DIRECTORY_DEPS);
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
