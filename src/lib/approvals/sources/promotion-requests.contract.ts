import "server-only";

import { buildPromotionContract, promotionSubjectAdapters } from "./promotion-subjects";

// ---------------------------------------------------------------------------
// IMPORT-LIGHT nav contract for the shared promotion source (cinatra#1560, E10;
// pattern per cinatra#1283/#1391).
//
// Holds ONLY id / availability / appliesTo / counts, derived purely from the
// subject-adapter registry (`promotion-subjects.ts`) and its subject BACKENDS
// (plain data-layer read helpers) — NEVER `../decision-helpers`, the heavy
// source's rowRenderer/decide surface, or a React client decision component — so
// the root layout that consumes it via `nav-registry` stays off the heavy graph
// (nav-registry-import-purity.test.ts). The heavy `promotion-requests.ts` source
// SPREADS this object (same function references; enforced by
// `registry-parity.test.ts`).
//
// While every subject backend is unplugged, `availability()` is
// `not_configured`, so the source is DORMANT: the byte-identical `not_configured`
// filter in both `availableSources` and `availableNavSources` drops it, and the
// sidebar badge / feed never surface it until #1381 / #1437 land a backend.
// ---------------------------------------------------------------------------

export { PROMOTION_SOURCE_ID } from "./source-ids";

export const promotionRequestsContract = buildPromotionContract(promotionSubjectAdapters);
