/**
 * EVERY AUDIT EVENT OF THE TOOL ROAD NAMES WHOSE CODE RAN (cinatra#4154, part
 * C2; spec v2.2 section 2.7).
 *
 * Since part C an `extension_tool` call of an embedded child step runs the
 * child's code under the parent's run. An audit row that names only "the
 * extension" no longer says which package's code acted for which run, so every
 * event the tool road writes carries four fields: `runPackage` (the run's own
 * package), `codePackage` (the package whose code ran), `codeInstallId` (the
 * exact child installation; null on the run package's own road) and
 * `verifiedStepId` (the step the route verified).
 *
 * Here the three audit writers are driven directly with an injected audit:
 * the data operation, the artifact get and the objects read. Each one, handed
 * an attribution, adds the four fields to the event's metadata and keeps every
 * other field; handed none (every caller outside the tool road), it writes the
 * event exactly as before. The packages are fixtures.
 *
 *   pnpm exec vitest run src/lib/__tests__/extension-tool-audit-attribution.test.ts
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/artifacts/artifact-service", () => ({
  getArtifact: () => null,
  listArtifactsPage: () => ({ artifacts: [], nextCursor: null }),
  registeredArtifactTypeIds: () => [],
}));

import { POLICY_VERSION, type ActorContext } from "@/lib/authz/actor-context";
import type { ArtifactDependencyAdmission } from "@/lib/artifacts/extension-artifact-admission";
import { extensionArtifactGet } from "@/lib/artifacts/extension-artifact-reads";
import { runExtensionDataOperation } from "@/lib/extension-data-tool";
import { createExtensionObjectsPort } from "@/lib/extension-objects-port";
import {
  withAttribution,
  type ExtensionToolAttribution,
} from "@/lib/extension-tool-attribution";

const ORG = "org-fixture";
const PARENT = "@fixture-scope/fixture-parent-agent";
const CHILD = "@fixture-scope/fixture-child-agent";
const RUN = { id: "run-fixture", orgId: ORG, runBy: "user-fixture" };

const CHILD_ROAD: ExtensionToolAttribution = {
  runPackage: PARENT,
  codePackage: CHILD,
  codeInstallId: "install-child",
  verifiedStepId: "child-embed_step",
};
const OWN_ROAD: ExtensionToolAttribution = {
  runPackage: PARENT,
  codePackage: PARENT,
  codeInstallId: null,
  verifiedStepId: "own_step",
};
const FOUR = ["runPackage", "codePackage", "codeInstallId", "verifiedStepId"];

const ACTOR: ActorContext = {
  principalType: "HumanUser",
  principalId: "user-fixture",
  organizationId: ORG,
  platformRole: "member",
  authSource: "a2a",
  policyVersion: POLICY_VERSION,
};

const ADMISSION: ArtifactDependencyAdmission = {
  packageName: CHILD,
  packageVersion: "0.1.1",
  admittedPackages: [],
  admittedTypes: [],
  declarationDigest: "digest-declaration",
} as ArtifactDependencyAdmission;

function auditSpy() {
  return vi.fn<(event: Record<string, unknown>) => Promise<void>>(async () => {});
}

function metadataOf(audit: ReturnType<typeof auditSpy>, call = 0): Record<string, unknown> {
  const event = audit.mock.calls[call]![0];
  return event.metadata as Record<string, unknown>;
}

describe("withAttribution", () => {
  it("adds the four fields to the event's metadata and keeps the rest of the event", async () => {
    const audit = auditSpy();
    await withAttribution(audit, CHILD_ROAD)({
      operation: "fixture.op",
      decision: "allowed",
      metadata: { extension: CHILD, table: "t" },
    });
    expect(audit).toHaveBeenCalledWith({
      operation: "fixture.op",
      decision: "allowed",
      metadata: { extension: CHILD, table: "t", ...CHILD_ROAD },
    });
  });

  it("gives an event without metadata the four fields", async () => {
    const audit = auditSpy();
    await withAttribution(audit, OWN_ROAD)({ operation: "fixture.op" });
    expect(audit).toHaveBeenCalledWith({ operation: "fixture.op", metadata: { ...OWN_ROAD } });
  });

  it("lets no event field stand in for one of the four", async () => {
    const audit = auditSpy();
    await withAttribution(audit, CHILD_ROAD)({
      metadata: { codePackage: "@fixture-scope/forged", codeInstallId: "install-forged" },
    });
    expect(metadataOf(audit)).toEqual({ ...CHILD_ROAD });
  });

  it("copies only the four fields of the attribution it is handed", async () => {
    const audit = auditSpy();
    const wider = { ...CHILD_ROAD, originCode: "provenance-mismatch", extra: "x" };
    await withAttribution(audit, wider)({ metadata: {} });
    expect(Object.keys(metadataOf(audit)).sort()).toEqual([...FOUR].sort());
  });

  it("returns the same writer when there is no attribution", () => {
    const audit = auditSpy();
    expect(withAttribution(audit, undefined)).toBe(audit);
  });
});

describe("the data operation's audit", () => {
  const refused = (attribution?: ExtensionToolAttribution) => {
    const audit = auditSpy();
    const run = runExtensionDataOperation({
      client: {} as never,
      schemaName: "cinatra",
      packageName: CHILD,
      tables: [],
      orgId: ORG,
      runId: RUN.id,
      actorPrincipalId: RUN.runBy,
      request: { operation: "select", table: "undeclared_rows" },
      audit,
      ...(attribution ? { attribution } : {}),
    });
    return { run, audit };
  };

  it("carries the four fields on a refused operation of the tool road", async () => {
    const { run, audit } = refused(CHILD_ROAD);
    await expect(run).rejects.toThrow(/does not declare a table/);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(metadataOf(audit)).toEqual({
      extension: CHILD,
      table: "undeclared_rows",
      reason: "table-not-declared",
      ...CHILD_ROAD,
    });
  });

  it("writes the event as before when there is no attribution", async () => {
    const { run, audit } = refused();
    await expect(run).rejects.toThrow(/does not declare a table/);
    expect(metadataOf(audit)).toEqual({
      extension: CHILD,
      table: "undeclared_rows",
      reason: "table-not-declared",
    });
  });
});

describe("the artifact get's audit", () => {
  it("carries the four fields on a refused read of the tool road", async () => {
    const audit = auditSpy();
    await expect(
      extensionArtifactGet(
        { admission: ADMISSION, orgId: ORG, runId: RUN.id, actorPrincipalId: RUN.runBy, audit, attribution: CHILD_ROAD },
        { artifactId: "artifact-1" },
      ),
    ).rejects.toThrow(/is not an artifact/);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(metadataOf(audit)).toMatchObject({ extension: CHILD, reason: "not-found", ...CHILD_ROAD });
  });

  it("writes the event as before when there is no attribution", async () => {
    const audit = auditSpy();
    await expect(
      extensionArtifactGet({ admission: ADMISSION, orgId: ORG, runId: RUN.id, audit }, { artifactId: "artifact-1" }),
    ).rejects.toThrow(/is not an artifact/);
    for (const key of FOUR) expect(metadataOf(audit)).not.toHaveProperty(key);
  });
});

describe("the objects port's audit", () => {
  const port = (attribution?: ExtensionToolAttribution) => {
    const audit = auditSpy();
    const objects = createExtensionObjectsPort(
      {
        packageName: CHILD,
        packageVersion: "0.1.1",
        cinatra: { kind: "agent" },
        run: RUN,
        actor: ACTOR,
        ...(attribution ? { attribution } : {}),
      },
      {
        readClaims: () => [],
        resolveType: () => null,
        readObject: async () => null,
        readRun: async () => null,
        collectHandlers: async () => ({}),
        audit,
      },
    );
    return { objects, audit };
  };

  it("carries the four fields on a refused read of the tool road", async () => {
    const { objects, audit } = port(OWN_ROAD);
    await expect(objects.read({ objectId: "object-1" })).rejects.toThrow(/is not an object of this run/);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(metadataOf(audit)).toMatchObject({ extension: CHILD, reason: "not-in-lineage", ...OWN_ROAD });
  });

  it("writes the event as before when there is no attribution", async () => {
    const { objects, audit } = port();
    await expect(objects.read({ objectId: "object-1" })).rejects.toThrow(/is not an object of this run/);
    for (const key of FOUR) expect(metadataOf(audit)).not.toHaveProperty(key);
  });
});
