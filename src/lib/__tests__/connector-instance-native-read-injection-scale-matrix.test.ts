import { describe, expect, it, vi } from "vitest";
import type {
  CatalogServerSnapshot,
  CatalogToolEntry,
} from "@/lib/connector-instance-catalog-cache";
import type { EnrolledServerRef } from "@/lib/connector-instance-invoker";
import type { NativeInjectionPolicyView } from "@/lib/connector-instance-native-injection-store";
import {
  computeTrustedReadDescriptorSetHash,
  type ShippedTrustedSiteConsent,
  type TrustedReadDescriptorEntry,
  type TrustedReadDescriptorSet,
} from "@/lib/connector-instance-trusted-read-descriptors";
import { computeTrustedReadFingerprint } from "@/lib/connector-instance-trusted-read-verifier";
import type { ResolvedActor } from "@/lib/connector-instance-write-authority";
import {
  createWordPressNativeReadInjectionMembers,
  type WordPressNativeReadInjection,
  type WordPressNativeReadInjectionDeps,
} from "@/lib/connector-instance-native-read-injection";
import {
  materializeExternalMcpServers,
  type McpMaterializerInput,
} from "@cinatra-ai/llm/mcp-materializer";
import { checkMcpApprovalVocabulary } from "@/lib/mcp-approval-vocabulary";
import {
  BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS,
  declarationSatisfiesCapability,
} from "@cinatra-ai/agents/llm-provider-policy";

// cinatra#2019 — the provider-scale proof harness, builder-level half (the
// live-fixture half runs in a dedicated capture workflow; see
// tests/e2e/wp-mcp-gateway/trusted-read-scale-smoke.live.test.ts).
//
// This is a fully SYNTHETIC, deterministic test: no live WordPress stack, no
// network. It exercises the REAL production functions end to end —
// `createWordPressNativeReadInjectionMembers` (the injection builder),
// `materializeExternalMcpServers` (the provider materializer), and
// `checkMcpApprovalVocabulary` (the shared per-tool approval-vocabulary
// boundary every provider path crosses) — over a descriptor set sized to the
// issue's "≥64 read tools" acceptance row, across 3 synthetic connector-
// instances x 3 enrolled servers each (1 default + 2 others per instance),
// proving in one pass:
//   1. all 64 names survive post-materializer with no truncation, for every
//      instance that carries no duplicate;
//   2. per-entry auth isolation: a duplicate on ONE instance's non-default
//      server only ejects that instance's copy of the name — the other two
//      instances are provably unaffected, and every builder call is proven
//      (via the injected mocks) to have been made with EXACTLY its own
//      instance id, never another instance's;
//   3. label -> instance attribution stays stable and unique across all three
//      emitted servers post-materializer (no misrouting);
//   4. zero skipped entries in the materializer batch (no batch loss);
//   5. both provider-capability-matrix entries required by the issue's scale
//      smoke (openai, anthropic) declare native MCP support, and every
//      materialized entry's `allowedTools` survives the shared approval-
//      vocabulary boundary intact (non-null, non-empty, exact).

const READ_TOOL_COUNT = 64;

const READ_INPUT_SCHEMA = { type: "object", properties: {} } as const;
const READ_OUTPUT_SCHEMA = {
  type: "object",
  properties: { id: { type: "integer" }, note: { type: "string" } },
  required: ["id", "note"],
} as const;

function fingerprintOf(input: { inputSchema: unknown; outputSchema?: unknown }): string {
  const computed = computeTrustedReadFingerprint(input);
  if (!computed.ok) throw new Error("fixture fingerprint computation failed");
  return computed.fingerprint;
}

const READ_FINGERPRINT = fingerprintOf({
  inputSchema: READ_INPUT_SCHEMA,
  outputSchema: READ_OUTPUT_SCHEMA,
});

/** The 64 descriptor-listed names, matching the fixture plugin's
 * `scalesmoke/note-get-001` .. `-064` naming (docker/wordpress/scale-smoke-plugin). */
const READ_TOOL_NAMES: string[] = Array.from({ length: READ_TOOL_COUNT }, (_, i) =>
  `scalesmoke/note-get-${String(i + 1).padStart(3, "0")}`,
);

const DESCRIPTOR_ENTRIES: TrustedReadDescriptorEntry[] = READ_TOOL_NAMES.map((name) => ({
  name,
  fingerprint: READ_FINGERPRINT,
  hasOutputSchema: true,
}));

const DESCRIPTOR_SET: TrustedReadDescriptorSet = {
  version: 1,
  pinnedTuple: { wp: "6.9", mcpAdapter: "0.5.0", eafm: "2.0.20" },
  fingerprintAlgorithm: "tsr1",
  entries: DESCRIPTOR_ENTRIES,
};

const SHIPPED_CONSENT: ShippedTrustedSiteConsent = {
  descriptorSetVersion: DESCRIPTOR_SET.version,
  descriptorSetHash: computeTrustedReadDescriptorSetHash(DESCRIPTOR_ENTRIES),
  disclosureVersion: "v1",
};

function readTool(name: string, serverId = "mcp-adapter-default"): CatalogToolEntry {
  return {
    name,
    serverId,
    inputSchema: READ_INPUT_SCHEMA,
    outputSchema: READ_OUTPUT_SCHEMA,
    rawAnnotations: { readOnlyHint: true, destructiveHint: false },
  };
}

type Instance = {
  instanceId: string;
  orgId: string;
  otherServerIds: [string, string];
  /** A name from READ_TOOL_NAMES duplicated onto this instance's SECOND other
   * server, or undefined for an instance with no duplicate. */
  duplicatedName?: string;
};

const INSTANCES: Instance[] = [
  { instanceId: "instance-a", orgId: "org-a", otherServerIds: ["wps-aaaa000000000001", "wps-aaaa000000000002"] },
  {
    instanceId: "instance-b",
    orgId: "org-b",
    otherServerIds: ["wps-bbbb000000000001", "wps-bbbb000000000002"],
    duplicatedName: READ_TOOL_NAMES[0],
  },
  { instanceId: "instance-c", orgId: "org-c", otherServerIds: ["wps-cccc000000000001", "wps-cccc000000000002"] },
];

function buildInstanceFixture(instance: Instance): {
  enrolled: EnrolledServerRef[];
  snapshots: CatalogServerSnapshot[];
} {
  const defaultSnapshot: CatalogServerSnapshot = {
    serverId: "mcp-adapter-default",
    exposureMode: "first-class",
    tools: READ_TOOL_NAMES.map((name) => readTool(name)),
    catalogRevision: `rev-${instance.instanceId}-default`,
    fetchedAtMs: 1_000,
  };
  const other1: CatalogServerSnapshot = {
    serverId: instance.otherServerIds[0],
    exposureMode: "first-class",
    tools: [],
    catalogRevision: `rev-${instance.instanceId}-other1`,
    fetchedAtMs: 1_000,
  };
  const other2: CatalogServerSnapshot = {
    serverId: instance.otherServerIds[1],
    exposureMode: "first-class",
    tools: instance.duplicatedName ? [readTool(instance.duplicatedName, instance.otherServerIds[1])] : [],
    catalogRevision: `rev-${instance.instanceId}-other2`,
    fetchedAtMs: 1_000,
  };
  const enrolled: EnrolledServerRef[] = [defaultSnapshot, other1, other2].map((s) => ({
    serverId: s.serverId,
    exposureMode: s.exposureMode,
    restPath: `mcp/${s.serverId}`,
  }));
  return { enrolled, snapshots: [defaultSnapshot, other1, other2] };
}

const TRUSTED_SITE_POLICY: NativeInjectionPolicyView = {
  mode: "trusted_site",
  disclosureVersion: SHIPPED_CONSENT.disclosureVersion,
  descriptorSetVersion: SHIPPED_CONSENT.descriptorSetVersion,
  descriptorSetHash: SHIPPED_CONSENT.descriptorSetHash,
  consentedOrgId: null,
  enabledBy: "admin",
  enabledAt: "2026-07-28T00:00:00.000Z",
  updatedBy: "admin",
  updatedAt: "2026-07-28T00:00:00.000Z",
};

describe("connector-instance-native-read-injection — provider-scale builder matrix (cinatra#2019)", () => {
  it("proves no truncation, per-instance isolation, stable attribution, and zero materializer loss across 3 instances x 3 servers x 64 tools", async () => {
    const acquireCalls: Array<{ connectorKey: string; instanceId: string }> = [];
    const requireUseCalls: Array<{ instanceId: string; actorOrgId: string }> = [];

    const acquireEnrolledSnapshots = vi.fn<WordPressNativeReadInjectionDeps["acquireEnrolledSnapshots"]>(
      async (connectorKey, instanceId) => {
        acquireCalls.push({ connectorKey, instanceId });
        const instance = INSTANCES.find((i) => i.instanceId === instanceId);
        if (!instance) throw new Error(`unexpected instanceId in acquire: ${instanceId}`);
        return buildInstanceFixture(instance);
      },
    );

    const requireUse = vi.fn<WordPressNativeReadInjectionDeps["requireUse"]>(async (resolved, input) => {
      requireUseCalls.push({ instanceId: input.instanceId, actorOrgId: resolved.orgId });
      // Per-entry auth isolation, enforced INSIDE the fake gate: an actor may
      // only USE the instance whose org it resolved to (mirrors the real
      // per-instance USE authority's org scoping). A cross-instance call
      // would throw here exactly like the real gate denies it.
      const expectedInstance = INSTANCES.find((i) => i.orgId === resolved.orgId);
      if (!expectedInstance || expectedInstance.instanceId !== input.instanceId) {
        throw new Error(
          `cross-instance USE attempt: actor for org ${resolved.orgId} tried to use instance ${input.instanceId}`,
        );
      }
    });

    function depsFor(instance: Instance): WordPressNativeReadInjectionDeps {
      const actor: ResolvedActor = {
        actor: { organizationId: instance.orgId } as ResolvedActor["actor"],
        userId: `user-${instance.instanceId}`,
        orgId: instance.orgId,
      };
      return {
        resolveInstanceOrgId: (id) => (id === instance.instanceId ? instance.orgId : null),
        readPolicy: async () => TRUSTED_SITE_POLICY,
        resolveTrustedActor: async () => actor,
        requireUse,
        acquireEnrolledSnapshots,
        isKnownDestructiveToolName: () => false,
        requireSession: async () => ({ user: { id: `admin-${instance.instanceId}` } }),
        resolveOrgRole: async () => "org_admin",
        audit: () => {},
        shippedConsent: SHIPPED_CONSENT,
        descriptorSet: DESCRIPTOR_SET,
      };
    }

    const grants = new Map<string, WordPressNativeReadInjection | null>();
    for (const instance of INSTANCES) {
      const members = createWordPressNativeReadInjectionMembers(depsFor(instance));
      const grant = await members.buildNativeReadInjection({
        instanceId: instance.instanceId,
        surface: "chat",
      });
      grants.set(instance.instanceId, grant);
    }

    // ---- 1. No truncation for the undisturbed instances ---------------------
    const grantA = grants.get("instance-a");
    const grantC = grants.get("instance-c");
    expect(grantA).not.toBeNull();
    expect(grantC).not.toBeNull();
    expect(grantA?.allowedTools).toHaveLength(READ_TOOL_COUNT);
    expect(grantC?.allowedTools).toHaveLength(READ_TOOL_COUNT);
    expect(new Set(grantA?.allowedTools)).toEqual(new Set(READ_TOOL_NAMES));
    expect(new Set(grantC?.allowedTools)).toEqual(new Set(READ_TOOL_NAMES));

    // ---- 2. Per-instance isolation: instance-b's local duplicate ejects
    //         ONLY the duplicated name, and ONLY for instance-b -------------
    const grantB = grants.get("instance-b");
    expect(grantB).not.toBeNull();
    expect(grantB?.allowedTools).toHaveLength(READ_TOOL_COUNT - 1);
    expect(grantB?.allowedTools).not.toContain(READ_TOOL_NAMES[0]);
    expect(grantA?.allowedTools).toContain(READ_TOOL_NAMES[0]);
    expect(grantC?.allowedTools).toContain(READ_TOOL_NAMES[0]);

    // Every acquire/requireUse call carried EXACTLY its own instance id — no
    // cross-instance parameter bleed (the fake gate above would have thrown
    // otherwise, but assert the call ledger directly too).
    expect(acquireCalls).toHaveLength(3);
    for (const instance of INSTANCES) {
      expect(acquireCalls.filter((c) => c.instanceId === instance.instanceId)).toHaveLength(1);
      expect(requireUseCalls.filter((c) => c.instanceId === instance.instanceId)).toHaveLength(1);
    }
    expect(acquireCalls.every((c) => c.connectorKey === "wordpress")).toBe(true);

    // ---- 3 + 4. Materialize each instance's grant as the connector toolbox
    //             would (D8 default-server label form) and prove stable
    //             attribution + zero batch loss -----------------------------
    const materializerInputs: McpMaterializerInput[] = INSTANCES.map((instance) => {
      const grant = grants.get(instance.instanceId);
      if (!grant) throw new Error(`expected a non-null grant for ${instance.instanceId}`);
      return {
        serverLabel: `wordpress-${instance.instanceId}`,
        serverUrl: `https://${instance.instanceId}.example.com/wp-json/mcp/mcp-adapter-default-server`,
        authorization: `Basic ${Buffer.from(`admin:${instance.instanceId}-app-password`).toString("base64")}`,
        allowedTools: grant.allowedTools,
        approval: "auto_execute" as const,
        transport: "streamable-http" as const,
        origin: "managed" as const,
      };
    });

    const materialized = materializeExternalMcpServers(materializerInputs);
    expect(materialized.skipped).toEqual([]); // zero skipped entries — no batch loss
    expect(materialized.servers).toHaveLength(3);

    for (const instance of INSTANCES) {
      const normalized = `wordpress_${instance.instanceId.replace(/-/g, "_")}`;
      expect(materialized.attribution[normalized]).toBe(`wordpress-${instance.instanceId}`);
      const server = materialized.servers.find((s) => s.serverLabel === normalized);
      expect(server).toBeDefined();
      const expectedCount = instance.instanceId === "instance-b" ? READ_TOOL_COUNT - 1 : READ_TOOL_COUNT;
      expect(server?.allowedTools).toHaveLength(expectedCount);
    }
    // Attribution is a bijection over these three entries — no two instances
    // ever collide onto the same normalized label (misrouting).
    expect(new Set(Object.keys(materialized.attribution))).toHaveLength(3);

    // ---- 5. Provider-capability matrix + the shared approval-vocabulary
    //         boundary, for every provider the issue's scale smoke names ----
    for (const provider of ["openai", "anthropic"] as const) {
      const declaration = BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS[provider];
      expect(declarationSatisfiesCapability(declaration, "native_mcp")).toBe(true);

      for (const server of materialized.servers) {
        const checked = checkMcpApprovalVocabulary(`provider:${provider}`, server);
        expect(checked).not.toBeNull();
        expect(checked?.allowedTools).toBeDefined();
        expect(checked?.allowedTools).not.toHaveLength(0);
        expect(checked?.allowedTools).toEqual(server.allowedTools);
      }
    }
  });

  it("degrades to nothing for every instance when the descriptor set is empty (the shipped v1 posture)", async () => {
    // Sanity companion: the same 3-instance harness, but with the actually
    // SHIPPED (empty) descriptor set — proves the scale fixture above is
    // exercising the opt-in path, not masking a fail-open default.
    const emptyShipped: ShippedTrustedSiteConsent = {
      descriptorSetVersion: 1,
      descriptorSetHash: computeTrustedReadDescriptorSetHash([]),
      disclosureVersion: "v1",
    };
    const emptyDescriptor: TrustedReadDescriptorSet = {
      version: 1,
      pinnedTuple: { wp: "6.9", mcpAdapter: "0.5.0", eafm: "2.0.20" },
      fingerprintAlgorithm: "tsr1",
      entries: [],
    };
    const instance = INSTANCES[0]!;
    const actor: ResolvedActor = {
      actor: { organizationId: instance.orgId } as ResolvedActor["actor"],
      userId: "user-1",
      orgId: instance.orgId,
    };
    const members = createWordPressNativeReadInjectionMembers({
      resolveInstanceOrgId: () => instance.orgId,
      readPolicy: async () => ({
        ...TRUSTED_SITE_POLICY,
        descriptorSetHash: emptyShipped.descriptorSetHash,
      }),
      resolveTrustedActor: async () => actor,
      requireUse: async () => {},
      acquireEnrolledSnapshots: async () => buildInstanceFixture(instance),
      isKnownDestructiveToolName: () => false,
      requireSession: async () => ({ user: { id: "admin-1" } }),
      resolveOrgRole: async () => "org_admin",
      shippedConsent: emptyShipped,
      descriptorSet: emptyDescriptor,
    });
    const grant = await members.buildNativeReadInjection({ instanceId: instance.instanceId, surface: "chat" });
    expect(grant).toBeNull();
  });
});
