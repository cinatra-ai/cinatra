import { describe, expect, it, vi } from "vitest";
import type { ActorContext } from "@/lib/authz/actor-context";
import {
  invokeConnectorInstanceTool,
  listConnectorInstanceTools,
  type ConnectorInstanceInvokerDeps,
  type EnrolledServerRef,
  type InvokeConnectorInstanceToolInput,
  type InvokerTrustedActor,
  type RequireInstanceUseGate,
} from "@/lib/connector-instance-invoker";
import { InvokerError, TRIAD_EXECUTE_ABILITY } from "@/lib/connector-instance-mcp-transport";
import {
  CATALOG_DEFAULT_SERVER_ID,
  createInMemoryConnectorInstanceCatalogCache,
  type CatalogServerSnapshot,
} from "@/lib/connector-instance-catalog-cache";
import type { InstanceToolPolicyRecord } from "@cinatra-ai/mcp-server/instance-tool-policy";

// cinatra#2024 (S9 program acceptance) — item A / design §3 / D2: the
// program-acceptance proof PR #2189 (S4/#2019's scale-smoke fixture) itself
// deferred — "real provider round-trips deferred to program acceptance."
//
// #2189's own matrix (connector-instance-native-read-injection-scale-matrix.
// test.ts) only proves the M2 native-injection BUILDER path
// (createWordPressNativeReadInjectionMembers / materializeExternalMcpServers).
// It never calls invokeConnectorInstanceTool / listConnectorInstanceTools —
// the M1 GOVERNED-INVOKER functions the model-visible primitives
// (wordpress_site_tool_call / wordpress_site_tools_list) actually dispatch
// to. This file closes that gap: it imports and calls those two exported
// functions DIRECTLY (never a wrapper) against a synthetic 3-instance x
// 3-server x 64-tool fixture shaped after the real scale-smoke-plugin
// (docker/wordpress/scale-smoke-plugin — `scalesmoke/note-get-001..064`),
// proving the same class of invariant #2189 proved for M2, but for the REAL
// dispatch/routing path the epic's own primitives use:
//   1. no truncation across a paginated `listConnectorInstanceTools` catalog
//      read of a 64-tool server (cursor/pagination correctness at scale);
//   2. per-instance isolation across 3 instances x 3 enrolled servers each
//      (>= 9 server entries) — no cross-instance leakage in the gate/acquire
//      ledger, and a per-instance duplicate tool name never bleeds into a
//      sibling instance's unambiguous resolution;
//   3. no misrouting / zero batch loss under 9 CONCURRENT
//      invokeConnectorInstanceTool calls spanning the full 3x3 matrix — every
//      call resolves to its own pinned instance + server, never a neighbor's.
//
// Fully SYNTHETIC and deterministic (no live stack, no network) — the real
// wire round-trip against the actual booted fixture is the sibling live file
// (connector-instance-invoker-live-scale-smoke.test.ts).

const READ_TOOL_COUNT = 64;
const READ_TOOL_NAMES: string[] = Array.from({ length: READ_TOOL_COUNT }, (_, i) =>
  `scalesmoke/note-get-${String(i + 1).padStart(3, "0")}`,
);
const DEFAULT_TOOL_NAME = "core/get-site-info";
const NOW = 1_753_800_000_000;

type InstanceSpec = {
  instanceId: string;
  orgId: string;
  scaleServerId: string;
  otherServerId: string;
  vendorToolName: string;
  /** instance-b only: also files READ_TOOL_NAMES[0] onto the OTHER server, so
   * a name-only call is ambiguous FOR THAT INSTANCE ONLY (§3.6's real
   * ambiguous_tool mechanism) — proving isolation via the real invoker
   * behavior, not a synthetic ejection rule. */
  duplicateOntoOtherServer?: boolean;
};

const INSTANCES: InstanceSpec[] = [
  {
    instanceId: "instance-a",
    orgId: "org-a",
    scaleServerId: "wps-aaaa-scale00000001",
    otherServerId: "wps-aaaa-other0000001",
    vendorToolName: "vendor/instance-a-widget",
  },
  {
    instanceId: "instance-b",
    orgId: "org-b",
    scaleServerId: "wps-bbbb-scale00000001",
    otherServerId: "wps-bbbb-other0000001",
    vendorToolName: "vendor/instance-b-widget",
    duplicateOntoOtherServer: true,
  },
  {
    instanceId: "instance-c",
    orgId: "org-c",
    scaleServerId: "wps-cccc-scale00000001",
    otherServerId: "wps-cccc-other0000001",
    vendorToolName: "vendor/instance-c-widget",
  },
];

function defaultEndpoint(instanceId: string): string {
  return `https://${instanceId}.example.com/wp-json/mcp/mcp-adapter-default-server`;
}
function scaleEndpoint(instanceId: string): string {
  return `https://${instanceId}.example.com/wp-json/scalesmoke/scalesmoke-server`;
}
function otherEndpoint(instanceId: string): string {
  return `https://${instanceId}.example.com/wp-json/vendor/${instanceId}-other`;
}
function authFor(instanceId: string): string {
  return `Basic ${Buffer.from(`admin:${instanceId}-app-password`).toString("base64")}`;
}
/** Recover the instanceId embedded in one of the endpoint helpers above — the
 * concurrency test's cross-attribution check reads this back out of the
 * wire-call target, exactly the way a real routing bug would surface (a
 * response arriving against the WRONG endpoint). */
function instanceIdFromEndpoint(endpoint: string): string {
  const match = /^https:\/\/([^.]+)\.example\.com\//.exec(endpoint);
  if (!match) throw new Error(`unrecognized synthetic endpoint: ${endpoint}`);
  return match[1]!;
}

function snapshot(
  serverId: string,
  tools: string[],
  exposureMode: "triad-only" | "first-class",
): CatalogServerSnapshot {
  return {
    serverId,
    exposureMode,
    tools: tools.map((name) => ({
      name,
      serverId,
      inputSchema: {},
      outputSchema: {
        type: "object",
        properties: { id: { type: "integer" }, note: { type: "string" } },
        required: ["id", "note"],
      },
      rawAnnotations: { readOnlyHint: true, destructiveHint: false },
    })),
    catalogRevision: `rev-${serverId}`,
    fetchedAtMs: NOW,
  };
}

type WireEcho = { echoInstanceId: string; echoEndpoint: string; echoToolName: string };

function makeDeps() {
  const cache = createInMemoryConnectorInstanceCatalogCache();
  const byInstance = new Map(INSTANCES.map((i) => [i.instanceId, i]));
  const byOrg = new Map(INSTANCES.map((i) => [i.orgId, i]));

  const requireUseCalls: Array<{ instanceId: string; orgId: string }> = [];
  const requireUse: RequireInstanceUseGate = vi.fn(async (actor, input) => {
    requireUseCalls.push({ instanceId: input.instanceId, orgId: actor.orgId });
    // Fake per-instance USE authority (mirrors the real gate's org scoping):
    // an actor may only USE the instance its own org resolves to. A
    // cross-instance call would throw here exactly like the real gate denies
    // it — proving no cross-instance bleed even before we inspect the ledger.
    const expected = byOrg.get(actor.orgId);
    if (!expected || expected.instanceId !== input.instanceId) {
      throw new Error(
        `cross-instance USE attempt: actor for org ${actor.orgId} tried to use instance ${input.instanceId}`,
      );
    }
  });

  const listEnrolledServers = vi.fn(
    async (_connectorKey: string, instanceId: string): Promise<EnrolledServerRef[]> => {
      const spec = byInstance.get(instanceId);
      if (!spec) throw new Error(`unexpected instanceId in listEnrolledServers: ${instanceId}`);
      return [
        { serverId: CATALOG_DEFAULT_SERVER_ID, exposureMode: "triad-only", restPath: "mcp/mcp-adapter-default-server" },
        { serverId: spec.scaleServerId, exposureMode: "first-class", restPath: "scalesmoke/scalesmoke-server" },
        { serverId: spec.otherServerId, exposureMode: "first-class", restPath: `vendor/${instanceId}-other` },
      ];
    },
  );

  const resolveInstanceEndpoint = vi.fn(
    async (
      _ck: string,
      instanceId: string,
      serverId?: string,
    ): Promise<{ endpoint: string; authHeader: string } | null> => {
      const spec = byInstance.get(instanceId);
      if (!spec) return null;
      const authHeader = authFor(instanceId);
      if (!serverId || serverId === CATALOG_DEFAULT_SERVER_ID) {
        return { endpoint: defaultEndpoint(instanceId), authHeader };
      }
      if (serverId === spec.scaleServerId) return { endpoint: scaleEndpoint(instanceId), authHeader };
      if (serverId === spec.otherServerId) return { endpoint: otherEndpoint(instanceId), authHeader };
      return null;
    },
  );

  const loadSnapshotCalls: Array<{ instanceId: string; serverId: string }> = [];
  const loadServerSnapshot = vi.fn(
    async (input: {
      connectorKey: string;
      instanceId: string;
      serverId: string;
      endpoint: string;
      authHeader: string;
    }): Promise<CatalogServerSnapshot> => {
      loadSnapshotCalls.push({ instanceId: input.instanceId, serverId: input.serverId });
      const spec = byInstance.get(input.instanceId);
      if (!spec) throw new Error(`unexpected instanceId in loadServerSnapshot: ${input.instanceId}`);
      if (input.serverId === CATALOG_DEFAULT_SERVER_ID) {
        return snapshot(CATALOG_DEFAULT_SERVER_ID, [DEFAULT_TOOL_NAME], "triad-only");
      }
      if (input.serverId === spec.scaleServerId) {
        return snapshot(spec.scaleServerId, READ_TOOL_NAMES, "first-class");
      }
      if (input.serverId === spec.otherServerId) {
        const tools = [spec.vendorToolName];
        if (spec.duplicateOntoOtherServer) tools.push(READ_TOOL_NAMES[0]!);
        return snapshot(spec.otherServerId, tools, "first-class");
      }
      throw new Error(`unexpected serverId in loadServerSnapshot: ${input.serverId}`);
    },
  );

  const wireCalls: Array<{ endpoint: string; name: string; arguments: Record<string, unknown> }> = [];
  const callWireTool = vi.fn<
    (input: {
      endpoint: string;
      authHeader: string;
      name: string;
      arguments: Record<string, unknown>;
    }) => Promise<WireEcho>
  >(async (input) => {
    wireCalls.push({ endpoint: input.endpoint, name: input.name, arguments: input.arguments });
    const toolName =
      input.name === TRIAD_EXECUTE_ABILITY ? (input.arguments.ability_name as string) : input.name;
    return {
      echoInstanceId: instanceIdFromEndpoint(input.endpoint),
      echoEndpoint: input.endpoint,
      echoToolName: toolName,
    };
  });

  const readPolicy = vi.fn(
    async (connectorKey: string, instanceId: string): Promise<InstanceToolPolicyRecord | null> => ({
      connectorKey,
      instanceId,
      mode: "open",
      updatedBy: "harness",
      updatedAt: "2026-07-30T00:00:00.000Z",
    }),
  );

  const audit = vi.fn(async () => {});

  const deps: ConnectorInstanceInvokerDeps = {
    requireUse,
    ensureDefaultOpenPolicy: vi.fn(async () => ({ created: false })),
    resolveInstanceEndpoint,
    cache,
    loadServerSnapshot,
    callWireTool,
    readPolicy,
    audit,
    listEnrolledServers,
    ensureDefaultServerEnrollment: vi.fn(async () => {}),
    now: () => NOW,
    pageSize: 20,
  };

  function actorFor(instanceId: string): InvokerTrustedActor {
    const spec = byInstance.get(instanceId);
    if (!spec) throw new Error(`unknown instance ${instanceId}`);
    return {
      actor: {
        principalType: "HumanUser",
        principalId: `user-${instanceId}`,
        organizationId: spec.orgId,
      } as never as ActorContext,
      userId: `user-${instanceId}`,
      orgId: spec.orgId,
      connectorInstancePin: { connectorKey: "wordpress", instanceId },
    };
  }

  return {
    deps,
    cache,
    requireUseCalls,
    listEnrolledServers,
    resolveInstanceEndpoint,
    loadSnapshotCalls,
    wireCalls,
    callWireTool,
    actorFor,
  };
}

async function fetchAllPages(
  input: { connectorKey: string; actor: InvokerTrustedActor; serverId?: string },
  deps: ConnectorInstanceInvokerDeps,
) {
  let cursor: string | undefined;
  const rows: Array<{ name: string; serverId: string }> = [];
  const revisions = new Set<string>();
  let pages = 0;
  do {
    const page = await listConnectorInstanceTools({ ...input, cursor }, deps);
    pages += 1;
    rows.push(...page.tools.map((t) => ({ name: t.name, serverId: t.serverId })));
    revisions.add(page.catalogRevision);
    cursor = page.nextCursor;
  } while (cursor);
  return { rows, revisions, pages };
}

describe("connector-instance-invoker — governed M1 provider-scale matrix (cinatra#2024 S9 item A / D2)", () => {
  it("calls the REAL exported invokeConnectorInstanceTool / listConnectorInstanceTools functions directly — not a wrapper (D2 hardening)", () => {
    // A cheap but genuine proof this suite exercises the functions THEMSELVES:
    // `Function.prototype.name` reflects the function's own declared name at
    // its definition site in connector-instance-invoker.ts, not whatever local
    // binding name an import happens to use — a differently-implemented
    // wrapper could never satisfy this by accident.
    expect(invokeConnectorInstanceTool.name).toBe("invokeConnectorInstanceTool");
    expect(listConnectorInstanceTools.name).toBe("listConnectorInstanceTools");
  });

  it("lists the full 64-tool scale-server catalog via listConnectorInstanceTools, paginated, no truncation/duplication, stable across repeats", async () => {
    const { deps, actorFor } = makeDeps();
    for (const instanceId of ["instance-a", "instance-c"]) {
      const input = { connectorKey: "wordpress", actor: actorFor(instanceId) };
      const first = await fetchAllPages(input, deps);
      // 64 scale tools + 1 vendor tool + 1 default-server tool, paginated at
      // pageSize=20 => at least 4 pages, never one silently-truncated page.
      expect(first.pages).toBeGreaterThanOrEqual(4);
      expect(first.rows).toHaveLength(READ_TOOL_COUNT + 2);
      expect(first.revisions.size).toBe(1); // stable, revision-pinned across pages
      const scaleNames = first.rows.filter((r) => r.serverId !== CATALOG_DEFAULT_SERVER_ID && r.name.startsWith("scalesmoke/"));
      expect(new Set(scaleNames.map((r) => r.name))).toEqual(new Set(READ_TOOL_NAMES));
      expect(scaleNames).toHaveLength(READ_TOOL_COUNT); // no truncation, no dup rows

      // Stable ordering across two independent, fully-paginated runs.
      const second = await fetchAllPages(input, deps);
      expect(second.rows.map((r) => `${r.serverId}:${r.name}`)).toEqual(
        first.rows.map((r) => `${r.serverId}:${r.name}`),
      );
    }
  });

  it("isolates instance-b's per-instance duplicate: A/C resolve unambiguously, B needs an explicit serverId, and nothing is dropped from the list", async () => {
    const { deps, actorFor } = makeDeps();

    // instance-a / instance-c: the SAME tool name, no serverId, resolves
    // uniquely (their servers carry no duplicate).
    for (const instanceId of ["instance-a", "instance-c"]) {
      const result = await invokeConnectorInstanceTool(
        { connectorKey: "wordpress", toolName: READ_TOOL_NAMES[0]!, args: {}, actor: actorFor(instanceId) },
        deps,
      );
      expect(result).toMatchObject({ echoInstanceId: instanceId, echoToolName: READ_TOOL_NAMES[0] });
    }

    // instance-b: the identical call, no serverId, is genuinely ambiguous —
    // the real §3.6 mechanism, not a synthetic ejection rule — and NEVER
    // silently resolves to the wrong server.
    const ambiguous = await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: READ_TOOL_NAMES[0]!, args: {}, actor: actorFor("instance-b") },
      deps,
    ).catch((e: unknown) => e);
    expect(ambiguous).toBeInstanceOf(InvokerError);
    expect((ambiguous as InvokerError).code).toBe("ambiguous_tool");

    // Disambiguated explicitly, instance-b's call succeeds on EITHER server.
    const bSpec = INSTANCES.find((i) => i.instanceId === "instance-b")!;
    const viaScale = await invokeConnectorInstanceTool(
      {
        connectorKey: "wordpress",
        toolName: READ_TOOL_NAMES[0]!,
        serverId: bSpec.scaleServerId,
        args: {},
        actor: actorFor("instance-b"),
      },
      deps,
    );
    expect(viaScale).toMatchObject({ echoInstanceId: "instance-b" });
    const viaOther = await invokeConnectorInstanceTool(
      {
        connectorKey: "wordpress",
        toolName: READ_TOOL_NAMES[0]!,
        serverId: bSpec.otherServerId,
        args: {},
        actor: actorFor("instance-b"),
      },
      deps,
    );
    expect(viaOther).toMatchObject({ echoInstanceId: "instance-b" });

    // The duplicate is never DROPPED from the governed list — report-never-
    // drop: both server-scoped rows are present (67 = 64 + vendor + default +
    // the one duplicate row on the other server).
    const { rows } = await fetchAllPages(
      { connectorKey: "wordpress", actor: actorFor("instance-b") },
      deps,
    );
    expect(rows).toHaveLength(READ_TOOL_COUNT + 3);
    expect(rows.filter((r) => r.name === READ_TOOL_NAMES[0]).map((r) => r.serverId).sort()).toEqual(
      [bSpec.otherServerId, bSpec.scaleServerId].sort(),
    );
  });

  it("every acquire/gate call across the 3-instance matrix carries EXACTLY its own instanceId — no cross-instance bleed", async () => {
    const { deps, actorFor, requireUseCalls, listEnrolledServers, loadSnapshotCalls } = makeDeps();
    for (const spec of INSTANCES) {
      await invokeConnectorInstanceTool(
        { connectorKey: "wordpress", toolName: DEFAULT_TOOL_NAME, args: {}, actor: actorFor(spec.instanceId) },
        deps,
      );
    }
    expect(requireUseCalls).toHaveLength(3);
    for (const spec of INSTANCES) {
      const rows = requireUseCalls.filter((c) => c.instanceId === spec.instanceId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.orgId).toBe(spec.orgId);
    }
    expect(listEnrolledServers).toHaveBeenCalledTimes(3);
    // Each invocation's acquire loop populates all 3 of ITS OWN instance's
    // servers from a cold cache — 9 total loads, 3 per instance, never a
    // load tagged with a foreign instanceId.
    expect(loadSnapshotCalls).toHaveLength(9);
    for (const spec of INSTANCES) {
      const own = loadSnapshotCalls.filter((c) => c.instanceId === spec.instanceId);
      expect(own).toHaveLength(3);
    }
  });

  it("resolves 9 CONCURRENT invocations across the full 3-instance x 3-server matrix to their own pinned instance+server — no cross-attribution, zero drops", async () => {
    const { deps, actorFor, wireCalls } = makeDeps();
    type Call = { instanceId: string; expectedToolName: string; input: InvokeConnectorInstanceToolInput };
    const calls: Call[] = [];
    for (const spec of INSTANCES) {
      calls.push({
        instanceId: spec.instanceId,
        expectedToolName: DEFAULT_TOOL_NAME,
        input: { connectorKey: "wordpress", toolName: DEFAULT_TOOL_NAME, args: {}, actor: actorFor(spec.instanceId) },
      });
      calls.push({
        instanceId: spec.instanceId,
        expectedToolName: READ_TOOL_NAMES[5]!,
        input: {
          connectorKey: "wordpress",
          toolName: READ_TOOL_NAMES[5]!,
          serverId: spec.scaleServerId,
          args: {},
          actor: actorFor(spec.instanceId),
        },
      });
      calls.push({
        instanceId: spec.instanceId,
        expectedToolName: spec.vendorToolName,
        input: {
          connectorKey: "wordpress",
          toolName: spec.vendorToolName,
          serverId: spec.otherServerId,
          args: {},
          actor: actorFor(spec.instanceId),
        },
      });
    }
    expect(calls).toHaveLength(9);

    const results = await Promise.all(calls.map((c) => invokeConnectorInstanceTool(c.input, deps)));

    results.forEach((result, i) => {
      const call = calls[i]!;
      expect(result).toMatchObject({ echoInstanceId: call.instanceId, echoToolName: call.expectedToolName });
    });
    expect(wireCalls).toHaveLength(9);
    // Every wire call's endpoint really belongs to the instance the CALLER
    // intended — checked at the transport ledger itself (not only via the
    // returned echo, which the SUT could in principle fabricate; the
    // endpoint is what step 4 actually dialed). Concurrent execution gives NO
    // ordering guarantee for when each call's own wire dial actually fires
    // (Promise.all only orders the RESULTS array, not the interleaving), so
    // this compares the two ledgers as SETS of `instanceId:toolName` pairs —
    // every pair here is unique across the 9 calls (instanceId always
    // differs), so a set-equality check is exactly as strong as an index
    // match would be, without assuming an interleaving order the runtime
    // never promised.
    const expectedPairs = new Set(calls.map((c) => `${c.instanceId}:${c.expectedToolName}`));
    const actualPairs = new Set(
      wireCalls.map((w) => {
        const toolName = w.name === TRIAD_EXECUTE_ABILITY ? (w.arguments.ability_name as string) : w.name;
        return `${instanceIdFromEndpoint(w.endpoint)}:${toolName}`;
      }),
    );
    expect(actualPairs).toEqual(expectedPairs);
  });
});
