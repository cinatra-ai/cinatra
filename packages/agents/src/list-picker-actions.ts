"use server";

import "server-only";

import { crmFacade } from "@cinatra-ai/crm-connector";
import { requireAdminSession } from "@/lib/auth-session";

// The picker still exposes the legacy `AvailableListSummary` shape so its
// downstream consumers (orchestrator panels, list-curator scrape renderer,
// agent-builder steppers) don't need to migrate in the same slice. The
// source of truth swaps from the in-process lists-package handlers to the
// CRM facade — Twenty Views via the twenty-connector provider — but the
// outward shape is preserved.
//
// Field mapping from CrmList -> AvailableListSummary:
//   id          : CrmList.id
//   name        : CrmList.name
//   memberCount : NOT available from `crm_list_search` (Twenty Views are
//                 filter-defined, not materialized). Until the resolver
//                 wires per-view membership counts, this surfaces as null.
//   lastUpdated : not part of the CrmList shape; surfaces as null.
//   memberType  : derived from CrmList.objectType ("contact" / "account").
//                 The legacy "mixed" branch is gone — Twenty Views are
//                 single-type. Downstream `mixed` consumers fall back to
//                 the "contact" branch (the picker's only callers today
//                 work with contact lists).

export type AvailableListSummary = {
  id: string;
  name: string;
  /** null when the CRM provider does not expose a materialized member count. */
  memberCount: number | null;
  /** null when the CRM provider does not expose a last-updated timestamp. */
  lastUpdated: string | null;
  memberType: "account" | "contact" | "mixed";
};

export async function fetchAvailableLists(): Promise<AvailableListSummary[]> {
  // Auth gate FIRST — no CRM read before this resolves.
  await requireAdminSession();

  let lists;
  try {
    // Picker shows contact-eligible lists. Twenty's `get_views` is
    // workspace-scoped; the crm-connector facade post-filters by objectType
    // when the per-type object-metadata cache has resolved (lazy-loaded by
    // the connector on first call).
    lists = await crmFacade.list.search({ query: "", objectType: "contact" });
  } catch {
    // No Twenty row yet, no bearer attached, or upstream unreachable —
    // degrade to "no lists available" rather than 500-ing the picker UI.
    return [];
  }

  return lists.map((l) => ({
    id: l.id,
    name: l.name,
    memberCount: null,
    lastUpdated: null,
    memberType: l.objectType,
  }));
}
