/**
 * THE OBJECTS PORT'S DENIED AUDIT ROW CARRIES NO ERROR TEXT (cinatra#4471).
 *
 * A save or a read that the objects port refuses, or that fails before the
 * host's save, writes one denied audit row and re-throws. The row's `reason`
 * is a fixed word, never the thrown value's text: a failing read inside the
 * save (here the artifact-claim read) can carry a file path or an install id
 * in its message, and the audit sanitizer drops keys, not values.
 *
 * The suite drives the real port. Its outside reads are injected through the
 * port's `deps`, so it needs no database, and every package and type is under
 * a fixture scope.
 *
 *   pnpm exec vitest run src/lib/__tests__/extension-objects-port-audit-reason-4471.test.ts
 */
import { describe, expect, it, vi } from "vitest";

import { POLICY_VERSION, type ActorContext } from "@/lib/authz/actor-context";
import { createExtensionObjectsPort } from "@/lib/extension-objects-port";

const ORG = "org-fixture";
const CALLER = "@fixture-scope/fixture-tool-pack";
const DECLARED_ARTIFACTS = "@fixture-scope/fixture-artifacts";
const RECORD = `${DECLARED_ARTIFACTS}:record`;
const UNDECLARED_RECORD = "@fixture-scope/other-artifacts:record";
const RUN = { id: "run-fixture-4471", orgId: ORG, runBy: "user-fixture" };

const ACTOR: ActorContext = {
  principalType: "HumanUser",
  principalId: "user-fixture",
  organizationId: ORG,
  platformRole: "member",
  authSource: "a2a",
  policyVersion: POLICY_VERSION,
};

const AGENT_CINATRA: Record<string, unknown> = {
  apiVersion: "cinatra.ai/v1",
  kind: "agent",
  dependencies: [
    {
      packageName: DECLARED_ARTIFACTS,
      kind: "artifact",
      edgeType: "runtime",
      versionConstraint: { kind: "semver-range", range: "^1.0.0" },
      requirement: "required",
    },
  ],
};

/** A fake absolute path and a fake install id: the values no audit row may hold. */
const FAKE_PATH = "/srv/fixture-store/extensions/fixture-install-dir/cinatra/tools/fixture.mjs";
const FAKE_INSTALL_ID = "inst_fixture_7f3a9c21";
const LEAKY = `ENOENT: no such file or directory, open '${FAKE_PATH}' (install ${FAKE_INSTALL_ID})`;

function harness(readClaims: () => readonly never[]) {
  const audit = vi.fn<(event: Record<string, unknown>) => Promise<void>>(async () => {});
  const port = createExtensionObjectsPort(
    {
      packageName: CALLER,
      packageVersion: "1.2.3",
      cinatra: AGENT_CINATRA,
      run: RUN,
      actor: ACTOR,
    },
    {
      readClaims,
      resolveType: () => null,
      readObject: async () => null,
      readRun: async () => null,
      collectHandlers: async () => ({}),
      audit,
    },
  );
  return { port, audit };
}

describe("the objects port's denied audit row (cinatra#4471)", () => {
  it("records a fixed reason word, not the text of a read that fails inside a save", async () => {
    const h = harness(() => {
      throw new Error(LEAKY);
    });
    await expect(h.port.save({ type: RECORD, data: { key: "k1" } })).rejects.toThrow();
    expect(h.audit).toHaveBeenCalledTimes(1);
    const [event] = h.audit.mock.calls[0]!;
    expect(event).toMatchObject({
      operation: "objects_save",
      decision: "denied",
      metadata: expect.objectContaining({ reason: "failed" }),
    });
    const row = JSON.stringify(h.audit.mock.calls);
    expect(row).not.toContain(FAKE_PATH);
    expect(row).not.toContain(FAKE_INSTALL_ID);
    expect(row).not.toContain("ENOENT");
  });

  it("records the fixed reason word `refused` for a stated refusal of a save", async () => {
    const h = harness(() => []);
    await expect(h.port.save({ type: UNDECLARED_RECORD, data: { key: "k1" } })).rejects.toMatchObject({
      name: "ExtensionToolRefusal",
    });
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0]![0]).toMatchObject({
      operation: "objects_save",
      decision: "denied",
      metadata: expect.objectContaining({ reason: "refused" }),
    });
  });

  it("records the fixed reason word `refused` for a stated refusal of a read", async () => {
    const h = harness(() => []);
    await expect(h.port.read({ objectId: "" })).rejects.toMatchObject({ name: "ExtensionToolRefusal" });
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0]![0]).toMatchObject({
      operation: "objects_read",
      decision: "denied",
      metadata: expect.objectContaining({ reason: "refused" }),
    });
  });
});
