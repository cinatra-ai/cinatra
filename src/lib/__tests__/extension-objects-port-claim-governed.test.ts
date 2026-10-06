/**
 * THE OBJECTS PORT SAVES A RECORD OF A CLAIM-GOVERNED TYPE (cinatra#3089).
 *
 * When no package registers a type in the process, the claiming pack's own
 * claim governs it: its schema, and the record identity the claim declares in
 * that schema (`x-cinatra-identity`). An agent's module then saves a record of
 * such a type through the objects port, which reads the PROCESS registry (its
 * `resolveType` is left to its default here) and keys the record by the
 * declared identity — a record without that identity is refused.
 *
 * Every other outside read is injected through the port's `deps`, as in
 * extension-objects-port.test.ts, so the suite needs no database. Every package
 * and type below is under a fixture scope, never a real organisation's slug.
 *
 *   pnpm exec vitest run src/lib/__tests__/extension-objects-port-claim-governed.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ArbitrableClaim } from "@cinatra-ai/objects/claims";
import { registerParsedArtifactManifest } from "@cinatra-ai/objects/register-artifact-extensions";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";

import { POLICY_VERSION, type ActorContext } from "@/lib/authz/actor-context";
import { createExtensionObjectsPort } from "@/lib/extension-objects-port";

const ORG = "org-fixture";
const CALLER = "@fixture-scope/fixture-tool-pack";
const PINNED = "1.2.3";
const DECLARED_ARTIFACTS = "@fixture-scope/fixture-artifacts";
const RECORD = "@fixture-scope/virtual-mail:record";

const RUN = { id: "run-fixture-child", orgId: ORG, runBy: "user-fixture" };

const ACTOR: ActorContext = {
  principalType: "HumanUser",
  principalId: "user-fixture",
  organizationId: ORG,
  platformRole: "member",
  authSource: "a2a",
  policyVersion: POLICY_VERSION,
};

/** The caller's own `cinatra` block: an agent with one artifact dependency. */
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

/** The org's claim chain: the artifact pack's dedicated, active claim of the type. */
const CLAIMS: readonly ArbitrableClaim[] = [
  {
    id: `claim-${RECORD}`,
    scope: "platform",
    objectTypeId: RECORD,
    claimKind: "dedicated",
    status: "active",
    extensionPackage: DECLARED_ARTIFACTS,
    extensionVersion: "1.0.0",
    generation: 1,
  },
];

/** The artifact pack's manifest: its claim of the type, with the record
 *  identity declared inside the claim's own schema. */
const MANIFEST: Parameters<typeof registerParsedArtifactManifest>[0] = {
  accepts: { file: { mimeTypes: ["text/markdown"] } },
  objectTypes: [
    {
      type: RECORD,
      claim: "dedicated",
      dispositions: {
        projection: "none",
        pinnable: false,
        snapshotPolicy: "none",
        sensitivity: "sensitive",
        mutability: "record",
      },
      schema: {
        type: "object",
        properties: {
          runId: { type: "string", minLength: 1 },
          key: { type: "string" },
          address: { type: "string", minLength: 1, pattern: "\\S" },
        },
        required: ["runId"],
        anyOf: [{ required: ["address"] }, { required: ["key"], properties: { key: { minLength: 1 } } }],
        additionalProperties: true,
        "x-cinatra-identity": ["runId", "key"],
      },
    },
  ],
};

type SaveRequest = {
  primitiveName: string;
  input: { typeHint: string; rawData: Record<string, unknown> };
  actor: Record<string, unknown>;
  mode: string;
};

function harness() {
  const audit = vi.fn<(event: Record<string, unknown>) => Promise<void>>(async () => {});
  const objectsSave = vi.fn(async (request: SaveRequest) => ({
    objectId: "obj-saved",
    type: request.input.typeHint,
    isNew: true,
    wasMerged: false,
    confidence: 1,
  }));
  const readObject = vi.fn(async () => null);
  const readRun = vi.fn(async () => null);
  const port = createExtensionObjectsPort(
    { packageName: CALLER, packageVersion: PINNED, cinatra: AGENT_CINATRA, run: RUN, actor: ACTOR },
    {
      readClaims: () => CLAIMS,
      readObject,
      readRun,
      collectHandlers: async () => ({ objects_save: objectsSave }),
      audit,
    },
  );
  return { port, objectsSave };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  objectTypeRegistry.removeByPackage(DECLARED_ARTIFACTS);
  registerParsedArtifactManifest(MANIFEST, DECLARED_ARTIFACTS);
});

afterEach(() => {
  objectTypeRegistry.removeByPackage(DECLARED_ARTIFACTS);
  vi.resetModules();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("an agent's module saves a record of a claim-governed type through the objects port", () => {
  it("P1 saves a record keyed by the declared identity, with no address", async () => {
    const h = harness();
    await expect(
      h.port.save({ type: RECORD, data: { runId: { boundRun: true }, key: "k1" } }),
    ).resolves.toEqual({ objectId: "obj-saved", type: RECORD, isNew: true });
    expect(h.objectsSave).toHaveBeenCalledTimes(1);
    const request = h.objectsSave.mock.calls[0]?.[0];
    expect(request?.input.typeHint).toBe(RECORD);
    expect(request?.input.rawData).toEqual({ runId: RUN.id, key: "k1" });
  });

  it("P2 refuses a record the declared identity does not key, and never saves it", async () => {
    const h = harness();
    await expect(
      h.port.save({ type: RECORD, data: { runId: { boundRun: true }, address: "a@example.org" } }),
    ).rejects.toThrow("gives this record no identity");
    expect(h.objectsSave).not.toHaveBeenCalled();
  });
});
