// ---------------------------------------------------------------------------
// Design-conformance fixture for the per-extension Settings page (design §V).
//
// Mounts the REAL presentational ExtensionSettingsView against seeded props so
// the §V surface can be proven with Playwright without a DB/auth round-trip
// (mirrors the seeded conformance harness pattern, cinatra#986). Kept off the
// pixel-diffed /design-fixtures index. Every state variant §V specifies is
// rendered: editable Permissions (connector), the deferred-note Permissions
// (agent/skill), the not-a-registered-vendor Marketplace state, the
// registered-vendor Publish state, the already-published state, the
// update-available vs up-to-date Maintenance states, the complementary
// Archive/Activate pair, and the locked / system disabled-in-place Danger zone.
// ---------------------------------------------------------------------------

import type { Metadata } from "next";
import {
  ExtensionSettingsView,
  type ExtensionSettingsActions,
} from "@cinatra-ai/extensions/screens/extension-settings-view";
import { ExtensionAccessControl } from "@cinatra-ai/extensions/screens/extension-access-control";

export const metadata: Metadata = {
  title: "Design Fixtures — Extension settings (§V) — Cinatra",
  description:
    "Internal route mounting the real ExtensionSettingsView (§V) against seeded props for Playwright conformance.",
};

export const dynamic = "force-dynamic";

// No-op server actions — the fixture proves presentation, not the mutations
// (those are exercised by the real route + the actions' own unit coverage).
async function noop(): Promise<void> {
  "use server";
}
async function noopSave(): Promise<{ ok: boolean; error?: string }> {
  "use server";
  return { ok: true };
}

const ACTIONS: ExtensionSettingsActions = {
  update: noop,
  archive: noop,
  activate: noop,
  reinstall: noop,
  publish: noop,
  forceDelete: noop,
};

const SEED_SCOPES = {
  orgs: [{ id: "org-acme", name: "Acme Corp", teams: [{ id: "team-rev", name: "Revenue" }] }],
  projects: [{ id: "proj-atlas", name: "Atlas" }],
  canGrantWorkspace: true,
};

function EditablePermissions() {
  return (
    <ExtensionAccessControl initialValue="workspace" scopes={SEED_SCOPES} save={noopSave} />
  );
}

function DeferredPermissions({ note }: { note: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm text-foreground">Who can access this extension?</p>
      <p className="text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

function Case({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <section data-fixture-case={id} className="border-b border-line">
      <div className="bg-surface px-4 py-2 font-mono text-badge-2xs font-bold uppercase tracking-kicker-wide text-muted-foreground">
        {label}
      </div>
      {children}
    </section>
  );
}

export default function ExtensionSettingsFixturePage() {
  return (
    <div className="min-h-screen bg-paper">
      {/* Case A — active connector: editable Permissions, not a registered
          vendor (muted publish + register link), update available, active
          (Archive live / Activate greyed), full Danger zone. */}
      <Case id="connector-active" label="Connector · active · update available · not a vendor">
        <ExtensionSettingsView
          kind="connector"
          packageName="@acme/crm-sync"
          displayName="CRM Sync"
          vendor="Acme Corp"
          rawVersion="0.4.2"
          versionLabel={null}
          newestVersion="0.5.0"
          updateAvailable
          archiveDisabled={null}
          activateDisabled="Already active"
          reinstallDisabled={null}
          forceDeleteDisabled={null}
          isPublic={false}
          isRegisteredVendor={false}
          canPublish={false}
          permissions={<EditablePermissions />}
          actions={ACTIONS}
        />
      </Case>

      {/* Case B — agent: deferred Permissions note, registered vendor so the
          one-way Publish is live, up to date. */}
      <Case id="agent-publishable" label="Agent · registered vendor · publishable · up to date">
        <ExtensionSettingsView
          kind="agent"
          packageName="@acme/research-assistant"
          displayName="Research Assistant"
          vendor="Cinatra"
          rawVersion="1.2.0"
          versionLabel={null}
          newestVersion="1.2.0"
          updateAvailable={false}
          archiveDisabled={null}
          activateDisabled="Already active"
          reinstallDisabled={null}
          forceDeleteDisabled={null}
          isPublic={false}
          isRegisteredVendor
          canPublish
          permissions={
            <DeferredPermissions note="Manage who can access this agent from the Agents page." />
          }
          actions={ACTIONS}
        />
      </Case>

      {/* Case C — locked / system connector: Archive / Reinstall / Force-delete
          disabled-in-place (Update stays available), already published. */}
      <Case id="connector-locked" label="Connector · locked (system) · published">
        <ExtensionSettingsView
          kind="connector"
          packageName="@acme/directory-sync"
          displayName="Directory Sync"
          vendor="Acme Corp"
          rawVersion="0.1.6"
          versionLabel={null}
          newestVersion="0.1.7"
          updateAvailable
          archiveDisabled="Cannot archive — locked & required-in-prod"
          activateDisabled="Already active"
          reinstallDisabled="Cannot uninstall — locked; archive instead"
          forceDeleteDisabled="Cannot force delete — locked & required-in-prod"
          isPublic
          isRegisteredVendor
          canPublish={false}
          permissions={<EditablePermissions />}
          actions={ACTIONS}
        />
      </Case>

      {/* Case D — archived artifact: Activate live / Archive greyed
          (complementary), up to date. */}
      <Case id="artifact-archived" label="Artifact · archived · Activate live / Archive greyed">
        <ExtensionSettingsView
          kind="artifact"
          packageName="@acme/quarterly-brief"
          displayName="Quarterly Brief"
          vendor="Acme Corp"
          rawVersion="2.0.1"
          versionLabel={null}
          newestVersion="2.0.1"
          updateAvailable={false}
          archiveDisabled="Already archived"
          activateDisabled={null}
          reinstallDisabled={null}
          forceDeleteDisabled={null}
          isPublic={false}
          isRegisteredVendor={false}
          canPublish={false}
          permissions={<EditablePermissions />}
          actions={ACTIONS}
        />
      </Case>
    </div>
  );
}
