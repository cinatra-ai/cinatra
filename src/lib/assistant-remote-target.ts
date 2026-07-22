// ---------------------------------------------------------------------------
// Remote-assistant "Remote chat" destination resolver (cinatra#1878 W3, AC#4/#5).
// ---------------------------------------------------------------------------
// A `remote`-launch assistant offers a jump-out to the connected site itself.
// The destination is built FROM THE INSTANCE RECORD's own `siteUrl` by a
// FIRST-PARTY resolver keyed on the assistant's declared `targetProvider` —
// NEVER a manifest-supplied URL (anti-open-redirect). Ratified destinations:
//   - WordPress → `{siteUrl}/wp-admin/`
//   - Drupal    → the site front page (`{siteUrl}`)
// The resolver validates http(s) and guarantees the result is SAME-ORIGIN with
// the instance record (it can only ever append a path to the recorded siteUrl).
// PURE + zero server import so it is unit-testable and safe on the client props
// path (the flyout href is server-sourced but the builder itself is pure).

/** The first-party remote connector kinds an assistant `targetProvider` maps to. */
export type RemoteConnectorKind = "wordpress" | "drupal";

/** The canonical `targetProvider` → connector-kind map. `targetProvider` names a
 *  FIRST-PARTY resolver (this table), never an arbitrary string; an unknown
 *  provider resolves to null (no remote destination — fail-closed). */
const PROVIDER_TO_KIND: Readonly<Record<string, RemoteConnectorKind>> = Object.freeze({
  wordpress: "wordpress",
  drupal: "drupal",
});

/** Resolve an assistant's declared `targetProvider` to its remote connector
 *  kind, or null when it is absent/unknown (no first-party resolver → no remote
 *  destination). */
export function remoteConnectorKindForProvider(
  targetProvider: string | null | undefined,
): RemoteConnectorKind | null {
  if (typeof targetProvider !== "string") return null;
  return PROVIDER_TO_KIND[targetProvider.trim().toLowerCase()] ?? null;
}

/** A connected-site instance record (the subset the destination builder reads). */
export type RemoteInstanceRecord = {
  id: string;
  name?: string;
  siteUrl: string;
};

/** Parse a raw URL and accept ONLY http(s). */
function parseHttpUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/**
 * Build the validated "Remote chat" destination for a remote assistant kind and
 * one instance record. Returns null when the instance's `siteUrl` is not a valid
 * http(s) URL. The result is SAME-ORIGIN with the instance record by
 * construction (a path is only ever appended to the recorded siteUrl).
 */
export function buildRemoteChatHref(
  kind: RemoteConnectorKind,
  instance: RemoteInstanceRecord,
): string | null {
  const base = parseHttpUrl(instance.siteUrl);
  if (!base) return null;

  if (kind === "wordpress") {
    // `{siteUrl}/wp-admin/` — preserve any subdirectory install path.
    const basePath = base.pathname.replace(/\/+$/, "");
    const href = new URL(`${basePath}/wp-admin/`, base.origin).toString();
    // Defence-in-depth same-origin assertion (can only fail on a malformed base).
    if (new URL(href).origin !== base.origin) return null;
    return href;
  }

  // Drupal → the site front page (the recorded siteUrl root). Ratified: the
  // module mounts its widget on the front page; a dedicated `/cinatra-assistant`
  // page is a follow-up.
  return base.toString();
}

/** The resolved remote destination for a directory/flyout row. */
export type RemoteChatDestination = {
  kind: RemoteConnectorKind;
  href: string;
};

/**
 * Resolve the full remote destination for an assistant's `targetProvider` + an
 * instance record, or null when the provider is unknown or the siteUrl is
 * invalid. The single entry the directory row builder + the flyout href use.
 */
export function resolveRemoteChatDestination(
  targetProvider: string | null | undefined,
  instance: RemoteInstanceRecord,
): RemoteChatDestination | null {
  const kind = remoteConnectorKindForProvider(targetProvider);
  if (!kind) return null;
  const href = buildRemoteChatHref(kind, instance);
  return href ? { kind, href } : null;
}
