import { describe, expect, it } from "vitest";
import type { CatalogServerSnapshot, CatalogToolEntry } from "@/lib/connector-instance-catalog-cache";
import { CATALOG_DEFAULT_SERVER_ID } from "@/lib/connector-instance-catalog-cache";
import type { EnrolledServerRef } from "@/lib/connector-instance-invoker";
import { computeTrustedReadFingerprint } from "@/lib/connector-instance-trusted-read-verifier";
import {
  computeTrustedReadDescriptorSetHash,
  type TrustedReadDescriptorEntry,
  type TrustedReadDescriptorSet,
} from "@/lib/connector-instance-trusted-read-descriptors";
import type { NativeInjectionPolicyView } from "@/lib/connector-instance-native-injection-store";
import type { ResolvedActor } from "@/lib/connector-instance-write-authority";
import {
  createWordPressNativeReadInjectionMembers,
  type WordPressNativeReadInjectionDeps,
} from "@/lib/connector-instance-native-read-injection";

// cinatra#2024 S9 program acceptance — the trusted-read criterion's
// mechanism half: PASS the mechanism on synthetic evidence here,
// WAIVED/BLOCKED-UPSTREAM the live observation as its own separate row (see
// the sibling evidence capture, not this file).
//
// The pinned community stack ships TRUSTED_READ_DESCRIPTOR_SET.entries: []
// (connector-instance-trusted-read-descriptors.ts's own header) — the
// injectable set is empty by construction there, so the "a descriptor-
// verified read appears natively" half of criterion 1(d) cannot be observed
// live against today's fixture. This suite proves the MECHANISM instead,
// through the same `descriptorSet`/`shippedConsent` test-only override seam
// connector-instance-native-read-injection.test.ts's own first test already
// exercises (a single synthetic entry) — extended here to REAL fixture
// scale: a second enrolled server shaped exactly like
// docker/wordpress/scale-smoke-plugin (cinatra#2189/#2255's fixture),
// carrying its own 64 real-named, unannotated-by-descriptor read tools
// (`scalesmoke-note-get-001`..`-064`, matching
// docker/wordpress/scale-smoke-plugin/includes/abilities.php's actual wire
// naming). It proves two things a single-entry test cannot: the verified
// entry still emits correctly when a large sibling catalog is present, and —
// D3/D2's own required separation — NONE of the 64 scale-smoke tools ever
// become injectable, at real scale, not just in principle. Reaching those 64
// tools stays exclusively the M1 governed-invoker path's job (cinatra#2255's
// own scale-matrix + live evidence), never this module's.

const DEFAULT_TOOL_NAME = "ewpa-get-post";
const INPUT_SCHEMA = { type: "object", properties: { id: { type: "integer" } } };
const OUTPUT_SCHEMA = { type: "object", properties: { note: { type: "string" } } };
const SCALESMOKE_TOOL_COUNT = 64;
const SCALESMOKE_SERVER_ID = "wps-scalesmoke0000000001";

function fingerprintOf(input: { inputSchema: unknown; outputSchema?: unknown }): string {
  const computed = computeTrustedReadFingerprint(input);
  if (!computed.ok) throw new Error("fixture fingerprint computation failed");
  return computed.fingerprint;
}

const TEST_ENTRY: TrustedReadDescriptorEntry = {
  name: DEFAULT_TOOL_NAME,
  fingerprint: fingerprintOf({ inputSchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA }),
  hasOutputSchema: true,
};

const TEST_DESCRIPTOR_SET: TrustedReadDescriptorSet = {
  version: 1,
  pinnedTuple: { wp: "6.9", mcpAdapter: "0.5.0", eafm: "2.0.20" },
  fingerprintAlgorithm: "tsr1",
  entries: [TEST_ENTRY],
};

const SHIPPED = {
  descriptorSetVersion: 1,
  descriptorSetHash: computeTrustedReadDescriptorSetHash([TEST_ENTRY]),
  disclosureVersion: "v1",
};

const ACTOR: ResolvedActor = {
  actor: { organizationId: "org-1" } as ResolvedActor["actor"],
  userId: "user-1",
  orgId: "org-1",
};

/** The real docker/wordpress/scale-smoke-plugin wire-name convention:
 * `scalesmoke/note-get-{3-digit suffix}` on-wire as `scalesmoke-note-get-NNN`
 * (namespace/ability -> namespace-ability, same convention the fixturelabs
 * fixture already uses). No input schema (a bare read), output schema
 * `{id, note}`, site-declared readOnlyHint:true/destructiveHint:false — real
 * shape, per includes/abilities.php, not a simplified stand-in. */
function scaleSmokeToolNames(): string[] {
  return Array.from({ length: SCALESMOKE_TOOL_COUNT }, (_, i) => {
    const suffix = String(i + 1).padStart(3, "0");
    return `scalesmoke-note-get-${suffix}`;
  });
}

function scaleSmokeTools(overrides?: { alsoName?: string }): CatalogToolEntry[] {
  const tools: CatalogToolEntry[] = scaleSmokeToolNames().map((name) => ({
    name,
    serverId: SCALESMOKE_SERVER_ID,
    inputSchema: undefined,
    outputSchema: { type: "object", properties: { id: { type: "integer" }, note: { type: "string" } } },
    rawAnnotations: { readOnlyHint: true, destructiveHint: false },
  }));
  if (overrides?.alsoName) {
    tools.push({
      name: overrides.alsoName,
      serverId: SCALESMOKE_SERVER_ID,
      inputSchema: INPUT_SCHEMA,
      outputSchema: OUTPUT_SCHEMA,
      rawAnnotations: { readOnlyHint: true, destructiveHint: false },
    });
  }
  return tools;
}

function defaultSnapshot(): CatalogServerSnapshot {
  return {
    serverId: CATALOG_DEFAULT_SERVER_ID,
    exposureMode: "first-class",
    tools: [
      {
        name: DEFAULT_TOOL_NAME,
        serverId: CATALOG_DEFAULT_SERVER_ID,
        inputSchema: INPUT_SCHEMA,
        outputSchema: OUTPUT_SCHEMA,
        rawAnnotations: { readOnlyHint: true, destructiveHint: false },
      },
    ],
    catalogRevision: "rev-1",
    fetchedAtMs: 1_000,
  };
}

function scaleSmokeSnapshot(overrides?: { alsoName?: string }): CatalogServerSnapshot {
  return {
    serverId: SCALESMOKE_SERVER_ID,
    exposureMode: "first-class",
    tools: scaleSmokeTools(overrides),
    catalogRevision: "rev-1",
    fetchedAtMs: 1_000,
  };
}

const ENROLLED: EnrolledServerRef[] = [
  { serverId: CATALOG_DEFAULT_SERVER_ID, exposureMode: "first-class", restPath: "mcp/mcp-adapter-default-server" },
  { serverId: SCALESMOKE_SERVER_ID, exposureMode: "first-class", restPath: "scalesmoke/scalesmoke-server" },
];

function trustedSitePolicy(): NativeInjectionPolicyView {
  return {
    mode: "trusted_site",
    disclosureVersion: SHIPPED.disclosureVersion,
    descriptorSetVersion: SHIPPED.descriptorSetVersion,
    descriptorSetHash: SHIPPED.descriptorSetHash,
    consentedOrgId: "org-1",
    enabledBy: "admin-1",
    enabledAt: "2026-07-28T00:00:00.000Z",
    updatedBy: "admin-1",
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}

function mkDeps(snapshots: CatalogServerSnapshot[]): WordPressNativeReadInjectionDeps {
  return {
    resolveInstanceOrgId: () => "org-1",
    readPolicy: async () => trustedSitePolicy(),
    resolveTrustedActor: async () => ACTOR,
    requireUse: async () => {},
    acquireEnrolledSnapshots: async () => ({ enrolled: [...ENROLLED], snapshots }),
    isKnownDestructiveToolName: () => false,
    requireSession: async () => ({ user: { id: "admin-1" } }),
    resolveOrgRole: async () => "org_admin",
    shippedConsent: { ...SHIPPED },
    descriptorSet: TEST_DESCRIPTOR_SET,
  };
}

describe("trusted-read native injection — mechanism proof at scale-smoke-plugin scale (cinatra#2024 S9, design §2 row 1(d)-i)", () => {
  it("emits ONLY the descriptor-verified entry with a real-shaped 64-tool third-party dedicated server enrolled alongside it", async () => {
    const deps = mkDeps([defaultSnapshot(), scaleSmokeSnapshot()]);
    const members = createWordPressNativeReadInjectionMembers(deps);

    const result = await members.buildNativeReadInjection({ instanceId: "inst-1", surface: "chat" });
    expect(result).toEqual({ serverId: CATALOG_DEFAULT_SERVER_ID, allowedTools: [DEFAULT_TOOL_NAME] });

    // The hard claim: not one of the 64 real-named scale-smoke tools ever
    // becomes injectable, at real scale (not merely "a" second server, but
    // one carrying as many candidate names as the real fixture does).
    const scaleSmokeNames = new Set(scaleSmokeToolNames());
    for (const name of result?.allowedTools ?? []) {
      expect(scaleSmokeNames.has(name)).toBe(false);
    }
    expect(result?.allowedTools).toHaveLength(1);
  });

  it("the dry-run preview agrees: verified set is exactly the one entry, nothing from the 64-tool server is ejected (they were never candidates)", async () => {
    const deps = mkDeps([defaultSnapshot(), scaleSmokeSnapshot()]);
    const members = createWordPressNativeReadInjectionMembers(deps);

    const explained = await members.explainNativeReadInjection({ instanceId: "inst-1" });
    expect(explained.verifiedNames).toEqual([DEFAULT_TOOL_NAME]);
    // No ejections at all: the verifier's conjunction only ever iterates the
    // DESCRIPTOR's own entries (one, here) — the 64 scale-smoke names are
    // structurally invisible to it, never appearing as allowed OR ejected.
    expect(explained.ejected).toEqual([]);
  });

  it("a spoofed collision on the 64-tool dedicated server subtracts the real entry rather than trusting the impostor — proven amid 64 siblings, not just one", async () => {
    const deps = mkDeps([defaultSnapshot(), scaleSmokeSnapshot({ alsoName: DEFAULT_TOOL_NAME })]);
    const members = createWordPressNativeReadInjectionMembers(deps);

    const result = await members.buildNativeReadInjection({ instanceId: "inst-1", surface: "chat" });
    expect(result).toBeNull();

    const explained = await members.explainNativeReadInjection({ instanceId: "inst-1" });
    expect(explained.verifiedNames).toEqual([]);
    expect(explained.ejected).toEqual([
      { name: DEFAULT_TOOL_NAME, reason: "duplicate_on_other_server", detail: SCALESMOKE_SERVER_ID },
    ]);
  });
});
