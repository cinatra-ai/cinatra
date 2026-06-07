// Provider-agnostic CRM CONTRACT (types only) — lives in the SDK so that CRM
// provider extensions (twenty-connector today; hubspot/salesforce later) and the
// crm-connector facade share the contract WITHOUT importing each other by name.
//
// Every CRM provider package implements `CrmConnector`. The crm-connector facade
// resolves the registered provider for an instance and delegates verb calls to
// it. Provider packages import these symbols via `import type { ... }` only — the
// contract has no runtime code. crm-connector/src/contract.ts re-exports these
// for backward-compat.

export type CrmConnectorId = string;

// ---------------------------------------------------------------------------
// Cinatra-shaped types (provider-agnostic surface)
// ---------------------------------------------------------------------------

export type CrmContact = {
  /** Stable id from the CRM provider (Twenty Person id, HubSpot Contact id, etc.) */
  id: string;
  /** cinatra pointer row id (objects.id) — populated by the facade after the provider call */
  cinatraObjectId?: string;
  name: string;
  email?: string | null;
  title?: string | null;
  /** Provider-specific link to the owning account (e.g. Twenty Company id) */
  accountId?: string | null;
  /** `inLists` array — list slugs the contact belongs to (D5: Twenty Views ≡ Lists) */
  inLists?: string[];
  /** Apollo enrichment id, populated by apollo-prospecting-agent */
  apolloPersonId?: string | null;
  enrichmentStatus?: string | null;
  linkedinUrl?: string | null;
  twitterHandle?: string | null;
};

export type CrmAccount = {
  id: string;
  cinatraObjectId?: string;
  name: string;
  domainName?: string | null;
  /** `inLists` array — list slugs the account belongs to */
  inLists?: string[];
  apolloOrganizationId?: string | null;
};

export type CrmList = {
  /** Stable list id (Twenty View id, HubSpot List id, etc.) */
  id: string;
  /** Human-readable slug used in the `inLists` arrays on Contact + Account */
  slug: string;
  name: string;
  /** Provider's classification (Twenty View object scope: "person" | "company") */
  objectType: "contact" | "account";
};

export type CrmListMembership = {
  listId: string;
  /** Either contact or account; the facade resolves objectType from the list */
  objectId: string;
  objectType: "contact" | "account";
};

// ---------------------------------------------------------------------------
// CrmConnector interface — every provider implements this
// ---------------------------------------------------------------------------

export interface CrmConnector {
  /** Stable provider id, e.g. "twenty" */
  providerId: string;

  // ----- Contact (cinatra: contact ↔ Twenty: Person) -----

  /** crm_contact_search */
  searchContacts(input: { query: string; limit?: number }): Promise<CrmContact[]>;
  /** crm_contact_get */
  getContact(input: { id: string }): Promise<CrmContact | null>;
  /** crm_contact_create — also writes the cinatra.objects pointer row (D2) */
  createContact(input: Omit<CrmContact, "id" | "cinatraObjectId">): Promise<CrmContact>;
  /** crm_contact_update */
  updateContact(input: { id: string; patch: Partial<CrmContact> }): Promise<CrmContact>;
  /** crm_contact_find_by_email — returns null if no match */
  findContactByEmail(input: { email: string }): Promise<CrmContact | null>;

  // ----- Account (cinatra: account ↔ Twenty: Company) -----

  /** crm_account_search */
  searchAccounts(input: { query: string; limit?: number }): Promise<CrmAccount[]>;
  /** crm_account_get */
  getAccount(input: { id: string }): Promise<CrmAccount | null>;
  /** crm_account_create — also writes the cinatra.objects pointer row */
  createAccount(input: Omit<CrmAccount, "id" | "cinatraObjectId">): Promise<CrmAccount>;
  /** crm_account_update */
  updateAccount(input: { id: string; patch: Partial<CrmAccount> }): Promise<CrmAccount>;

  // ----- List (cinatra: list ↔ Twenty: View filtered on `inLists`) -----

  /** crm_list_search */
  searchLists(input: { query: string; objectType?: "contact" | "account" }): Promise<CrmList[]>;
  /** crm_list_get */
  getList(input: { id: string }): Promise<CrmList | null>;
  /** crm_list_create — creates a Twenty View filtered on `inLists CONTAINS <slug>` */
  createList(input: Omit<CrmList, "id">): Promise<CrmList>;
  /** crm_list_members_get — returns contact/account ids in the list */
  getListMembers(input: { listId: string; limit?: number }): Promise<{
    contactIds: string[];
    accountIds: string[];
  }>;
  /** crm_list_member_add — patches the member's `inLists` array */
  addListMember(input: CrmListMembership): Promise<void>;
  /** crm_list_member_remove — patches the member's `inLists` array */
  removeListMember(input: CrmListMembership): Promise<void>;
}
