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
import { getTableName } from "drizzle-orm";

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

const BUILT_IN = BUILTIN_ASSISTANT_ALIAS.packageName;
const UNKNOWN = "@northstar/no-such-package";
const ADMIN = "user_admin";
const ORG = "org_acme";

const UNREADABLE_SENTENCE =
  "This package's install record couldn't be read, so these assignments can't be changed right now.";

// ---------------------------------------------------------------------------
// The store double. Minimal replay of the drizzle read chain the eligibility
// reader uses, `db.select({…}).from(t)[.where(c)][.limit(n)]` to rows, keyed on
// the TABLE, so each read answers from its own rows. Every double below holds
// the rows for ONE package, so a read that ignores the predicate cannot answer
// for a package the test did not seed.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;

function storeDouble(opts: { installs?: Row[]; templates?: Row[] } = {}) {
  const rowsFor = (table: string): Row[] =>
    table === "agent_templates" ? (opts.templates ?? []) : (opts.installs ?? []);
  const select = () => ({
    from(table: Parameters<typeof getTableName>[0]) {
      const rows = rowsFor(getTableName(table));
      const chain = {
        where: () => chain,
        limit: () => chain,
        then: (resolve: (r: Row[]) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject),
      };
      return chain;
    },
  });
  return { select } as never;
}

/** An installation whose built-in assistant is boot-seeded, as every one is. */
const seeded = () =>
  storeDouble({ templates: [{ id: "tpl_cinatra", packageName: BUILT_IN, agentKind: "assistant" }] });
/** An installation that holds nothing for the package being asked about. */
const nothing = () => storeDouble();

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

  it("admits the built-in at the shared write gate and still refuses an unknown package", async () => {
    const gate = (packageName: string, db: ReturnType<typeof seeded>) =>
      assertAgentWriteTarget(packageName, {
        readPackageKind: (p) => readWritablePackageKind(p, db),
        isAssistantPackage: (p) => isAssistantPackageName(p, db),
      });
    expect(await gate(BUILT_IN, seeded())).toEqual({ ok: true });
    expect(await gate(UNKNOWN, nothing())).toEqual({ ok: false, reason: "eligibility-unreadable" });
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
