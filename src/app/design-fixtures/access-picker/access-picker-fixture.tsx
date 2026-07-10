"use client";

// ---------------------------------------------------------------------------
// Interactive design/conformance fixture for the checkbox multi-select access
// picker (cinatra#1072, multi-scope W3). Mounts the REAL
// AccessComboboxHierarchical in `multiple` mode against seeded scopes so the
// picker can be proven with Playwright without a DB/auth round-trip (mirrors
// the extension-settings fixture pattern). Kept OFF the pixel-diffed
// /design-fixtures index — driven directly by the W3 verification run.
// ---------------------------------------------------------------------------

import { useState } from "react";
import {
  AccessComboboxHierarchical,
  type AvailableScopes,
} from "@/components/access-combobox-hierarchical";

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

  return (
    <div className="mx-auto max-w-3xl p-8 flex flex-col gap-6">
      <h1 className="text-lg font-semibold text-foreground">
        Access picker — checkbox multi-select (W3)
      </h1>

      {/* The interactive instance the verification run drives (open, toggle,
          check org-implication + workspace-implication, read the summary). */}
      <Case id="picker-live" label="Interactive (multi)">
        <AccessComboboxHierarchical multiple value={live} onChange={setLive} scopes={SEED_SCOPES} />
        <pre data-testid="picker-live-value" className="text-xs font-mono text-muted-foreground">
          {JSON.stringify(live)}
        </pre>
      </Case>

      {/* Static trigger-label variants (closed) for the summary screenshot. */}
      <Case id="picker-owner" label="Trigger: single (Personal)">
        <AccessComboboxHierarchical multiple value={["owner"]} onChange={() => {}} scopes={SEED_SCOPES} />
      </Case>
      <Case id="picker-single-team" label="Trigger: single (Team)">
        <AccessComboboxHierarchical
          multiple
          value={["team:team-rev"]}
          onChange={() => {}}
          scopes={SEED_SCOPES}
        />
      </Case>
      <Case id="picker-multi" label="Trigger: multi-scope composition (tooltip)">
        <AccessComboboxHierarchical
          multiple
          value={["team:team-rev", "org:org-beta", "project:proj-atlas"]}
          onChange={() => {}}
          scopes={SEED_SCOPES}
        />
      </Case>
      <Case id="picker-workspace" label="Trigger: Workspace: All">
        <AccessComboboxHierarchical
          multiple
          value={["workspace"]}
          onChange={() => {}}
          scopes={SEED_SCOPES}
        />
      </Case>
    </div>
  );
}
