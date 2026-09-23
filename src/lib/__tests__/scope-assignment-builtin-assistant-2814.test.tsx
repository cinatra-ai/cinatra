// @vitest-environment jsdom
/**
 * THE BUILT-IN PLATFORM ASSISTANT'S ASSIGNMENT PAGE (cinatra#2814, the fix leg
 * of the per-scope assignment page; picture round 2, CELL8).
 *
 * CELL8 asks for the Skills pane alone on an assistant's page, with the chooser
 * labelled "Which skills should this assistant always use?". The round drew the
 * pane but no chooser: every group turned read-only, because the write gate
 * could read no KIND for the built-in assistant.
 *
 * The built-in platform assistant is never an `installed_extension` row and
 * ships no package on disk, so both arms the gate had answered null. The READ
 * road has always known this: the assistant registry reader unions the built-in
 * descriptor in from its boot-seeded `agent_templates` row. This suite pins that
 * the WRITE road now reads its kind from that same row, that nothing else moved
 * (a package with neither a row nor a directory entry stays refused), and that
 * the refusal names what the gate actually read.
 */
import "@/components/__tests__/access-picker-jsdom-shims";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/lib/scope-assignment/scope-assignment-actions", () => ({
  searchScopeAssignableSkillsAction: vi.fn(async () => ({ ok: true, results: [], hasMore: false })),
  assignScopeSkillAction: vi.fn(async () => ({ ok: true })),
  removeScopeSkillAction: vi.fn(async () => ({ ok: true })),
  searchScopeContextArtifactsAction: vi.fn(async () => ({ ok: true, results: [], hasMore: false })),
  assignScopeContextArtifactAction: vi.fn(async () => ({ ok: true })),
  removeScopeContextArtifactAction: vi.fn(async () => ({ ok: true })),
  reorderScopeContextArtifactsAction: vi.fn(async () => ({ ok: true })),
}));

import { BUILTIN_ASSISTANT_ALIAS } from "@/lib/assistant-registry-schema";
import {
  isAssistantPackageName,
  readBuiltInAssistantPackageKind,
  readWritablePackageKind,
} from "@/lib/agent-package-eligibility";
import { assertAgentWriteTarget } from "@cinatra-ai/skills/agent-package-resolver";
import { buildWorkspaceVantage } from "@/lib/scope-surface-vantage";
import type { ActorContext } from "@/lib/authz/actor-context";
import {
  loadScopeAssignmentPage,
  type ScopeAssignmentPageDeps,
} from "@/lib/scope-assignment/scope-assignment-page.server";
import { ScopeAssignmentPage } from "@/components/scope-assignment/scope-assignment-page";
import { storeDouble } from "./support/eligibility-store-double";

const BUILT_IN = BUILTIN_ASSISTANT_ALIAS.packageName;
const UNKNOWN = "@northstar/no-such-package";
const ADMIN = "user_admin";
const ORG = "org_acme";

const UNREADABLE_SENTENCE =
  "This package's install record couldn't be read, so these assignments can't be changed right now.";

// ---------------------------------------------------------------------------
// The store double (shared with the write-road suite) and the fixtures this
// suite reads through it.
// ---------------------------------------------------------------------------

/** An installation whose built-in assistant is boot-seeded, as every one is. */
const seeded = () =>
  storeDouble({ templates: [{ id: "tpl_cinatra", packageName: BUILT_IN, agentKind: "assistant" }] });
/** An installation that holds nothing for the package being asked about. */
const nothing = () => storeDouble();
/** A template under the reserved NAME that is an ordinary agent, not the
 *  platform assistant. Only `agent_kind` tells the two apart. */
const wrongKindTemplate = () =>
  storeDouble({ templates: [{ id: "tpl_impostor", packageName: BUILT_IN, agentKind: "agent" }] });
/** Two LIVE install rows under the reserved name that disagree about the kind,
 *  alongside the boot seed. The reserved name carries no install row of its own,
 *  so this is a state the platform never writes for itself. */
const conflictingInstalls = () =>
  storeDouble({
    installs: [
      { id: "ie_one", packageName: BUILT_IN, kind: "agent", status: "active" },
      { id: "ie_two", packageName: BUILT_IN, kind: "skill", status: "active" },
    ],
    templates: [{ id: "tpl_cinatra", packageName: BUILT_IN, agentKind: "assistant" }],
  });

describe("the built-in platform assistant's kind, on the write road", () => {
  it("reads as an agent-kind extension from its boot-seeded assistant template", async () => {
    const db = seeded();
    expect(await readBuiltInAssistantPackageKind(BUILT_IN, db)).toBe("agent");
    expect(await readWritablePackageKind(BUILT_IN, db)).toBe("agent");
    // The gate's other question was never the problem: the assistant linkage
    // already answers for the built-in.
    expect(await isAssistantPackageName(BUILT_IN, db)).toBe(true);
  });

  it("answers for the reserved package alone, and issues no query for any other", async () => {
    expect(await readBuiltInAssistantPackageKind(UNKNOWN, seeded())).toBeNull();
    expect(await readWritablePackageKind(UNKNOWN, nothing())).toBeNull();
  });

  it("resolves nothing where the platform assistant is not seeded at all", async () => {
    const db = nothing();
    expect(await readBuiltInAssistantPackageKind(BUILT_IN, db)).toBeNull();
    expect(await readWritablePackageKind(BUILT_IN, db)).toBeNull();
  });

  it("takes the reserved NAME and the assistant kind together, never the name alone", async () => {
    // An ordinary agent template filed under the reserved package name is not
    // the platform assistant, and must establish nothing. The `agent_kind`
    // column is the whole difference, so a read that dropped that predicate
    // would admit this row.
    const db = wrongKindTemplate();
    expect(await readBuiltInAssistantPackageKind(BUILT_IN, db)).toBeNull();
    expect(await readWritablePackageKind(BUILT_IN, db)).toBeNull();
  });

  it("reads the assistant DECLARATION as a presence test, not as a row count", async () => {
    // The declaration arm is the double's only `is not null` predicate, so it
    // is asserted both ways: a row that carries a declaration answers true, a
    // row of the same package that carries none answers false. A double that
    // dropped the predicate would answer true for both.
    const declared = storeDouble({
      installs: [
        { id: "ie_declared", packageName: UNKNOWN, kind: "agent", status: "active", assistantDeclaration: { audience: [] } },
      ],
    });
    const undeclared = storeDouble({
      installs: [{ id: "ie_plain", packageName: UNKNOWN, kind: "agent", status: "active", assistantDeclaration: null }],
    });
    expect(await isAssistantPackageName(UNKNOWN, declared)).toBe(true);
    expect(await isAssistantPackageName(UNKNOWN, undeclared)).toBe(false);
  });

  it("refuses when the install rows CONFLICT, and falls back only when there are none", async () => {
    // Two live rows that name different kinds are an unreadable install record,
    // not an absent one. The built-in's fallback answers for a package that has
    // NO row at all, so a conflict must refuse rather than reach past it.
    expect(await readWritablePackageKind(BUILT_IN, conflictingInstalls())).toBeNull();
    // The absence keeps admitting, unchanged.
    expect(await readWritablePackageKind(BUILT_IN, seeded())).toBe("agent");
  });

  it("admits the built-in at the shared write gate and still refuses an unknown package", async () => {
    const gate = (packageName: string, db: ReturnType<typeof seeded>) =>
      assertAgentWriteTarget(packageName, {
        readPackageKind: (p) => readWritablePackageKind(p, db),
        isAssistantPackage: (p) => isAssistantPackageName(p, db),
      });
    expect(await gate(BUILT_IN, seeded())).toEqual({ ok: true });
    expect(await gate(UNKNOWN, nothing())).toEqual({ ok: false, reason: "eligibility-unreadable" });
    // The conflict refuses at the gate too, although the assistant linkage is
    // present: an unreadable kind is decided before the assistant fact is read.
    expect(await gate(BUILT_IN, conflictingInstalls())).toEqual({
      ok: false,
      reason: "eligibility-unreadable",
    });
    // A template under the reserved name that is not an assistant is refused
    // the same way.
    expect(await gate(BUILT_IN, wrongKindTemplate())).toEqual({
      ok: false,
      reason: "eligibility-unreadable",
    });
  });
});

// ---------------------------------------------------------------------------
// The page itself, for the platform administrator, on the workspace tier: the
// address CELL8 photographs.
// ---------------------------------------------------------------------------
function pageDeps(): ScopeAssignmentPageDeps {
  const actor = {
    principalType: "HumanUser",
    principalId: ADMIN,
    authSource: "ui",
    policyVersion: "v2",
    organizationId: ORG,
    platformRole: "platform_admin",
    orgRole: "org_admin",
    teamIds: [],
    projectGrants: [],
  } as ActorContext;
  return {
    target: {
      readSession: async () => ({ userId: ADMIN, activeOrgId: ORG }),
      readBaseActor: async () => actor,
      readGrantsInOrg: async () => ({ teamIds: [], teamRoles: {}, projectGrants: [], orgRole: "org_admin" }),
      readMembership: async () => ({
        vantage: buildWorkspaceVantage({
          userId: ADMIN,
          memberships: [{ orgId: ORG }],
          teamIdsByOrg: { [ORG]: [] },
        }),
        scopeNames: { [`organization:${ORG}`]: "Acme" },
      }),
      readAgentRows: async () => [],
      readAssistantRows: async () => [
        {
          key: BUILT_IN,
          packageName: BUILT_IN,
          vendor: "cinatra-ai",
          slug: "cinatra-assistant",
          displayName: "Cinatra",
          description: null,
          chatHref: "",
          settingsHref: "",
          remoteCapable: false,
          remoteInstances: [],
          version: null,
          status: "active",
        },
      ],
      assertWriteTarget: async () => ({ ok: true }),
    },
    reads: {
      readAssignedSkills: vi.fn(async () => []),
      resolveAssignability: vi.fn(async () => new Map()),
      listSkillCandidates: vi.fn(async () => []),
      readInstallStatuses: vi.fn(async () => new Map()),
      readAssignedContext: vi.fn(async () => []),
      readArtifact: vi.fn(async () => ({ kind: "not-found" }) as never),
      listArtifacts: vi.fn(async () => []),
      expandAcceptedExtensions: vi.fn(async (accepted: readonly string[]) => [...accepted]),
      artifactKindLabel: () => "Brand Kit",
      resolveVendorName: (input) => input.manifestVendorName ?? input.author,
    },
    readSlots: vi.fn(async () => ({ ok: true as const, slots: [] })),
  };
}

const ADDRESS = {
  surface: "assistant" as const,
  scope: { kind: "workspace" as const },
  vendor: "cinatra-ai",
  name: "cinatra-assistant",
  tab: undefined,
};

describe("the built-in assistant's page", () => {
  it("offers the labelled chooser at every scope the administrator belongs to", async () => {
    const db = seeded();
    const deps = pageDeps();
    // The REAL gate over the REAL eligibility reads, so the admission the page
    // takes is the admission the product takes.
    deps.target.assertWriteTarget = (packageName: string) =>
      assertAgentWriteTarget(packageName, {
        readPackageKind: (p) => readWritablePackageKind(p, db),
        isAssistantPackage: (p) => isAssistantPackageName(p, db),
      });

    const page = await loadScopeAssignmentPage(ADDRESS, deps);
    expect(page).not.toBeNull();
    expect(page!.admission).toEqual({ ok: true });
    expect(page!.sections.length).toBeGreaterThan(0);
    for (const section of page!.sections) expect(section.write.allowed).toBe(true);

    render(<ScopeAssignmentPage model={page!} />);
    // The Skills pane alone and no strip, exactly as before the fix.
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getAllByLabelText("Which skills should this assistant always use?")).toHaveLength(
      page!.sections.length,
    );
    expect(screen.queryByText(/couldn’t be read|couldn't be read/)).toBeNull();
    cleanup();
  });

  it("stays read-only, and names what was read, when the gate does refuse", async () => {
    const deps = pageDeps();
    deps.target.assertWriteTarget = async () =>
      ({ ok: false, reason: "eligibility-unreadable" }) as const;
    const page = await loadScopeAssignmentPage(ADDRESS, deps);
    expect(page!.admission).toEqual({ ok: false, message: UNREADABLE_SENTENCE });

    render(<ScopeAssignmentPage model={page!} />);
    expect(screen.queryByLabelText("Which skills should this assistant always use?")).toBeNull();
    // The registry ADDRESS took no part: the gate reads a row and a directory.
    expect(screen.queryByText(/extension registry/)).toBeNull();
    expect(screen.getAllByText(UNREADABLE_SENTENCE).length).toBeGreaterThan(0);
    cleanup();
  });
});
