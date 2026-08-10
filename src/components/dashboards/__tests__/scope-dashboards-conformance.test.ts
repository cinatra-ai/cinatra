/**
 * §IX "The scope Dashboards tab — listings & add-to-scope" — BIDIRECTIONAL
 * source-text conformance (cinatra#1897 B4; re-mapped by cinatra#2474 PR3).
 *
 * Pins the build to the RATIFIED design spec `specs/app-artifacts.html` §IX at
 * design@0ead5d0c549115aca4e21c21b53dc2d2269dbd84 (the Artifacts spec, version 0.8.0;
 * `conformance/app-artifacts.json` contentHash
 * sha256:ee23ebf07b4f61405398cd05ca5045ec7b4103e501a0fde4392fa3a17c8380d7 — the
 * three §IX surfaces scope-dashboards-tab, scope-dashboards-add-picker,
 * scope-dashboards-write-access; §IX is byte-identical at the file's current tip
 * design@60cf789ec9b6d6455148a086cacc6ae43f447cef, the revision #2474 pins).
 * The repo runs these as SOURCE assertions (the established pattern — see
 * dashboard-surface-conformance.test.ts); the live bidirectional Playwright walk
 * on the staged stack is the proof-at-close, and the popup's PERMISSION and
 * hand-off behaviour is additionally proven by a real render in
 * add-dashboard-dialog.test.tsx.
 *
 * WHICH FILE CARRIES WHAT (cinatra#2474 PR3 consolidated every add path into one
 * toolbar-launched popup, so two §IX annotations moved COMPONENT — the surface
 * they annotate, the entity landing's Dashboards tab, is unchanged):
 *
 *   scope-dashboards-tab          → scope-dashboards-tab.tsx (the collection
 *                                   panel: rows, Open, Remove, the state frames)
 *   scope-dashboards-add-picker   → scope-reference-section.tsx (the §IX.1
 *                                   picker, now embedded in the popup) plus the
 *                                   popup shell add-dashboard-dialog.tsx
 *   scope-dashboards-write-access → the popup's TOOLBAR trigger
 *                                   (entity-dashboard-toolbar-controls.tsx) for
 *                                   Add, and scope-dashboards-tab.tsx for Remove
 *
 * BIDIRECTIONAL:
 *   spec → render — every §IX conformance id, field, action and data-state the
 *     ratified surfaces name is realized by the components; AND
 *   render → spec — the components introduce NO conformance id the spec does not
 *     specify, and the tab is a POINTER (Open navigates to the canonical surface;
 *     no inline dashboard render); removability is read from the Remove control
 *     ALONE — no Home / Listed relation badge, no per-row "Dashboards" pill, no
 *     `home:` provenance (a homed row shows no Remove); and the write controls
 *     are SUPPRESSED (not disabled) for a non-manager.
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
const PICKER = read("scope-reference-section.tsx");
const DIALOG = read("add-dashboard-dialog.tsx");
/** The toolbar control that launches the popup — where the §IX.2 Add gate now
 *  lives (cinatra#2474 PR3). */
const TOOLBAR = readFileSync(
  path.resolve(
    __dirname,
    "../../../../packages/dashboards/src/components/entity-dashboard-toolbar-controls.tsx",
  ),
  "utf8",
);
/** The server-side binder that DECIDES who gets the add source. */
const BINDING = read("scope-reference-binding.ts");
/** The SERVER service is where a row's meta line and a picker candidate's note
 *  are BUILT — so the "no `home:` provenance" ruling is guarded at its source,
 *  not only at the components that render the projected strings. */
const SERVICE = readFileSync(
  path.resolve(__dirname, "../../../lib/dashboards/scope-dashboards-service.ts"),
  "utf8",
);

/** The §IX surface contract, transcribed from conformance/app-artifacts.json at
 *  design@0ead5d0c5 — the pinned source of truth this test checks BOTH ways. */
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

  it("wires every §IX tab action — two on the panel, open-add-picker on the tab's toolbar", () => {
    // The Dashboards tab is the whole entity landing (cinatra#2474 PR1), so the
    // tab's three actions are realized across the two components that render it.
    //
    // DISTRIBUTED SURFACE, stated explicitly: `open-add-picker` is no longer a
    // DOM descendant of the `scope-dashboards-tab` annotated root — it sits in
    // the tab's toolbar, above the collection panel. Nothing in this repo walks
    // §IX by annotated-root ancestry (the e2e conformance contract covers no
    // scope-dashboards surface), and the live Playwright battery on this PR
    // asserts the three actions per RENDERED TAB (the landing), which is the
    // surface the spec names. If a future harness groups actions by ancestry it
    // must treat the landing, not the panel, as the tab root.
    expect(TAB).toContain('data-action="open-dashboard -> dashboard-canonical"');
    expect(TAB).toContain('data-action="remove-listing -> listing-removed"');
    expect(TOOLBAR).toContain('data-action="open-add-picker -> add-picker-open"');
    // And the panel no longer carries a SECOND add trigger — one entry point.
    // (Comments stripped: this file's own prose names the action it moved.)
    expect(code(TAB)).not.toContain("open-add-picker");
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

  it("no Home/Listed relation badge, no per-row Dashboards pill, no home: provenance; Remove ALONE marks a removable row (spec §IX, render → spec)", () => {
    // The owner rulings (design@0ead5d0c5): every row on this tab is a dashboard,
    // so no row repeats a "Dashboards" type label, and a row does NOT advertise
    // where the dashboard lives. Removability is read from the Remove control
    // alone — there is no Home or Listed badge and no `home:` provenance.
    const c = code(TAB);
    expect(c).not.toMatch(/["'>]Home[<"']/);
    expect(c).not.toMatch(/["'>]Listed[<"']/);
    expect(c).not.toMatch(/DASHBOARD_EXTENSION_LABEL/);
    expect(c).not.toMatch(/home:/);
    // Remove is gated on `row.canRemove` (listed AND manager) — a homed row, whose
    // canRemove is false, therefore never renders Remove.
    expect(TAB).toMatch(/row\.canRemove\s*\?/);
    expect(TAB).toMatch(/remove-listing -> listing-removed/);
  });
});

// ── scope-dashboards-write-access (§IX.2) ───────────────────────────────────
describe("§IX conformance id: scope-dashboards-write-access (the scope-write gate)", () => {
  it("carries the conformance id + the actorMayWriteScope field on BOTH manage controls (spec → render)", () => {
    for (const src of [TOOLBAR, TAB]) {
      expect(src).toContain(
        'data-conformance-id="scope-dashboards-write-access"',
      );
      expect(src).toContain(
        `data-field="${SURFACES["scope-dashboards-write-access"].field}"`,
      );
    }
  });

  it("Add is SUPPRESSED (not a disabled control) for a non-manager, and its gate IS actorMayWriteScope (§IX.2, render → spec)", () => {
    // The toolbar's scope-level Add renders only inside the `offersUnifiedAdd`
    // branch — suppression, not a disabled control …
    expect(TOOLBAR).toMatch(/offersUnifiedAdd\s*\?/);
    expect(code(TOOLBAR)).not.toMatch(/disabled=\{!?\s*(?:offersUnifiedAdd|offersScopeAdd)/);
    // … and that branch is driven by the reference source the SERVER decided to
    // hand down, which exists only when `actorMayWriteScope` holds. The gate is
    // the predicate itself, not "some source happened to be non-null".
    expect(TOOLBAR).toMatch(/const scopeReference = scopeAdd\?\.reference \?\? null/);
    expect(BINDING).toMatch(/if \(!actorMayWriteScope\(actor, scope\)\) return null/);
    expect(BINDING).toContain(
      'from "@/lib/dashboards/scope-write-authority"',
    );
  });

  it("concept B's catalog can never grant a non-manager the scope-level Add (§IX.2, render → spec)", () => {
    // cinatra#2474 PR4 supplies the catalog slot. The "Add dashboard" LABEL, the
    // §IX.2 annotation and the open-add-picker action must all hang off the
    // NARROW predicate (the manager-only reference source); the WIDE one
    // (`|| catalog`) may only decide whether the popup exists at all.
    expect(TOOLBAR).toMatch(/const offersScopeAdd = scopeReference !== null/);
    // cinatra#2474 PR4 supplied the catalog and NARROWED the wide predicate at
    // the same time: the catalog counts toward the popup's existence only
    // alongside `canCreate`, because concept B's section is browse-only until
    // PR5's instantiate action. Both halves are locked — the catalog is still in
    // the WIDE predicate only, and it can no longer raise a button on its own.
    expect(TOOLBAR).toMatch(
      /const offersUnifiedAdd =\s*\n?\s*offersScopeAdd \|\| \(scopeAdd\?\.catalog != null && canCreate\)/,
    );
    // The catalog appears in NO other predicate: not in the narrow one, and
    // nowhere that could reach the label, the annotation or the action.
    const catalogMentions = [...TOOLBAR.matchAll(/scopeAdd\?\.catalog/g)];
    expect(catalogMentions).toHaveLength(1);
    // The annotated branch opens on `offersScopeAdd`, and everything §IX.2 owns
    // lives inside it, BEFORE the non-manager branch begins.
    const managerBranch = TOOLBAR.slice(
      TOOLBAR.indexOf("{offersScopeAdd ? ("),
      TOOLBAR.indexOf(") : offersUnifiedAdd || canCreate ? ("),
    );
    expect(managerBranch).not.toBe("");
    expect(managerBranch).toContain(
      'data-conformance-id="scope-dashboards-write-access"',
    );
    expect(managerBranch).toContain(
      'data-action="open-add-picker -> add-picker-open"',
    );
    expect(managerBranch).toContain("Add dashboard");
    // …and NOTHING §IX.2 owns appears in the non-manager branch.
    const memberBranch = TOOLBAR.slice(
      TOOLBAR.indexOf(") : offersUnifiedAdd || canCreate ? ("),
      TOOLBAR.indexOf("</ToolbarGroup>"),
    );
    expect(memberBranch).not.toBe("");
    expect(memberBranch).not.toContain("scope-dashboards-write-access");
    expect(memberBranch).not.toContain("open-add-picker");
    expect(code(memberBranch)).not.toContain("Add dashboard");
  });

  it("Remove is SUPPRESSED (not a disabled control) for a non-manager — gated on row.canRemove (§IX.2, render → spec)", () => {
    expect(TAB).toMatch(/row\.canRemove\s*\?/);
    // The disabled attribute on Remove is a busy-state guard, never the
    // permission gate — the permission gate is the render branch above.
    expect(code(TAB)).not.toMatch(/disabled=\{!?\s*(?:data\.)?canManage/);
    expect(code(TAB)).not.toMatch(/disabled=\{!?\s*row\.canRemove/);
  });

  it("a read-only member is never handed the §IX.1 add actions at all (capability minimization)", () => {
    // The collection panel binds Remove ALONE; listCandidates / addListing /
    // requestPromotion ride the manager-only reference binding.
    const section = read("scope-dashboards-section.tsx");
    expect(section).toContain("scopeRemoveListingAction");
    expect(section).not.toContain("scopeAddListingAction");
    expect(section).not.toContain("scopeListCandidatesAction");
    expect(section).not.toContain("scopeRequestPromotionAction");
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

  it("keeps §IX.1's entity-named title, now on the popup that hosts the picker", () => {
    // §IX.1's illustration titles the picker "Add a dashboard to Team: Growth" —
    // that one DOES name the entity, because the dialog has no surrounding page
    // header. The popup is that dialog now.
    expect(DIALOG).toContain("`Add a dashboard to ${scopeLabel}`");
  });

  it("the picker is a BOUNDED panel that shrinks to the viewport (§X responsive, render → spec)", () => {
    // §X: "the add-to-scope picker is a bounded panel that shrinks to the
    // viewport". The popup now also carries Create (and, from PR4, the catalog),
    // so it is bounded on BOTH axes and scrolls inside itself.
    expect(DIALOG).toMatch(/max-w-\[520px\]/);
    expect(DIALOG).toMatch(/max-h-\[85svh\]/);
    expect(DIALOG).toMatch(/overflow-y-auto/);
  });
});

// ── render → spec: no surface the spec does not specify ─────────────────────
describe("§IX render → spec: the service builds NO `home:` provenance", () => {
  it("a row meta line is `updated <rel>` ONLY and a picker note states visibility eligibility — never `home: <entity>` (spec §IX/§IX.1)", () => {
    const s = code(SERVICE);
    // The rulings removed the `home: <entity>` provenance from BOTH the tab row
    // meta line and the picker candidate note; the service must not build it.
    expect(s).not.toMatch(/home:/);
    // The meta line is the updated time alone.
    expect(s).toContain("updated ${updatedRel");
    // The addable candidate note states scope-visibility eligibility.
    expect(s).toContain("can already see this");
  });
});

describe("§IX render → spec: no unspecified conformance id leaks in", () => {
  it("every data-conformance-id in the §IX components is one the ratified spec names", () => {
    const found = new Set<string>();
    for (const src of [TAB, PICKER, DIALOG, TOOLBAR]) {
      for (const m of src.matchAll(/data-conformance-id="([^"]+)"/g)) {
        found.add(m[1]);
      }
    }
    expect(found.size).toBeGreaterThan(0);
    for (const id of found) {
      expect(ALLOWED_CONFORMANCE_IDS.has(id)).toBe(true);
    }
  });

  it("the standalone add-to-scope picker dialog is GONE — one popup, no shim (#2474 PR3)", () => {
    expect(() => read("add-to-scope-picker.tsx")).toThrow();
  });
});
