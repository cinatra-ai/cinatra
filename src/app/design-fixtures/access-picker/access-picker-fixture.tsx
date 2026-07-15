"use client";

// ---------------------------------------------------------------------------
// Interactive design/conformance fixture for the UNIFIED access picker
// (cinatra#1607 AC1): ONE component, AccessCombobox, driven in both selection
// modes so both surfaces are proven with Playwright on ONE route without a
// DB/auth round-trip (mirrors the extension-settings fixture pattern):
//   - selectionMode="multiple" — the checkbox multi-select picker
//     (cinatra#1072, multi-scope W3), and
//   - selectionMode="single" (default) — the flat single-select combobox after
//     its #1509 §4.0-c alignment (cinatra#1508): typed headings, distinct
//     hover, selected checkmark, "Unknown team" synthesis for unhydrated
//     selections, disabled rows with tooltips.
// Kept OFF the pixel-diffed /design-fixtures index — driven directly by
// verification runs / the owner.
// ---------------------------------------------------------------------------

import { useState } from "react";
import {
  AccessCombobox,
  type AvailableScopes,
  type AccessComboboxProps,
} from "@/components/access-combobox";

const SEED_SCOPES: AvailableScopes = {
  orgs: [
    {
      id: "org-acme",
      name: "Acme Corp",
      teams: [
        { id: "team-rev", name: "Revenue" },
        { id: "team-eng", name: "Engineering" },
      ],
    },
    { id: "org-beta", name: "Beta LLC", teams: [{ id: "team-ops", name: "Ops" }] },
  ],
  projects: [{ id: "proj-atlas", name: "Atlas" }],
  canGrantWorkspace: true,
};

// Flat-picker shape of the same seed data (single active org).
const FLAT_SEED_SCOPES: AccessComboboxProps["availableScopes"] = {
  projects: [{ id: "proj-atlas", name: "Atlas" }],
  teams: [
    { id: "team-rev", name: "Revenue" },
    { id: "team-eng", name: "Engineering" },
  ],
  orgName: "Acme Corp",
  // Multi-scope W1: the org row emits the id-carrying `org:<id>` token.
  orgId: "org-acme",
  workspaceExposed: true,
};

function Case({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div data-testid={id} className="flex flex-col gap-2 border border-line rounded-card p-4 bg-surface">
      <span className="text-xs font-mono uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

export function AccessPickerFixture() {
  const [live, setLive] = useState<string[]>(["team:team-rev", "project:proj-atlas"]);
  const [flatLive, setFlatLive] = useState<string>("team:team-rev");

  return (
    <div className="mx-auto max-w-3xl p-8 flex flex-col gap-6">
      <h1 className="text-lg font-semibold text-foreground">
        Access picker — checkbox multi-select (selectionMode=&quot;multiple&quot;)
      </h1>

      {/* The interactive instance the verification run drives (open, toggle,
          check org-implication + workspace-implication, read the summary). */}
      <Case id="picker-live" label="Interactive (multi)">
        <AccessCombobox selectionMode="multiple" value={live} onChange={setLive} scopes={SEED_SCOPES} />
        <pre data-testid="picker-live-value" className="text-xs font-mono text-muted-foreground">
          {JSON.stringify(live)}
        </pre>
      </Case>

      {/* Static trigger-label variants (closed) for the summary screenshot. */}
      <Case id="picker-owner" label="Trigger: single (Personal)">
        <AccessCombobox selectionMode="multiple" value={["owner"]} onChange={() => {}} scopes={SEED_SCOPES} />
      </Case>
      <Case id="picker-single-team" label="Trigger: single (Team)">
        <AccessCombobox
          selectionMode="multiple"
          value={["team:team-rev"]}
          onChange={() => {}}
          scopes={SEED_SCOPES}
        />
      </Case>
      <Case id="picker-multi" label="Trigger: multi-scope composition (tooltip)">
        <AccessCombobox
          selectionMode="multiple"
          value={["team:team-rev", "org:org-beta", "project:proj-atlas"]}
          onChange={() => {}}
          scopes={SEED_SCOPES}
        />
      </Case>
      <Case id="picker-workspace" label="Trigger: Workspace: All">
        <AccessCombobox
          selectionMode="multiple"
          value={["workspace"]}
          onChange={() => {}}
          scopes={SEED_SCOPES}
        />
      </Case>

      {/* Flat single-select AccessCombobox cases (cinatra#1508 / #1509 §4.1) -- */}
      <h2 className="text-lg font-semibold text-foreground">
        Access picker — flat single-select (selectionMode=&quot;single&quot;, #1508)
      </h2>

      {/* Closed default trigger. */}
      <Case id="flat-default" label="Flat: default (Only me)">
        <AccessCombobox
          value="owner"
          onValueChange={() => {}}
          availableScopes={FLAT_SEED_SCOPES}
          isAdmin
        />
      </Case>

      {/* The interactive instance a verification run drives: open it to see
          the typed heading hierarchy (Only me → Projects → Teams →
          Organization → Workspace → Admin), the distinct hover tint, and the
          checkmark on the selected team row. */}
      <Case id="flat-open-with-selection" label="Flat: interactive, team selected">
        <AccessCombobox
          value={flatLive}
          onValueChange={setFlatLive}
          availableScopes={FLAT_SEED_SCOPES}
          isAdmin
        />
        <pre data-testid="flat-live-value" className="text-xs font-mono text-muted-foreground">
          {JSON.stringify(flatLive)}
        </pre>
      </Case>

      {/* Unhydrated selection: the id is NOT in the seeded teams, so the
          trigger reads "Team: Unknown team" and opening shows the synthesized,
          checked "Unknown team" row (never a truncated id). */}
      <Case id="flat-missing-team" label="Flat: missing-team selection (Unknown team)">
        <AccessCombobox
          value="team:team-gone"
          onValueChange={() => {}}
          availableScopes={FLAT_SEED_SCOPES}
          isAdmin
        />
      </Case>

      {/* Disabled rows: per-row disable with tooltip reasons, plus the
          non-admin Workspace lock treatment. */}
      <Case id="flat-disabled-rows" label="Flat: disabled rows + reasons (non-admin)">
        <AccessCombobox
          value="owner"
          onValueChange={() => {}}
          availableScopes={FLAT_SEED_SCOPES}
          isAdmin={false}
          disabledScopes={["team:team-eng", "project:proj-atlas"]}
          disabledReasons={{
            "team:team-eng": "Already granted — read",
            "project:proj-atlas": "Already granted — write",
          }}
        />
      </Case>
    </div>
  );
}
