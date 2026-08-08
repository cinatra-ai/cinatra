/**
 * Parity proof between the heavy full `approvalSourceRegistry` (page / MCP /
 * decide graph) and the IMPORT-LIGHT `approvalNavSourceRegistry` the root layout
 * consumes for the sidebar Approvals badge (cinatra#1283).
 *
 * The split (a `*.contract.ts` light half per source, SPREAD by the heavy
 * source) exists so the layout can resolve `{ total, visible }` WITHOUT dragging
 * the decide/render graph (`../decision-helpers` → `@cinatra-ai/agents/mcp-
 * handlers`, the client decision-action components) into every route's build.
 * That is only safe if the two registries can NEVER drift:
 *
 *  1. SAME ordered source list — every heavy source has exactly one nav entry at
 *     the same index (so "a new source lights the badge with no sidebar edit"
 *     holds: adding a source = one contract entry + one heavy entry, no layout
 *     or sidebar change).
 *  2. SAME function references — each heavy source's counts / appliesTo /
 *     availability / inboxActionable IS its contract's (equality by
 *     construction; the spread copies the reference). A hand-duplicated count in
 *     the heavy source would silently disagree with the badge — this fails CI.
 */
import { describe, it, expect } from "vitest";

import { approvalSourceRegistry } from "../registry";
import { approvalNavSourceRegistry } from "../nav-registry";

describe("nav registry ⇔ full registry parity", () => {
  it("enumerates the same sources in the same order", () => {
    expect(approvalNavSourceRegistry.map((s) => s.id)).toEqual(
      approvalSourceRegistry.map((s) => s.id),
    );
  });

  it("shares the SAME nav function references (no drift between badge and page)", () => {
    const navById = new Map(approvalNavSourceRegistry.map((s) => [s.id, s]));

    for (const heavy of approvalSourceRegistry) {
      const nav = navById.get(heavy.id);
      expect(nav, `nav source missing for id=${heavy.id}`).toBeDefined();
      if (!nav) continue;

      // The identity that guarantees the sidebar badge and the page compute
      // from the exact same logic — reference equality, not value equality.
      expect(heavy.counts, `${heavy.id}.counts`).toBe(nav.counts);
      expect(heavy.appliesTo, `${heavy.id}.appliesTo`).toBe(nav.appliesTo);
      expect(heavy.availability, `${heavy.id}.availability`).toBe(nav.availability);
      expect(heavy.inboxActionable, `${heavy.id}.inboxActionable`).toBe(nav.inboxActionable);
    }
  });

  it("every nav source is backed by exactly one heavy source", () => {
    const heavyIds = new Set(approvalSourceRegistry.map((s) => s.id));
    for (const nav of approvalNavSourceRegistry) {
      expect(heavyIds.has(nav.id), `orphan nav source id=${nav.id}`).toBe(true);
    }
    expect(approvalNavSourceRegistry.length).toBe(approvalSourceRegistry.length);
  });
});
