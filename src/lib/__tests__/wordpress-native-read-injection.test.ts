import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { logAuditEvent } from "@/lib/authz/audit";
import type {
  CatalogServerSnapshot,
  CatalogToolEntry,
} from "@/lib/connector-instance-catalog-cache";
import type { EnrolledServerRef } from "@/lib/connector-instance-invoker";
import { WordPressNativeInjectionConsentError } from "@/lib/connector-instance-native-injection-consent";
import type { NativeInjectionPolicyView } from "@/lib/connector-instance-native-injection-store";
import {
  TRUSTED_READ_DESCRIPTOR_SET,
  computeTrustedReadDescriptorSetHash,
  resolveShippedTrustedSiteConsent,
  type TrustedReadDescriptorEntry,
  type TrustedReadDescriptorSet,
} from "@/lib/connector-instance-trusted-read-descriptors";
import { computeTrustedReadFingerprint } from "@/lib/connector-instance-trusted-read-verifier";
import type { ResolvedActor } from "@/lib/connector-instance-write-authority";
import {
  NATIVE_READ_INJECTION_PRIMITIVE,
  createWordPressNativeReadInjectionMembers,
  type WordPressNativeReadInjectionDeps,
} from "@/lib/wordpress-native-read-injection";

// cinatra#2019 S4 — the impure builder around the pure verifier: opt-in +
// content-exact consent, dual-layer surface enforcement, ambient-actor USE
// authority, injected acquire (the invoker's freshness path), stateless
// recomputation, latched operator audits, and the org-admin dry-run preview.
// The verifier conjunction itself is pinned in
// connector-instance-trusted-read-verifier.test.ts; the capture gate in
// wordpress-trusted-read-capture-consistency.test.ts.

type AuditEvent = Parameters<typeof logAuditEvent>[0];

const INPUT_SCHEMA = { type: "object", properties: { id: { type: "integer" } } };
const OUTPUT_SCHEMA = { type: "object", properties: { note: { type: "string" } } };

function fingerprintOf(input: { inputSchema: unknown; outputSchema?: unknown }): string {
  const computed = computeTrustedReadFingerprint(input);
  if (!computed.ok) throw new Error("fixture fingerprint failed");
  return computed.fingerprint;
}

const TEST_ENTRY: TrustedReadDescriptorEntry = {
  name: "ewpa-get-post",
  fingerprint: fingerprintOf({ inputSchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA }),
  hasOutputSchema: true,
};

const TEST_DESCRIPTOR_SET: TrustedReadDescriptorSet = {
  version: 7,
  pinnedTuple: { wp: "6.9", mcpAdapter: "0.5.0", eafm: "2.0.20" },
  fingerprintAlgorithm: "tsr1",
  entries: [TEST_ENTRY],
};

const SHIPPED = {
  descriptorSetVersion: 7,
  descriptorSetHash: computeTrustedReadDescriptorSetHash([TEST_ENTRY]),
  disclosureVersion: "v1",
};

const ACTOR: ResolvedActor = {
  actor: { organizationId: "org-1" } as ResolvedActor["actor"],
  userId: "user-1",
  orgId: "org-1",
};

function readTool(overrides?: Partial<CatalogToolEntry>): CatalogToolEntry {
  return {
    name: "ewpa-get-post",
    serverId: "mcp-adapter-default",
    inputSchema: INPUT_SCHEMA,
    outputSchema: OUTPUT_SCHEMA,
    rawAnnotations: { readOnlyHint: true, destructiveHint: false },
    ...overrides,
  };
}

function defaultSnapshot(overrides?: Partial<CatalogServerSnapshot>): CatalogServerSnapshot {
  return {
    serverId: "mcp-adapter-default",
    exposureMode: "first-class",
    tools: [readTool()],
    catalogRevision: "rev-1",
    fetchedAtMs: 1_000,
    ...overrides,
  };
}

const DEFAULT_ENROLLED: EnrolledServerRef[] = [
  { serverId: "mcp-adapter-default", exposureMode: "first-class", restPath: "mcp/mcp-adapter-default-server" },
];

function trustedSitePolicy(overrides?: Partial<NativeInjectionPolicyView>): NativeInjectionPolicyView {
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
    ...overrides,
  };
}

const OFF_POLICY: NativeInjectionPolicyView = {
  mode: "off",
  disclosureVersion: null,
  descriptorSetVersion: null,
  descriptorSetHash: null,
  consentedOrgId: null,
  enabledBy: null,
  enabledAt: null,
  updatedBy: null,
  updatedAt: null,
};

function mkDeps(overrides?: Partial<WordPressNativeReadInjectionDeps>): {
  deps: WordPressNativeReadInjectionDeps;
  audits: AuditEvent[];
} {
  const audits: AuditEvent[] = [];
  const deps: WordPressNativeReadInjectionDeps = {
    resolveInstanceOrgId: () => "org-1",
    readPolicy: async () => trustedSitePolicy(),
    resolveTrustedActor: async () => ACTOR,
    requireUse: async () => {},
    acquireEnrolledSnapshots: async () => ({
      enrolled: [...DEFAULT_ENROLLED],
      snapshots: [defaultSnapshot()],
    }),
    isKnownDestructiveToolName: () => false,
    requireSession: async () => ({ user: { id: "admin-1" } }),
    resolveOrgRole: async () => "org_admin",
    audit: (event) => {
      audits.push(event);
    },
    shippedConsent: { ...SHIPPED },
    descriptorSet: TEST_DESCRIPTOR_SET,
    ...overrides,
  };
  return { deps, audits };
}

function emptyReasons(audits: AuditEvent[]): string[] {
  return audits
    .filter((event) => event.operation === "native_injection_empty")
    .map((event) => String((event.metadata as Record<string, unknown>)?.reason));
}

function emittedEvents(audits: AuditEvent[]): AuditEvent[] {
  return audits.filter((event) => event.operation === "native_injection_emitted");
}

describe("buildNativeReadInjection — the verified emission", () => {
  it("emits the exact non-empty verified set for the default server + one latched emitted audit", async () => {
    const { deps, audits } = mkDeps();
    const members = createWordPressNativeReadInjectionMembers(deps);
    const result = await members.buildNativeReadInjection({ instanceId: "inst-1", surface: "chat" });
    expect(result).toEqual({ serverId: "mcp-adapter-default", allowedTools: ["ewpa-get-post"] });
    // An emitted entry is by contract non-empty and exact — no null/empty
    // allowlist can ever leave this member (the empty verdict returns null).
    expect(result?.allowedTools.length).toBeGreaterThan(0);
    const emitted = emittedEvents(audits);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.decision).toBe("allowed");
    expect(emitted[0]?.metadata).toMatchObject({
      connectorKey: "wordpress",
      serverId: "mcp-adapter-default",
      toolCount: 1,
      allowedNamesSha256: createHash("sha256").update("ewpa-get-post", "utf8").digest("hex"),
    });
    // Latch: an identical rebuild on the SAME catalog revision audits once.
    await members.buildNativeReadInjection({ instanceId: "inst-1", surface: "chat" });
    expect(emittedEvents(audits)).toHaveLength(1);
  });

  it("re-audits when the catalog revision moves, and after the latch TTL expires", async () => {
    let revision = "rev-1";
    let at = 1_000_000;
    const { deps, audits } = mkDeps({
      acquireEnrolledSnapshots: async () => ({
        enrolled: [...DEFAULT_ENROLLED],
        snapshots: [defaultSnapshot({ catalogRevision: revision })],
      }),
      now: () => at,
    });
    const members = createWordPressNativeReadInjectionMembers(deps);
    await members.buildNativeReadInjection({ instanceId: "inst-1", surface: "chat" });
    revision = "rev-2"; // refreshed snapshot, same verified content
    await members.buildNativeReadInjection({ instanceId: "inst-1", surface: "chat" });
    expect(emittedEvents(audits)).toHaveLength(2);
    // Same revision again inside the TTL: latched…
    await members.buildNativeReadInjection({ instanceId: "inst-1", surface: "chat" });
    expect(emittedEvents(audits)).toHaveLength(2);
    // …and re-armed once the TTL window passes (best-effort noise bound).
    at += 11 * 60_000;
    await members.buildNativeReadInjection({ instanceId: "inst-1", surface: "chat" });
    expect(emittedEvents(audits)).toHaveLength(3);
  });

  it("recomputes statelessly: schema drift in a REFRESHED snapshot ejects at that rebuild (D2)", async () => {
    let snapshots = [defaultSnapshot()];
    const { deps, audits } = mkDeps({
      acquireEnrolledSnapshots: async () => ({
        enrolled: [...DEFAULT_ENROLLED],
        snapshots,
      }),
    });
    const members = createWordPressNativeReadInjectionMembers(deps);

    // Build 1 verifies; build 2 still serves the SAME cached snapshot (the
    // invoker's fresh window) — the prior verdict is REcomputed, not stored.
    expect(
      await members.buildNativeReadInjection({ instanceId: "inst-1", surface: "chat" }),
    ).toBeTruthy();
    expect(
      await members.buildNativeReadInjection({ instanceId: "inst-1", surface: "chat" }),
    ).toBeTruthy();

    // The refresh lands a mutated advertised schema ⇒ the name ejects at the
    // FIRST rebuild whose acquired snapshot reflects the drift.
    snapshots = [
      defaultSnapshot({
        catalogRevision: "rev-2",
        tools: [
          readTool({
            inputSchema: { type: "object", properties: { id: { type: "string" } } },
          }),
        ],
      }),
    ];
    expect(
      await members.buildNativeReadInjection({ instanceId: "inst-1", surface: "chat" }),
    ).toBeNull();
    const last = audits.at(-1);
    expect(last?.operation).toBe("native_injection_empty");
    expect(last?.metadata).toMatchObject({
      reason: "no_verified_tools",
      ejectedReasonCounts: { fingerprint_mismatch: 1 },
    });
  });

  it("D1 pinned-stack proof: the REAL shipped (empty) descriptor set emits NOTHING even when opted in", async () => {
    for (const snapshot of [
      defaultSnapshot(), // even against a first-class snapshot…
      defaultSnapshot({ exposureMode: "triad-only", catalogRevision: "rev-t" }), // …and the real triad shape
    ]) {
      const shipped = resolveShippedTrustedSiteConsent();
      const { deps, audits } = mkDeps({
        descriptorSet: TRUSTED_READ_DESCRIPTOR_SET,
        shippedConsent: shipped,
        readPolicy: async () =>
          trustedSitePolicy({
            descriptorSetVersion: shipped.descriptorSetVersion,
            descriptorSetHash: shipped.descriptorSetHash,
            disclosureVersion: shipped.disclosureVersion,
          }),
        acquireEnrolledSnapshots: async () => ({
          enrolled: [...DEFAULT_ENROLLED],
          snapshots: [snapshot],
        }),
      });
      const members = createWordPressNativeReadInjectionMembers(deps);
      expect(
        await members.buildNativeReadInjection({ instanceId: "inst-1", surface: "chat" }),
      ).toBeNull();
      const last = audits.at(-1);
      expect(last?.operation).toBe("native_injection_empty");
      expect(last?.metadata).toMatchObject({
        reason: "no_verified_tools",
        descriptorSetEmpty: true,
        descriptorSetSize: 0,
      });
    }
  });
});

describe("buildNativeReadInjection — the surface matrix (D5, host-side layer)", () => {
  it.each(["agent_run", "public_site_widget", "session", "somewhere-new"])(
    "refuses surface %s before ever reading policy or acquiring",
    async (surface) => {
      const readPolicy = vi.fn(async () => trustedSitePolicy());
      const acquire = vi.fn();
      const { deps, audits } = mkDeps({
        readPolicy,
        acquireEnrolledSnapshots: acquire as never,
      });
      const members = createWordPressNativeReadInjectionMembers(deps);
      expect(await members.buildNativeReadInjection({ instanceId: "inst-1", surface })).toBeNull();
      expect(readPolicy).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect(emptyReasons(audits)).toEqual(["surface_not_chat"]);
    },
  );

  it("refuses an ABSENT surface (unwidened/skewed caller) fail-closed", async () => {
    const { deps, audits } = mkDeps();
    const members = createWordPressNativeReadInjectionMembers(deps);
    expect(
      await members.buildNativeReadInjection({ instanceId: "inst-1" } as never),
    ).toBeNull();
    expect(audits.at(-1)?.metadata).toMatchObject({
      reason: "surface_not_chat",
      surface: "absent",
    });
  });
});

describe("buildNativeReadInjection — opt-in + content-exact consent (D3)", () => {
  it("mode off/absent emits nothing and stays SILENT (off is the normal state)", async () => {
    const { deps, audits } = mkDeps({ readPolicy: async () => ({ ...OFF_POLICY }) });
    const members = createWordPressNativeReadInjectionMembers(deps);
    expect(
      await members.buildNativeReadInjection({ instanceId: "inst-1", surface: "chat" }),
    ).toBeNull();
    expect(audits).toEqual([]);
  });

  it.each([
    ["version stale", { descriptorSetVersion: 6 }],
    ["version FUTURE (forged/rolled back host)", { descriptorSetVersion: 8 }],
    [
      "hash mismatch at the same version (unbumped content change / rollback)",
      { descriptorSetHash: computeTrustedReadDescriptorSetHash([]) },
    ],
    ["disclosure drift", { disclosureVersion: "v0" }],
    [
      "null stamps (unrepresentable per DDL — builder re-refuses defensively)",
      { descriptorSetVersion: null, descriptorSetHash: null, disclosureVersion: null },
    ],
  ])("refuses stale consent: %s", async (_label, stampOverrides) => {
    const { deps, audits } = mkDeps({
      readPolicy: async () => trustedSitePolicy(stampOverrides as Partial<NativeInjectionPolicyView>),
    });
    const members = createWordPressNativeReadInjectionMembers(deps);
    expect(
      await members.buildNativeReadInjection({ instanceId: "inst-1", surface: "chat" }),
    ).toBeNull();
    expect(emptyReasons(audits)).toEqual(["consent_stale"]);
  });

  it("proceeds again after a re-acknowledge re-stamp (fresh ceremony ⇒ current stamps)", async () => {
    let policy = trustedSitePolicy({ descriptorSetVersion: 6 });
    const { deps } = mkDeps({ readPolicy: async () => policy });
    const members = createWordPressNativeReadInjectionMembers(deps);
    expect(
      await members.buildNativeReadInjection({ instanceId: "inst-1", surface: "chat" }),
    ).toBeNull();
    policy = trustedSitePolicy(); // the re-ack ceremony stamped the shipped values
    expect(
      await members.buildNativeReadInjection({ instanceId: "inst-1", surface: "chat" }),
    ).toEqual({ serverId: "mcp-adapter-default", allowedTools: ["ewpa-get-post"] });
  });

  it("an unresolvable instance or unreadable policy refuses typed (fail closed)", async () => {
    const a = mkDeps({ resolveInstanceOrgId: () => null });
    expect(
      await createWordPressNativeReadInjectionMembers(a.deps).buildNativeReadInjection({
        instanceId: "inst-x",
        surface: "chat",
      }),
    ).toBeNull();
    expect(emptyReasons(a.audits)).toEqual(["instance_unresolved"]);

    const b = mkDeps({
      readPolicy: async () => {
        throw new Error("db down");
      },
    });
    expect(
      await createWordPressNativeReadInjectionMembers(b.deps).buildNativeReadInjection({
        instanceId: "inst-1",
        surface: "chat",
      }),
    ).toBeNull();
    expect(emptyReasons(b.audits)).toEqual(["policy_unreadable"]);
  });
});

describe("buildNativeReadInjection — ambient authority + acquire failures", () => {
  it("no ambient trusted actor ⇒ nothing (widget/anonymous frames can never emit)", async () => {
    const { deps, audits } = mkDeps({ resolveTrustedActor: async () => null });
    const members = createWordPressNativeReadInjectionMembers(deps);
    expect(
      await members.buildNativeReadInjection({ instanceId: "inst-1", surface: "chat" }),
    ).toBeNull();
    expect(emptyReasons(audits)).toEqual(["no_trusted_actor"]);
  });

  it("runs the explicit per-instance USE pass with the resolved actor and refuses on deny", async () => {
    const requireUse = vi.fn(async () => {
      throw new Error("denied");
    });
    const { deps, audits } = mkDeps({ requireUse });
    const members = createWordPressNativeReadInjectionMembers(deps);
    expect(
      await members.buildNativeReadInjection({ instanceId: "inst-1", surface: "chat" }),
    ).toBeNull();
    expect(requireUse).toHaveBeenCalledWith(ACTOR, {
      instanceId: "inst-1",
      primitiveName: NATIVE_READ_INJECTION_PRIMITIVE,
      sourceType: "chat",
    });
    expect(emptyReasons(audits)).toEqual(["use_authority_denied"]);
  });

  it("acquire failure / missing default snapshot / incomplete enumeration all refuse typed", async () => {
    const a = mkDeps({
      acquireEnrolledSnapshots: async () => {
        throw new Error("store read failed");
      },
    });
    expect(
      await createWordPressNativeReadInjectionMembers(a.deps).buildNativeReadInjection({
        instanceId: "inst-1",
        surface: "chat",
      }),
    ).toBeNull();
    expect(emptyReasons(a.audits)).toEqual(["acquire_failed"]);

    const b = mkDeps({
      acquireEnrolledSnapshots: async () => ({
        enrolled: [...DEFAULT_ENROLLED],
        snapshots: [], // default omitted (past max-stale)
      }),
    });
    expect(
      await createWordPressNativeReadInjectionMembers(b.deps).buildNativeReadInjection({
        instanceId: "inst-1",
        surface: "chat",
      }),
    ).toBeNull();
    expect(emptyReasons(b.audits)).toEqual(["default_snapshot_missing"]);

    const c = mkDeps({
      acquireEnrolledSnapshots: async () => ({
        enrolled: [
          ...DEFAULT_ENROLLED,
          { serverId: "wps-aaaaaaaaaaaaaaaa", exposureMode: "first-class", restPath: "x/y" },
        ],
        snapshots: [defaultSnapshot()], // the dedicated server yielded nothing
      }),
    });
    expect(
      await createWordPressNativeReadInjectionMembers(c.deps).buildNativeReadInjection({
        instanceId: "inst-1",
        surface: "chat",
      }),
    ).toBeNull();
    const last = c.audits.at(-1);
    expect(last?.metadata).toMatchObject({
      reason: "no_verified_tools",
      ejectedReasonCounts: { enrollment_incomplete: 1 },
    });
  });

  it("a duplicate name on another enrolled server subtracts (the spoof rule, end to end)", async () => {
    const { deps, audits } = mkDeps({
      acquireEnrolledSnapshots: async () => ({
        enrolled: [
          ...DEFAULT_ENROLLED,
          { serverId: "wps-bbbbbbbbbbbbbbbb", exposureMode: "first-class", restPath: "x/y" },
        ],
        snapshots: [
          defaultSnapshot(),
          defaultSnapshot({
            serverId: "wps-bbbbbbbbbbbbbbbb",
            catalogRevision: "rev-9",
            tools: [readTool({ serverId: "wps-bbbbbbbbbbbbbbbb" })],
          }),
        ],
      }),
    });
    const members = createWordPressNativeReadInjectionMembers(deps);
    expect(
      await members.buildNativeReadInjection({ instanceId: "inst-1", surface: "chat" }),
    ).toBeNull();
    expect(audits.at(-1)?.metadata).toMatchObject({
      reason: "no_verified_tools",
      ejectedReasonCounts: { duplicate_on_other_server: 1 },
    });
  });
});

describe("credential + schema hygiene of everything this module externalizes", () => {
  it("no audit event or member result ever carries header/credential/schema material", async () => {
    const collected: unknown[] = [];
    const { deps, audits } = mkDeps();
    const members = createWordPressNativeReadInjectionMembers(deps);
    collected.push(await members.buildNativeReadInjection({ instanceId: "inst-1", surface: "chat" }));
    collected.push(await members.explainNativeReadInjection({ instanceId: "inst-1" }));
    // A refusal path too (consent-stale metadata is version data only).
    const stale = mkDeps({
      readPolicy: async () => trustedSitePolicy({ descriptorSetVersion: 1 }),
    });
    collected.push(
      await createWordPressNativeReadInjectionMembers(stale.deps).buildNativeReadInjection({
        instanceId: "inst-1",
        surface: "chat",
      }),
    );
    const externalized = JSON.stringify([collected, audits, stale.audits]);
    expect(externalized).not.toMatch(/authorization/i);
    expect(externalized).not.toContain("Basic ");
    expect(externalized).not.toContain("authHeader");
    expect(externalized).not.toContain("endpoint");
    // Advertised schemas stay internal: audits/results carry names + counts
    // + hashes only, never schema bodies.
    expect(externalized).not.toContain("inputSchema");
    expect(externalized).not.toContain("properties");
  });
});

describe("explainNativeReadInjection — the org-admin dry-run (codex r0 #7)", () => {
  it("previews the verified set while the mode is OFF, and NEVER audits", async () => {
    const { deps, audits } = mkDeps({ readPolicy: async () => ({ ...OFF_POLICY }) });
    const members = createWordPressNativeReadInjectionMembers(deps);
    const explained = await members.explainNativeReadInjection({ instanceId: "inst-1" });
    expect(explained).toEqual({
      mode: "off",
      consentStale: false,
      verifiedNames: ["ewpa-get-post"],
      ejected: [],
    });
    expect(audits).toEqual([]);
  });

  it("reports consent staleness on a trusted_site row with drifted stamps — still no audits", async () => {
    const { deps, audits } = mkDeps({
      readPolicy: async () => trustedSitePolicy({ descriptorSetVersion: 3 }),
      acquireEnrolledSnapshots: async () => ({
        enrolled: [...DEFAULT_ENROLLED],
        snapshots: [
          defaultSnapshot({
            tools: [readTool(), readTool({ name: "ewpa-unlisted", rawAnnotations: {} })],
          }),
        ],
      }),
    });
    const members = createWordPressNativeReadInjectionMembers(deps);
    const explained = await members.explainNativeReadInjection({ instanceId: "inst-1" });
    expect(explained.mode).toBe("trusted_site");
    expect(explained.consentStale).toBe(true);
    expect(explained.verifiedNames).toEqual(["ewpa-get-post"]);
    expect(audits).toEqual([]);
  });

  it("surfaces ejections with typed reasons (the settings card's why-not view)", async () => {
    const { deps } = mkDeps({
      acquireEnrolledSnapshots: async () => ({
        enrolled: [...DEFAULT_ENROLLED],
        snapshots: [
          defaultSnapshot({ exposureMode: "triad-only", catalogRevision: "rev-t" }),
        ],
      }),
    });
    const members = createWordPressNativeReadInjectionMembers(deps);
    const explained = await members.explainNativeReadInjection({ instanceId: "inst-1" });
    expect(explained.verifiedNames).toEqual([]);
    expect(explained.ejected).toEqual([
      { name: "ewpa-get-post", reason: "exposure_not_first_class" },
    ]);
  });

  it("renders an honest 'preview unavailable' on acquire failure instead of a fake empty verdict", async () => {
    const { deps, audits } = mkDeps({
      acquireEnrolledSnapshots: async () => {
        throw new Error("site unreachable");
      },
    });
    const members = createWordPressNativeReadInjectionMembers(deps);
    const explained = await members.explainNativeReadInjection({ instanceId: "inst-1" });
    expect(explained.previewUnavailableReason).toBe("acquire_failed");
    expect(explained.verifiedNames).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("requires an org-admin in the OWNING org — one opaque refusal for every failure mode", async () => {
    const cases: Array<Partial<WordPressNativeReadInjectionDeps>> = [
      { resolveInstanceOrgId: () => null }, // unknown/unbound instance
      { resolveOrgRole: async () => undefined }, // non-member
      { resolveOrgRole: async () => "member" }, // member without connector.update
      {
        resolveOrgRole: async () => {
          throw new Error("lookup failed");
        },
      },
    ];
    for (const overrides of cases) {
      const { deps } = mkDeps(overrides);
      const members = createWordPressNativeReadInjectionMembers(deps);
      await expect(
        members.explainNativeReadInjection({ instanceId: "inst-1" }),
      ).rejects.toMatchObject({
        name: "WordPressNativeInjectionConsentError",
        reason: "not_authorized_for_instance",
      });
    }
    const { deps } = mkDeps();
    await expect(
      createWordPressNativeReadInjectionMembers(deps).explainNativeReadInjection({
        instanceId: "   ",
      }),
    ).rejects.toBeInstanceOf(WordPressNativeInjectionConsentError);
  });

  it("does NOT require an ambient trusted actor (the org-admin session is the authority)", async () => {
    const requireUse = vi.fn();
    const { deps } = mkDeps({
      resolveTrustedActor: async () => null,
      requireUse: requireUse as never,
    });
    const members = createWordPressNativeReadInjectionMembers(deps);
    const explained = await members.explainNativeReadInjection({ instanceId: "inst-1" });
    expect(explained.verifiedNames).toEqual(["ewpa-get-post"]);
    expect(requireUse).not.toHaveBeenCalled();
  });
});
