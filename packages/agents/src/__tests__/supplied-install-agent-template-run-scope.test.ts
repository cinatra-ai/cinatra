/**
 * AN AGENT PACK INSTALLED THROUGH THE PRODUCT'S OWN INSTALL SCREENS IS RUNNABLE
 * (cinatra#3534 / cinatra#3493).
 *
 * THE WHOLE ROAD IN ONE SUITE, and no step of it asserted twice in different
 * words: the picker's own value -> the real install-scope contract
 * (`resolveInstallAccessTargetContract`) -> the REAL agents kind handler
 * (`createAgentExtensionHandler`) -> the owner tuple the handler threads into
 * the agent installer -> the row `withDeterminateInstallScope` persists from
 * that tuple -> the REAL run-scope evaluator
 * (`evaluateActorWithinAgentTemplateScope`). What is graded is the run decision
 * an operator actually meets after installing through a screen.
 *
 * THE DEFECT THIS FILE PINS: the two workspace install targets ("Workspace: All"
 * and "Workspace: Admins only") map to the WORKSPACE row anchor, whose owner
 * level the run-scope evaluator does not recognise — so the template row the
 * install writes is refused at run start with `unknown_scope` / level `null`,
 * and one press of the Run control mints no run at all.
 *
 * THE EVALUATOR IS NOT WIDENED. Which levels authorize a run is a security
 * decision this file does not touch (it is locked by
 * `agent-template-scope.test.ts`, which asserts a `workspace` owner level is
 * DENIED). What is asserted here is that the agents kind TRANSLATES a
 * workspace-anchored install into the determinate organization anchor the
 * evaluator already admits, for the installing organization and for nobody else.
 *
 * THE SCOPES ARE ENUMERATED RATHER THAN NAMED ONE AT A TIME: one table entry per
 * level the picker offers, so a level nobody thought about fails here rather
 * than first in a proof round.
 *
 * MODULE BOUNDARIES: borrowed from `extension-handler-native-ownership.test.ts`
 * — the install environment resolver, the finalized store payload, the
 * dependency-closure installer and the single-package installer are substituted
 * and their arguments captured, so the handler itself runs for real. The
 * contract, the write-boundary stamp and the evaluator are all the real modules.
 *
 * HOW THE PERSISTED ROW IS MODELLED, stated as a MODEL and not as a measurement
 * of what either installer writes: the installers are substituted here, so this
 * file reads the tuple the handler THREADS and stamps it with the real write
 * boundary (`withDeterminateInstallScope`, which returns its input unchanged
 * when no `orgId` is supplied — and the handler supplies none, the identity
 * claim's organization having its own rules this road does not touch). The row
 * is therefore modelled with `orgId: null`. That models the org-anchor column
 * as absent; it is NOT an inference from the round's `unknown_scope` reading,
 * which a workspace-owned row carrying an org column answers just the same, and
 * it is not a "worst case" either — a null column SKIPS the evaluator's leading
 * cross-org guard, so the isolation these arms prove is the one the translated
 * owner ID itself enforces. What an installer actually persists is the
 * database-tier suite's to measure, not this file's.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ActorContext } from "@/lib/authz/actor-context";

const { resolveInstallEnvironmentMock } = vi.hoisted(() => ({
  resolveInstallEnvironmentMock: vi.fn(),
}));
vi.mock("@cinatra-ai/extensions/destination-resolver", () => ({
  resolveInstallEnvironment: resolveInstallEnvironmentMock,
}));

const { resolveFinalizedStorePayloadMock } = vi.hoisted(() => ({
  resolveFinalizedStorePayloadMock: vi.fn(async (input: { packageName: string }) => ({
    storeDir: `/tmp/store/agent/${input.packageName}/deadbeef`,
    digest: "d".repeat(128),
    version: "1.2.3",
    registryUrl: null,
  })),
}));
vi.mock("@/lib/extension-store-payload", () => ({
  resolveFinalizedStorePayload: (...a: unknown[]) =>
    resolveFinalizedStorePayloadMock(...(a as [never])),
}));

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(async () => {
    const err = new Error("ENOENT") as Error & { code: string };
    err.code = "ENOENT";
    throw err;
  }),
  readFile: vi.fn(),
}));

const { sagaActiveSpy } = vi.hoisted(() => ({ sagaActiveSpy: vi.fn(() => false) }));

vi.mock("@cinatra-ai/agents", () => ({
  installAgentPackageWithDependencies: vi.fn(async () => ({
    rootTemplateId: "tpl-tree",
    installedTemplateIds: ["tpl-tree"],
    tree: {},
  })),
  installAgentFromPackage: vi.fn(async () => ({ templateId: "tpl-root" })),
  isSagaOwnedFanoutActive: () => sagaActiveSpy(),
  extractAgentPackage: vi.fn(async () => ({
    packageName: "@scope/ext",
    packageVersion: "1.2.3",
    manifest: {},
    payload: {},
    readme: null,
    tempDir: "/tmp/ext",
  })),
  cleanupExtractedAgentPackage: vi.fn(async () => {}),
  deleteAgentTemplate: vi.fn(),
  readAgentTemplateByPackageName: vi.fn(),
  updateAgentTemplate: vi.fn(),
  readActiveExtensionTemplates: vi.fn(async () => []),
  readArchivedExtensionTemplates: vi.fn(async () => []),
}));

vi.mock("@cinatra-ai/skills", () => ({
  upsertSkill: vi.fn(),
  parseFrontmatter: vi.fn(() => ({ attributes: {} })),
  deleteAgentSkillsForSlugs: vi.fn(),
  enqueueInlineForAgent: vi.fn(async () => {}),
  cleanupForAgent: vi.fn(async () => {}),
}));

vi.mock("@cinatra-ai/registries", async () => {
  const scope = await vi.importActual<typeof import("../../../registries/src/scope")>(
    "../../../registries/src/scope",
  );
  class InstanceNamespaceNotConfiguredError extends Error {}
  return { ...scope, InstanceNamespaceNotConfiguredError };
});

vi.mock("../materialize-agent-package", () => ({
  withInstallLock: (_pkg: string, fn: () => Promise<unknown>) => fn(),
}));

import { createAgentExtensionHandler } from "../extension-handler";
import { installAgentPackageWithDependencies, installAgentFromPackage } from "@cinatra-ai/agents";
import { resolveInstallAccessTargetContract } from "@cinatra-ai/extensions/install-access-target";
import { pickerValueToInstallTarget } from "@cinatra-ai/extensions/screens/install-picker-target";
import {
  evaluateActorWithinAgentTemplateScope,
  withDeterminateInstallScope,
  type AgentTemplateScopeRef,
} from "../auth-policy";

const BROKER_URL = "https://marketplace.cinatra.ai/install/v1";
const ORG = "org-1";
const OTHER_ORG = "org-other";

const actor = {
  userId: "u1",
  orgId: ORG,
  source: "ui" as const,
  actorType: "human" as const,
};

/**
 * THE SCOPE TABLE — one entry per level the install picker offers, keyed by the
 * picker's own value so the set is the picker's rather than this file's.
 */
const OFFERED_SCOPES = [
  { pickerValue: `org:${ORG}`, level: "organization" as const, label: "your organization" },
  { pickerValue: "team:team-7", level: "team" as const, label: "a team" },
  { pickerValue: "project:proj-9", level: "project" as const, label: "a project" },
  { pickerValue: "workspace", level: "workspace" as const, label: "Workspace: All" },
  { pickerValue: "admin", level: "admin" as const, label: "Workspace: Admins only" },
];

type ThreadedTuple = {
  anchorOrgId: string | null;
  ownerLevel?: string;
  ownerId?: string;
};

function memberOf(orgId: string, overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "u1",
    organizationId: orgId,
    teamIds: [],
    projectGrants: [],
    projectIds: [],
    orgRole: "member",
    platformRole: "member",
    authSource: "ui",
    policyVersion: "v2",
    ...overrides,
  } as ActorContext;
}

/** The row the write boundary persists from the tuple the handler threaded. */
function persistedRow(threaded: ThreadedTuple): AgentTemplateScopeRef {
  const stamped = withDeterminateInstallScope({
    ...(threaded.ownerLevel ? { ownerLevel: threaded.ownerLevel as never } : {}),
    ...(threaded.ownerId ? { ownerId: threaded.ownerId } : {}),
  });
  return {
    id: "tmpl-installed",
    orgId: null,
    ownerLevel: stamped.ownerLevel ?? null,
    ownerId: stamped.ownerId ?? null,
  };
}

/**
 * Drive the REAL handler for one picker value on one of the two installer roads
 * and answer the owner tuple it threaded into the agent installer.
 *
 * ROOT-ONLY is the road a SUPPLIED pack takes (a file or a repository link the
 * operator handed over); CLOSURE is the road a registry or marketplace pack
 * takes. Both must yield an admissible tuple, so both are entered.
 */
async function threadedTupleFor(
  pickerValue: string,
  road: "root-only" | "closure",
  installingActor: { userId: string; orgId: string | null } = actor,
): Promise<ThreadedTuple> {
  vi.clearAllMocks();
  const target = pickerValueToInstallTarget(pickerValue, ORG);
  if (!target) throw new Error(`the picker offered no install target for "${pickerValue}"`);
  const { rowOwnership } = resolveInstallAccessTargetContract(target as never, ORG);
  const handler = createAgentExtensionHandler();
  const ref =
    road === "root-only"
      ? {
          packageName: "@scope/ext",
          version: "1.2.3",
          provenance: { type: "local", path: "abc.tgz", contentDigest: "a".repeat(64) },
        }
      : { packageName: "@scope/ext", version: "1.2.3" };
  await handler.install(ref as never, installingActor as never, { rowOwnership } as never);
  const installer = road === "root-only" ? installAgentFromPackage : installAgentPackageWithDependencies;
  const call = (installer as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as
    | Record<string, unknown>
    | undefined;
  if (!call) throw new Error(`the ${road} installer was never called for "${pickerValue}"`);
  return {
    anchorOrgId: (call.anchorOrgId ?? null) as string | null,
    ...(call.ownerLevel ? { ownerLevel: call.ownerLevel as string } : {}),
    ...(call.ownerId ? { ownerId: call.ownerId as string } : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sagaActiveSpy.mockReturnValue(false);
  resolveInstallEnvironmentMock.mockResolvedValue({
    args: [`--registry=${BROKER_URL}`, `--//marketplace.cinatra.ai/:_authToken=opaque.grant`],
    registryUrl: BROKER_URL,
    routingMode: "shared-acl",
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// ARM 1 + ARM 2 + ARM 3 — every offered scope, on both installer roads, is
// RUNNABLE by an actor of the installing organization.
//
// ARM 1 (RED before the cut): the workspace and admin entries. ARM 2
// (green before and after): the organization, team and project entries — the
// pin that this change moves nothing for them. ARM 3: both roads are entered.
// ---------------------------------------------------------------------------
describe("every install scope the picker offers yields a template an operator of the installing organization can run", () => {
  for (const road of ["root-only", "closure"] as const) {
    for (const entry of OFFERED_SCOPES) {
      it(`${entry.level} (${entry.label}) on the ${road} road is runnable by the installing organization`, async () => {
        const threaded = await threadedTupleFor(entry.pickerValue, road);
        const decision = evaluateActorWithinAgentTemplateScope(
          persistedRow(threaded),
          memberOf(ORG),
        );
        // The threaded tuple travels in the expectation so a failure records
        // WHAT the handler threaded, not only that the run was refused.
        expect({ level: entry.level, threaded, decision }).toEqual({
          level: entry.level,
          threaded,
          decision: expect.objectContaining({ allowed: true }),
        });
      });
    }
  }
});

// ---------------------------------------------------------------------------
// ARM 4 — THE NEGATIVE: the cut admits the installing tenant and nobody else.
// ---------------------------------------------------------------------------
describe("no install scope the picker offers is runnable by an actor of a DIFFERENT organization", () => {
  for (const entry of OFFERED_SCOPES) {
    it(`${entry.level} (${entry.label}) denies an actor of another organization`, async () => {
      const threaded = await threadedTupleFor(entry.pickerValue, "root-only");
      const decision = evaluateActorWithinAgentTemplateScope(
        persistedRow(threaded),
        memberOf(OTHER_ORG),
      );
      expect({ level: entry.level, threaded, decision }).toEqual({
        level: entry.level,
        threaded,
        decision: expect.objectContaining({ allowed: false }),
      });
    });
  }

  it("the two workspace targets are refused as not_org_member — a determinate owner, not an unknown scope", async () => {
    for (const pickerValue of ["workspace", "admin"]) {
      const threaded = await threadedTupleFor(pickerValue, "root-only");
      const decision = evaluateActorWithinAgentTemplateScope(
        persistedRow(threaded),
        memberOf(OTHER_ORG),
      );
      expect({ pickerValue, threaded, decision }).toEqual({
        pickerValue,
        threaded,
        decision: { allowed: false, reason: "not_org_member", level: "organization" },
      });
    }
  });

  // The fail-closed side of the same arm, and the one branch the translation
  // deliberately does NOT take: with no installing organization there is no
  // authoritative owner on this road, so the tuple is left exactly as it is —
  // `anchorOrgId` null, no owner id, and no `orgId` or `claimantOrgId` added —
  // and the row stays refused rather than becoming runnable for anyone.
  it("a workspace install with NO installing organization is left untranslated and stays refused", async () => {
    const threaded = await threadedTupleFor("workspace", "root-only", {
      userId: "u1",
      orgId: null,
    });
    expect(threaded).toEqual({ anchorOrgId: null, ownerLevel: "workspace" });
    expect(evaluateActorWithinAgentTemplateScope(persistedRow(threaded), memberOf(ORG))).toEqual(
      expect.objectContaining({ allowed: false }),
    );
  });
});

// ---------------------------------------------------------------------------
// ARM 5 — THE FLEET SYNC'S OWN TUPLE, pinned in the same table for
// completeness: the development loader passes an organization id ALONE, and the
// write boundary turns that into the determinate organization anchor. This is
// the road cinatra#3534 compares the install screens with, and it is the road
// the cut above brings them onto.
// ---------------------------------------------------------------------------
describe("the development fleet sync's tuple — an organization id alone — is admissible", () => {
  it("an org id alone is stamped organization-owned and runs for that organization", () => {
    const stamped = withDeterminateInstallScope<{
      orgId: string;
      ownerLevel?: "user" | "team" | "organization" | "workspace" | "project";
      ownerId?: string;
    }>({ orgId: ORG });
    expect(stamped).toEqual({ orgId: ORG, ownerLevel: "organization", ownerId: ORG });
    const row: AgentTemplateScopeRef = {
      id: "tmpl-fleet",
      orgId: ORG,
      ownerLevel: stamped.ownerLevel ?? null,
      ownerId: stamped.ownerId ?? null,
    };
    expect(evaluateActorWithinAgentTemplateScope(row, memberOf(ORG))).toEqual(
      expect.objectContaining({ allowed: true, level: "organization" }),
    );
    expect(evaluateActorWithinAgentTemplateScope(row, memberOf(OTHER_ORG))).toEqual(
      expect.objectContaining({ allowed: false }),
    );
  });
});
