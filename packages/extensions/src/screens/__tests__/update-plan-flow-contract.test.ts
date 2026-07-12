// cinatra#1041 outcome 2 — §II "Modal footer — Update plan (dry-run)".
//
// Two halves, mirroring the repo's screen-test idiom:
//   1. UNIT — the pure update-plan-model derivations (names are displayNames,
//      per-group notes, version transitions);
//   2. SOURCE CONTRACT (node-env, no jsdom — UI is proven via Playwright per
//      the design doctrine): the flow component dry-runs BEFORE any write and
//      the modal/screen wiring honors the spec rule that the update runs ONLY
//      from the §II detail-modal footer.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

import {
  updatePlanMemberName,
  updatePlanMemberNote,
  updatePlanMemberVersionLabel,
  type UpdatePlanPreviewMemberDto,
} from "../update-plan-model";

const read = (rel: string): string =>
  readFileSync(path.resolve(__dirname, rel), "utf8");

const FLOW = read("../update-plan-flow.tsx");
const MODAL = read("../marketplace-detail-modal.tsx");
const CATALOG = read("../registry-catalog-screen.tsx");
const SETTINGS_VIEW = read("../extension-settings-view.tsx");
const SETTINGS_SCREEN = read("../extension-settings-screen.tsx");

function member(over: Partial<UpdatePlanPreviewMemberDto>): UpdatePlanPreviewMemberDto {
  return {
    packageName: "@acme/pkg",
    displayName: null,
    action: "update",
    fromVersion: null,
    toVersion: null,
    reboundToPackageName: null,
    isRoot: false,
    ...over,
  };
}

describe("update-plan-model — rendered names are displayNames", () => {
  it("prefers the manifest displayName, then the card displayName (root), then the package name", () => {
    expect(
      updatePlanMemberName(member({ displayName: "Foundry Core" }), "Research Assistant"),
    ).toBe("Foundry Core");
    expect(updatePlanMemberName(member({ isRoot: true }), "Research Assistant")).toBe(
      "Research Assistant",
    );
    expect(updatePlanMemberName(member({}), "")).toBe("@acme/pkg");
  });

  it("derives the §II per-group notes (drawing wording)", () => {
    const shared = member({
      packageName: "@acme/foundry-core",
      displayName: "Foundry Core",
      action: "update",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
    });
    expect(updatePlanMemberNote(shared, [shared], "Root")).toBe(
      "shared dependency, upgraded in place (dedupe-upward)",
    );
    expect(updatePlanMemberNote(member({ action: "update", isRoot: true }), [], "Root")).toBeNull();
    expect(updatePlanMemberNote(member({ action: "install" }), [], "Root")).toBe("new dependency");
    expect(
      updatePlanMemberNote(member({ action: "side-by-side", fromVersion: "1.4.0" }), [], "Root"),
    ).toBe("kept beside v1.4.0 (ranges disjoint)");
    // Rebound resolves the shared dep's displayName from the member list.
    expect(
      updatePlanMemberNote(
        member({ action: "rebound", reboundToPackageName: "@acme/foundry-core" }),
        [shared],
        "Root",
      ),
    ).toBe("re-pointed to Foundry Core v1.1.0");
  });

  it("renders the mono version transition per group", () => {
    expect(
      updatePlanMemberVersionLabel(
        member({ action: "update", fromVersion: "0.1.2", toVersion: "0.1.5" }),
      ),
    ).toBe("v0.1.2 → v0.1.5");
    expect(updatePlanMemberVersionLabel(member({ action: "install", toVersion: "2.0.0" }))).toBe(
      "v2.0.0",
    );
    expect(updatePlanMemberVersionLabel(member({ action: "rebound" }))).toBeNull();
  });
});

describe("§II flow source contract — dry-run first, confirm before apply", () => {
  it("'Update now' runs the DRY-RUN action, never the write", () => {
    // The idle CTA drives runDryRun() → planAction; updateAction appears only
    // inside the Confirm form.
    expect(FLOW).toContain("runDryRun");
    expect(FLOW).toContain("await planAction()");
    expect(FLOW).toContain("Confirm update");
    expect(FLOW).toContain('MarketplaceInstallSubmit pendingLabel="Updating…"');
  });
  it("failures surface ONLY the category-mapped #685 copy", () => {
    expect(FLOW).toContain("failureCopyByCategory[result.category] ?? defaultFailureMessage");
    expect(FLOW).not.toContain("result.error");
  });
  it("renders the four §II member groups with the drawing's tag colours", () => {
    expect(FLOW).toContain('update: "bg-info text-info-foreground"');
    expect(FLOW).toContain('install: "bg-success text-success-foreground"');
    expect(FLOW).toContain('"side-by-side": "bg-warning text-warning-foreground"');
    expect(FLOW).toContain('rebound: "bg-muted-foreground text-background"');
    expect(FLOW).toContain("Update plan");
    expect(FLOW).toContain('data-slot="update-plan-panel"');
    expect(FLOW).toContain('data-slot="update-plan-member"');
    // Names bind the manifest displayName (conformance stable-id contract).
    expect(FLOW).toContain('data-field="manifest.displayName"');
  });
  it("offers Cancel back out of the plan without applying", () => {
    expect(FLOW).toContain('onClick={() => setPlan(null)}');
    expect(FLOW).toContain("Cancel");
  });
});

describe("§II/§III placement contract — the update runs ONLY from the modal footer", () => {
  it("the installed-page modal renders a footer ONLY for the update flow", () => {
    expect(MODAL).toContain(
      'cta?.state === "update" && updateAction != null && planUpdateAction != null',
    );
    expect(MODAL).toContain("ModalUpdatePlanFlow");
  });
  it("the browse-card footer update state routes through the dry-run flow when wired", () => {
    expect(MODAL).toContain("if (isUpdate && planUpdateAction)");
  });
  it("the installed screen wires the flow ONLY for the update-available state and keeps card actions Settings + More details", () => {
    expect(CATALOG).toContain('state === "update-available" && latestVersion != null');
    expect(CATALOG).toContain("planExtensionUpdateFormAction.bind");
    expect(CATALOG).toContain("updateExtensionPackageFormAction.bind");
    // The card's actions panel stays exactly Settings + More details — the
    // update affordance on the card is the CHIP only.
    expect(CATALOG).toContain("renderDetailModal(row, isArchived)");
    expect(CATALOG).not.toContain("Update now</Button>");
  });
  it("the §V settings row's live Update button OPENS the modal flow (link), never a direct write", () => {
    expect(SETTINGS_VIEW).toContain("/configuration/extensions?update=");
    expect(SETTINGS_VIEW).not.toContain("<form action={actions.update}>");
    expect(SETTINGS_SCREEN).not.toContain("updateExtensionPackageFormAction");
  });
  it("the settings deep link auto-opens the matching row's modal (`?update=<pkg>`)", () => {
    expect(CATALOG).toContain('resolvedSearchParams?.update === "string"');
    expect(CATALOG).toContain("defaultOpen={openUpdateFor === row.packageName}");
  });
});
