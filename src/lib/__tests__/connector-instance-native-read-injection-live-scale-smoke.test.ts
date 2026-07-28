import { describe, expect, it } from "vitest";
import {
  CATALOG_DEFAULT_SERVER_ID,
  buildFirstClassSnapshot,
  type CatalogServerSnapshot,
} from "@/lib/connector-instance-catalog-cache";
import type { EnrolledServerRef } from "@/lib/connector-instance-invoker";
import type { NativeInjectionPolicyView } from "@/lib/connector-instance-native-injection-store";
import {
  TRUSTED_READ_DESCRIPTOR_SET,
  computeTrustedReadDescriptorSetHash,
  resolveShippedTrustedSiteConsent,
  type ShippedTrustedSiteConsent,
  type TrustedReadDescriptorEntry,
  type TrustedReadDescriptorSet,
} from "@/lib/connector-instance-trusted-read-descriptors";
import { computeTrustedReadFingerprint } from "@/lib/connector-instance-trusted-read-verifier";
import {
  createWordPressNativeReadInjectionMembers,
  type WordPressNativeReadInjectionDeps,
} from "@/lib/connector-instance-native-read-injection";
import type { ResolvedActor } from "@/lib/connector-instance-write-authority";
import {
  materializeExternalMcpServers,
  type McpMaterializerInput,
} from "@cinatra-ai/llm/mcp-materializer";
import { checkMcpApprovalVocabulary } from "@/lib/mcp-approval-vocabulary";
import {
  BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS,
  declarationSatisfiesCapability,
} from "@cinatra-ai/agents/llm-provider-policy";

// cinatra#2019 — the LIVE half of the provider-scale proof harness. Runs ONLY
// against a booted pinned WordPress fixture (docker/wordpress, `wordpress`
// profile) — never on a developer machine or the default CI job. Gated by the
// same two env vars the S1 capture producer uses
// (tests/e2e/wp-mcp-gateway/capture-annotations.mjs): WP_BASE_URL,
// WP_MCP_BASIC_AUTH. Absent either, this whole suite is skipped — it is
// invisible to every ordinary `pnpm test:root` run and only exercised by the
// dedicated capture-workflow job that boots the fixture first.
//
// What this proves, all against REAL wire data (no hand-typed schemas):
//   1. the pinned DEFAULT adapter server is still triad-only live — the
//      ship-dark precondition this whole feature rests on;
//   2. the dedicated scale-smoke fixture server (docker/wordpress/
//      scale-smoke-plugin) really is first-class and really carries >= 64
//      read-only tools;
//   3. a descriptor set DERIVED from that live capture (by construction —
//      the fingerprints are computed from the exact bytes the server
//      returned) survives builder -> materializer -> the shared per-provider
//      approval-vocabulary boundary for openai + anthropic with NO
//      truncation and ZERO skipped entries;
//   4. with the REAL SHIPPED (still-empty, cinatra#2019 D1) descriptor set,
//      opt-in ON against the REAL pinned default server emits the EMPTY set —
//      the post-merge live proof that trusted-site mode ships dark.

const WP_BASE_URL = process.env.WP_BASE_URL;
const WP_MCP_BASIC_AUTH = process.env.WP_MCP_BASIC_AUTH;
const LIVE = Boolean(WP_BASE_URL && WP_MCP_BASIC_AUTH);

const MCP_PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "cinatra-scale-smoke-live-proof", version: "1.0.0" };
const SCALE_SMOKE_MIN_TOOL_COUNT = 64;
const DEFAULT_SERVER_TRIAD_TOOL_NAMES = [
  "mcp-adapter-discover-abilities",
  "mcp-adapter-get-ability-info",
  "mcp-adapter-execute-ability",
];

type JsonRpcTool = { name: string; inputSchema?: unknown; outputSchema?: unknown; annotations?: unknown };
type JsonRpcResponse = { parsed: { result?: { tools?: JsonRpcTool[] }; error?: unknown } | null; sessionId: string | null };

/** Minimal JSON-RPC/MCP transport client — mirrors the bare-then-handshake
 * fallback in tests/e2e/wp-mcp-gateway/capture-annotations.mjs's
 * `postJsonRpc`/`rawToolsList` (kept local: that file is a CLI producer with
 * no exported symbols to import). */
async function postJsonRpc(
  url: string,
  auth: string,
  body: Record<string, unknown>,
  sessionId?: string | null,
): Promise<JsonRpcResponse> {
  const headers: Record<string, string> = {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const rawText = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  const newSession = res.headers.get("mcp-session-id") ?? sessionId ?? null;
  let parsed: JsonRpcResponse["parsed"] = null;
  if (contentType.includes("text/event-stream")) {
    for (const block of rawText.split(/\n\n/)) {
      for (const line of block.split(/\n/)) {
        const match = /^data:\s?(.*)$/.exec(line);
        if (!match) continue;
        try {
          parsed = JSON.parse(match[1]!);
        } catch {
          // non-JSON data line — ignore
        }
      }
    }
  } else if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = null;
    }
  }
  return { parsed, sessionId: newSession };
}

let rpcId = 0;
function nextId(): number {
  rpcId += 1;
  return rpcId;
}

/** Raw `tools/list`: bare call first (lenient servers), full initialize
 * handshake fallback (spec-strict servers) — same fallback the S1 capture
 * producer uses against this exact fixture stack. */
async function rawToolsList(url: string, auth: string): Promise<JsonRpcTool[]> {
  const bare = await postJsonRpc(url, auth, { jsonrpc: "2.0", id: nextId(), method: "tools/list", params: {} });
  if (Array.isArray(bare.parsed?.result?.tools)) return bare.parsed.result.tools;

  const init = await postJsonRpc(url, auth, {
    jsonrpc: "2.0",
    id: nextId(),
    method: "initialize",
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
  });
  const sessionId = init.sessionId;
  if (init.parsed && !init.parsed.error) {
    await postJsonRpc(url, auth, { jsonrpc: "2.0", method: "notifications/initialized", params: {} }, sessionId);
  }
  const listed = await postJsonRpc(
    url,
    auth,
    { jsonrpc: "2.0", id: nextId(), method: "tools/list", params: {} },
    sessionId,
  );
  return Array.isArray(listed.parsed?.result?.tools) ? listed.parsed.result.tools : [];
}

describe.skipIf(!LIVE)(
  "connector-instance-native-read-injection — live provider-scale proof (cinatra#2019)",
  () => {
    it(
      "proves no truncation at real scale across providers, and the ship-dark empty emission on the real pinned default server",
      async () => {
        const auth = WP_MCP_BASIC_AUTH!;
        const base = WP_BASE_URL!;

        // ---- 1. The pinned default server is still triad-only, live -------
        const defaultTools = await rawToolsList(`${base}/wp-json/mcp/mcp-adapter-default-server`, auth);
        expect(defaultTools.map((t) => t.name).sort()).toEqual([...DEFAULT_SERVER_TRIAD_TOOL_NAMES].sort());
        const defaultSnapshot: CatalogServerSnapshot = {
          serverId: CATALOG_DEFAULT_SERVER_ID,
          exposureMode: "triad-only",
          tools: [],
          catalogRevision: "live-default",
          fetchedAtMs: Date.now(),
        };

        // ---- 2. The dedicated scale-smoke server really is first-class and
        //         really carries >= 64 read tools -----------------------------
        const scaleTools = await rawToolsList(`${base}/wp-json/scalesmoke/scalesmoke-server`, auth);
        expect(scaleTools.length).toBeGreaterThanOrEqual(SCALE_SMOKE_MIN_TOOL_COUNT);
        const scaleSnapshot = buildFirstClassSnapshot({
          serverId: "scalesmoke-server",
          tools: scaleTools as Array<Record<string, unknown>>,
          revision: "live-scalesmoke",
        });
        expect(scaleSnapshot.exposureMode).toBe("first-class");

        // ---- 3. Derive a descriptor set from the LIVE capture (by
        //         construction: fingerprints computed from the exact bytes
        //         the server returned, not a hand-typed guess) ---------------
        const descriptorEntries: TrustedReadDescriptorEntry[] = [];
        for (const tool of scaleSnapshot.tools) {
          const computed = computeTrustedReadFingerprint({
            inputSchema: tool.inputSchema,
            ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
          });
          expect(computed.ok).toBe(true);
          if (!computed.ok) continue;
          descriptorEntries.push({
            name: tool.name,
            fingerprint: computed.fingerprint,
            hasOutputSchema: computed.hasOutputSchema,
          });
        }
        expect(descriptorEntries).toHaveLength(scaleSnapshot.tools.length);

        const liveDescriptorSet: TrustedReadDescriptorSet = {
          version: 1,
          pinnedTuple: { wp: "6.9", mcpAdapter: "0.5.0", eafm: "2.0.20" },
          fingerprintAlgorithm: "tsr1",
          entries: descriptorEntries,
        };
        const liveShipped: ShippedTrustedSiteConsent = {
          descriptorSetVersion: 1,
          descriptorSetHash: computeTrustedReadDescriptorSetHash(descriptorEntries),
          disclosureVersion: "v1",
        };

        const enrolled: EnrolledServerRef[] = [
          { serverId: defaultSnapshot.serverId, exposureMode: defaultSnapshot.exposureMode, restPath: "mcp/mcp-adapter-default-server" },
          { serverId: scaleSnapshot.serverId, exposureMode: scaleSnapshot.exposureMode, restPath: "scalesmoke/scalesmoke-server" },
        ];
        const actor: ResolvedActor = {
          actor: { organizationId: "live-org" } as ResolvedActor["actor"],
          userId: "live-user",
          orgId: "live-org",
        };
        const trustedSitePolicy: NativeInjectionPolicyView = {
          mode: "trusted_site",
          disclosureVersion: liveShipped.disclosureVersion,
          descriptorSetVersion: liveShipped.descriptorSetVersion,
          descriptorSetHash: liveShipped.descriptorSetHash,
          consentedOrgId: "live-org",
          enabledBy: "live-admin",
          enabledAt: "2026-07-28T00:00:00.000Z",
          updatedBy: "live-admin",
          updatedAt: "2026-07-28T00:00:00.000Z",
        };

        const baseDeps: Omit<WordPressNativeReadInjectionDeps, "shippedConsent" | "descriptorSet" | "readPolicy" | "acquireEnrolledSnapshots"> = {
          resolveInstanceOrgId: () => "live-org",
          resolveTrustedActor: async () => actor,
          requireUse: async () => {},
          isKnownDestructiveToolName: () => false,
          requireSession: async () => ({ user: { id: "live-admin" } }),
          resolveOrgRole: async () => "org_admin",
        };

        const scaleMembers = createWordPressNativeReadInjectionMembers({
          ...baseDeps,
          readPolicy: async () => trustedSitePolicy,
          acquireEnrolledSnapshots: async () => ({ enrolled, snapshots: [defaultSnapshot, scaleSnapshot] }),
          shippedConsent: liveShipped,
          descriptorSet: liveDescriptorSet,
        });
        const grant = await scaleMembers.buildNativeReadInjection({ instanceId: "live-instance", surface: "chat" });
        expect(grant).not.toBeNull();
        expect(grant?.allowedTools).toHaveLength(scaleSnapshot.tools.length);

        // ---- Materializer + the shared per-provider approval-vocabulary
        //      boundary, for every provider the issue's scale smoke names ----
        const materializerInputs: McpMaterializerInput[] = [
          {
            serverLabel: "wordpress-live-instance",
            serverUrl: `${base}/wp-json/mcp/mcp-adapter-default-server`,
            authorization: `Basic ${auth}`,
            allowedTools: grant!.allowedTools,
            approval: "auto_execute",
            transport: "streamable-http",
            origin: "managed",
          },
        ];
        const materialized = materializeExternalMcpServers(materializerInputs);
        expect(materialized.skipped).toEqual([]); // zero skipped entries — no batch loss
        expect(materialized.servers).toHaveLength(1);
        const materializedServer = materialized.servers[0]!;
        expect(materializedServer.allowedTools).toHaveLength(scaleSnapshot.tools.length);

        for (const provider of ["openai", "anthropic"] as const) {
          const declaration = BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS[provider];
          expect(declarationSatisfiesCapability(declaration, "native_mcp")).toBe(true);
          const checked = checkMcpApprovalVocabulary(`provider:${provider}`, materializedServer);
          expect(checked).not.toBeNull();
          expect(checked?.allowedTools).toEqual(materializedServer.allowedTools);
        }

        // ---- 4. Ship-dark proof (D1): opt-in ON, REAL pinned default
        //         server, REAL SHIPPED descriptor set -> EMPTY emission ------
        const shipDarkMembers = createWordPressNativeReadInjectionMembers({
          ...baseDeps,
          readPolicy: async () => {
            const shipped = resolveShippedTrustedSiteConsent();
            return {
              ...trustedSitePolicy,
              descriptorSetVersion: shipped.descriptorSetVersion,
              descriptorSetHash: shipped.descriptorSetHash,
              disclosureVersion: shipped.disclosureVersion,
            };
          },
          acquireEnrolledSnapshots: async () => ({ enrolled: [enrolled[0]!], snapshots: [defaultSnapshot] }),
          // shippedConsent / descriptorSet OMITTED — resolves to the real
          // TRUSTED_READ_DESCRIPTOR_SET / resolveShippedTrustedSiteConsent().
        });
        const shipDarkGrant = await shipDarkMembers.buildNativeReadInjection({
          instanceId: "live-instance",
          surface: "chat",
        });
        expect(TRUSTED_READ_DESCRIPTOR_SET.entries).toHaveLength(0); // still true — see D1
        expect(shipDarkGrant).toBeNull();
      },
      60_000,
    );
  },
);
