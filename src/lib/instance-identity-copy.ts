// -----------------------------------------------------------------------------
// Shared honest copy for instance namespace mutability + marketplace framing.
//
// Consumed by BOTH /setup/name (initial capture) and /configuration/environment
// (post-setup administration) so the two surfaces cannot drift into
// inconsistent claims about namespace renamability. See
// src/lib/instance-namespace/FREEZE-RULE.md for the underlying mechanics this
// copy describes, and src/app/configuration/instance/actions.ts for the
// server-side enforcement of each state.
//
// The mutability story is four-state:
//   1. Freely editable post-setup, from Administration -> Environment -> Instance.
//   2. Temporarily locked while a marketplace vendor application is pending or
//      approved (cancel the application to unlock).
//   3. Not currently renameable on marketplace-managed instances (the
//      marketplace-backed rename round-trip is not implemented yet).
//   4. Fixed once the instance has published its first extension under the
//      current namespace — with an explicit rename escape that keeps
//      working (old published packages stay reachable under the previous
//      scope; new ones publish under the new one).
//
// Pure module (no I/O) — safe to import from a client or server component.
// -----------------------------------------------------------------------------

export function getNamespaceMutabilityCopy(isMarketplaceManaged: boolean): string {
  const editablePart =
    "You can change this later from Administration → Environment → Instance. ";
  const lockedWhilePendingPart =
    "A rename is temporarily locked while a marketplace vendor application is pending or approved. ";
  const frozenPart =
    "Once you publish your first extension, the namespace is fixed going forward — a dedicated " +
    "rename flow still exists, but old published packages stay reachable under the previous name.";

  if (isMarketplaceManaged) {
    return (
      editablePart +
      lockedWhilePendingPart +
      "This instance is marketplace-managed, so renaming the namespace isn’t supported yet " +
      "— contact Cinatra Marketplace support to coordinate a change. " +
      frozenPart
    );
  }
  return editablePart + lockedWhilePendingPart + frozenPart;
}

export function getNetworkParticipationCopy(isMarketplaceManaged: boolean): string {
  if (isMarketplaceManaged) {
    return (
      "This step reserves and registers your namespace with the Cinatra Marketplace — the " +
      "marketplace uses it to identify this instance as a vendor."
    );
  }
  return (
    "This step provisions your namespace locally; choosing a name registers nothing by itself. " +
    "Catalog attachment (browsing and installing published extensions) happens automatically and " +
    "anonymously on boot. Registering as a vendor — so you can publish under this namespace — " +
    "is a separate, opt-in step from Configuration → Environment → Registries."
  );
}

/**
 * Whether this instance's namespace is governed by the Cinatra Marketplace
 * (mode (c) in saveInstanceIdentityAction / the same env check
 * provisionAndPersist uses to block a marketplace-backed rename). Kept as a
 * one-line named check rather than an inline `process.env` read at each call
 * site so the "which env var decides this" question has exactly one answer.
 */
export function isMarketplaceManagedInstance(): boolean {
  return Boolean(process.env.MARKETPLACE_INSTANCE_TOKEN?.trim());
}
