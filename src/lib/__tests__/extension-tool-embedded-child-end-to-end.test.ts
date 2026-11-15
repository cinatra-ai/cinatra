/**
 * AN EMBEDDED CHILD STEP RUNS THE CHILD'S OWN MODULE, END TO END (cinatra#4154,
 * acceptance 1).
 *
 * The other suites of this road pin one part each and stub the rest: the
 * origin resolver is driven with injected reads (extension-tool-origin.test.ts),
 * and the scoped dispatch is driven with the resolver and the module loader
 * stubbed (extension-scoped-tools-embedded-child.test.ts,
 * extension-scoped-tools-dispatch-audit.test.ts). Here none of them is
 * stubbed: the scoped dispatch, the origin resolver, the install binding, the
 * root resolver of the module loader, the loader's re-check and the import
 * seam are the real ones, in one call.
 *
 * A parent and a child installation are written to a temporary directory as
 * the store lays them out: each one's package.json and flow document, and the
 * child's declared tool module. Only the stores are substituted: the canonical
 * install rows, the trusted install anchors, the store discovery, the run's
 * template row and manifest, the database client, the claim registry, the
 * object type the child saves, the host's objects save and the audit sink. No
 * database is reached.
 *
 * The child's module is a real file. It counts its own runs and reports the
 * file it was loaded from, and it calls two ports: one data write and one
 * objects save. The test reads that the module ran from the exact child
 * installation's root, that the write reached the child's own table under the
 * child's own role, that the save is of a type the child declares and is
 * bound to this run, and that every audit event of the call names the run
 * package, the package whose code ran, the exact child installation and the
 * verified step.
 *
 *   pnpm exec vitest run src/lib/__tests__/extension-tool-embedded-child-end-to-end.test.ts
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { declaredTablePhysicalName, extensionDatabaseRoleName } from "@cinatra-ai/sdk-extensions/manifest";

import { POLICY_VERSION, type ActorContext } from "@/lib/authz/actor-context";

const ORG = "org-fixture";
const PARENT = "@fixture-scope/fixture-parent-agent";
const CHILD = "@fixture-scope/fixture-child-agent";
const RECORDS = "@fixture-scope/fixture-record-artifact";
const RECORD_TYPE = `${RECORDS}:record`;
const PARENT_ID = "install-parent";
const CHILD_ID = "install-child";
const PARENT_VERSION = "2.0.0";
const CHILD_VERSION = "0.1.1";
const PARENT_DIGEST = "a".repeat(64);
const CHILD_DIGEST = "c".repeat(64);
const TOOL = "child_tool";
const STEP = "child-embed_step";
const CHILD_MODULE = "./cinatra/tools/child-tool.mjs";
/** The global the child's module counts its runs in. */
const RUN_COUNTER = "__cinatra4154ChildToolRuns";

/**
 * The child's tool module: a CONSTANT text, never built from a value (a module
 * text built by interpolation is the shape js/bad-code-sanitization names). It
 * counts its runs in RUN_COUNTER, reports the file it was loaded from, and
 * calls the two ports the test reads, saving a RECORD_TYPE record.
 */
const CHILD_TOOL_SOURCE = `export async function extensionTool({ input, ports }) {
  globalThis.__cinatra4154ChildToolRuns = (globalThis.__cinatra4154ChildToolRuns ?? 0) + 1;
  const row = await ports.data.insertIfAbsent({
    table: "child_rows",
    row: { id: input.rowId },
    conflictKeys: ["id"],
  });
  const saved = await ports.objects.save({
    type: "@fixture-scope/fixture-record-artifact:record",
    data: { ref: input.rowId, sourceRun: { boundRun: true } },
  });
  return { ranFrom: import.meta.url, row, saved };
}
`;

/** The parent's own tool module: never the one a child step may run. */
const PARENT_TOOL_SOURCE = `export async function extensionTool() {
  return { ran: "parent" };
}
`;

type Doc = Record<string, unknown>;

/** The node the child authored in its own flow, without its id. */
function childNodeBody(): Doc {
  return {
    component_type: "ApiNode",
    name: "Embedded step",
    url: "{{CINATRA_BASE_URL}}/api/agents/passthrough",
    http_method: "POST",
    data: {
      tool: "extension_tool",
      input: { name: TOOL, input: { rowId: "{{ row_id }}" } },
      agent_run_id: "{{ agent_run_id }}",
    },
    inputs: [{ title: "agent_run_id", type: "string", default: "" }],
  };
}

const CHILD_FLOW: Doc = {
  component_type: "Flow",
  id: "child-root",
  nodes: [{ $component_ref: "embed_step" }],
  $referenced_components: { embed_step: { ...childNodeBody(), id: "embed_step" } },
};

const PARENT_FLOW: Doc = {
  component_type: "Flow",
  id: "parent-root",
  nodes: [{ $component_ref: "own_step" }, { $component_ref: "child_flow" }],
  $referenced_components: {
    own_step: {
      component_type: "ApiNode",
      id: "own_step",
      data: { tool: "extension_tool", input: { name: "parent_tool" } },
    },
    child_flow: {
      component_type: "FlowNode",
      id: "child_flow",
      subflow: { $component_ref: "child-subflow" },
      metadata: { cinatra: { packageName: CHILD } },
    },
    "child-subflow": {
      component_type: "Flow",
      id: "child-subflow",
      nodes: [{ $component_ref: STEP }],
      $referenced_components: { [STEP]: { ...childNodeBody(), id: STEP } },
    },
  },
};

const CHILD_DEPENDENCY = {
  packageName: CHILD,
  kind: "agent",
  edgeType: "runtime",
  requirement: "required",
  versionConstraint: { kind: "semver-range", range: "^0.1.0" },
};

const PARENT_CINATRA: Doc = {
  kind: "agent",
  dependencies: [CHILD_DEPENDENCY],
  tools: [{ name: "parent_tool", module: "./cinatra/tools/parent-tool.mjs" }],
};

function childCinatra(embeddable: boolean): Doc {
  return {
    kind: "agent",
    dependencies: [
      { packageName: RECORDS, kind: "artifact", versionConstraint: { kind: "semver-range", range: "^1.0.0" } },
    ],
    tools: [{ name: TOOL, module: CHILD_MODULE, ...(embeddable ? { embeddable: true } : {}) }],
    declaredTables: [
      {
        name: "child_rows",
        organizationColumn: "org_id",
        columns: [
          { name: "id", type: "text", notNull: true, primaryKey: true },
          { name: "org_id", type: "text", notNull: true },
        ],
      },
    ],
  };
}

const RUN = {
  id: "run-fixture",
  orgId: ORG,
  runBy: "user-fixture",
  templateId: "tmpl-fixture",
  packageVersion: PARENT_VERSION,
  dependentInstallId: PARENT_ID,
  verifiedStepId: STEP,
};

/** The four fields every audit event of this call carries. */
const CHILD_ROAD = {
  runPackage: PARENT,
  codePackage: CHILD,
  codeInstallId: CHILD_ID,
  verifiedStepId: STEP,
};

// ---- the substituted stores, read through one mutable world ----

type StoreRecord = { packageName: string; kind: string; storeDir: string; declaredDigest: string };
type Anchor = { installId: string; version: string; digest: string; kind: string; isDefault: boolean };

const world = {
  rows: {} as Record<string, Doc>,
  anchors: {} as Record<string, Anchor[]>,
  records: [] as StoreRecord[],
  childModuleFile: "",
};

const query = vi.fn();
const getAgentPackage = vi.fn();
const logAuditEvent = vi.fn();
const objectsSave = vi.fn();

vi.mock("@/lib/db/pooled", async () => ({
  ...(await vi.importActual<typeof import("@/lib/db/pooled")>("@/lib/db/pooled")),
  getPooledDb: () => ({
    query: (...a: unknown[]) => query(...a),
    connect: async () => ({ query: (...a: unknown[]) => query(...a), release: () => {} }),
  }),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://unused",
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
vi.mock("@cinatra-ai/registries", () => ({
  getAgentPackage: (...a: unknown[]) => getAgentPackage(...a),
}));
vi.mock("@cinatra-ai/agents/installed-oas-path", () => ({
  probeInstalledOasPathForRead: () => ({ path: null }),
}));
vi.mock("@/lib/verdaccio-config", () => ({ loadVerdaccioConfigForReads: async () => ({}) }));
vi.mock("@/lib/authz/audit", () => ({
  logAuditEvent: (...a: unknown[]) => logAuditEvent(...a),
}));
// The canonical install rows the binding reads by id.
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionById: async (id: string) => world.rows[id] ?? null,
  readInstalledExtensionsByPackageName: async (name: string) =>
    Object.values(world.rows).filter((r) => r.packageName === name),
}));
// The trusted install anchors, per package, as the run's organisation reads them.
vi.mock("@/lib/extension-install-anchor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/extension-install-anchor")>()),
  makeDefaultInstallAnchorsResolver: async () => async (packageName: string) => world.anchors[packageName] ?? [],
}));
// The store's discovered records: the digest directories written below.
vi.mock("@/lib/extension-store-io", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/extension-store-io")>()),
  discoverStoreRecordsV2: async () => world.records,
}));
// The claim registry: the record artifact package owns the type the child saves.
vi.mock("@/lib/objects/artifact-claim-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/objects/artifact-claim-store")>()),
  readArtifactTypeClaimsForOrg: () => [
    {
      id: "claim-records",
      scope: "platform",
      objectTypeId: RECORD_TYPE,
      claimKind: "dedicated",
      status: "active",
      extensionPackage: RECORDS,
      extensionVersion: "1.0.0",
      generation: 1,
    },
  ],
}));
// The object type the child saves, as this process would hold it.
vi.mock("@cinatra-ai/objects/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cinatra-ai/objects/registry")>();
  const recordType = {
    identityKey: (data: Record<string, unknown>) => (typeof data.ref === "string" ? `record:${data.ref}` : null),
  };
  return {
    ...actual,
    objectTypeRegistry: Object.create(actual.objectTypeRegistry, {
      resolve: {
        value: (typeId: string) => (typeId === RECORD_TYPE ? recordType : actual.objectTypeRegistry.resolve(typeId)),
      },
    }),
  };
});
// The host's own objects save.
vi.mock("@/lib/primitive-handlers", () => ({
  collectAllPrimitiveHandlers: async () => ({ objects_save: (...a: unknown[]) => objectsSave(...a) }),
}));

const ACTOR: ActorContext = {
  principalType: "HumanUser",
  principalId: "user-fixture",
  organizationId: ORG,
  platformRole: "member",
  authSource: "a2a",
  policyVersion: POLICY_VERSION,
};

let baseDir = "";
let priorDataRoot: string | undefined;

beforeAll(async () => {
  // The data root is read from the environment, never from the database; the
  // records it would hold are the discovered ones above.
  priorDataRoot = process.env.CINATRA_EXTENSION_DATA_ROOT;
  baseDir = await realpath(await mkdtemp(path.join(tmpdir(), "cinatra-4154-e2e-")));
  process.env.CINATRA_EXTENSION_DATA_ROOT = baseDir;
});

afterAll(async () => {
  if (priorDataRoot === undefined) delete process.env.CINATRA_EXTENSION_DATA_ROOT;
  else process.env.CINATRA_EXTENSION_DATA_ROOT = priorDataRoot;
  await rm(baseDir, { recursive: true, force: true }).catch(() => undefined);
});

/** Write one installation's digest directory and return its root. */
async function writeInstall(
  name: string,
  digest: string,
  manifest: Doc,
  flow: Doc,
  modules: Record<string, string>,
): Promise<string> {
  const root = path.join(baseDir, "agent", ...name.split("/"), digest);
  await mkdir(path.join(root, "cinatra", "tools"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
  await writeFile(path.join(root, "cinatra", "oas.json"), JSON.stringify(flow));
  for (const [rel, source] of Object.entries(modules)) await writeFile(path.join(root, rel), source);
  return root;
}

/** The parent and the child installed in the run's organisation; the child's tool embeddable or not. */
async function install(opts: { embeddable: boolean }): Promise<void> {
  await rm(path.join(baseDir, "agent"), { recursive: true, force: true });
  const parentRoot = await writeInstall(
    PARENT,
    PARENT_DIGEST,
    { name: PARENT, version: PARENT_VERSION, cinatra: PARENT_CINATRA },
    PARENT_FLOW,
    { "cinatra/tools/parent-tool.mjs": PARENT_TOOL_SOURCE },
  );
  const childRoot = await writeInstall(
    CHILD,
    CHILD_DIGEST,
    { name: CHILD, version: CHILD_VERSION, cinatra: childCinatra(opts.embeddable) },
    CHILD_FLOW,
    { "cinatra/tools/child-tool.mjs": CHILD_TOOL_SOURCE },
  );
  world.childModuleFile = path.join(childRoot, "cinatra", "tools", "child-tool.mjs");
  world.records = [
    { packageName: PARENT, kind: "agent", storeDir: parentRoot, declaredDigest: PARENT_DIGEST },
    { packageName: CHILD, kind: "agent", storeDir: childRoot, declaredDigest: CHILD_DIGEST },
  ];
  world.anchors = {
    [PARENT]: [{ installId: PARENT_ID, version: PARENT_VERSION, digest: PARENT_DIGEST, kind: "agent", isDefault: true }],
    [CHILD]: [{ installId: CHILD_ID, version: CHILD_VERSION, digest: CHILD_DIGEST, kind: "agent", isDefault: true }],
  };
  world.rows = {
    [PARENT_ID]: {
      id: PARENT_ID,
      packageName: PARENT,
      version: PARENT_VERSION,
      status: "active",
      kind: "agent",
      organizationId: ORG,
      isDefault: true,
      dependencies: [],
      dependencyEdges: [{ ...CHILD_DEPENDENCY, resolvedInstallId: CHILD_ID, resolutionReason: "scoped:org" }],
    },
    [CHILD_ID]: {
      id: CHILD_ID,
      packageName: CHILD,
      version: CHILD_VERSION,
      status: "active",
      kind: "agent",
      organizationId: ORG,
      isDefault: true,
      dependencies: [],
      dependencyEdges: [],
    },
  };
}

/** The statement text of every database call, in order. */
function statements(): string[] {
  return query.mock.calls.map((c) => String(c[0]));
}

type Event = Record<string, unknown> & { metadata: Record<string, unknown> };

function eventsOf(operation: string): Event[] {
  return logAuditEvent.mock.calls.map((c) => c[0] as Event).filter((e) => e.operation === operation);
}

function childRuns(): number {
  return ((globalThis as Record<string, unknown>)[RUN_COUNTER] as number | undefined) ?? 0;
}

async function callChildTool() {
  const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
  return dispatchExtensionScopedTool({
    tool: "extension_tool",
    input: { name: TOOL, input: { rowId: "row-1" } },
    run: RUN,
    actor: ACTOR,
  });
}

describe("an embedded child step's extension_tool call, through the real resolver, dispatch and loader", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[RUN_COUNTER];
    query.mockReset().mockImplementation(async (text: string) => {
      if (text.includes("agent_templates")) {
        return { rows: [{ package_name: PARENT, package_version: PARENT_VERSION }], rowCount: 1 };
      }
      if (text.startsWith("WITH")) {
        return { rows: [{ __inserted: true, id: "row-1", org_id: ORG }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    getAgentPackage.mockReset().mockResolvedValue({ manifest: { cinatra: PARENT_CINATRA } });
    logAuditEvent.mockReset().mockResolvedValue(undefined);
    objectsSave.mockReset().mockResolvedValue({ objectId: "object-1", type: RECORD_TYPE, isNew: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the child's own module from the exact child installation, and its ports act as the child", async () => {
    await install({ embeddable: true });
    const outcome = await callChildTool();

    // The child's module ran, once, from the bound child installation's root.
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const result = outcome.result as { ranFrom: string; row: unknown; saved: unknown };
    expect(childRuns()).toBe(1);
    expect(fileURLToPath(result.ranFrom)).toBe(await realpath(world.childModuleFile));
    expect(result.row).toEqual({ inserted: true, row: { id: "row-1", org_id: ORG } });
    expect(result.saved).toEqual({ objectId: "object-1", type: RECORD_TYPE, isNew: true });

    // The data write reached the child's own table, under the child's own role, in the run's organisation.
    const childTable = declaredTablePhysicalName(CHILD, "child_rows");
    const insert = query.mock.calls.find((c) => String(c[0]).startsWith("WITH"));
    expect(insert).toBeDefined();
    expect(String(insert![0])).toContain(`"cinatra"."${childTable}"`);
    expect(insert![1]).toEqual(expect.arrayContaining([ORG, "row-1"]));
    expect(statements()).toContain(`SET LOCAL ROLE "${extensionDatabaseRoleName(CHILD)}"`);
    expect(statements().some((s) => s.includes(declaredTablePhysicalName(PARENT, "child_rows")))).toBe(false);

    // The save is of a type the child declares, through the host's objects save, bound to this run.
    expect(objectsSave).toHaveBeenCalledTimes(1);
    const save = objectsSave.mock.calls[0]![0] as {
      primitiveName: string;
      input: { typeHint: string; rawData: Record<string, unknown> };
      actor: Record<string, unknown>;
    };
    expect(save.primitiveName).toBe("objects_save");
    expect(save.input).toEqual({ typeHint: RECORD_TYPE, rawData: { ref: "row-1", sourceRun: RUN.id } });
    expect(save.actor).toMatchObject({ orgId: ORG, runId: RUN.id });

    // Every audit event of the call names whose code ran for which run.
    const [write] = eventsOf("extension_data.insertIfAbsent");
    expect(write).toMatchObject({
      organizationId: ORG,
      runId: RUN.id,
      decision: "allowed",
      resourceId: childTable,
      metadata: { extension: CHILD, table: childTable, ...CHILD_ROAD },
    });
    const [saved] = eventsOf("objects_save");
    expect(saved).toMatchObject({
      organizationId: ORG,
      runId: RUN.id,
      decision: "allowed",
      resourceId: RECORD_TYPE,
      metadata: { extension: CHILD, extensionVersion: CHILD_VERSION, ...CHILD_ROAD },
    });
    const dispatch = eventsOf("extension_tool.dispatch");
    expect(dispatch).toHaveLength(1);
    expect(dispatch[0]).toMatchObject({
      organizationId: ORG,
      runId: RUN.id,
      resourceId: CHILD,
      decision: "allowed",
      metadata: CHILD_ROAD,
    });
  });

  it("refuses a child tool the child does not mark embeddable, and runs nothing of it", async () => {
    await install({ embeddable: false });
    const outcome = await callChildTool();

    expect(outcome).toEqual({
      ok: false,
      status: 403,
      error: "extension_tool: the calling step reaches no tool of this origin (not-embeddable)",
    });
    expect(childRuns()).toBe(0);
    expect(statements().some((s) => s.startsWith("WITH") || s.startsWith("SET LOCAL ROLE"))).toBe(false);
    expect(objectsSave).not.toHaveBeenCalled();
    expect(eventsOf("extension_data.insertIfAbsent")).toHaveLength(0);
    expect(eventsOf("objects_save")).toHaveLength(0);
    const dispatch = eventsOf("extension_tool.dispatch");
    expect(dispatch).toHaveLength(1);
    expect(dispatch[0]).toMatchObject({
      decision: "denied",
      metadata: {
        runPackage: PARENT,
        codePackage: null,
        codeInstallId: null,
        verifiedStepId: STEP,
        reason: "refused",
        originCode: "not-embeddable",
      },
    });
  });
});
