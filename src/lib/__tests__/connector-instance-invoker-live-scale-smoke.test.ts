import { describe, expect, it } from "vitest";
import type { SiteToolRow } from "@cinatra-ai/sdk-extensions";
import {
  invokeConnectorInstanceTool,
  listConnectorInstanceTools,
  type ConnectorInstanceInvokerDeps,
  type EnrolledServerRef,
  type InvokerTrustedActor,
} from "@/lib/connector-instance-invoker";
import {
  CATALOG_DEFAULT_SERVER_ID,
  createInMemoryConnectorInstanceCatalogCache,
} from "@/lib/connector-instance-catalog-cache";
import {
  callConnectorInstanceMcpTool,
  listConnectorInstanceMcpTools,
} from "@/lib/connector-instance-mcp-transport";
import { createConnectorInstanceSnapshotLoader } from "@/lib/connector-instance-snapshot-loader";
import type { InstanceToolPolicyRecord } from "@cinatra-ai/mcp-server/instance-tool-policy";

// cinatra#2024 (S9 program acceptance) — item A / design §3 / D2: the LIVE
// half of the M1 governed-invoker provider-scale proof. PR #2189 (S4/#2019's
// scale-smoke fixture) built the fixture + the M2-only live proof and
// explicitly deferred the M1 (governed-invoker) real round-trip to program
// acceptance ("real provider round-trips deferred to program acceptance") —
// this file is that deferred proof.
//
// Runs ONLY against a booted pinned WordPress fixture (docker/wordpress,
// `wordpress` profile, scale-smoke-plugin installed) — never on a developer
// machine or the default CI job. Gated by the SAME two env vars the S1
// capture producer and the sibling M2 live test
// (connector-instance-native-read-injection-live-scale-smoke.test.ts) use:
// WP_BASE_URL, WP_MCP_BASIC_AUTH. Absent either, this whole suite is
// skipped — invisible to every ordinary `pnpm test:root` run, exercised only
// by the dedicated capture-workflow job that boots the fixture first (this
// operator box never boots it — architecture-preservation / workspace
// guardrail).
//
// Deliberately reuses the REAL production wire layer rather than a
// hand-rolled JSON-RPC client: `callConnectorInstanceMcpTool` /
// `listConnectorInstanceMcpTools` (connector-instance-mcp-transport.ts) are
// the exact functions register-host-connector-services.ts binds in
// production, and `createConnectorInstanceSnapshotLoader` (connector-
// instance-snapshot-loader.ts) is the exact per-server snapshot loader prod
// binds as `loadServerSnapshot` — only the enrollment-store-backed
// `readExposureMode`/`recordExposureMode` are stood in with no-ops (this
// harness has no database), and `requireUse`/`readPolicy` are simple
// open-mode stand-ins (mirroring the sibling M2 live test's own `baseDeps`
// pattern) rather than the full DB-backed authority service. Everything
// else is the real `invokeConnectorInstanceTool` / `listConnectorInstanceTools`
// dispatch, called directly (never a wrapper), against the real fixture.
//
// What this proves, all against REAL wire data:
//   1. `listConnectorInstanceTools`, paginated through the REAL M1 dispatch,
//      returns >= 64 uniquely-named scale-smoke tools with NO truncation —
//      and that set is byte-identical to a raw `tools/list` fetched
//      independently, tying the governed list to the real wire exactly;
//   2. a bounded fan-out of CONCURRENT `invokeConnectorInstanceTool` calls
//      against 9 distinct real fixture tools round-trips the REAL PHP
//      execute path and attributes each response to its OWN requested
//      ability (no cross-attribution under real concurrent wire calls) —
//      the fixture's own abilities.php derives `id`/`note` deterministically
//      from each ability's own numeric suffix, so a wrong attribution here
//      would be caught, not just a dropped response;
//   3. the pinned default adapter server's catalog is still reachable
//      through the same M1 dispatch (a non-empty, real triad-expanded read),
//      proving the governed list/invoke path works end-to-end on BOTH
//      enrolled servers, not only the dedicated scale server.
//
// The 3-instance x 3-server ISOLATION dimension is the synthetic sibling's
// job (connector-instance-invoker-scale-matrix.test.ts) — this fixture stack
// boots exactly one real WordPress site, so "instance breadth" here is
// necessarily single-instance; what only a live run can prove is the REAL
// wire round-trip, which is this file's whole point.

const WP_BASE_URL = process.env.WP_BASE_URL;
const WP_MCP_BASIC_AUTH = process.env.WP_MCP_BASIC_AUTH;
const LIVE = Boolean(WP_BASE_URL && WP_MCP_BASIC_AUTH);

const SCALE_SMOKE_MIN_TOOL_COUNT = 64;
const SCALE_SERVER_ID = "scalesmoke-server";
const CONCURRENT_SAMPLE_SIZE = 9;

async function fetchAllPages(
  input: { connectorKey: string; actor: InvokerTrustedActor; serverId?: string },
  deps: ConnectorInstanceInvokerDeps,
): Promise<SiteToolRow[]> {
  let cursor: string | undefined;
  const rows: SiteToolRow[] = [];
  do {
    const page = await listConnectorInstanceTools({ ...input, cursor }, deps);
    rows.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return rows;
}

describe.skipIf(!LIVE)(
  "connector-instance-invoker — live M1 governed-invoker provider-scale proof (cinatra#2024 S9 item A)",
  () => {
    it(
      "lists >= 64 real scale-smoke tools through the real M1 dispatch (no truncation) and round-trips 9 concurrent real invocations with no cross-attribution",
      async () => {
        const auth = WP_MCP_BASIC_AUTH!;
        const base = WP_BASE_URL!;
        const authHeader = `Basic ${auth}`;

        // ---- Raw wire baseline (independent of the invoker) — what the real
        //      fixture server actually advertises today. ----------------------
        const wireScaleTools = await listConnectorInstanceMcpTools({
          endpoint: `${base}/wp-json/scalesmoke/scalesmoke-server`,
          authHeader,
        });
        expect(wireScaleTools.length).toBeGreaterThanOrEqual(SCALE_SMOKE_MIN_TOOL_COUNT);

        // ---- The REAL M1 deps: real transport, real snapshot loader, no DB. ---
        const endpointFor = (serverId: string): string =>
          serverId === CATALOG_DEFAULT_SERVER_ID
            ? `${base}/wp-json/mcp/mcp-adapter-default-server`
            : `${base}/wp-json/scalesmoke/scalesmoke-server`;

        const loadServerSnapshot = createConnectorInstanceSnapshotLoader({
          callWireTool: (input) => callConnectorInstanceMcpTool(input),
          listTools: (input) => listConnectorInstanceMcpTools(input),
          // No enrollment store in this harness — every run is a first
          // classification (harmless: classification is re-verified on every
          // load in production too, this just never persists it).
          readExposureMode: async () => null,
          recordExposureMode: async () => {},
          invalidateSnapshot: () => {},
          audit: () => {},
        });

        const enrolled: EnrolledServerRef[] = [
          { serverId: CATALOG_DEFAULT_SERVER_ID, exposureMode: "triad-only", restPath: "mcp/mcp-adapter-default-server" },
          { serverId: SCALE_SERVER_ID, exposureMode: "first-class", restPath: "scalesmoke/scalesmoke-server" },
        ];

        const actor: InvokerTrustedActor = {
          actor: { principalType: "HumanUser", principalId: "live-user", organizationId: "live-org" } as never,
          userId: "live-user",
          orgId: "live-org",
          connectorInstancePin: { connectorKey: "wordpress", instanceId: "live-instance" },
        };

        const deps: ConnectorInstanceInvokerDeps = {
          requireUse: async () => {},
          ensureDefaultOpenPolicy: async () => ({ created: false }),
          resolveInstanceEndpoint: async (_ck, _iid, serverId) => ({
            endpoint: endpointFor(serverId ?? CATALOG_DEFAULT_SERVER_ID),
            authHeader,
          }),
          cache: createInMemoryConnectorInstanceCatalogCache(),
          loadServerSnapshot,
          callWireTool: (input) => callConnectorInstanceMcpTool(input),
          readPolicy: async (): Promise<InstanceToolPolicyRecord | null> => ({
            connectorKey: "wordpress",
            instanceId: "live-instance",
            mode: "open",
            updatedBy: "live-harness",
            updatedAt: new Date().toISOString(),
          }),
          audit: () => {},
          listEnrolledServers: async () => enrolled,
          ensureDefaultServerEnrollment: async () => {},
          pageSize: 20,
        };

        // ---- 1. The REAL M1 governed list, paginated, tied back to the raw
        //         wire baseline — no truncation, no drift between the two. -----
        const allRows = await fetchAllPages({ connectorKey: "wordpress", actor }, deps);
        const scaleRows = allRows.filter((r) => r.serverId === SCALE_SERVER_ID);
        expect(scaleRows.length).toBeGreaterThanOrEqual(SCALE_SMOKE_MIN_TOOL_COUNT);
        expect(new Set(scaleRows.map((r) => r.name))).toEqual(new Set(wireScaleTools.map((t) => t.name as string)));

        // ---- 2. The pinned default server is ALSO reachable through the same
        //         real M1 dispatch (non-empty triad-expanded read). -------------
        const defaultRows = allRows.filter((r) => r.serverId === CATALOG_DEFAULT_SERVER_ID);
        expect(defaultRows.length).toBeGreaterThan(0);

        // ---- 3. Real, CONCURRENT invokeConnectorInstanceTool round-trips
        //         against real fixture abilities — every response attributed to
        //         its OWN requested tool, never a neighbor's. The fixture's own
        //         PHP (docker/wordpress/scale-smoke-plugin/includes/abilities.php)
        //         derives {id, note} deterministically from each ability's own
        //         numeric suffix, so a misattributed response is caught exactly,
        //         not just "a response came back". ---------------------------
        const candidateNames = wireScaleTools
          .map((t) => t.name as string)
          .filter((n) => /^scalesmoke\/note-get-\d+$/.test(n))
          .slice(0, CONCURRENT_SAMPLE_SIZE);
        expect(candidateNames.length).toBe(CONCURRENT_SAMPLE_SIZE);

        const results = await Promise.all(
          candidateNames.map((name) =>
            invokeConnectorInstanceTool(
              { connectorKey: "wordpress", toolName: name, serverId: SCALE_SERVER_ID, args: {}, actor },
              deps,
            ),
          ),
        );
        results.forEach((result, i) => {
          const name = candidateNames[i]!;
          const expectedId = Number(/(\d+)$/.exec(name)![1]);
          expect(result).toMatchObject({ id: expectedId, note: `Scale-smoke note #${expectedId}` });
        });
      },
      60_000,
    );
  },
);
