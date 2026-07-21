import "server-only";

/**
 * Organization archive — ACTIVATION GATE + refusing stub (cinatra#1937, S1).
 *
 * The #1510 archive program lands dark: this module owns the default-OFF
 * activation gate and an archive entry point that REFUSES while the gate is
 * off. The real archive transaction (exclusive org lock, session
 * deactivation, lease snapshot) is the activation slice's job (S6) — nothing
 * here mutates anything.
 *
 * Gate storage: its own connector_config row (`org_archive_activation`), read
 * FAIL-CLOSED — any read error means OFF. This deliberately inverts the
 * fail-open instance-mode toggles (see isRegistrationClosed's rationale):
 * a lifecycle feature behind a dark launch must never activate because a
 * config read failed. Only a stored literal `true` enables it, and S6's
 * closeout is the only place that will ever write it in production.
 */

export const ORG_ARCHIVE_ACTIVATION_CONFIG_KEY = "org_archive_activation";

export async function isArchiveActivationEnabled(): Promise<boolean> {
  try {
    const { readConnectorConfigFromDatabase } = await import("@/lib/database");
    const cfg = readConnectorConfigFromDatabase<{ enabled?: boolean } | null>(
      ORG_ARCHIVE_ACTIVATION_CONFIG_KEY,
      null,
    );
    return cfg?.enabled === true;
  } catch {
    return false;
  }
}

export type OrganizationArchiveResult =
  | { readonly ok: false; readonly reason: "activation-gate-off" }
  | { readonly ok: false; readonly reason: "not-implemented" };

/**
 * S1 stub: refuses while the activation gate is off; refuses as
 * `not-implemented` even when a test flips the gate on (the mechanics land in
 * later slices — this pin guarantees the gate is consulted FIRST and that no
 * S1 code path can archive anything).
 */
export async function archiveOrganization(
  _organizationId: string,
  _actorUserId: string,
): Promise<OrganizationArchiveResult> {
  if (!(await isArchiveActivationEnabled())) {
    return { ok: false, reason: "activation-gate-off" };
  }
  return { ok: false, reason: "not-implemented" };
}
