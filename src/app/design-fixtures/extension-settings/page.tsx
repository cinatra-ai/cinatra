// ---------------------------------------------------------------------------
// Design-conformance fixture for the per-extension Settings page (design §V).
//
// Mounts the REAL presentational ExtensionSettingsView against seeded props so
// the §V surface can be proven with Playwright without a DB/auth round-trip
// (mirrors the seeded conformance harness pattern, cinatra#986). Kept off the
// pixel-diffed /design-fixtures index. Every state variant §V specifies is
// rendered: editable Permissions (connector), the deferred-note Permissions
// (agent/skill), the not-a-registered-vendor Marketplace state, the
// registered-vendor Publish state, the already-published state, the FOUR
// Maintenance update-row states (update available / up to date / incompatible
// / non-comparable — the per-state wording lives HERE, never on the card), the
// complementary Archive/Activate pair, and the locked / system
// disabled-in-place Danger zone.
// ---------------------------------------------------------------------------

import type { Metadata } from "next";
import {
  ExtensionSettingsView,
  type ExtensionSettingsActions,
} from "@cinatra-ai/extensions/screens/extension-settings-view";
import { ExtensionAccessControl } from "@cinatra-ai/extensions/screens/extension-access-control";
import {
  AgentSkillsConfigClient,
  type AgentSkillCandidate,
  type AgentSkillRow,
} from "@/components/skills/agent-skills-config-client";

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

// NOTE (cinatra#1041): no update action — the live Update button is a LINK
// opening the §II detail-modal update flow on the Installed page.
const ACTIONS: ExtensionSettingsActions = {
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
    <ExtensionAccessControl initialValue={["workspace"]} scopes={SEED_SCOPES} save={noopSave} />
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

// ---------------------------------------------------------------------------
// §V Skills (cinatra#2349) — seeded variants.
//
// The section's SERVER half decides eligibility and hydrates from the store, so
// the fixture mounts the REAL client editor against seeded rows and driven
// actions. That is what makes the two states an admin cannot reach on demand —
// a search that is slow or failing, and a save that refuses — deterministically
// renderable, and it keeps the rest of the surface (rows, badges, the cap, the
// count hint, the no-floor removal) rendering through exactly the code the real
// route renders.
//
// `?drive=` selects the driver on the interactive case:
//   (absent)      instant success on every action
//   slow          searches hang, so the picker's in-flight row is visible
//   search-error  searches refuse, so the picker's ERROR row is visible
//   assign-error  the save refuses, so the row rolls back with the reason
//   remove-error  the removal refuses, so the row stays with the reason
// ---------------------------------------------------------------------------

const SEED_CANDIDATES: AgentSkillCandidate[] = [
  {
    skillId: "@northstar/research-toolkit:company-research",
    skillName: "Company Research",
    displayName: "Research Toolkit",
    vendorName: "Northstar",
    status: "active",
  },
  {
    skillId: "@northstar/research-toolkit:research-summarising",
    skillName: "Research Summarising",
    displayName: "Research Toolkit",
    vendorName: "Northstar",
    status: "locked",
  },
  {
    skillId: "@cinatra-ai/blog-skills:blog-writing",
    skillName: "Blog Writing",
    displayName: "Blog Skills",
    vendorName: "Cinatra",
    status: "active",
  },
  {
    skillId: "@acme/brand-kit:brand-voice",
    skillName: "Brand Voice",
    displayName: "Brand Kit",
    vendorName: "Acme Corp",
    status: "active",
  },
];

const SEED_CHOSEN: AgentSkillRow[] = [
  {
    skillId: "@cinatra-ai/blog-skills:blog-writing",
    skillName: "Blog Writing",
    displayName: "Blog Skills",
    vendorName: "Cinatra",
    status: "ok",
  },
];

const SEED_AT_CAP: AgentSkillRow[] = [
  SEED_CHOSEN[0]!,
  {
    skillId: "@northstar/research-toolkit:company-research",
    skillName: "Company Research",
    displayName: "Research Toolkit",
    vendorName: "Northstar",
    status: "ok",
  },
  {
    skillId: "@acme/brand-kit:brand-voice",
    skillName: "Brand Voice",
    displayName: "Brand Kit",
    vendorName: "Acme Corp",
    status: "ok",
  },
];

const SEED_DEGRADED: AgentSkillRow[] = [
  SEED_CHOSEN[0]!,
  {
    skillId: "@northstar/research-toolkit:company-research",
    skillName: "Company Research",
    displayName: "Research Toolkit",
    vendorName: "Northstar",
    status: "archived",
  },
  {
    skillId: "@acme/brand-kit:brand-voice",
    skillName: "Brand Voice",
    displayName: "Brand Kit",
    vendorName: "Acme Corp",
    status: "role-changed",
  },
];

type SkillsDriver = "ok" | "slow" | "search-error" | "assign-error" | "remove-error";

function SeededSkills({
  rows,
  drive = "ok",
}: {
  rows: AgentSkillRow[];
  drive?: SkillsDriver;
}) {
  // Server actions bound per variant. The narrowing is done here the way the
  // real action does it server-side — substring over the skill name and the
  // providing extension's title — so the fixture proves the SAME narrowing
  // behaviour the picker relies on rather than a client-side filter.
  async function search(query: string, page: { offset: number; limit: number }) {
    "use server";
    if (drive === "search-error") return { ok: false as const, reason: "eligibility-unreadable" };
    if (drive === "slow") await new Promise((resolve) => setTimeout(resolve, 30_000));
    const needle = query.trim().toLowerCase();
    const matched = SEED_CANDIDATES.filter(
      (c) =>
        needle.length === 0 ||
        c.skillName.toLowerCase().includes(needle) ||
        c.displayName.toLowerCase().includes(needle),
    );
    const window = matched.slice(page.offset, page.offset + page.limit + 1);
    return {
      ok: true as const,
      results: window.slice(0, page.limit),
      hasMore: window.length > page.limit,
    };
  }
  async function assign() {
    "use server";
    if (drive === "assign-error") return { ok: false as const, reason: "not-assignable" };
    return { ok: true as const };
  }
  async function remove() {
    "use server";
    if (drive === "remove-error") return { ok: false as const, reason: "forbidden" };
    return { ok: true as const };
  }
  return (
    <AgentSkillsConfigClient
      cap={3}
      initialRows={rows}
      search={search}
      assign={assign}
      remove={remove}
    />
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

export default async function ExtensionSettingsFixturePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) ?? {};
  const raw = Array.isArray(params.drive) ? params.drive[0] : params.drive;
  const drive: SkillsDriver = (
    ["ok", "slow", "search-error", "assign-error", "remove-error"] as const
  ).includes(raw as SkillsDriver)
    ? (raw as SkillsDriver)
    : "ok";

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
          updateRow={{
            enabled: true,
            description: "Currently on version 0.4.2 — version 0.5.0 is available.",
          }}
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
          updateRow={{
            enabled: false,
            description: "Currently on version 1.2.0 — up to date.",
            disabledReason: "Already up to date",
          }}
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
          skills={<SeededSkills rows={SEED_CHOSEN} drive={drive} />}
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
          updateRow={{
            enabled: true,
            description: "Currently on version 0.1.6 — version 0.1.7 is available.",
          }}
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
          updateRow={{
            enabled: false,
            description: "Currently on version 2.0.1 — up to date.",
            disabledReason: "Already up to date",
          }}
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

      {/* Case E — incompatible: a newer version exists but needs a newer
          Cinatra. The §V Maintenance · Update row spells it out verbatim and
          the button greys out (the §III card shows no chip, no text — just the
          greyed spec line). */}
      <Case id="skill-incompatible" label="Skill · newer version needs a newer Cinatra">
        <ExtensionSettingsView
          kind="skill"
          packageName="@acme/outreach-toolkit"
          displayName="Outreach Toolkit"
          vendor="Acme Corp"
          updateRow={{
            enabled: false,
            description: "Newer version needs a newer Cinatra.",
            disabledReason: "Newer version needs a newer Cinatra",
          }}
          archiveDisabled={null}
          activateDisabled="Already active"
          reinstallDisabled={null}
          forceDeleteDisabled={null}
          isPublic={false}
          isRegisteredVendor={false}
          canPublish={false}
          permissions={
            <DeferredPermissions note="Manage who can access this skill from the Skills configuration page." />
          }
          actions={ACTIONS}
        />
      </Case>

      {/* Case F — non-comparable: a github/dev/local source has no registry
          version to compare. Row wording verbatim, button greyed. */}
      <Case id="workflow-non-comparable" label="Workflow · no registry version to compare">
        <ExtensionSettingsView
          kind="workflow"
          packageName="@acme/pipeline-workflow"
          displayName="Pipeline Workflow"
          vendor="Acme Corp"
          updateRow={{
            enabled: false,
            description: "No registry version to compare.",
            disabledReason: "No registry version to compare",
          }}
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

      {/* Case G — agent with NOTHING chosen: the field, the count hint and no
          list at all. Zero is a correct, warning-free state (§V Skills). */}
      <Case id="agent-skills-empty" label="Agent · Skills · nothing chosen (zero is fine)">
        <ExtensionSettingsView
          kind="agent"
          packageName="@acme/outreach-agent"
          displayName="Outreach Agent"
          vendor="Acme Corp"
          updateRow={{
            enabled: false,
            description: "Currently on version 0.3.0 — up to date.",
            disabledReason: "Already up to date",
          }}
          archiveDisabled={null}
          activateDisabled="Already active"
          reinstallDisabled={null}
          forceDeleteDisabled={null}
          isPublic={false}
          isRegisteredVendor={false}
          canPublish={false}
          permissions={
            <DeferredPermissions note="Manage who can access this agent from the Agents page." />
          }
          skills={<SeededSkills rows={[]} drive={drive} />}
          actions={ACTIONS}
        />
      </Case>

      {/* Case H — agent AT the cap: the chooser greys out and stops accepting
          input, the hint says what to do about it, every row still removable. */}
      <Case id="agent-skills-at-cap" label="Agent · Skills · three chosen (chooser closed off)">
        <ExtensionSettingsView
          kind="agent"
          packageName="@acme/pipeline-agent"
          displayName="Pipeline Agent"
          vendor="Acme Corp"
          updateRow={{
            enabled: false,
            description: "Currently on version 1.0.0 — up to date.",
            disabledReason: "Already up to date",
          }}
          archiveDisabled={null}
          activateDisabled="Already active"
          reinstallDisabled={null}
          forceDeleteDisabled={null}
          isPublic={false}
          isRegisteredVendor={false}
          canPublish={false}
          permissions={
            <DeferredPermissions note="Manage who can access this agent from the Agents page." />
          }
          skills={<SeededSkills rows={SEED_AT_CAP} drive={drive} />}
          actions={ACTIONS}
        />
      </Case>

      {/* Case I — chosen skills that have since degraded: archived and
          role-changed rows stay VISIBLE, wear a warning-toned badge naming the
          state, and keep a fully live remove control. */}
      <Case
        id="agent-skills-degraded"
        label="Agent · Skills · chosen skills that have since degraded"
      >
        <ExtensionSettingsView
          kind="agent"
          packageName="@acme/briefing-agent"
          displayName="Briefing Agent"
          vendor="Acme Corp"
          updateRow={{
            enabled: false,
            description: "Currently on version 0.2.0 — up to date.",
            disabledReason: "Already up to date",
          }}
          archiveDisabled={null}
          activateDisabled="Already active"
          reinstallDisabled={null}
          forceDeleteDisabled={null}
          isPublic={false}
          isRegisteredVendor={false}
          canPublish={false}
          permissions={
            <DeferredPermissions note="Manage who can access this agent from the Agents page." />
          }
          skills={<SeededSkills rows={SEED_DEGRADED} drive={drive} />}
          actions={ACTIONS}
        />
      </Case>
    </div>
  );
}
