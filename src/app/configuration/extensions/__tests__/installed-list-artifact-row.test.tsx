/**
 * The installed list draws a marketplace-installed ARTIFACT pack (cinatra#3533).
 *
 * Design spec §III ("Installed extensions") opens: "Manage installed agents,
 * skills, connectors, and artifacts. Each installed extension is one horizontal
 * card … a white middle carrying the description, then the version with its
 * status beside it — a green check for Active …", and §III.3 makes Active /
 * Locked / Archived "a clean partition of the installed set … no row is dropped
 * or double-counted across views".
 *
 * A real marketplace install of an artifact pack was dropped from that list.
 * The artifact reader facet (`artifact-handler.ts` `listActive`) lists the
 * in-memory object-type registry, which is populated ONLY by the build-time
 * bundle scan (`registerArtifactExtensions`, rooted at the dev-bundle
 * `extensions/` directory) — a pack installed at runtime is never copied there,
 * registers no descriptor, and `loadInstalledCardRows` had a runtime-only union
 * for the connector kind alone, so the artifact install reached no row at all.
 *
 * This suite drives the REAL `loadInstalledCardRows` road (row collapse,
 * canonical annotation, the runtime-only unions, the kind/name sort) over
 * mocked ports, then renders the resulting row through the SAME card
 * composition `RegistryCatalogScreen.renderCard` uses, so the assertion is on
 * what the list draws: the row's name, its version and its state.
 *
 * The mocked coarse-gate readers mirror the real contract of
 * `runtime-discovery-host.ts` (`readActiveManifestsFromStore` /
 * `readArchivedManifestsFromStore`): one manifest per live/archived install
 * identity, filtered by the `kind` argument when one is given.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";
import {
  extensionKindEmblem,
  type ExtensionEmblemKind,
} from "@/components/extension-kind-emblem";
import {
  InstalledExtensionCard,
  InstalledStatusIndicator,
} from "@/components/extensions/installed-extension-card";
import { deriveExtensionAccent } from "@/lib/extension-accent";
import { resolveVendorPresentation } from "@/lib/vendor-presentation";

const ARTIFACT_PACKAGE = "@cinatra-ai/json-artifact";
const AGENT_PACKAGE = "@cinatra-ai/research-agent";
const CONNECTOR_PACKAGE = "@cinatra-ai/knowledge-base-connector";

/** Mutable fixture state the hoisted module factories read. */
const fixture = vi.hoisted(() => ({
  canonicalRows: [] as Array<Record<string, unknown>>,
  activeByKind: {} as Record<string, unknown[]>,
  archivedByKind: {} as Record<string, unknown[]>,
  registryPackages: [] as unknown[],
}));

vi.mock("@/lib/extensions", () => ({}));
vi.mock("@/lib/register-all-object-types", () => ({
  registerAllObjectTypes: vi.fn(),
}));
vi.mock("@/lib/verdaccio-config", () => ({
  loadVerdaccioConfigForReads: vi.fn(async () => ({ registryUrl: "http://registry.test" })),
}));
vi.mock("@/lib/generated/extensions.server", () => ({ STATIC_EXTENSION_MANIFEST: {} }));
vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(() => ({
    instanceNamespace: "acme",
    registries: { remote: { url: "http://registry.test" }, local: null },
  })),
}));
vi.mock("@/lib/marketplace-credentials", () => ({
  getEffectiveViewerScope: vi.fn(() => null),
}));
vi.mock("@/lib/extension-discovery-scope", () => ({
  resolveExtensionDiscoveryContext: vi.fn(async () => ({
    actor: { userId: "user_admin", actorType: "human", source: "ui" },
    scope: { userId: "user_admin", organizationId: null, teamIds: [] },
  })),
}));
// The root suite maps `@cinatra-ai/registries` to a narrow stub (the real
// barrel drags the pacote chain into the sandbox), so this factory supplies the
// three symbols the loader reads: the catalog read (mocked — this suite is
// about the rows, not the registry), its two page budgets (plain numbers on the
// heavy verdaccio client), and the REAL pure vendor-name resolver the byline
// resolves through.
vi.mock("@cinatra-ai/registries", async () => {
  const scope = await vi.importActual<{ resolveInstalledVendorName: unknown }>(
    "../../../../../packages/registries/src/scope",
  );
  return {
    resolveInstalledVendorName: scope.resolveInstalledVendorName,
    listExtensionPackages: vi.fn(async () => fixture.registryPackages),
    CATALOG_PACKUMENT_TIMEOUT_MS: 8_000,
    CATALOG_HYDRATION_BUDGET_MS: 12_000,
  };
});
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  listInstalledExtensions: vi.fn(async () => fixture.canonicalRows),
}));
vi.mock("@cinatra-ai/extensions/runtime-discovery-host", () => {
  const manifestOf = (row: Record<string, unknown>) => ({
    id: row.id,
    packageName: row.packageName,
    kind: row.kind,
    ownerLevel: row.ownerLevel,
    ownerId: row.ownerId,
    organizationId: row.organizationId,
    status: row.status,
  });
  // The real readers de-dupe by DISTINCT INSTALL IDENTITY
  // `(kind, packageName, ownerLevel, ownerId, organizationId)` — not by package
  // — so every owner scope a pack is live under reaches the shared visibility
  // gate (`runtime-discovery-host.ts`). The mock mirrors that key, its
  // active-over-locked preference within one identity, and the archived side's
  // "live wins" suppression, so a fixture can exercise several owner identities
  // of one package the way the real store would present them.
  const identityKey = (row: Record<string, unknown>) =>
    `${row.kind as string}::${row.packageName as string}::${row.ownerLevel as string}::${(row.ownerId as string | null) ?? ""}::${(row.organizationId as string | null) ?? ""}`;
  const liveManifests = (kind?: string) => {
    const live = new Map<string, ReturnType<typeof manifestOf>>();
    for (const row of fixture.canonicalRows) {
      const status = row.status as string;
      if (status !== "active" && status !== "locked") continue;
      if (kind !== undefined && row.kind !== kind) continue;
      const key = identityKey(row);
      const existing = live.get(key);
      // Keep the first row for an identity; only replace a 'locked' with 'active'.
      if (existing && !(existing.status === "locked" && status === "active")) continue;
      live.set(key, manifestOf(row));
    }
    return [...live.values()];
  };
  const archivedManifests = (kind?: string) => {
    const liveIdentities = new Set(
      fixture.canonicalRows
        .filter((row) => row.status === "active" || row.status === "locked")
        .map(identityKey),
    );
    const archived = new Map<string, ReturnType<typeof manifestOf>>();
    for (const row of fixture.canonicalRows) {
      if (row.status !== "archived") continue;
      if (kind !== undefined && row.kind !== kind) continue;
      const key = identityKey(row);
      // "Live wins": an identity that also has a live row is not archived.
      if (liveIdentities.has(key) || archived.has(key)) continue;
      archived.set(key, manifestOf(row));
    }
    return [...archived.values()];
  };
  return {
    readActiveManifestsFromStore: vi.fn(async (input: { kind?: string }) =>
      liveManifests(input.kind),
    ),
    readArchivedManifestsFromStore: vi.fn(async (input: { kind?: string }) =>
      archivedManifests(input.kind),
    ),
    discoverActiveExtensionCapabilities: vi.fn(async () => ({
      byKind: fixture.activeByKind,
      unmigratedKinds: [],
    })),
    discoverArchivedExtensionCapabilities: vi.fn(async () => ({
      byKind: fixture.archivedByKind,
      unmigratedKinds: [],
    })),
  };
});
import {
  KIND_LABEL,
  loadInstalledCardRows,
  type InstalledCardRow,
} from "@cinatra-ai/extensions/screens/installed-rows";

/** One canonical `installed_extension` row, as a real install records it. */
function installRow(
  partial: Partial<InstalledExtension> & { packageName: string; kind: string },
): Record<string, unknown> {
  return {
    id: `iext_${partial.packageName}`,
    ownerLevel: "workspace",
    ownerId: null,
    organizationId: null,
    status: "active",
    source: {
      type: "verdaccio",
      registryUrl: "http://registry.test",
      packageName: partial.packageName,
      version: "1.4.0",
      integrity: "sha512-x",
    },
    requiredInProd: false,
    dependencies: [],
    manifestHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

/** A registry catalog entry for the installed pack (marketplace hydration). */
function registryEntry(packageName: string, title: string, kind: string) {
  return {
    packageName,
    packageVersion: "1.4.0",
    title,
    description: "Reads and writes structured JSON documents as artifacts.",
    changelog: null,
    riskLevel: "low",
    hasApprovalGates: false,
    toolAccess: [],
    executionMode: "agentic",
    ownerOrgId: null,
    publishedAt: "2026-09-01T00:00:00.000Z",
    registryUrl: "http://registry.test",
    registryUiUrl: "http://registry.test",
    deprecated: false,
    author: "Cinatra",
    kind,
    origin: null,
  };
}

function setFixture(input: {
  rows: Array<Record<string, unknown>>;
  activeByKind?: Record<string, unknown[]>;
  archivedByKind?: Record<string, unknown[]>;
  registry?: unknown[];
}) {
  fixture.canonicalRows = input.rows;
  fixture.activeByKind = input.activeByKind ?? {};
  fixture.archivedByKind = input.archivedByKind ?? {};
  fixture.registryPackages = input.registry ?? [];
}

async function load() {
  return loadInstalledCardRows({ user: { id: "user_admin" } } as never);
}

/**
 * The §III card exactly as `RegistryCatalogScreen.renderCard` composes it for
 * an installed row — name, kind label, version and the lifecycle status.
 */
function renderInstalledCard(row: InstalledCardRow): string {
  return renderToStaticMarkup(
    <InstalledExtensionCard
      name={row.displayName}
      accentColor={deriveExtensionAccent(row.packageName)}
      emblem={extensionKindEmblem(row.kind as ExtensionEmblemKind)}
      kindIcon={extensionKindEmblem(row.kind as ExtensionEmblemKind, "size-3.5")}
      kindLabel={KIND_LABEL[row.kind]}
      vendor={resolveVendorPresentation(
        { name: row.vendor },
        { surface: "installed-list-artifact-row-test", ref: row.packageName },
      )}
      description={row.description}
      version={row.versionLabel}
      status={<InstalledStatusIndicator status={row.status} />}
      archived={row.status === "archived"}
    />,
  );
}

const rowsFor = (rows: InstalledCardRow[], packageName: string) =>
  rows.filter((row) => row.packageName === packageName);

afterEach(() => {
  vi.clearAllMocks();
  setFixture({ rows: [] });
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("installed list — a marketplace-installed artifact pack (cinatra#3533)", () => {
  it("draws the artifact row with its name, version and state, beside the other kinds", async () => {
    setFixture({
      // A real install: an active installed_extension row whose source is the
      // boot's registry. No artifact descriptor is registered — the pack was
      // installed at runtime, not scanned out of the dev-bundle tree.
      rows: [
        installRow({ packageName: ARTIFACT_PACKAGE, kind: "artifact" }),
        installRow({ packageName: AGENT_PACKAGE, kind: "agent" }),
      ],
      activeByKind: {
        agent: [
          {
            packageName: AGENT_PACKAGE,
            name: "Research Assistant",
            description: "Gathers sources, summarises, and cites answers.",
            packageVersion: "0.4.2",
          },
        ],
      },
      registry: [registryEntry(ARTIFACT_PACKAGE, "JSON Artifact", "artifact")],
    });

    const { active } = await load();

    const artifactRows = rowsFor(active, ARTIFACT_PACKAGE);
    expect(artifactRows).toHaveLength(1);
    const artifactRow = artifactRows[0];
    expect(artifactRow.kind).toBe("artifact");
    expect(artifactRow.displayName).toBe("JSON Artifact");
    expect(artifactRow.versionLabel).toBe("v1.4.0");
    expect(artifactRow.status).toBe("active");
    // The other kinds are untouched: the agent row is still drawn.
    expect(rowsFor(active, AGENT_PACKAGE)).toHaveLength(1);

    const html = renderInstalledCard(artifactRow);
    expect(html).toContain("JSON Artifact");
    // The kind's own label, as §III's "{Type} by {Vendor}" line gives it.
    expect(html).toContain(KIND_LABEL.artifact);
    expect(html).toContain("v1.4.0");
    expect(html).toContain('data-status="active"');
    expect(html).toContain("Active");
  });

  it("counts the artifact row in exactly one status view (Active), never twice", async () => {
    setFixture({
      rows: [installRow({ packageName: ARTIFACT_PACKAGE, kind: "artifact" })],
      registry: [registryEntry(ARTIFACT_PACKAGE, "JSON Artifact", "artifact")],
    });

    const { active, archived } = await load();

    // §III.3: every installed extension falls in exactly one of Active /
    // Locked / Archived, and All is their union — the screen partitions the
    // live set by `row.status`, so one live row with status "active" lands in
    // Active and in All, and in neither Locked nor Archived.
    expect(rowsFor(active, ARTIFACT_PACKAGE)).toHaveLength(1);
    expect(rowsFor(active, ARTIFACT_PACKAGE)[0].status).toBe("active");
    expect(rowsFor(archived, ARTIFACT_PACKAGE)).toHaveLength(0);
  });

  it("puts a LOCKED artifact install under the Locked view's status, not Active's", async () => {
    setFixture({
      rows: [
        installRow({ packageName: ARTIFACT_PACKAGE, kind: "artifact", status: "locked" }),
      ],
      registry: [registryEntry(ARTIFACT_PACKAGE, "JSON Artifact", "artifact")],
    });

    const { active } = await load();

    expect(rowsFor(active, ARTIFACT_PACKAGE)).toHaveLength(1);
    expect(rowsFor(active, ARTIFACT_PACKAGE)[0].status).toBe("locked");
  });

  it("falls back to the package name when the pack is in no registry catalog", async () => {
    setFixture({
      rows: [installRow({ packageName: ARTIFACT_PACKAGE, kind: "artifact" })],
    });

    const { active } = await load();

    const row = rowsFor(active, ARTIFACT_PACKAGE)[0];
    expect(row.displayName).toBe(ARTIFACT_PACKAGE);
    expect(row.versionLabel).toBe("v1.4.0");
  });

  it("never draws an artifact pack installed for ANOTHER user", async () => {
    setFixture({
      // A live install owned by a different user: the shared owner-scope gate
      // the artifact facet applies (`visibleManifestPackageNames`) must keep it
      // off this actor's list — a runtime-only row is never MORE visible than a
      // registered one.
      rows: [
        installRow({
          packageName: ARTIFACT_PACKAGE,
          kind: "artifact",
          id: "iext_artifact_other_user",
          ownerLevel: "user",
          ownerId: "user_other",
        }),
      ],
      registry: [registryEntry(ARTIFACT_PACKAGE, "JSON Artifact", "artifact")],
    });

    const { active } = await load();

    expect(rowsFor(active, ARTIFACT_PACKAGE)).toHaveLength(0);
  });

  it("collapses TWO visible owner identities of one pack into a single row", async () => {
    setFixture({
      // The same pack live under two owner scopes the actor may see. The coarse
      // gate surfaces both identities; the list must still draw one card.
      rows: [
        installRow({
          packageName: ARTIFACT_PACKAGE,
          kind: "artifact",
          id: "iext_artifact_workspace",
        }),
        installRow({
          packageName: ARTIFACT_PACKAGE,
          kind: "artifact",
          id: "iext_artifact_own_user",
          ownerLevel: "user",
          ownerId: "user_admin",
        }),
      ],
      registry: [registryEntry(ARTIFACT_PACKAGE, "JSON Artifact", "artifact")],
    });

    const { active } = await load();

    expect(rowsFor(active, ARTIFACT_PACKAGE)).toHaveLength(1);
    expect(rowsFor(active, ARTIFACT_PACKAGE)[0].versionLabel).toBe("v1.4.0");
    expect(rowsFor(active, ARTIFACT_PACKAGE)[0].status).toBe("active");
  });

  it("still draws exactly ONE row when the pack DOES register its object types", async () => {
    setFixture({
      rows: [installRow({ packageName: ARTIFACT_PACKAGE, kind: "artifact" })],
      // The build-time bundle scan registered two object types of the pack.
      activeByKind: {
        artifact: [
          { type: `${ARTIFACT_PACKAGE}:json-document` },
          { type: `${ARTIFACT_PACKAGE}:json-record` },
        ],
      },
      registry: [registryEntry(ARTIFACT_PACKAGE, "JSON Artifact", "artifact")],
    });

    const { active } = await load();

    expect(rowsFor(active, ARTIFACT_PACKAGE)).toHaveLength(1);
    expect(rowsFor(active, ARTIFACT_PACKAGE)[0].versionLabel).toBe("v1.4.0");
  });

  it("leaves the ARCHIVED side as it was — one archived row, no active twin", async () => {
    setFixture({
      rows: [
        installRow({ packageName: ARTIFACT_PACKAGE, kind: "artifact", status: "archived" }),
      ],
      // What the artifact `listArchived` facet returns: package-level rows.
      archivedByKind: { artifact: [{ packageName: ARTIFACT_PACKAGE }] },
      registry: [registryEntry(ARTIFACT_PACKAGE, "JSON Artifact", "artifact")],
    });

    const { active, archived } = await load();

    expect(rowsFor(active, ARTIFACT_PACKAGE)).toHaveLength(0);
    expect(rowsFor(archived, ARTIFACT_PACKAGE)).toHaveLength(1);
    expect(rowsFor(archived, ARTIFACT_PACKAGE)[0].status).toBe("archived");
  });

  it("keeps the runtime-only CONNECTOR union drawing its row unchanged", async () => {
    setFixture({
      rows: [installRow({ packageName: CONNECTOR_PACKAGE, kind: "connector" })],
    });

    const { active } = await load();

    const connectorRows = rowsFor(active, CONNECTOR_PACKAGE);
    expect(connectorRows).toHaveLength(1);
    expect(connectorRows[0].kind).toBe("connector");
    // The connector row keeps the scope-stripped package title it always drew.
    expect(connectorRows[0].displayName).toBe("knowledge-base-connector");
    expect(connectorRows[0].versionLabel).toBe("v1.4.0");
  });
});
