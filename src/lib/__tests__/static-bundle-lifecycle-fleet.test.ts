// WHICH FLEET THE IMAGE CARRIES decides the boot seed set (engineering#666).
//
// Two images, one seeder. A REQUIRED-only image — the road every real deployment
// takes — must keep today's seed set exactly: bundled serverEntry packages plus
// bundled required-in-prod packages plus their transitive required closure, and
// nothing else. A DEV-FLEET image — a preview / proof instance — must register
// every package of its OWN manifest in the catalogue, of every kind, and must
// additionally seed the chat-resolvable `agent_templates` record for its agents,
// because the run resolver reads THAT table and an `installed_extension` anchor
// does not satisfy it.
//
// Kept in its own file so the four existing static-bundle suites keep their
// fixtures and their assertions untouched; the seeder's mock surface is the same
// one they use, plus the fleet reader and the agent-template seam.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";

const readInstalledExtensionsByPackageName = vi.fn();
const installExtensionManifest = vi.fn();
const sourceSwitchExtension = vi.fn();
const recordExtensionAccessDeclaration = vi.fn();
const isPackageRequiredInProd = vi.fn<(pkg: string) => boolean>(() => false);
const readBundledFleet = vi.fn<() => string>(() => "required");
type AgentTemplateSeedOutcome = {
  outcome: string;
  templateId?: string;
  versionId?: string;
  reason?: string;
};
const ensureBundledAgentTemplateRecord = vi.fn<
  (...args: unknown[]) => Promise<AgentTemplateSeedOutcome>
>(async () => ({ outcome: "created", templateId: "tpl_1", versionId: "ver_1" }));
const resolveRequiredOasSeedDir = vi.fn(() => ({ seedDir: "/app/.cinatra-required-oas-seed", source: "image-default" }));

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: (...args: unknown[]) =>
    readInstalledExtensionsByPackageName(...args),
}));
vi.mock("@cinatra-ai/extensions/lifecycle-primitive", () => ({
  installExtensionManifest: (...args: unknown[]) => installExtensionManifest(...args),
  sourceSwitchExtension: (...args: unknown[]) => sourceSwitchExtension(...args),
  recordExtensionAccessDeclaration: (...args: unknown[]) =>
    recordExtensionAccessDeclaration(...args),
}));
vi.mock("@cinatra-ai/extensions/required-in-prod", () => ({
  isPackageRequiredInProd: (pkg: string) => isPackageRequiredInProd(pkg),
}));
vi.mock("@/lib/bundled-digests", () => ({
  readRecordedBundledDigests: () => new Map(),
}));
vi.mock("@/lib/bundled-fleet", () => ({
  BUNDLED_FLEET_REQUIRED: "required",
  BUNDLED_FLEET_DEV: "dev",
  readBundledFleet: () => readBundledFleet(),
}));
// The seeder module is reached by a DYNAMIC import inside the seeder. A getter
// lets one test make that import itself fail (a missing export condition in a
// traced standalone build, a throwing module initializer) instead of only the
// call it returns.
let seederModuleLoadError: Error | null = null;
vi.mock("@cinatra-ai/agents/seed-bundled-agent-template", () => ({
  get ensureBundledAgentTemplateRecord() {
    if (seederModuleLoadError) throw seederModuleLoadError;
    return (...args: unknown[]) => ensureBundledAgentTemplateRecord(...(args as []));
  },
}));
vi.mock("@/lib/required-extension-materialize", () => ({
  resolveRequiredOasSeedDir: () => resolveRequiredOasSeedDir(),
}));

// The image's own manifest, as the presence-aware regeneration would emit it for
// a dev-fleet image: ONE serverEntry connector (the base seed of today), its
// required dependency (today's closure), and four fleet packages of four kinds
// that today's seed set does NOT reach — including the agent the chat could not
// dispatch.
const SERVER_ENTRY_CONNECTOR = "@cinatra-ai/bundled-connector";
const REQUIRED_DEP = "@cinatra-ai/dep-connector";
const FLEET_CONNECTOR = "@cinatra-ai/ui-only-connector";
const FLEET_ARTIFACT = "@cinatra-ai/blog-idea-artifact";
const FLEET_SKILL = "@cinatra-ai/context-selection-skill";
const FLEET_AGENT = "@cinatra-ai/blog-idea-generator-agent";

vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_RECORDS: [
    {
      packageName: "@cinatra-ai/bundled-connector",
      kind: "connector",
      version: "0.1.0",
      serverEntry: "./register",
      requestedHostPorts: [],
      sdkAbiRange: null,
      accessConfig: { formatVersion: 1, access: { scope: { default: "workspace" } } },
      dependencies: [
        {
          packageName: "@cinatra-ai/dep-connector",
          kind: "connector",
          edgeType: "runtime",
          versionConstraint: { kind: "semver-range", range: "*" },
          requirement: "required",
        },
      ],
    },
    {
      packageName: "@cinatra-ai/dep-connector",
      kind: "connector",
      version: "0.1.0",
      serverEntry: null,
      requestedHostPorts: [],
      sdkAbiRange: null,
      accessConfig: { formatVersion: 1, access: { scope: { default: "workspace" } } },
      dependencies: [],
    },
    {
      packageName: "@cinatra-ai/ui-only-connector",
      kind: "connector",
      version: "0.1.0",
      serverEntry: null,
      requestedHostPorts: [],
      sdkAbiRange: null,
      accessConfig: { formatVersion: 1, access: { scope: { default: "workspace" } } },
      dependencies: [],
    },
    {
      packageName: "@cinatra-ai/blog-idea-artifact",
      kind: "artifact",
      version: "0.2.0",
      serverEntry: null,
      requestedHostPorts: [],
      sdkAbiRange: null,
      dependencies: [],
    },
    {
      packageName: "@cinatra-ai/context-selection-skill",
      kind: "skill",
      version: "0.3.0",
      serverEntry: null,
      requestedHostPorts: [],
      sdkAbiRange: null,
      dependencies: [],
    },
    {
      packageName: "@cinatra-ai/blog-idea-generator-agent",
      kind: "agent",
      version: "0.4.0",
      serverEntry: null,
      requestedHostPorts: [],
      sdkAbiRange: null,
      dependencies: [],
    },
  ],
  GENERATED_EXTENSION_SERVER_ENTRIES: {},
}));

import { staticBundleAnchorSource } from "@cinatra-ai/extensions/static-bundle-anchor";

const row = (over: Partial<InstalledExtension>): InstalledExtension => ({
  id: "iext_x",
  packageName: SERVER_ENTRY_CONNECTOR,
  ownerLevel: "platform",
  ownerId: null,
  organizationId: null,
  kind: "connector",
  status: "active",
  source: staticBundleAnchorSource(SERVER_ENTRY_CONNECTOR, "0.1.0"),
  requiredInProd: false,
  dependencies: [],
  manifestHash: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

async function runSeeder() {
  const { ensureStaticBundleLifecycleAnchors } = await import("@/lib/static-bundle-lifecycle");
  return ensureStaticBundleLifecycleAnchors();
}

/** Every package name the run passed to installExtensionManifest. */
const anchoredNames = (): string[] =>
  installExtensionManifest.mock.calls.map((c) => (c[0] as { packageName: string }).packageName);

describe("the boot seed set follows the image's fleet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CINATRA_RUNTIME_MODE", "development");
    readBundledFleet.mockReturnValue("required");
    resolveRequiredOasSeedDir.mockReturnValue({
      seedDir: "/app/.cinatra-required-oas-seed",
      source: "image-default",
    });
    ensureBundledAgentTemplateRecord.mockResolvedValue({
      outcome: "created",
      templateId: "tpl_1",
      versionId: "ver_1",
    });
    installExtensionManifest.mockImplementation(async (r: Record<string, unknown>) => ({
      ...row({}),
      ...r,
    }));
    sourceSwitchExtension.mockImplementation(async (id: string) => row({ id }));
    readInstalledExtensionsByPackageName.mockResolvedValue([]);
    seederModuleLoadError = null;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // ── the deployment road ──────────────────────────────────────────────────
  it("a REQUIRED-only image seeds exactly today's set: the serverEntry package and its required closure", async () => {
    readBundledFleet.mockReturnValue("required");
    const result = await runSeeder();
    expect(anchoredNames().sort()).toEqual([REQUIRED_DEP, SERVER_ENTRY_CONNECTOR].sort());
    expect(result.seededLive.sort()).toEqual([REQUIRED_DEP, SERVER_ENTRY_CONNECTOR].sort());
    expect(anchoredNames()).not.toContain(FLEET_AGENT);
    expect(anchoredNames()).not.toContain(FLEET_ARTIFACT);
    expect(anchoredNames()).not.toContain(FLEET_SKILL);
    expect(anchoredNames()).not.toContain(FLEET_CONNECTOR);
  });

  it("a required-only image never seeds an agent template record", async () => {
    readBundledFleet.mockReturnValue("required");
    const result = await runSeeder();
    expect(ensureBundledAgentTemplateRecord).not.toHaveBeenCalled();
    expect(result.seededAgentTemplates).toEqual([]);
  });

  it("an image with NO fleet marker is read as required — the seed set is today's", async () => {
    // The reader's own fail-soft default; pinned here at the seeder so a boot
    // can never widen its catalogue because a marker file was unreadable.
    readBundledFleet.mockReturnValue("required");
    await runSeeder();
    expect(anchoredNames().sort()).toEqual([REQUIRED_DEP, SERVER_ENTRY_CONNECTOR].sort());
  });

  // ── the preview road ─────────────────────────────────────────────────────
  it("a DEV-FLEET image anchors EVERY record of its own manifest, of every kind", async () => {
    readBundledFleet.mockReturnValue("dev");
    const result = await runSeeder();
    expect(anchoredNames().sort()).toEqual(
      [
        SERVER_ENTRY_CONNECTOR,
        REQUIRED_DEP,
        FLEET_CONNECTOR,
        FLEET_ARTIFACT,
        FLEET_SKILL,
        FLEET_AGENT,
      ].sort(),
    );
    expect(result.seededLive).toHaveLength(6);
    // The anchor row carries the record's own kind — an artifact is anchored as
    // an artifact, not coerced to a connector.
    const kinds = Object.fromEntries(
      installExtensionManifest.mock.calls.map((c) => {
        const arg = c[0] as { packageName: string; kind: string };
        return [arg.packageName, arg.kind];
      }),
    );
    expect(kinds[FLEET_ARTIFACT]).toBe("artifact");
    expect(kinds[FLEET_SKILL]).toBe("skill");
    expect(kinds[FLEET_AGENT]).toBe("agent");
  });

  it("a DEV-FLEET image seeds the chat-resolvable record for its AGENT packages, from the image's OAS seed", async () => {
    readBundledFleet.mockReturnValue("dev");
    const result = await runSeeder();
    expect(ensureBundledAgentTemplateRecord).toHaveBeenCalledTimes(1);
    expect(ensureBundledAgentTemplateRecord).toHaveBeenCalledWith({
      packageName: FLEET_AGENT,
      packageVersion: "0.4.0",
      seedDir: "/app/.cinatra-required-oas-seed",
    });
    expect(result.seededAgentTemplates).toEqual([FLEET_AGENT]);
    expect(result.agentTemplateFailed).toEqual([]);
  });

  it("an agent whose template row already exists is not reported as seeded (idempotent across boots)", async () => {
    readBundledFleet.mockReturnValue("dev");
    ensureBundledAgentTemplateRecord.mockResolvedValue({ outcome: "exists" });
    const result = await runSeeder();
    expect(result.seededAgentTemplates).toEqual([]);
    expect(result.agentTemplateFailed).toEqual([]);
  });

  it("a template seed failure is loud, per package, and never blocks the boot", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    readBundledFleet.mockReturnValue("dev");
    ensureBundledAgentTemplateRecord.mockRejectedValue(new Error("oas did not compile"));
    const result = await runSeeder();
    expect(result.agentTemplateFailed).toEqual([FLEET_AGENT]);
    expect(result.seededAgentTemplates).toEqual([]);
    // The anchors still all landed — only the chat dispatch is missing.
    expect(anchoredNames()).toHaveLength(6);
    expect(errorSpy).toHaveBeenCalled();
  });

  // The two paths a NOT-LIVE blacklist cannot see. The template pass must run
  // for packages this seeder POSITIVELY established as live this run, and for
  // no others — a package whose state the loop never established is left alone.
  it("an agent whose archived anchor is found only by the recovery re-read gets no template row", async () => {
    readBundledFleet.mockReturnValue("dev");
    const archived = row({
      id: "iext_agent",
      packageName: FLEET_AGENT,
      kind: "agent",
      status: "archived",
      source: staticBundleAnchorSource(FLEET_AGENT, "0.4.0"),
    });
    let agentReads = 0;
    readInstalledExtensionsByPackageName.mockImplementation(async (pkg: string) => {
      if (pkg !== FLEET_AGENT) return [];
      agentReads += 1;
      // The canonical read fails once (a transient store error); the outer
      // catch re-reads and finds the package's ARCHIVED tombstone, which it
      // correctly treats as "already anchored, nothing to do".
      if (agentReads === 1) throw new Error("transient store read failure");
      return [archived];
    });
    const result = await runSeeder();
    expect(agentReads).toBe(2);
    expect(ensureBundledAgentTemplateRecord).not.toHaveBeenCalled();
    expect(result.seededAgentTemplates).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("an agent whose anchor write failed gets no template row (no chat record without a row)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    readBundledFleet.mockReturnValue("dev");
    installExtensionManifest.mockImplementation(async (r: Record<string, unknown>) => {
      if ((r as { packageName: string }).packageName === FLEET_AGENT) {
        throw new Error("anchor insert failed");
      }
      return { ...row({}), ...r };
    });
    const result = await runSeeder();
    expect(result.failed).toEqual([FLEET_AGENT]);
    expect(ensureBundledAgentTemplateRecord).not.toHaveBeenCalled();
    expect(result.seededAgentTemplates).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("an agent whose LIVE anchor is found only by the recovery re-read still gets its template row", async () => {
    // The counterpart of the archived-recovery case above. A concurrent boot
    // won the insert and wrote a LIVE anchor; our write threw and the recovery
    // re-read found that row. The package IS live, so the chat must be able to
    // dispatch it — establishing liveness from the recovered row's own status
    // is what keeps the benign direction benign.
    readBundledFleet.mockReturnValue("dev");
    const live = row({
      id: "iext_agent",
      packageName: FLEET_AGENT,
      kind: "agent",
      status: "active",
      source: staticBundleAnchorSource(FLEET_AGENT, "0.4.0"),
    });
    let agentReads = 0;
    readInstalledExtensionsByPackageName.mockImplementation(async (pkg: string) => {
      if (pkg !== FLEET_AGENT) return [];
      agentReads += 1;
      if (agentReads === 1) throw new Error("transient store read failure");
      return [live];
    });
    const result = await runSeeder();
    expect(agentReads).toBe(2);
    expect(ensureBundledAgentTemplateRecord).toHaveBeenCalledTimes(1);
    expect(ensureBundledAgentTemplateRecord).toHaveBeenCalledWith({
      packageName: FLEET_AGENT,
      packageVersion: "0.4.0",
      seedDir: "/app/.cinatra-required-oas-seed",
    });
    expect(result.seededAgentTemplates).toEqual([FLEET_AGENT]);
    expect(result.failed).toEqual([]);
  });

  it("a seeder that cannot even be PREPARED is loud and still returns the anchors", async () => {
    // Module load and seed-directory resolution share one boundary because they
    // share one outcome. Neither may reject the seeder: the anchors already
    // written above would be thrown away with the result that reports them.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    readBundledFleet.mockReturnValue("dev");
    seederModuleLoadError = new Error("export condition missing in the traced build");
    const result = await runSeeder();
    expect(anchoredNames()).toHaveLength(6);
    expect(result.seededAgentTemplates).toEqual([]);
    expect(result.agentTemplateFailed).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("an unresolvable image OAS seed directory is loud and still returns the anchors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    readBundledFleet.mockReturnValue("dev");
    resolveRequiredOasSeedDir.mockImplementation(() => {
      throw new Error("no seed directory in this image");
    });
    const result = await runSeeder();
    expect(anchoredNames()).toHaveLength(6);
    expect(ensureBundledAgentTemplateRecord).not.toHaveBeenCalled();
    expect(result.seededAgentTemplates).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("an ARCHIVED bundled agent is never given a template row (a retirement is not resurrected)", async () => {
    readBundledFleet.mockReturnValue("dev");
    readInstalledExtensionsByPackageName.mockImplementation(async (pkg: string) =>
      pkg === FLEET_AGENT
        ? [row({ id: "iext_agent", packageName: FLEET_AGENT, kind: "agent", status: "archived", source: staticBundleAnchorSource(FLEET_AGENT, "0.4.0") })]
        : [],
    );
    const result = await runSeeder();
    expect(ensureBundledAgentTemplateRecord).not.toHaveBeenCalled();
    expect(result.seededAgentTemplates).toEqual([]);
  });
});
