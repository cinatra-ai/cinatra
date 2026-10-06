/**
 * THE OBJECTS PORT OF THE EXTENSION TOOL (cinatra#3089).
 *
 * A declared step module of an agent package is handed `ports.objects` with two
 * calls: a read of one object of its run's OWN LINEAGE, and a save of a record
 * whose type one of the calling package's declared artifact dependencies owns,
 * with the run bound by the host and never passed by the module.
 *
 * Every outside read is injected through the port's `deps`, so the suite needs
 * no database. Every package and type below is under a fixture scope, never a
 * real organisation's slug, so nothing here names a pack, a table or a type.
 *
 *   pnpm exec vitest run src/lib/__tests__/extension-objects-port.test.ts
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ArbitrableClaim } from "@cinatra-ai/objects/claims";
import { getActorContext } from "@cinatra-ai/llm/actor-context";

import { POLICY_VERSION, type ActorContext } from "@/lib/authz/actor-context";
import { EXTENSION_ARTIFACT_CONTENT_MAX_BYTES } from "@/lib/artifacts/extension-artifact-reads";
import { createExtensionObjectsPort } from "@/lib/extension-objects-port";
import { EXTENSION_TOOL_RUN_IDENTITY_KEYS } from "@/lib/extension-tool-dispatch";
import { InvalidActivatedTypePayloadError } from "@/lib/objects/claim-activation-gate";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

const ORG = "org-fixture";
const OTHER_ORG = "org-fixture-other";

const CALLER = "@fixture-scope/fixture-tool-pack";
const PINNED = "1.2.3";
const DECLARED_ARTIFACTS = "@fixture-scope/fixture-artifacts";
const UNDECLARED_ARTIFACTS = "@fixture-scope/other-artifacts";
const DECLARED_CONNECTOR = "@fixture-scope/fixture-connector";

const RECORD = `${DECLARED_ARTIFACTS}:record`;
const KEYLESS = `${DECLARED_ARTIFACTS}:keyless`;
const THROWING = `${DECLARED_ARTIFACTS}:throwing`;
const UNREGISTERED = `${DECLARED_ARTIFACTS}:unregistered`;
const OTHER_RECORD = `${UNDECLARED_ARTIFACTS}:record`;
const CONNECTOR_RECORD = `${DECLARED_CONNECTOR}:record`;

const RUN = { id: "run-fixture-child", orgId: ORG, runBy: "user-fixture" };
const PARENT_RUN = "run-fixture-parent";
const FOREIGN_GRANDPARENT_RUN = "run-fixture-foreign-grandparent";
const UNRELATED_RUN = "run-fixture-unrelated";

const ACTOR: ActorContext = {
  principalType: "HumanUser",
  principalId: "user-fixture",
  organizationId: ORG,
  platformRole: "member",
  authSource: "a2a",
  policyVersion: POLICY_VERSION,
};

const edge = (packageName: string, kind: string) => ({
  packageName,
  kind,
  edgeType: "runtime",
  versionConstraint: { kind: "semver-range", range: "^1.0.0" },
  requirement: "required",
});

/** The caller's own `cinatra` block: an agent with one artifact dependency. */
const AGENT_CINATRA: Record<string, unknown> = {
  apiVersion: "cinatra.ai/v1",
  kind: "agent",
  dependencies: [edge(DECLARED_ARTIFACTS, "artifact"), edge(DECLARED_CONNECTOR, "connector")],
};

const claim = (objectTypeId: string, extensionPackage: string): ArbitrableClaim => ({
  id: `claim-${objectTypeId}`,
  scope: "platform",
  objectTypeId,
  claimKind: "dedicated",
  status: "active",
  extensionPackage,
  extensionVersion: "1.0.0",
  generation: 1,
});

/** The registrations the admission resolves owners from (the winning claims). */
const CLAIMS: readonly ArbitrableClaim[] = [
  claim(RECORD, DECLARED_ARTIFACTS),
  claim(KEYLESS, DECLARED_ARTIFACTS),
  claim(THROWING, DECLARED_ARTIFACTS),
  claim(UNREGISTERED, DECLARED_ARTIFACTS),
  claim(OTHER_RECORD, UNDECLARED_ARTIFACTS),
  claim(CONNECTOR_RECORD, DECLARED_CONNECTOR),
];

/** The process registry: what `resolveType` answers per type. */
const keyOf = (data: Record<string, unknown>) =>
  typeof data.key === "string" && data.key !== ""
    ? `${String(data.cinatraAgentRunId)}:${data.key}`
    : null;
const TYPES: Record<string, { identityKey?: (data: Record<string, unknown>) => string | null }> = {
  [RECORD]: { identityKey: keyOf },
  [KEYLESS]: {},
  [THROWING]: {
    identityKey: () => {
      throw new Error("fixture key failure");
    },
  },
  [OTHER_RECORD]: { identityKey: keyOf },
  [CONNECTOR_RECORD]: { identityKey: keyOf },
};

type FixtureRow = { id: string; type: string; data: unknown; runId: string | null; orgId: string | null };
type FixtureRun = { id: string; orgId: string; parentRunId: string | null };

const RUNS: Record<string, FixtureRun> = {
  [RUN.id]: { id: RUN.id, orgId: ORG, parentRunId: PARENT_RUN },
  [PARENT_RUN]: { id: PARENT_RUN, orgId: ORG, parentRunId: FOREIGN_GRANDPARENT_RUN },
  [FOREIGN_GRANDPARENT_RUN]: { id: FOREIGN_GRANDPARENT_RUN, orgId: OTHER_ORG, parentRunId: null },
  [UNRELATED_RUN]: { id: UNRELATED_RUN, orgId: ORG, parentRunId: null },
};

const ROWS: FixtureRow[] = [
  { id: "obj-own", type: RECORD, data: { key: "k-own" }, runId: RUN.id, orgId: ORG },
  { id: "obj-parent", type: RECORD, data: { key: "k-parent" }, runId: PARENT_RUN, orgId: ORG },
  { id: "obj-unrelated", type: RECORD, data: { key: "k-x" }, runId: UNRELATED_RUN, orgId: ORG },
  {
    id: "obj-foreign-ancestor",
    type: RECORD,
    data: { key: "k-y" },
    runId: FOREIGN_GRANDPARENT_RUN,
    orgId: ORG,
  },
  { id: "obj-other-org", type: RECORD, data: { key: "k-z" }, runId: RUN.id, orgId: OTHER_ORG },
  { id: "obj-no-run", type: RECORD, data: { key: "k-n" }, runId: null, orgId: ORG },
  {
    id: "obj-large",
    type: RECORD,
    data: { text: "x".repeat(EXTENSION_ARTIFACT_CONTENT_MAX_BYTES) },
    runId: RUN.id,
    orgId: ORG,
  },
];

type SaveRequest = {
  primitiveName: string;
  input: { typeHint: string; rawData: Record<string, unknown> };
  actor: Record<string, unknown>;
  mode: string;
};

function harness(
  opts: {
    cinatra?: Record<string, unknown>;
    actor?: ActorContext | null;
    rows?: FixtureRow[];
    runs?: Record<string, FixtureRun>;
    handler?: (request: SaveRequest) => unknown;
  } = {},
) {
  const rows = opts.rows ?? ROWS;
  const runs = opts.runs ?? RUNS;
  const audit = vi.fn<(event: Record<string, unknown>) => Promise<void>>(async () => {});
  const framesSeen: Array<ActorContext | undefined> = [];
  const objectsSave = vi.fn(async (request: SaveRequest) => {
    framesSeen.push(getActorContext());
    if (opts.handler) return opts.handler(request);
    return {
      objectId: "obj-saved",
      type: request.input.typeHint,
      isNew: true,
      wasMerged: false,
      confidence: 1,
    };
  });
  // The injected row read answers by id alone, so the port's own organisation
  // and lineage rules are the ones under test.
  const readObject = vi.fn<
    (id: string, scope: { orgId: string | null }, actor?: ActorContext) => Promise<FixtureRow | null>
  >(async (id) => rows.find((r) => r.id === id) ?? null);
  const readRun = vi.fn(async (id: string) => runs[id] ?? null);
  const port = createExtensionObjectsPort(
    {
      packageName: CALLER,
      packageVersion: PINNED,
      cinatra: opts.cinatra ?? AGENT_CINATRA,
      run: RUN,
      ...(opts.actor === null ? {} : { actor: opts.actor ?? ACTOR }),
    },
    {
      readClaims: () => CLAIMS,
      resolveType: (typeId: string) => TYPES[typeId] ?? null,
      readObject,
      readRun,
      collectHandlers: async () => ({ objects_save: objectsSave }),
      audit,
    },
  );
  return { port, audit, objectsSave, readObject, readRun, framesSeen };
}

describe("CASE 2 — a save is admitted only for a type that the calling package's declared artifact dependencies own", () => {
  it("refuses a save of a type an UNDECLARED package owns, naming the type, and audits the denial", async () => {
    const h = harness();
    await expect(h.port.save({ type: OTHER_RECORD, data: { key: "k1" } })).rejects.toMatchObject({
      name: "ExtensionToolRefusal",
      message: expect.stringMatching(/^extension_tool: objects\.save: /),
    });
    await expect(h.port.save({ type: OTHER_RECORD, data: { key: "k1" } })).rejects.toThrow(
      OTHER_RECORD,
    );
    expect(h.objectsSave).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledTimes(2);
    const [event] = h.audit.mock.calls[0]!;
    expect(event).toMatchObject({
      organizationId: ORG,
      runId: RUN.id,
      actorPrincipalId: RUN.runBy,
      resourceType: "object",
      operation: "objects_save",
      decision: "denied",
      metadata: expect.objectContaining({
        extension: CALLER,
        extensionVersion: PINNED,
        admittedPackages: [DECLARED_ARTIFACTS],
        declarationDigest: expect.any(String),
      }),
    });
  });

  it("refuses a type that a package the caller declares as a CONNECTOR owns", async () => {
    const h = harness();
    await expect(
      h.port.save({ type: CONNECTOR_RECORD, data: { key: "k1" } }),
    ).rejects.toThrow(CONNECTOR_RECORD);
    expect(h.objectsSave).not.toHaveBeenCalled();
  });

  it("refuses a request without a type or without a plain-object data", async () => {
    const h = harness();
    for (const request of [
      { data: { key: "k1" } },
      { type: "", data: { key: "k1" } },
      { type: RECORD },
      { type: RECORD, data: [] },
      { type: RECORD, data: "text" },
    ]) {
      await expect(h.port.save(request)).rejects.toMatchObject({
        name: "ExtensionToolRefusal",
        message: expect.stringMatching(/^extension_tool: objects\.save: /),
      });
    }
    expect(h.objectsSave).not.toHaveBeenCalled();
  });
});

describe("CASE 3 — the run is bound by the host, and its identity never rides in the data", () => {
  it("substitutes the bound run for the top-level marker and saves with the run on the actor", async () => {
    const h = harness();
    const answer = await h.port.save({ type: RECORD, data: { runId: { boundRun: true }, key: "k1" } });
    expect(answer).toEqual({ objectId: "obj-saved", type: RECORD, isNew: true });
    expect(h.objectsSave).toHaveBeenCalledTimes(1);
    const [request] = h.objectsSave.mock.calls[0]!;
    expect(request.primitiveName).toBe("objects_save");
    expect(request.mode).toBe("agentic");
    expect(request.input).toEqual({ typeHint: RECORD, rawData: { runId: RUN.id, key: "k1" } });
    expect(request.actor).toEqual({
      actorType: "human",
      userId: ACTOR.principalId,
      source: "a2a",
      orgId: ORG,
      platformRole: "member",
      runId: RUN.id,
    });
    // The handler ran inside the run's own actor frame.
    expect(h.framesSeen).toEqual([ACTOR]);
    const allowed = h.audit.mock.calls.map(([e]) => e).filter((e) => e.decision === "allowed");
    expect(allowed).toHaveLength(1);
    expect(allowed[0]).toMatchObject({ operation: "objects_save", resourceType: "object" });
  });

  const IDENTITY_KEYS = [
    "externalId",
    "external_id",
    "cinatraAgentRunId",
    ...EXTENSION_TOOL_RUN_IDENTITY_KEYS,
  ];

  for (const key of IDENTITY_KEYS) {
    it(`refuses \`${key}\` at the top level, in a nested object and in an array element`, async () => {
      const h = harness();
      for (const data of [
        { key: "k1", [key]: "x" },
        { key: "k1", inner: { deeper: { [key]: "x" } } },
        { key: "k1", list: [{ a: 1 }, { [key]: "x" }] },
        { key: "k1", inner: { list: [[{ [key]: "x" }]] } },
      ]) {
        await expect(h.port.save({ type: RECORD, data })).rejects.toThrow(`\`${key}\``);
      }
      expect(h.objectsSave).not.toHaveBeenCalled();
    });
  }

  it("refuses a run marker nested, inside an array, beside a second key or of another value", async () => {
    const h = harness();
    for (const data of [
      { key: "k1", inner: { runId: { boundRun: true } } },
      { key: "k1", list: [{ boundRun: true }] },
      { key: "k1", runId: { boundRun: true, other: 1 } },
      { key: "k1", runId: { boundRun: "true" } },
      { key: "k1", boundRun: true },
    ]) {
      await expect(h.port.save({ type: RECORD, data })).rejects.toThrow("`boundRun`");
    }
    expect(h.objectsSave).not.toHaveBeenCalled();
  });
});

describe("CASE 4 — a save whose type gives the record no identity of its own is refused", () => {
  it("refuses a type without an identity key, a key that is null, a key that throws and a type the process does not hold", async () => {
    const h = harness();
    await expect(h.port.save({ type: KEYLESS, data: { key: "k1" } })).rejects.toThrow(KEYLESS);
    await expect(h.port.save({ type: RECORD, data: { other: "no key" } })).rejects.toThrow(RECORD);
    await expect(h.port.save({ type: THROWING, data: { key: "k1" } })).rejects.toThrow(THROWING);
    await expect(h.port.save({ type: UNREGISTERED, data: { key: "k1" } })).rejects.toThrow(
      UNREGISTERED,
    );
    expect(h.objectsSave).not.toHaveBeenCalled();
  });

  it("hands the identity key exactly the data the save will see, the bound run stamped", async () => {
    const seen: Array<Record<string, unknown>> = [];
    TYPES[`${DECLARED_ARTIFACTS}:spy`] = {
      identityKey: (data) => {
        seen.push(data);
        return "spy";
      },
    };
    const claims = [...CLAIMS, claim(`${DECLARED_ARTIFACTS}:spy`, DECLARED_ARTIFACTS)];
    try {
      const h = harness();
      const port = createExtensionObjectsPort(
        { packageName: CALLER, packageVersion: PINNED, cinatra: AGENT_CINATRA, run: RUN, actor: ACTOR },
        {
          readClaims: () => claims,
          resolveType: (typeId: string) => TYPES[typeId] ?? null,
          readObject: h.readObject,
          readRun: h.readRun,
          collectHandlers: async () => ({ objects_save: h.objectsSave }),
          audit: h.audit,
        },
      );
      await port.save({ type: `${DECLARED_ARTIFACTS}:spy`, data: { runId: { boundRun: true } } });
      expect(seen).toEqual([{ runId: RUN.id, cinatraAgentRunId: RUN.id }]);
    } finally {
      delete TYPES[`${DECLARED_ARTIFACTS}:spy`];
    }
  });
});

describe("CASE 5 — a read returns one object only when the object's run is the bound run or one of its ancestors", () => {
  const REFUSAL = (id: string) => new RegExp(`^extension_tool: objects\\.read: ${id} `);

  it("returns an object of the bound run and an object of its parent run", async () => {
    const h = harness();
    await expect(h.port.read({ objectId: "obj-own" })).resolves.toEqual({
      objectId: "obj-own",
      type: RECORD,
      data: { key: "k-own" },
    });
    await expect(h.port.read({ objectId: "obj-parent" })).resolves.toEqual({
      objectId: "obj-parent",
      type: RECORD,
      data: { key: "k-parent" },
    });
    // The row is read in the run's own organisation, under the run's actor.
    expect(h.readObject).toHaveBeenCalledWith("obj-own", { orgId: ORG }, ACTOR);
  });

  it("refuses an unrelated run's object, an ancestor walk that meets another organisation, another organisation's object and an absent one with ONE sentence", async () => {
    const h = harness();
    const messages: string[] = [];
    for (const objectId of [
      "obj-unrelated",
      "obj-foreign-ancestor",
      "obj-other-org",
      "obj-no-run",
      "obj-absent",
    ]) {
      const error = await h.port.read({ objectId }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toMatchObject({ name: "ExtensionToolRefusal", message: expect.stringMatching(REFUSAL(objectId)) });
      messages.push((error as Error).message.replace(objectId, "<id>"));
    }
    expect(new Set(messages).size).toBe(1);
    const denied = h.audit.mock.calls.map(([e]) => e).filter((e) => e.decision === "denied");
    expect(denied).toHaveLength(5);
    expect(denied[0]).toMatchObject({
      operation: "objects_read",
      resourceType: "object",
      metadata: expect.objectContaining({ extension: CALLER, extensionVersion: PINNED }),
    });
  });

  it("refuses a row over the cap", async () => {
    const h = harness();
    await expect(h.port.read({ objectId: "obj-large" })).rejects.toThrow(
      String(EXTENSION_ARTIFACT_CONTENT_MAX_BYTES),
    );
  });

  it("ends a looping ancestor walk and a walk past its bound refused", async () => {
    const looping: Record<string, FixtureRun> = {
      [RUN.id]: { id: RUN.id, orgId: ORG, parentRunId: "run-loop-a" },
      "run-loop-a": { id: "run-loop-a", orgId: ORG, parentRunId: "run-loop-b" },
      "run-loop-b": { id: "run-loop-b", orgId: ORG, parentRunId: "run-loop-a" },
    };
    const loop = harness({
      runs: looping,
      rows: [{ id: "obj-far", type: RECORD, data: {}, runId: "run-never", orgId: ORG }],
    });
    await expect(loop.port.read({ objectId: "obj-far" })).rejects.toThrow(REFUSAL("obj-far"));
    expect(loop.readRun.mock.calls.length).toBeLessThan(10);

    const chain: Record<string, FixtureRun> = {
      [RUN.id]: { id: RUN.id, orgId: ORG, parentRunId: "run-up-1" },
    };
    for (let i = 1; i <= 20; i++) {
      chain[`run-up-${i}`] = { id: `run-up-${i}`, orgId: ORG, parentRunId: `run-up-${i + 1}` };
    }
    const rows = [
      { id: "obj-near", type: RECORD, data: {}, runId: "run-up-16", orgId: ORG },
      { id: "obj-beyond", type: RECORD, data: {}, runId: "run-up-17", orgId: ORG },
    ];
    const deep = harness({ runs: chain, rows });
    await expect(deep.port.read({ objectId: "obj-near" })).resolves.toMatchObject({ objectId: "obj-near" });
    await expect(deep.port.read({ objectId: "obj-beyond" })).rejects.toThrow(REFUSAL("obj-beyond"));
  });

  it("refuses a request without an object id", async () => {
    const h = harness();
    for (const request of [{}, { objectId: "" }, { objectId: 7 }]) {
      await expect(h.port.read(request)).rejects.toThrow(/^extension_tool: objects\.read: /);
    }
    expect(h.readObject).not.toHaveBeenCalled();
  });
});

describe("the caller — a caller whose manifest does not declare the agent kind is refused", () => {
  it("refuses both calls for a caller of another kind, and without the run's actor context", async () => {
    for (const h of [
      harness({ cinatra: { ...AGENT_CINATRA, kind: "connector" } }),
      harness({ cinatra: { ...AGENT_CINATRA, kind: undefined } }),
      harness({ actor: null }),
    ]) {
      await expect(h.port.read({ objectId: "obj-own" })).rejects.toThrow(/^extension_tool: objects\.read: /);
      await expect(h.port.save({ type: RECORD, data: { key: "k1" } })).rejects.toThrow(
        /^extension_tool: objects\.save: /,
      );
      expect(h.readObject).not.toHaveBeenCalled();
      expect(h.objectsSave).not.toHaveBeenCalled();
      expect(h.audit).toHaveBeenCalledTimes(2);
    }
  });
});

describe("CASE 7 — a save goes through the same objects save handler the passthrough's generic branch calls", () => {
  it("lets the handler's activation gate refuse the save, with the SAME error", async () => {
    const refusal = new InvalidActivatedTypePayloadError(RECORD);
    const h = harness({
      handler: () => {
        throw refusal;
      },
    });
    await expect(h.port.save({ type: RECORD, data: { key: "k1" } })).rejects.toBe(refusal);
    expect(h.objectsSave).toHaveBeenCalledTimes(1);
  });
});

describe("the request is read once as plain data — the run's identity never rides in the data", () => {
  const SAVE_REFUSAL = /^extension_tool: objects\.save: /;

  class Smuggler {
    toJSON() {
      return { externalId: "smuggled", cinatraAgentRunId: "run-fixture-unrelated" };
    }
  }

  it("refuses a nested value that would serialize to host-set keys, or that reads differently a second time", async () => {
    const h = harness();
    let reads = 0;
    const shifting = {
      get deep() {
        reads += 1;
        return reads > 1 ? { externalId: "smuggled" } : {};
      },
    };
    for (const data of [
      { key: "k1", inner: new Smuggler() },
      { key: "k1", inner: { toJSON: () => ({ cinatraAgentRunId: "run-fixture-unrelated" }) } },
      { key: "k1", inner: shifting },
      { key: "k1", list: [new Date(0)] },
    ]) {
      await expect(h.port.save({ type: RECORD, data })).rejects.toMatchObject({
        name: "ExtensionToolRefusal",
        message: expect.stringMatching(SAVE_REFUSAL),
      });
    }
    expect(h.objectsSave).not.toHaveBeenCalled();
  });

  it("refuses a marker whose `boundRun` is inherited, and cyclic data", async () => {
    const h = harness();
    const inherited = Object.assign(Object.create({ boundRun: true }) as object, { unrelated: 1 });
    const cyclic: Record<string, unknown> = { key: "k1" };
    cyclic.self = cyclic;
    for (const data of [{ key: "k1", runId: inherited }, cyclic]) {
      await expect(h.port.save({ type: RECORD, data })).rejects.toMatchObject({
        name: "ExtensionToolRefusal",
        message: expect.stringMatching(SAVE_REFUSAL),
      });
    }
    expect(h.objectsSave).not.toHaveBeenCalled();
  });

  it("refuses a nested value that throws when read, as a refusal of the port", async () => {
    const h = harness();
    const throwing = {
      get deep(): unknown {
        throw new Error("fixture read failure");
      },
    };
    await expect(
      h.port.save({ type: RECORD, data: { key: "k1", inner: throwing } }),
    ).rejects.toMatchObject({ name: "ExtensionToolRefusal", message: expect.stringMatching(SAVE_REFUSAL) });
    expect(h.objectsSave).not.toHaveBeenCalled();
  });

  it("saves plain data of a null prototype, nested arrays and scalars unchanged", async () => {
    const h = harness();
    const data = Object.assign(Object.create(null) as Record<string, unknown>, {
      key: "k1",
      runId: { boundRun: true },
      nested: { list: [1, "two", true, null, { deep: [3] }] },
    });
    await h.port.save({ type: RECORD, data });
    expect(h.objectsSave).toHaveBeenCalledTimes(1);
    const [request] = h.objectsSave.mock.calls[0]!;
    expect(request.input.rawData).toEqual({
      key: "k1",
      runId: RUN.id,
      nested: { list: [1, "two", true, null, { deep: [3] }] },
    });
  });

  it("refuses a request that is no plain object, with one denied audit row per call", async () => {
    const h = harness();
    // The port's methods take a request; a module's code may hand it anything.
    const loose: { read(request: unknown): Promise<unknown>; save(request: unknown): Promise<unknown> } =
      h.port;
    await expect(loose.read(null)).rejects.toMatchObject({
      name: "ExtensionToolRefusal",
      message: expect.stringMatching(/^extension_tool: objects\.read: /),
    });
    await expect(loose.save(null)).rejects.toMatchObject({
      name: "ExtensionToolRefusal",
      message: expect.stringMatching(SAVE_REFUSAL),
    });
    expect(h.audit).toHaveBeenCalledTimes(2);
    expect(h.readObject).not.toHaveBeenCalled();
    expect(h.objectsSave).not.toHaveBeenCalled();
  });

  it("names the admission on every refused save, whatever refused it", async () => {
    for (const [h, request] of [
      [harness(), { type: RECORD, data: [] }],
      [harness(), { data: { key: "k1" } }],
      [harness({ cinatra: { ...AGENT_CINATRA, kind: "connector" } }), { type: RECORD, data: { key: "k1" } }],
      [harness({ actor: null }), { type: RECORD, data: { key: "k1" } }],
    ] as const) {
      await expect(h.port.save(request)).rejects.toThrow(SAVE_REFUSAL);
      expect(h.audit).toHaveBeenCalledTimes(1);
      expect(h.audit.mock.calls[0]![0]).toMatchObject({
        operation: "objects_save",
        decision: "denied",
        metadata: expect.objectContaining({
          extension: CALLER,
          extensionVersion: PINNED,
          admittedPackages: [DECLARED_ARTIFACTS],
          declarationDigest: expect.any(String),
        }),
      });
    }
  });
});
