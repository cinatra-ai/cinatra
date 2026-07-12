// Skills lifecycle A3 (cinatra#1363) — the state × consumer enforcement matrix
// pinned as the acceptance artifact ("a state-x-consumer matrix in-repo; each
// cell covered by a test") plus the fail-closed truth table for the single
// runtime-delivery predicate every consumer resolves.
//
// Pure leaf test: skill-source.ts has no server-only imports, so this imports
// the predicate + matrix directly.

import { describe, it, expect } from "vitest";
import {
  isRuntimeDeliverableLifecycleState,
  SKILL_LIFECYCLE_CONSUMER_MATRIX,
} from "../skill-source";

describe("isRuntimeDeliverableLifecycleState — fail-closed truth table", () => {
  it("delivers active + deprecated (deprecated is delivered + badged; badging is display-only)", () => {
    expect(isRuntimeDeliverableLifecycleState("active")).toBe(true);
    expect(isRuntimeDeliverableLifecycleState("deprecated")).toBe(true);
  });

  it("withholds draft (owner-visible only) and archived (retired)", () => {
    expect(isRuntimeDeliverableLifecycleState("draft")).toBe(false);
    expect(isRuntimeDeliverableLifecycleState("archived")).toBe(false);
  });

  it("delivers a NULL state — DERIVED (extension/legacy); the extension install-state authority governs it, this layer is a pass-through", () => {
    expect(isRuntimeDeliverableLifecycleState(null)).toBe(true);
  });

  it("FAILS CLOSED on undefined (unresolved / reader error) — undefined is NOT treated as derived", () => {
    expect(isRuntimeDeliverableLifecycleState(undefined)).toBe(false);
  });

  it("FAILS CLOSED on any unknown non-null value the DB CHECK could never store", () => {
    for (const v of ["", "ACTIVE", "retired", "unknown", "Draft", "archived ", "null", "0"]) {
      expect(isRuntimeDeliverableLifecycleState(v)).toBe(false);
    }
  });
});

describe("SKILL_LIFECYCLE_CONSUMER_MATRIX — every cell pinned", () => {
  const STATES = ["draft", "active", "deprecated", "archived", "null", "unknown"] as const;
  const CONSUMERS = [
    "matching",
    "tierResolution",
    "providerDelivery",
    "directDefaultList",
    "managementPlane",
    "anthropicMirror",
  ] as const;

  it("declares a decision for every (state × consumer) cell", () => {
    for (const state of STATES) {
      const row = SKILL_LIFECYCLE_CONSUMER_MATRIX[state];
      expect(row, `row for state=${state}`).toBeDefined();
      for (const consumer of CONSUMERS) {
        expect(
          (row as Record<string, string>)[consumer],
          `cell (${state} × ${consumer})`,
        ).toBeTruthy();
      }
    }
  });

  it("pins the archived row — excluded from EVERY runtime-delivery mode, mirror RECLAIMED, still management-visible", () => {
    const archived = SKILL_LIFECYCLE_CONSUMER_MATRIX.archived;
    expect(archived.matching).toBe("exclude");
    expect(archived.tierResolution).toBe("exclude");
    expect(archived.providerDelivery).toBe("exclude");
    expect(archived.directDefaultList).toBe("manage-only");
    expect(archived.managementPlane).toBe("visible");
    expect(archived.anthropicMirror).toBe("reclaim");
  });

  it("pins the draft row — owner-visible only, excluded from runtime delivery", () => {
    const draft = SKILL_LIFECYCLE_CONSUMER_MATRIX.draft;
    expect(draft.tierResolution).toBe("exclude");
    expect(draft.providerDelivery).toBe("exclude");
    expect(draft.directDefaultList).toBe("owner-only");
    expect(draft.managementPlane).toBe("visible");
  });

  it("pins active/deprecated/null as delivered + synced; unknown fully excluded", () => {
    for (const s of ["active", "deprecated", "null"] as const) {
      expect(SKILL_LIFECYCLE_CONSUMER_MATRIX[s].tierResolution).toBe("deliver");
      expect(SKILL_LIFECYCLE_CONSUMER_MATRIX[s].providerDelivery).toBe("deliver");
      expect(SKILL_LIFECYCLE_CONSUMER_MATRIX[s].anthropicMirror).toBe("sync");
    }
    expect(SKILL_LIFECYCLE_CONSUMER_MATRIX.unknown.tierResolution).toBe("exclude");
    expect(SKILL_LIFECYCLE_CONSUMER_MATRIX.unknown.providerDelivery).toBe("exclude");
    expect(SKILL_LIFECYCLE_CONSUMER_MATRIX.unknown.anthropicMirror).toBe("exclude");
  });

  it("the matrix delivery columns AGREE with isRuntimeDeliverableLifecycleState (predicate ⇔ matrix, no drift)", () => {
    const stateArg: Record<(typeof STATES)[number], string | null> = {
      draft: "draft",
      active: "active",
      deprecated: "deprecated",
      archived: "archived",
      null: null,
      unknown: "totally-unknown-value",
    };
    for (const state of STATES) {
      const deliverable = isRuntimeDeliverableLifecycleState(stateArg[state]);
      const row = SKILL_LIFECYCLE_CONSUMER_MATRIX[state];
      const delivers = deliverable ? "deliver" : "exclude";
      const includes = deliverable ? "include" : "exclude";
      const syncs = deliverable ? "sync" : ["exclude", "reclaim"];
      expect(row.tierResolution, `tierResolution ${state}`).toBe(delivers);
      expect(row.providerDelivery, `providerDelivery ${state}`).toBe(delivers);
      expect(row.matching, `matching ${state}`).toBe(includes);
      if (Array.isArray(syncs)) {
        expect(syncs, `anthropicMirror ${state}`).toContain(row.anthropicMirror);
      } else {
        expect(row.anthropicMirror, `anthropicMirror ${state}`).toBe(syncs);
      }
    }
  });

  it("management-plane is ALWAYS visible — an authorized manage actor sees every state (restore/rollback/history)", () => {
    for (const state of STATES) {
      expect(SKILL_LIFECYCLE_CONSUMER_MATRIX[state].managementPlane).toBe("visible");
    }
  });
});
