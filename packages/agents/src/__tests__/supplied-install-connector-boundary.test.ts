/**
 * WHAT THE SUPPLIED ROAD PROMISES FOR A CONNECTOR, AND WHAT IT DOES NOT
 * (cinatra#3204 leg 3 — criteria 21, 22, 27).
 *
 * The issue is explicit that "success is not promised for every connector
 * package", and leg 1 settled HOW that refusal happens: a connector's whole
 * install exists to run `register(ctx)` in this process, so an unsigned supplied
 * connector is refused by the trust gate rather than activated. Criterion 27's
 * per-kind execution boundary is the same fact stated from the other side.
 *
 * A refusal is only honest if the operator can read it. These are the claims:
 *
 *   - a connector package is ACCEPTED at the door — the kind resolves, the scope
 *     question is asked — so the refusal happens where the reason is known, not
 *     as a file the screen would not take;
 *   - the TYPED `REQUIRES_REBUILD` state arrives as a named state with the
 *     packageName in it, never as a generic "the install failed";
 *   - a refusal whose own words are addressed to whoever maintains the install
 *     chain — the execution boundary's, and the access-declaration chain's —
 *     reaches the admin as ONE short sentence in product words, with the
 *     diagnostics written to the server log;
 *   - a refused install writes no access policy and rolls nothing back that it
 *     did not create.
 *
 * And the anchor claim criterion 22 names: the compensation addresses the row at
 * the CHOSEN identity and nothing else, so a coexisting bundled PLATFORM anchor
 * for the same package name is never read and never uninstalled.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { resolveAbsentConnectorAccessConfig } from "@cinatra-ai/sdk-extensions/access-config";
import { classifyExtensionTrust, UntrustedInstallRefusedError } from "@/lib/extension-trust";

const session = vi.hoisted(() => ({
  user: { id: "u1" },
  session: { activeOrganizationId: "org-1" },
}));
vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: vi.fn(async () => session),
  buildCanDoOptsFromSession: vi.fn(async () => ({ orgRole: "org_admin" })),
}));
vi.mock("../install-target-authz", () => ({
  readActorRolesForInstall: vi.fn(() => ({ principalId: "u1", organizationId: "org-1" })),
  assertTargetBelongsToActiveOrg: vi.fn(async () => ({ projectOwnership: null })),
  assertCanInstallAtTarget: vi.fn(async () => undefined),
}));

const road = vi.hoisted(() => ({
  prepareSuppliedArchiveSnapshot: vi.fn(async () => ({
    package: {
      kind: "connector",
      packageName: "@acme/thing-connector",
      version: "1.0.0",
      contentDigest: "a".repeat(64),
      provenance: { type: "local", path: "x.tgz", contentDigest: "a".repeat(64) },
    },
    tarball: new Uint8Array([1]),
    provenance: { type: "local", path: "x.tgz", contentDigest: "a".repeat(64) },
    validatorRan: true,
  })),
  candidateFromPreparedArchive: vi.fn(
    (p: { package: Record<string, unknown>; provenance: unknown; validatorRan: boolean }) => ({
      kind: p.package.kind,
      packageName: p.package.packageName,
      version: p.package.version,
      provenance: p.provenance,
      validatorRan: p.validatorRan,
    }),
  ),
  installSuppliedCandidate: vi.fn(async () => undefined),
  prepareSuppliedRepositorySnapshot: vi.fn(),
}));
vi.mock("@/lib/supplied-package-install", () => road);

const store = vi.hoisted(() => ({
  readInstalledExtensionByIdentity: vi.fn(
    async (_identity?: unknown) => null as Record<string, unknown> | null,
  ),
}));
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionByIdentity: (...a: unknown[]) =>
    store.readInstalledExtensionByIdentity(...(a as [])),
}));

const access = vi.hoisted(() => ({ setExtensionInstallAccess: vi.fn(async () => undefined) }));
vi.mock("@cinatra-ai/extensions/install-access-contract", () => access);

const registry = vi.hoisted(() => ({
  extensionRegistry: { uninstall: vi.fn(async () => undefined) },
}));
vi.mock("@cinatra-ai/extensions", () => registry);

vi.mock("../materialize-agent-package", () => ({
  withInstallLock: (_p: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("../store", () => ({ readAgentTemplateByPackageName: vi.fn(async () => ({ id: "t" })) }));
vi.mock("@/lib/archive-supplied-install", () => ({
  previewSuppliedArchive: vi.fn(async () => ({
    kind: "connector",
    packageName: "@acme/thing-connector",
    version: "1.0.0",
    contentDigest: "a".repeat(64),
  })),
}));

import {
  installSuppliedArchiveAction,
  previewSuppliedArchiveAction,
} from "../supplied-install-actions";

const ZIP = Buffer.from("zip").toString("base64");
const TARGET = { level: "workspace", id: "org-1" };

/**
 * THE ACCESS-DECLARATION REFUSAL, exactly as it reaches this boundary: the SDK
 * validator's own words, wrapped by `extension-runtime-activate`'s SUPPLIED-row
 * reason token and then by the dispatcher's non-finalized-row sentence — the
 * shape measured on a running instance. Built from the REAL SDK refusal rather
 * than pasted, so a reword
 * upstream fails this suite instead of leaving it testing a message nobody
 * throws.
 */
function absentAccessConfigMessage(packageName: string): string {
  try {
    resolveAbsentConnectorAccessConfig({ packageName, surface: "install" });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected the absence rule to refuse, but it returned");
}

const ACCESS_CONFIG_CHAIN_REFUSAL =
  `install of @acme/thing-connector did not finalize the real-integrity pipeline ` +
  `(supplied-install-failed:${absentAccessConfigMessage("@acme/thing-connector")}) — the package is ` +
  `not anchorable; the placeholder install row was rolled back so a re-install re-runs the pipeline.`;

/**
 * THE EXECUTION BOUNDARY'S REFUSAL, built from the REAL chain rather than
 * paraphrased: the classifier's verdict words, composed by the refusal the
 * pipeline raises, wrapped by the activator's supplied-row reason token and the
 * dispatcher's non-finalized-row sentence — the shape read off a running
 * instance's toast surface.
 */
const TRUST_REFUSAL =
  `install of @acme/thing-connector did not finalize the real-integrity pipeline ` +
  `(supplied-install-failed:${new UntrustedInstallRefusedError(
    "@acme/thing-connector",
    "1.0.0",
    classifyExtensionTrust({
      packageName: "@acme/thing-connector",
      registryUrl: "supplied:operator",
      integrityVerified: true,
      persistedTrustDecision: true,
      trustedActivationHosts: [],
      allowMarketplaceBootstrapTrust: false,
    }).reason,
    "install",
  ).message}) — the package is not anchorable; the placeholder install row was rolled back so a ` +
  `re-install re-runs the pipeline.`;

beforeEach(() => {
  vi.clearAllMocks();
  store.readInstalledExtensionByIdentity.mockResolvedValue(null as never);
  road.installSuppliedCandidate.mockResolvedValue(undefined as never);
});

describe("a connector is taken at the door and refused where the reason is known", () => {
  it("resolves the connector kind on preview, so the scope question is still asked", async () => {
    const result = await previewSuppliedArchiveAction(ZIP);
    expect(result.ok).toBe(true);
    expect(result.ok && result.preview.kind).toBe("connector");
  });

  it("surfaces the TYPED requires-rebuild state by name, not as a generic failure", async () => {
    road.installSuppliedCandidate.mockRejectedValue(
      Object.assign(new Error("ships a bundled React setup page"), {
        code: "REQUIRES_REBUILD",
      }) as never,
    );

    const result = await installSuppliedArchiveAction({
      zipBase64: ZIP,
      accessTarget: TARGET,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.stage).toBe("requires-rebuild");
    expect(result.ok === false && result.error).toContain("@acme/thing-connector");
    expect(result.ok === false && result.error).toMatch(/rebuild/i);
    // Nothing was recorded for a package that never installed.
    expect(access.setExtensionInstallAccess).not.toHaveBeenCalled();
    expect(registry.extensionRegistry.uninstall).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // THE EXECUTION BOUNDARY'S REFUSAL IS THE SAME AUDIENCE PROBLEM. Its own words
  // name the install-op journal, the host-port grant, the materialized bytes,
  // anchorability and what happened to the placeholder row: every one of them
  // true, every one of them written for whoever maintains the install chain. On
  // the toast surface that is a paragraph, so this path is answered in product
  // words too — and, exactly as on the access-declaration path, the diagnostics
  // are written to the server log rather than thrown away.
  // -------------------------------------------------------------------------
  it("answers the execution boundary's refusal in product words and logs the diagnostics", async () => {
    const serverLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    road.installSuppliedCandidate.mockRejectedValue(new Error(TRUST_REFUSAL) as never);

    const result = await installSuppliedArchiveAction({
      zipBase64: ZIP,
      accessTarget: TARGET,
    });

    expect(result.ok).toBe(false);
    const shown = result.ok === false ? result.error : "";

    expect(shown).not.toMatch(/pipeline-threw|supplied-install-failed/);
    expect(shown).not.toMatch(/install-op journal|host-port grant|materialized bytes/i);
    expect(shown).not.toMatch(/activation host/i);
    expect(shown).not.toMatch(/roll(?:ed|s|ing)?[ -]?back/i);
    expect(shown.length).toBeLessThan(160);
    expect(shown.match(/[.!?]/g) ?? []).toHaveLength(1);

    // The diagnostics are not lost — they go to the server log.
    expect(serverLog).toHaveBeenCalled();
    expect(
      (serverLog.mock.calls as unknown[][]).flat().map(String).join(" "),
    ).toContain(TRUST_REFUSAL);

    expect(result.ok === false && result.stage).toBeUndefined();
    expect(access.setExtensionInstallAccess).not.toHaveBeenCalled();
    serverLog.mockRestore();
  });

  // -------------------------------------------------------------------------
  // THE ONE REFUSAL WHOSE OWN WORDS ARE NOT THE OPERATOR'S.
  //
  // "In the words of whatever refused it" is the right rule while those words
  // are addressed to whoever can act on them. The access-declaration chain is
  // addressed to whoever maintains the install chain: it names the config file,
  // the internal issue that closed the absence rule, the activator's failure
  // token and what the dispatcher did to the placeholder row. Composed, that is
  // a paragraph — and a paragraph on the toast surface is not a refusal the
  // admin can read, it is a refusal that pushes itself off the screen.
  //
  // So this ONE refusal is answered in product words, and the diagnostics are
  // written to the server log instead of being thrown away.
  // -------------------------------------------------------------------------
  it("answers the access-declaration refusal in product words and logs the diagnostics", async () => {
    const serverLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    road.installSuppliedCandidate.mockRejectedValue(
      new Error(ACCESS_CONFIG_CHAIN_REFUSAL) as never,
    );

    const result = await installSuppliedArchiveAction({
      zipBase64: ZIP,
      accessTarget: TARGET,
    });

    expect(result.ok).toBe(false);
    const shown = result.ok === false ? result.error : "";

    // No internal token, no issue reference, no rollback prose, one short
    // sentence — and it says what the package lacks and what it must declare.
    expect(shown).not.toMatch(
      /pipeline-threw|supplied-install-failed|\[connector-access-config\]|cinatra\/config\.json/,
    );
    expect(shown).not.toMatch(/cinatra#\d+/);
    expect(shown).not.toMatch(/roll(?:ed|s|ing)?[ -]?back/i);
    expect(shown.length).toBeLessThan(160);
    expect(shown.match(/[.!?]/g) ?? []).toHaveLength(1);
    expect(shown).toMatch(/configuration/i);
    expect(shown).toMatch(/access scope/i);

    // The diagnostics are not lost — they go to the server log.
    expect(serverLog).toHaveBeenCalled();
    expect(
      (serverLog.mock.calls as unknown[][]).flat().map(String).join(" "),
    ).toContain(ACCESS_CONFIG_CHAIN_REFUSAL);

    expect(access.setExtensionInstallAccess).not.toHaveBeenCalled();
    serverLog.mockRestore();
  });
});

describe("the compensation addresses the CHOSEN row and nothing else (criterion 22)", () => {
  it("never reads or uninstalls a row at an anchor the operator did not choose", async () => {
    access.setExtensionInstallAccess.mockRejectedValue(new Error("policy write failed") as never);
    store.readInstalledExtensionByIdentity.mockImplementation(async (identity: unknown) => {
      const id = identity as { ownerLevel: string };
      // A bundled PLATFORM anchor for the same package name exists. It must
      // never be the row this road reads, because it is not the row it wrote.
      if (id.ownerLevel === "platform") return { id: "bundled", kind: "connector", status: "active" };
      return { id: "chosen", kind: "connector", status: "active" };
    });

    await installSuppliedArchiveAction({ zipBase64: ZIP, accessTarget: TARGET });

    const levels = (
      store.readInstalledExtensionByIdentity.mock.calls as unknown as unknown[][]
    ).map(
      (c) => (c[0] as { ownerLevel: string }).ownerLevel,
    );
    expect(levels.length).toBeGreaterThan(0);
    expect(levels).not.toContain("platform");
    expect(new Set(levels)).toEqual(new Set(["workspace"]));
  });
});
