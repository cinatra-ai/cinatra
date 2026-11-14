/**
 * cinatra#4158 — a production-mode boot claims the artifact types of an
 * image-bundled artifact package.
 *
 * The static-bundle seeder writes the package's platform `installed_extension`
 * row as active but no `artifact_type_claims` row, and the repair that seeds
 * the claims (`healArtifactInstallRecordAndClaims`, cinatra#2536) used to run
 * only from the development scan. These cases boot through the REAL
 * orchestrator in production mode and run the REAL install-record probe and
 * heal; the canonical rows and the claim registry are held in memory, and the
 * claim-activation backstop is replaced by an in-memory one that keeps its
 * contract (one claim per scope and type, a matching claim is a no-op), so the
 * reading is exactly which packages the boot hands to the repair and what the
 * organization's claim chain (platform + org) reads afterwards.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type Row = {
  id: string;
  packageName: string;
  status: string;
  organizationId: string | null;
  kind: string;
  isDefault: boolean;
  version: string;
  source: { type: string; version?: string };
};
type Claim = {
  id: string;
  scope: string;
  extensionPackage: string;
  type: string;
  status: "active";
  installId: string;
};

const h = vi.hoisted(() => ({
  rows: new Map<string, Row[]>(),
  claims: [] as Claim[],
  records: [] as Array<{ packageName: string; kind: string; version: string; sourceDir: string | null }>,
  backstopCalls: [] as Array<Array<{ packageName: string; storeDir: string }>>,
  installRow: vi.fn(async () => {}),
}));

// ── the boot sequence around the phase under test (as boot-orchestrator.test.ts) ──
vi.mock("@/lib/boot/boot-state", () => ({ beginBoot: vi.fn(), markBootReady: vi.fn() }));
vi.mock("@/lib/boot/phases/core-boot", () => ({
  coreBootPhases: () => [{ name: "core-x", policy: "retryable", run: async () => {} }],
}));
vi.mock("@/lib/boot/phases/schema-version-precondition", () => ({
  schemaVersionPreconditionPhases: () => [
    { name: "schema-version-precondition", policy: "fatal", run: async () => {} },
  ],
}));
vi.mock("@/lib/boot/phases/extension-activation", () => ({
  extensionActivationPhases: () => [{ name: "ext-x", policy: "retryable", run: async () => {} }],
}));
vi.mock("@/lib/boot/phases/required-extension-materialize", () => ({
  requiredExtensionMaterializePhases: () => [
    { name: "required-extension-materialize", policy: "fatal", run: async () => {} },
  ],
}));
vi.mock("@/lib/boot/phases/agent-mount-projection", () => ({
  agentMountProjectionPhases: () => [{ name: "agent-mount-projection", policy: "degraded", run: async () => {} }],
}));
vi.mock("@/lib/boot/phases/agent-marker-backfill", () => ({
  agentMarkerBackfillPhases: () => [{ name: "agent-marker-backfill", policy: "degraded", run: async () => {} }],
}));
vi.mock("@/lib/boot/phases/agent-runtime-dep-backfill", () => ({
  agentRuntimeDepBackfillPhases: () => [
    { name: "agent-runtime-dep-backfill", policy: "retryable", run: async () => {} },
  ],
}));
vi.mock("@/lib/boot/phases/agent-template-org-reconcile", () => ({
  agentTemplateOrgReconcilePhases: () => [
    { name: "agent-template-org-reconcile", policy: "degraded", run: async () => {} },
  ],
}));
vi.mock("@/lib/boot/phases/bundled-skill-registration", () => ({
  bundledSkillRegistrationPhases: () => [
    { name: "bundled-skill-registration", policy: "degraded", run: async () => {} },
  ],
}));
vi.mock("@/lib/boot/phases/skills-catalog-rebuild", () => ({
  skillsCatalogRebuildPhases: () => [{ name: "skills-catalog-rebuild", policy: "degraded", run: async () => {} }],
}));
vi.mock("@/lib/boot/phases/system-services", () => ({
  systemServicesPhases: () => [
    { name: "services-1", policy: "retryable", run: async () => {} },
    { name: "services-2", policy: "degraded", run: async () => {} },
    { name: "services-3", policy: "degraded", run: async () => {} },
    { name: "services-4", policy: "retryable", run: async () => {} },
  ],
}));
vi.mock("@/lib/boot/phases/system-loops", () => ({
  systemLoopPhases: () => [{ name: "loops-x", policy: "retryable", run: async () => {} }],
}));
vi.mock("@/lib/boot/phases/required-env-note", () => ({
  requiredEnvNotePhases: () => [{ name: "required-env-soft-check", policy: "retryable", run: async () => {} }],
}));
vi.mock("@/lib/boot/phases/user-store-mount-check", () => ({
  userStoreMountCheckPhases: () => [{ name: "user-store-mount-check", policy: "retryable", run: async () => {} }],
}));
vi.mock("@/lib/boot/phases/artifact-data-root-guard", () => ({
  artifactDataRootGuardPhases: () => [
    { name: "artifact-data-root-guard", policy: "retryable", run: async () => {} },
  ],
}));
vi.mock("@/lib/boot/phases/boot-degrade-probe", () => ({
  bootDegradeProbePhases: () => [{ name: "boot-degrade-probe", policy: "degraded", run: async () => {} }],
}));
vi.mock("@/lib/boot/phases/provider-connection-bootstrap", () => ({
  providerConnectionBootstrapPhases: () => [
    { name: "provider-connection-bootstrap", policy: "retryable", run: async () => {} },
  ],
}));
vi.mock("@/lib/boot/phases/dev-boot", () => ({
  devAgentIngestPhases: () => [{ name: "dev-agent-ingest", policy: "dev-only", run: async () => {} }],
  devAwaitedPhases: () => [{ name: "a2a-dev-auto-connect", policy: "dev-only", run: async () => {} }],
  startDetachedDevExtensionsPhase: vi.fn(),
  startDetachedDevAutoSetupPhase: vi.fn(),
}));

// ── the image's bundled records, the canonical rows and the claim registry ──
vi.mock("@/lib/generated/extensions.server", () => ({ STATIC_EXTENSION_RECORDS: h.records }));
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: async (packageName: string) => h.rows.get(packageName) ?? [],
}));
vi.mock("@cinatra-ai/extensions/lifecycle-primitive", () => ({ installExtensionManifest: h.installRow }));
vi.mock("@/lib/artifacts/ensure-artifact-registry", () => ({ ensureArtifactTypesRegistered: vi.fn() }));
vi.mock("@/lib/objects/artifact-claim-install-anchor", () => ({
  // The backstop's contract, in memory: per live row scope, activate each
  // manifest claim that is not already active there; a match is a no-op.
  runInstallAnchorClaimBackstop: async (records: Array<{ packageName: string; storeDir: string }>) => {
    h.backstopCalls.push(records.map((r) => ({ ...r })));
    const result = { converged: 0, failed: 0, skipped: 0 };
    for (const rec of records) {
      const pkg = JSON.parse(readFileSync(path.join(rec.storeDir, "package.json"), "utf8")) as {
        cinatra: { artifact: { objectTypes: Array<{ type: string }> } };
      };
      const live = (h.rows.get(rec.packageName) ?? []).filter((r) => r.status === "active" || r.status === "locked");
      if (live.length === 0) {
        result.skipped += 1;
        continue;
      }
      for (const row of live) {
        const scope = row.organizationId ? `org:${row.organizationId}` : "platform";
        for (const t of pkg.cinatra.artifact.objectTypes) {
          const held = h.claims.some(
            (c) => c.scope === scope && c.type === t.type && c.extensionPackage === rec.packageName,
          );
          if (!held) {
            h.claims.push({
              id: `claim-${h.claims.length + 1}`,
              scope,
              extensionPackage: rec.packageName,
              type: t.type,
              status: "active",
              installId: row.id,
            });
          }
        }
        result.converged += 1;
      }
    }
    return result;
  },
}));

import type { BootPhase } from "@/lib/boot/boot-phase";
import { runBoot } from "@/lib/boot/boot-orchestrator";
import { explainAbsentArtifactSafeClaims } from "@/lib/extension-install-anchor";

const ORG = "org-4158";
const BUNDLED = "@fixture/bundled-artifact";
const TYPE = "@fixture/bundled-artifact:note";
const ARCHIVED = "@fixture/archived-artifact";
const UNANCHORED = "@fixture/unanchored-artifact";
const CONNECTOR = "@fixture/bundled-connector";
const STORE = "@fixture/store-artifact";
const PHASE = "bundled-artifact-claim-heal";

let tmp = "";
let bundledDir = "";

function writePackage(dir: string, name: string, type: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name,
      version: "1.2.3",
      cinatra: { kind: "artifact", artifact: { objectTypes: [{ type, claim: "dedicated" }] } },
    }),
  );
}

function platformRow(packageName: string, status: string): Row {
  return {
    id: `iext_${packageName.split("/")[1]}`,
    packageName,
    status,
    organizationId: null,
    kind: "artifact",
    isDefault: true,
    version: "1.2.3",
    source: { type: "static-bundle", version: "1.2.3" },
  };
}

/** What the organization's claim chain reads: a platform claim or its own. */
function claimsGoverning(orgId: string, type: string): Claim[] {
  return h.claims.filter((c) => c.type === type && (c.scope === "platform" || c.scope === `org:${orgId}`));
}

/** A write of the artifact through the claim chain, refused as the materializer refuses it. */
function materialize(orgId: string, extension: string, type: string): { claimId: string } {
  const claim = claimsGoverning(orgId, type).find((c) => c.extensionPackage === extension);
  if (!claim) throw new Error(`no active artifact-safe claim for "${type}" in org "${orgId}"`);
  return { claimId: claim.id };
}

async function bootProduction(): Promise<string[]> {
  const order: string[] = [];
  await runBoot({
    isDevMode: () => false,
    isConnectorAutoSetupMode: () => false,
    runPhase: vi.fn(async (phase: BootPhase) => {
      order.push(phase.name);
      // Only the phase under test runs; every other phase is a name.
      if (phase.name === PHASE) await phase.run();
      return undefined as never;
    }),
  });
  return order;
}

beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "bundled-artifact-claim-heal-4158-"));
  bundledDir = path.join(tmp, "extensions", "fixture", "bundled-artifact");
  writePackage(bundledDir, BUNDLED, TYPE);
  writePackage(path.join(tmp, "extensions", "fixture", "archived-artifact"), ARCHIVED, `${ARCHIVED}:note`);
  writePackage(path.join(tmp, "extensions", "fixture", "unanchored-artifact"), UNANCHORED, `${UNANCHORED}:note`);
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  h.rows.clear();
  h.claims.length = 0;
  h.backstopCalls.length = 0;
  h.installRow.mockClear();
  h.records.length = 0;
  h.records.push(
    { packageName: BUNDLED, kind: "artifact", version: "1.2.3", sourceDir: bundledDir },
    {
      packageName: ARCHIVED,
      kind: "artifact",
      version: "1.2.3",
      sourceDir: path.join(tmp, "extensions", "fixture", "archived-artifact"),
    },
    {
      packageName: UNANCHORED,
      kind: "artifact",
      version: "1.2.3",
      sourceDir: path.join(tmp, "extensions", "fixture", "unanchored-artifact"),
    },
    { packageName: CONNECTOR, kind: "connector", version: "1.2.3", sourceDir: null },
  );
  h.rows.set(BUNDLED, [platformRow(BUNDLED, "active")]);
  h.rows.set(ARCHIVED, [platformRow(ARCHIVED, "archived")]);
  // A runtime-store package: installed for the organization, claimed by the
  // store backstop, and not one of the image's bundled records.
  h.rows.set(STORE, [
    {
      ...platformRow(STORE, "active"),
      organizationId: ORG,
      source: { type: "registry", version: "2.0.0" },
      version: "2.0.0",
    },
  ]);
  h.claims.push({
    id: "claim-store",
    scope: `org:${ORG}`,
    extensionPackage: STORE,
    type: `${STORE}:note`,
    status: "active",
    installId: `iext_store-artifact`,
  });
});

describe("cinatra#4158 — a production-mode boot claims image-bundled artifact types", () => {
  it("claims the image-bundled artifact package's types for the organization, and a write through that claim succeeds", async () => {
    expect(claimsGoverning(ORG, TYPE)).toHaveLength(0);
    expect(() => materialize(ORG, BUNDLED, TYPE)).toThrow(/no active artifact-safe claim/);

    await bootProduction();

    const governing = claimsGoverning(ORG, TYPE);
    expect(governing).toHaveLength(1);
    expect(governing[0]).toMatchObject({
      scope: "platform",
      extensionPackage: BUNDLED,
      status: "active",
      installId: `iext_bundled-artifact`,
    });
    expect(materialize(ORG, BUNDLED, TYPE)).toEqual({ claimId: governing[0]!.id });
  });

  it("a second production boot creates no duplicate claim and changes no existing claim", async () => {
    await bootProduction();
    expect(claimsGoverning(ORG, TYPE)).toHaveLength(1);
    const afterFirst = structuredClone(h.claims);

    await bootProduction();

    expect(h.claims).toEqual(afterFirst);
    expect(h.backstopCalls).toEqual([
      [{ packageName: BUNDLED, storeDir: bundledDir }],
      [{ packageName: BUNDLED, storeDir: bundledDir }],
    ]);
  });

  it("hands only the live bundled artifact package to the repair: no install row is written and runtime-store packages are unchanged", async () => {
    const storeClaimBefore = structuredClone(h.claims.find((c) => c.extensionPackage === STORE));

    await bootProduction();

    expect(h.backstopCalls).toEqual([[{ packageName: BUNDLED, storeDir: bundledDir }]]);
    expect(h.installRow).not.toHaveBeenCalled();
    for (const name of [ARCHIVED, UNANCHORED, CONNECTOR]) {
      expect(h.claims.filter((c) => c.extensionPackage === name)).toEqual([]);
    }
    expect(h.claims.filter((c) => c.extensionPackage === STORE)).toEqual([storeClaimBefore]);
    expect(h.rows.get(UNANCHORED)).toBeUndefined();
  });

  it("is an always-on phase right after extension activation, in development as in production", async () => {
    for (const dev of [false, true]) {
      const order: string[] = [];
      await runBoot({
        isDevMode: () => dev,
        isConnectorAutoSetupMode: () => false,
        runPhase: vi.fn(async (phase: { name: string; policy: string }) => {
          order.push(`${phase.name}:${phase.policy}`);
          return undefined as never;
        }),
      });
      expect(order.indexOf(`${PHASE}:retryable`)).toBe(order.indexOf("ext-x:retryable") + 1);
    }
  });

  it("the refusal's restart advice names the boot repair that claims a package shipped in the image", async () => {
    const message = await explainAbsentArtifactSafeClaims(
      { orgId: ORG, extension: BUNDLED, declaredObjectTypeIds: [TYPE] },
      { readRows: async () => [platformRow(BUNDLED, "active")] },
    );
    expect(message).toContain("Heal: restart the instance");
    expect(message).toContain("shipped in the image");
  });
});
