// NEGATIVE FIXTURE — criterion 2: registration is closed by default and fails
// closed.
//
// This module is never imported by the product. It carries the WRONG version of
// the rule it is named after, so the assertion that pins the real rule can be
// pointed at it and REQUIRED to reject it. An assertion that passes on this
// fixture proves nothing about the module it is supposed to be guarding: it
// would go on passing after the safe default had been lost again.
//
// What is wrong with it, line by line:
//   - the stored value has to say `true` before registration counts as closed,
//     so an instance with nothing stored — every brand-new instance — is OPEN;
//   - a setting that cannot be read at all resolves to OPEN.

export const CRITERION_2_NEGATIVE_FIXTURE = {
  criterion: 2,
  name: "criterion-2-registration-defaults-open",
  rule: "registration is closed by default and a failed read fails closed",
  source: `
export async function isRegistrationClosed(): Promise<boolean> {
  try {
    const { readConnectorConfigFromDatabase } = await import("@/lib/database");
    const cfg = readConnectorConfigFromDatabase<{ closedRegistration?: unknown } | null>("instance_identity", null);
    return cfg?.closedRegistration === true;
  } catch {
    return false;
  }
}
`,
} as const;
