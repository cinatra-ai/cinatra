/**
 * §IX "The scope Dashboards tab — listings & add-to-scope" — BIDIRECTIONAL
 * source-text conformance (cinatra#1897 B4).
 *
 * Pins the build to the RATIFIED design spec `specs/app-artifacts.html` §IX at
 * design@bb9230d9b19e3ea632911ae94b4a6d0561292dab (the Artifacts spec;
 * `conformance/app-artifacts.json` contentHash
 * sha256:6079f4afd6c106373c154fee7d016ca139c753c0ae4adad7b6948db02b6c6502 — the
 * three §IX surfaces scope-dashboards-tab, scope-dashboards-add-picker,
 * scope-dashboards-write-access). The repo runs vitest in node without
 * @testing-library/react, so the component wiring is pinned via SOURCE
 * assertions (the established pattern — see dashboard-surface-conformance.test.ts);
 * the live bidirectional Playwright walk on the staged stack is the
 * proof-at-close.
 *
 * BIDIRECTIONAL:
 *   spec → render — every §IX conformance id, field, action and data-state the
 *     ratified surfaces name is realized by the components; AND
 *   render → spec — the components introduce NO conformance id the spec does not
 *     specify, and the tab is a POINTER (Open navigates to the canonical surface;
 *     no inline dashboard render), a Home row carries no Remove, and the write
 *     controls are SUPPRESSED (not disabled) for a non-manager.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const HERE = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(HERE, rel), "utf8");
/** Strip comments so a "no X" check tests the CODE, not the prose explaining it. */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const TAB = read("scope-dashboards-tab.tsx");
const PICKER = read("add-to-scope-picker.tsx");

/** The §IX surface contract, transcribed from conformance/app-artifacts.json at
 *  design@bb9230d9b — the pinned source of truth this test checks BOTH ways. */
const SURFACES = {
  "scope-dashboards-tab": {
    field: "name=identity.displayName",
    actions: [
      "open-add-picker -> add-picker-open",
      "open-dashboard -> dashboard-canonical",
      "remove-listing -> listing-removed",
    ],
    states: ["empty", "error", "kind:artifact", "loading"],
  },
  "scope-dashboards-add-picker": {
    field: "candidate=collectionAdd.listable",
    actions: [
      "add-listing -> listing-added",
      "request-promotion -> promotion-requested",
    ],
    states: ["empty", "error", "loading"],
  },
  "scope-dashboards-write-access": {
    field: "manage-controls=collectionAdd.actorMayWriteScope",
    actions: [] as string[],
    states: [] as string[],
  },
} as const;

/** The complete set of §IX conformance ids — nothing outside it may appear. */
const ALLOWED_CONFORMANCE_IDS = new Set(Object.keys(SURFACES));

// ── scope-dashboards-tab ────────────────────────────────────────────────────
describe("§IX conformance id: scope-dashboards-tab (the scope's Dashboards tab)", () => {
  it("carries the conformance id + the name field (spec → render)", () => {
    expect(TAB).toContain('data-conformance-id="scope-dashboards-tab"');
    expect(TAB).toContain(`data-field="${SURFACES["scope-dashboards-tab"].field}"`);
  });

  it("wires every §IX tab action (open-add-picker, open-dashboard, remove-listing)", () => {
    for (const action of SURFACES["scope-dashboards-tab"].actions) {
      expect(TAB).toContain(`data-action="${action}"`);
    }
  });

  it("covers the closed data-state set (empty · error · loading · kind:artifact)", () => {
    for (const state of SURFACES["scope-dashboards-tab"].states) {
      expect(TAB).toContain(`"${state}"`);
    }
  });

  it("Open navigates to the dashboard's CANONICAL surface — a pointer, never an inline render (render → spec)", () => {
    expect(TAB).toMatch(/href=\{row\.canonicalHref\}/);
    expect(TAB).toMatch(/>\s*Open\s*</);
    // No inline dashboard render is wired into the tab.
    expect(TAB).not.toMatch(/PortletHost/);
    expect(TAB).not.toMatch(/DashboardGrid/);
    expect(TAB).not.toMatch(/pickArtifactRenderer/);
  });

  it("Home vs Listed: both badges render; ONLY a Listed row carries Remove (render → spec)", () => {
    expect(TAB).toMatch(/["'>]Home[<"']/);
    expect(TAB).toMatch(/["'>]Listed[<"']/);
    // Remove is gated on `row.canRemove` (listed AND manager) — a Home row, whose
    // canRemove is false, therefore never renders Remove.
    expect(TAB).toMatch(/row\.canRemove\s*\?/);
    expect(TAB).toMatch(/remove-listing -> listing-removed/);
  });
});

// ── scope-dashboards-write-access (§IX.2) ───────────────────────────────────
describe("§IX conformance id: scope-dashboards-write-access (the scope-write gate)", () => {
  it("carries the conformance id + the actorMayWriteScope field (spec → render)", () => {
    expect(TAB).toContain('data-conformance-id="scope-dashboards-write-access"');
    expect(TAB).toContain(
      `data-field="${SURFACES["scope-dashboards-write-access"].field}"`,
    );
  });

  it("Add is SUPPRESSED (not a disabled control) for a non-manager — gated on canManage (§IX.2, render → spec)", () => {
    // The Add affordance renders only inside the `data.canManage ? (...) : null`
    // branch — suppression, not a disabled control.
    expect(TAB).toMatch(/data\.canManage\s*\?/);
    expect(TAB).toMatch(/open-add-picker -> add-picker-open/);
    // The disabled attribute on Add/Remove is a busy-state guard, never the
    // permission gate — the permission gate is the render branch above.
    expect(code(TAB)).not.toMatch(/disabled=\{!?\s*(?:data\.)?canManage/);
  });
});

// ── scope-dashboards-add-picker (§IX.1) ─────────────────────────────────────
describe("§IX conformance id: scope-dashboards-add-picker (add to scope)", () => {
  it("carries the conformance id + the candidate field (spec → render)", () => {
    expect(PICKER).toContain('data-conformance-id="scope-dashboards-add-picker"');
    expect(PICKER).toContain(
      `data-field="${SURFACES["scope-dashboards-add-picker"].field}"`,
    );
  });

  it("wires both §IX.1 actions (add-listing, request-promotion)", () => {
    for (const action of SURFACES["scope-dashboards-add-picker"].actions) {
      expect(PICKER).toContain(`data-action="${action}"`);
    }
  });

  it("covers the picker data-state set (empty · error · loading)", () => {
    for (const state of SURFACES["scope-dashboards-add-picker"].states) {
      expect(PICKER).toContain(`data-state="${state}"`);
    }
  });

  it("the promotion recourse is offered ONLY on the scope-invisible disposition, never an in-place add (render → spec)", () => {
    // request-promotion lives on the `disposition === "promotion"` branch; the
    // add button on the `disposition === "addable"` branch — the two are mutually
    // exclusive per candidate, so a scope-invisible row is never directly Add-able.
    expect(PICKER).toMatch(/disposition === "addable"/);
    expect(PICKER).toMatch(/disposition === "promotion"/);
    expect(PICKER).toMatch(/add-listing -> listing-added/);
    expect(PICKER).toMatch(/request-promotion -> promotion-requested/);
  });
});

// ── render → spec: no surface the spec does not specify ─────────────────────
describe("§IX render → spec: no unspecified conformance id leaks in", () => {
  it("every data-conformance-id in the §IX components is one the ratified spec names", () => {
    const found = new Set<string>();
    for (const src of [TAB, PICKER]) {
      for (const m of src.matchAll(/data-conformance-id="([^"]+)"/g)) {
        found.add(m[1]);
      }
    }
    expect(found.size).toBeGreaterThan(0);
    for (const id of found) {
      expect(ALLOWED_CONFORMANCE_IDS.has(id)).toBe(true);
    }
  });
});
