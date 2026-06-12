// CRM list READ capability contract (cinatra#151 Stage 4).
//
// The crm-connector's `register(ctx)` publishes a deliberately NARROW
// provider-agnostic list-read surface under this capability id; the host's
// agent-builder list picker resolves it at call time instead of
// value-importing the connector's `crmFacade` export. Least privilege (the
// getNangoClient / shellTools precedent): exactly the read member the host
// consumes — mutation members are NOT exposed through the capability
// registry; they remain on the connector's own module surface for its
// internal consumers.
//
// Degradation contract: the IMPL fails loud when no CRM provider extension is
// registered (a descriptive error, never a silent empty result); the HOST
// consumer owns its degraded-to-empty policy (the list picker maps both
// "capability absent" — connector not installed/active — and a thrown
// resolution error to an empty picker, never a 500).

import type { CrmList } from "./crm-connector-contract";

/** Capability id under which the CRM list-read surface registers. */
export const CRM_LIST_READER_CAPABILITY_ID = "crm-list-reader";

/** The provider implementation the crm-connector registers. */
export type CrmListReader = {
  /** Provider-agnostic list search (today: Twenty Views via the registered
   *  CRM provider). Throws descriptively when no CRM provider is registered. */
  searchLists(input: {
    query: string;
    objectType?: "contact" | "account";
  }): Promise<CrmList[]>;
};
