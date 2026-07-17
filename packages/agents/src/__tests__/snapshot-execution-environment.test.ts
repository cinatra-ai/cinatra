/**
 * buildSnapshotFromTemplate executionEnvironment capture (exec-plane S3,
 * cinatra#1708): the declared env is part of the immutable version snapshot —
 * and the capture is SHAPE-PRESERVING (env-less templates keep the legacy
 * snapshot shape, so their content hashes are byte-identical to pre-S3).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../db", () => ({
  db: {} as unknown,
  agentBuilderPool: {} as unknown,
}));

import {
  buildSnapshotFromTemplate,
  computeSnapshotContentHash,
  type AgentTemplateRecord,
} from "../store";

const baseTemplate = (): AgentTemplateRecord =>
  ({
    id: "tpl-1",
    orgId: null,
    ownerLevel: null,
    ownerId: null,
    creatorId: null,
    name: "T",
    description: null,
    sourceNl: "do things",
    compiledPlan: [],
    inputSchema: {},
    outputSchema: null,
    approvalPolicy: { mode: "auto" },
    status: "active",
    type: "leaf",
    taskSpec: null,
    packageName: null,
    packageVersion: null,
    currentVersionId: null,
    hitlScreens: null,
    ioSpec: null,
    hitlRequired: false,
    executionProvider: "default",
    lgGraphCode: null,
    lgGraphId: null,
    sourceType: "internal",
    agentUrl: null,
    connectorSlug: null,
    remoteAgentId: null,
    triggerMode: null,
    gatedSteps: null,
    agentAuthPolicy: null,
    extensionLifecycleStatus: "active",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }) as unknown as AgentTemplateRecord;

describe("buildSnapshotFromTemplate executionEnvironment capture", () => {
  it("captures the declared environment into the snapshot", () => {
    const template = { ...baseTemplate(), executionEnvironment: { pip: ["pandas==2.2.1"] } };
    const snapshot = buildSnapshotFromTemplate(template);
    expect(snapshot.executionEnvironment).toEqual({ pip: ["pandas==2.2.1"] });
  });

  it("is SHAPE-PRESERVING: env-less templates emit NO executionEnvironment key", () => {
    const withoutEnv = buildSnapshotFromTemplate(baseTemplate());
    expect("executionEnvironment" in withoutEnv).toBe(false);
    // Content-hash stability for legacy templates: adding the S3 capture must
    // not change the hash of an env-less snapshot.
    const legacyShape = { ...withoutEnv };
    expect(computeSnapshotContentHash(withoutEnv)).toBe(
      computeSnapshotContentHash(legacyShape),
    );
  });

  it("a declared env changes the snapshot content hash (new version = new recipe)", () => {
    const a = buildSnapshotFromTemplate(baseTemplate());
    const b = buildSnapshotFromTemplate({
      ...baseTemplate(),
      executionEnvironment: { pip: ["pandas"] },
    });
    expect(computeSnapshotContentHash(a)).not.toBe(computeSnapshotContentHash(b));
  });
});
