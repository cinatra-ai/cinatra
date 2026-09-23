/**
 * The installed list draws every installed SKILL package, on the Active view and
 * on the All view (cinatra#3569).
 *
 * Design spec §III opens "Manage installed agents, skills, connectors, and
 * artifacts.", and §III.3 makes the views exact: "Active, Locked and Archived
 * are a clean partition of the installed set: every installed extension falls in
 * exactly one of Active (status: active), Locked (status: locked) or Archived
 * (status: archived). A locked extension appears under Locked (and, as their
 * union, All) and is excluded from the default Active view; no row is dropped or
 * double-counted across views, and every view's count is exact."
 *
 * THE CAUSE this suite pins, in the three readings it was ground on:
 *   1. `packages/skills/src/extension-skill-resolver.ts:85-91` is an EXACT
 *      allowlist of five first-party skill packages by directory basename, and
 *      the derivation at :111-121 REWRITES the catalog package name of every
 *      skill in those packages to the VIRTUAL `@cinatra-ai/chat` (the return at
 *      :120) — "a privileged VIRTUAL namespace …, never a real installable
 *      package" (:100-106). That rewritten name lands on the persisted skill row
 *      as its `packageName`.
 *   2. `packages/skills/src/extension-handler.ts:100-112` is the skill reader
 *      facet's two-stage filter. `live` is
 *      `visibleManifestPackageNames(manifests, scope)`, which
 *      `packages/extension-types/src/index.ts:524-535` builds out of
 *      `manifest.packageName` and nothing else — the name the canonical
 *      `installed_extension` rows carry. The join is the single line
 *      `live.has(skill.packageName)` (:109): a catalog row carrying the virtual
 *      name can never be in that set, because the virtual name is never an
 *      installed package. `listActive` (:226-229) and `listArchived` (:237-240)
 *      both return through that one filter, so both views lose the same rows.
 *   3. `packages/extensions/src/screens/installed-rows.ts:198-202` takes the
 *      card's packageName from the skill descriptor alone and :214 skips a
 *      descriptor that has none, so a package with no surviving descriptor gets
 *      no card. The active assembly unions in the runtime-only CONNECTOR rows
 *      and feeds the ARTIFACT kind a package-level fallback (cinatra#3533) —
 *      there was no union and no fallback for the SKILL kind, on either side.
 *
 * This suite drives the REAL `loadInstalledCardRows` road (the skill facet's
 * package-name join, the row collapse, the canonical annotation, the
 * runtime-only unions, the kind/name sort) over mocked ports, in the shape of
 * `installed-list-artifact-row.test.tsx`. Its table covers ALL FOUR kinds of the
 * shared `KIND_ORDER`, so a kind that loses rows fails here and never first in a
 * picture round.
 *
 * The mocked coarse-gate readers mirror the real contract of
 * `runtime-discovery-host.ts`, and the mocked skill facet mirrors
 * `filterSkillsForScope` — the catalog intersected against the owner-visible
 * lifecycle-live package set — so the defect is reproduced by its own cause
 * rather than by an empty descriptor list asserted into place.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  ExtensionKind,
  InstalledExtension,
} from "@cinatra-ai/extensions/canonical-types";
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

/**
 * The privileged VIRTUAL namespace the five allowlisted chat-successor skill
 * packages' catalog rows carry instead of their own scoped name
 * (`extension-skill-resolver.ts:120`). It is never an installed package, so it
 * is never in the manifest gate's set.
 */
const VIRTUAL_SKILL_NAME = "@cinatra-ai/chat";

/** A skill catalog row's name/description — per-owner content the card never carries. */
const CATALOG_PRIVATE_DESCRIPTION = "PRIVATE catalog row text — never on a card";

/**
 * One installed package as the instance records it, plus the card name the
 * shared row model must resolve for it. The EXPECTED per-kind sets below are
 * derived from THIS table — the installed rows — and never from what the loader
 * returned.
 */
type InstalledFixture = {
  packageName: string;
  kind: ExtensionKind;
  status: "active" | "locked" | "archived";
  /** The card name the shared row model resolves (here: the registry title). */
  cardName: string;
  /** Whether the actor's scope admits this install identity. */
  visible: boolean;
  ownerLevel?: string;
  ownerId?: string | null;
  /**
   * Whether the kind's build-time reader facet resolves a native descriptor for
   * this package (agent / connector / artifact kinds).
   */
  descriptor?: boolean;
  /**
   * SKILL kind only: the package name this package's skill CATALOG rows carry —
   * its own name (the facet resolves it), the virtual namespace (the five's
   * shape: the facet drops it), or null for a package with no catalog rows at
   * all (the facet resolves nothing for it).
   */
  skillCatalogName?: string | null;
};

const INSTALLED: InstalledFixture[] = [
  // ---- AGENT: unchanged by this leg -------------------------------------
  {
    packageName: "@acme/research-agent",
    kind: "agent",
    status: "active",
    cardName: "Research Agent",
    visible: true,
    descriptor: true,
  },
  {
    packageName: "@acme/outreach-agent",
    kind: "agent",
    status: "active",
    cardName: "Outreach Agent",
    visible: true,
    descriptor: true,
  },
  {
    packageName: "@acme/legacy-agent",
    kind: "agent",
    status: "archived",
    cardName: "Legacy Agent",
    visible: true,
    descriptor: true,
  },

  // ---- SKILL: the kind this leg fixes ----------------------------------
  // Its catalog rows carry its OWN scoped name, so the facet resolves it and it
  // was always drawn.
  {
    packageName: "@acme/notes-skill",
    kind: "skill",
    status: "active",
    cardName: "Notes Skill",
    visible: true,
    skillCatalogName: "@acme/notes-skill",
  },
  // The shape of the five allowlisted packages: live and active, but its catalog
  // rows carry the VIRTUAL name, so `live.has(skill.packageName)` is false and
  // the facet returns nothing for it.
  {
    packageName: "@acme/company-research-skill",
    kind: "skill",
    status: "active",
    cardName: "Company Research Skill",
    visible: true,
    skillCatalogName: VIRTUAL_SKILL_NAME,
  },
  // A live skill package with NO catalog rows at all.
  {
    packageName: "@acme/silent-skill",
    kind: "skill",
    status: "active",
    cardName: "Silent Skill",
    visible: true,
    skillCatalogName: null,
  },
  // A LOCKED skill package of the same virtual-name shape: it belongs to the
  // Locked view and to All, and is excluded from the default Active view.
  {
    packageName: "@acme/chat-assistant-core-skill",
    kind: "skill",
    status: "locked",
    cardName: "Chat Assistant Core Skill",
    visible: true,
    skillCatalogName: VIRTUAL_SKILL_NAME,
  },
  // An ARCHIVED skill package with no catalog rows: the facet drops the five on
  // the archived side too, so the fallback is proved on both sides.
  {
    packageName: "@acme/retired-skill",
    kind: "skill",
    status: "archived",
    cardName: "Retired Skill",
    visible: true,
    skillCatalogName: null,
  },
  // An ARCHIVED skill package whose catalog rows carry its own name: the
  // archived facet already resolved it, and it must keep exactly one card.
  {
    packageName: "@acme/archived-catalogued-skill",
    kind: "skill",
    status: "archived",
    cardName: "Archived Catalogued Skill",
    visible: true,
    skillCatalogName: "@acme/archived-catalogued-skill",
  },
  // A skill package installed for ANOTHER user. Its catalog rows carry its own
  // name, so the ONLY thing keeping it off this actor's list is the shared
  // owner-scope manifest gate — which the fallback must apply and nothing wider.
  {
    packageName: "@acme/private-skill",
    kind: "skill",
    status: "active",
    cardName: "Private Skill",
    visible: false,
    ownerLevel: "user",
    ownerId: "user_other",
    skillCatalogName: "@acme/private-skill",
  },

  // ---- CONNECTOR: unchanged by this leg --------------------------------
  {
    packageName: "@acme/crm-connector",
    kind: "connector",
    status: "active",
    cardName: "CRM Connector",
    visible: true,
    descriptor: true,
  },
  // Runtime-installed: no build-time catalog descriptor, drawn by the existing
  // runtime-only connector union.
  {
    packageName: "@acme/runtime-connector",
    kind: "connector",
    status: "active",
    cardName: "Runtime Connector",
    visible: true,
    descriptor: false,
  },
  {
    packageName: "@acme/old-connector",
    kind: "connector",
    status: "archived",
    cardName: "Old Connector",
    visible: true,
    descriptor: true,
  },

  // ---- ARTIFACT: keeps the package-level fallback of cinatra#3533 ------
  {
    packageName: "@acme/table-artifact",
    kind: "artifact",
    status: "active",
    cardName: "Table Artifact",
    visible: true,
    descriptor: true,
  },
  // Runtime-installed: no registered object type, drawn by the artifact
  // package-level fallback this leg must leave intact.
  {
    packageName: "@acme/json-artifact",
    kind: "artifact",
    status: "active",
    cardName: "JSON Artifact",
    visible: true,
    descriptor: false,
  },
  {
    packageName: "@acme/legacy-artifact",
    kind: "artifact",
    status: "archived",
    cardName: "Legacy Artifact",
    visible: true,
    descriptor: true,
  },
];

/** Mutable fixture state the hoisted module factories read. */
const fixture = vi.hoisted(() => ({
  canonicalRows: [] as Array<Record<string, unknown>>,
  activeByKind: {} as Record<string, unknown[]>,
  archivedByKind: {} as Record<string, unknown[]>,
  registryPackages: [] as unknown[],
  /** The skill catalog, as `listInstalledSkills()` returns it. */
  skillCatalog: [] as Array<Record<string, unknown>>,
  /**
   * The discovery scope the loader resolves, so a case can drive the SAME
   * fallback under a different actor. `null` means the default below: an
   * ordinary workspace user, no organization, no platform role.
   */
  scope: null as Record<string, unknown> | null,
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
// The DEFAULT actor of this suite is an ordinary workspace user with NO
// platform role — which is what makes the scope-refusal case below a real
// refusal. A case that needs a wider actor sets `fixture.scope` instead.
const DEFAULT_SCOPE = { userId: "user_admin", organizationId: null, teamIds: [] };

vi.mock("@/lib/extension-discovery-scope", () => ({
  resolveExtensionDiscoveryContext: vi.fn(async () => {
    const scope = fixture.scope ?? { userId: "user_admin", organizationId: null, teamIds: [] };
    return {
      actor: { userId: scope.userId as string, actorType: "human", source: "ui" },
      scope,
    };
  }),
}));
// The root suite maps `@cinatra-ai/registries` to a narrow stub (the real barrel
// drags the pacote chain into the sandbox), so this factory supplies the three
// symbols the loader reads: the catalog read (mocked — this suite is about the
// rows, not the registry), its two page budgets, and the REAL pure vendor-name
// resolver the byline resolves through.
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
vi.mock("@cinatra-ai/extensions/runtime-discovery-host", async () => {
  // The SHARED owner-scope manifest gate, real (`extension-types`): the mocked
  // skill facet must apply exactly the gate the product facet applies, or this
  // suite would prove nothing about visibility.
  const gate = await vi.importActual<{
    visibleManifestPackageNames: (
      manifests: Array<Record<string, unknown>>,
      scope: Record<string, unknown>,
    ) => Set<string>;
  }>("@cinatra-ai/extension-types");

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
  // `(kind, packageName, ownerLevel, ownerId, organizationId)` — not by package —
  // so every owner scope a pack is live under reaches the shared visibility gate
  // (`runtime-discovery-host.ts`). The mock mirrors that key, its
  // active-over-locked preference within one identity, and the archived side's
  // "live wins" suppression.
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
      if (liveIdentities.has(key) || archived.has(key)) continue;
      archived.set(key, manifestOf(row));
    }
    return [...archived.values()];
  };
  /**
   * `filterSkillsForScope` (`packages/skills/src/extension-handler.ts:100-112`):
   * the skill catalog intersected against the owner-visible lifecycle-live
   * package set, by the single join `live.has(skill.packageName)` (:109). The
   * per-row `skillVisibleToScope` predicate is held true here — every fixture
   * catalog row is its owner's own — so the ONE variable this suite exercises is
   * the package-name join the virtual namespace defeats.
   */
  const skillFacet = (
    manifests: Array<Record<string, unknown>>,
    scope: Record<string, unknown>,
  ) => {
    const live = gate.visibleManifestPackageNames(manifests, scope);
    return fixture.skillCatalog.filter(
      (skill) => skill.packageName != null && live.has(skill.packageName as string),
    );
  };

  return {
    readActiveManifestsFromStore: vi.fn(async (input: { kind?: string }) =>
      liveManifests(input.kind),
    ),
    readArchivedManifestsFromStore: vi.fn(async (input: { kind?: string }) =>
      archivedManifests(input.kind),
    ),
    discoverActiveExtensionCapabilities: vi.fn(
      async (input: { scope: Record<string, unknown> }) => ({
        byKind: {
          ...fixture.activeByKind,
          skill: skillFacet(
            liveManifests("skill") as unknown as Array<Record<string, unknown>>,
            input.scope,
          ),
        },
        unmigratedKinds: [],
      }),
    ),
    discoverArchivedExtensionCapabilities: vi.fn(
      async (input: { scope: Record<string, unknown> }) => ({
        byKind: {
          ...fixture.archivedByKind,
          skill: skillFacet(
            archivedManifests("skill") as unknown as Array<Record<string, unknown>>,
            input.scope,
          ),
        },
        unmigratedKinds: [],
      }),
    ),
  };
});
import {
  KIND_LABEL,
  KIND_ORDER,
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
    description: `What ${title} does, from the marketplace catalog.`,
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

/**
 * Wire the whole INSTALLED table into the mocked ports: the canonical rows, the
 * per-kind native descriptors each kind's build-time facet resolves, the skill
 * catalog (whose rows carry the package name the fixture declares), and the
 * registry catalog that hydrates every card's title.
 */
function setInstalledFixture(): void {
  fixture.canonicalRows = INSTALLED.map((pkg) =>
    installRow({
      packageName: pkg.packageName,
      kind: pkg.kind,
      status: pkg.status,
      ...(pkg.ownerLevel ? { ownerLevel: pkg.ownerLevel } : {}),
      ...(pkg.ownerId !== undefined ? { ownerId: pkg.ownerId } : {}),
    } as Partial<InstalledExtension> & { packageName: string; kind: string }),
  );

  const nativeDescriptor = (pkg: InstalledFixture): unknown => {
    switch (pkg.kind) {
      case "agent":
        return {
          packageName: pkg.packageName,
          name: pkg.cardName,
          description: `What ${pkg.cardName} does.`,
          packageVersion: "1.4.0",
        };
      case "connector":
        return {
          packageId: pkg.packageName,
          slug: pkg.packageName.split("/")[1],
          displayName: pkg.cardName,
        };
      case "artifact":
        // The artifact facet returns object-type defs on the live side and
        // package-level rows on the archived side.
        return pkg.status === "archived"
          ? { packageName: pkg.packageName }
          : { type: `${pkg.packageName}:primary` };
      default:
        return null;
    }
  };

  const activeByKind: Record<string, unknown[]> = {};
  const archivedByKind: Record<string, unknown[]> = {};
  for (const pkg of INSTALLED) {
    if (pkg.kind === "skill" || pkg.descriptor !== true) continue;
    const bucket = pkg.status === "archived" ? archivedByKind : activeByKind;
    bucket[pkg.kind] = [...(bucket[pkg.kind] ?? []), nativeDescriptor(pkg)];
  }
  fixture.activeByKind = activeByKind;
  fixture.archivedByKind = archivedByKind;

  // The skill catalog. A package whose rows carry the VIRTUAL name contributes
  // rows under that name with a per-skill slug and PRIVATE description — neither
  // of which may ever reach a card.
  fixture.skillCatalog = INSTALLED.filter(
    (pkg) => pkg.kind === "skill" && pkg.skillCatalogName != null,
  ).map((pkg) =>
    pkg.skillCatalogName === pkg.packageName
      ? {
          packageName: pkg.packageName,
          name: pkg.cardName,
          description: `What ${pkg.cardName} does.`,
        }
      : {
          packageName: pkg.skillCatalogName,
          name: `${pkg.packageName.split("/")[1]}-slug`,
          description: CATALOG_PRIVATE_DESCRIPTION,
        },
  );

  fixture.registryPackages = INSTALLED.map((pkg) =>
    registryEntry(pkg.packageName, pkg.cardName, pkg.kind),
  );
}

function clearFixture(): void {
  fixture.canonicalRows = [];
  fixture.activeByKind = {};
  fixture.archivedByKind = {};
  fixture.registryPackages = [];
  fixture.skillCatalog = [];
  fixture.scope = null;
}

async function load() {
  return loadInstalledCardRows({ user: { id: "user_admin" } } as never);
}

/**
 * The four status views, exactly as `registry-catalog-screen.tsx:432-441`
 * partitions the loaded rows: the loader's `active` set is the LIVE set (status
 * active OR locked), split by status, and All is the union of the live and
 * archived sets.
 */
const activeView = (rows: LoadedRows) =>
  rows.active.filter((row) => row.status === "active");
const lockedView = (rows: LoadedRows) =>
  rows.active.filter((row) => row.status === "locked");
const archivedView = (rows: LoadedRows) => rows.archived;
const allView = (rows: LoadedRows) => [...rows.active, ...rows.archived];

type LoadedRows = { active: InstalledCardRow[]; archived: InstalledCardRow[] };

/** The sorted card NAMES a view draws for one kind — count included. */
const drawnNames = (rows: InstalledCardRow[], kind: ExtensionKind): string[] =>
  rows
    .filter((row) => row.kind === kind)
    .map((row) => row.displayName)
    .sort();

/**
 * The sorted card names the INSTALLED rows of one kind must draw in the given
 * statuses — read from the installed table, never from the loader's output.
 */
const installedNames = (
  kind: ExtensionKind,
  statuses: Array<"active" | "locked" | "archived">,
): string[] =>
  INSTALLED.filter(
    (pkg) => pkg.kind === kind && pkg.visible && statuses.includes(pkg.status),
  )
    .map((pkg) => pkg.cardName)
    .sort();

/**
 * The §III card exactly as `RegistryCatalogScreen.renderCard` composes it for an
 * installed row — name, kind label, version and the lifecycle status.
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
        { surface: "installed-list-skill-rows-test", ref: row.packageName },
      )}
      description={row.description}
      version={row.versionLabel}
      status={<InstalledStatusIndicator status={row.status} />}
      archived={row.status === "archived"}
    />,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  clearFixture();
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("installed list — every installed skill package is drawn (cinatra#3569)", () => {
  // THE PER-KIND TABLE. §III.3: "no row is dropped or double-counted across
  // views, and every view's count is exact."
  it.each(KIND_ORDER)(
    "the %s kind: the Active view draws exactly the scope-visible active installed rows, by name",
    async (kind) => {
      setInstalledFixture();
      const rows = await load();

      expect(drawnNames(activeView(rows), kind)).toEqual(installedNames(kind, ["active"]));
    },
  );

  it.each(KIND_ORDER)(
    "the %s kind: the All view draws exactly the union of the active, locked and archived installed rows, by name",
    async (kind) => {
      setInstalledFixture();
      const rows = await load();

      expect(drawnNames(allView(rows), kind)).toEqual(
        installedNames(kind, ["active", "locked", "archived"]),
      );
    },
  );

  it.each(KIND_ORDER)(
    "the %s kind: the Archived view draws exactly the scope-visible archived installed rows, by name",
    async (kind) => {
      setInstalledFixture();
      const rows = await load();

      expect(drawnNames(archivedView(rows), kind)).toEqual(
        installedNames(kind, ["archived"]),
      );
    },
  );

  it("the skill kind: a LOCKED skill package is on the Locked view, never on Active", async () => {
    setInstalledFixture();
    const rows = await load();

    expect(drawnNames(lockedView(rows), "skill")).toEqual(installedNames("skill", ["locked"]));
    expect(drawnNames(activeView(rows), "skill")).not.toContain(
      "Chat Assistant Core Skill",
    );
  });

  it("the skill kind: every drawn card carries its name, the Skill kind label and its status", async () => {
    setInstalledFixture();
    const rows = await load();

    const skillCards = allView(rows).filter((row) => row.kind === "skill");
    expect(skillCards).toHaveLength(installedNames("skill", ["active", "locked", "archived"]).length);
    for (const row of skillCards) {
      const html = renderInstalledCard(row);
      expect(html).toContain(row.displayName);
      expect(html).toContain(KIND_LABEL.skill);
      expect(html).toContain(`data-status="${row.status}"`);
      expect(html).toContain("v1.4.0");
    }
  });

  it("the skill kind: a package whose catalog rows carry the virtual name draws ONE card, named from the shared row model", async () => {
    setInstalledFixture();
    const rows = await load();

    const drawn = activeView(rows).filter(
      (row) => row.packageName === "@acme/company-research-skill",
    );
    expect(drawn).toHaveLength(1);
    expect(drawn[0].kind).toBe("skill");
    expect(drawn[0].displayName).toBe("Company Research Skill");
    expect(drawn[0].status).toBe("active");
    expect(drawn[0].versionLabel).toBe("v1.4.0");
    expect(drawn[0].settingsHref).toContain("@acme/company-research-skill");
  });

  it("the skill kind: the drawn card reads NO skill name, description or count out of the skill catalog", async () => {
    setInstalledFixture();
    const rows = await load();

    for (const packageName of ["@acme/company-research-skill", "@acme/chat-assistant-core-skill"]) {
      const row = allView(rows).find((candidate) => candidate.packageName === packageName);
      expect(row).toBeDefined();
      const html = renderInstalledCard(row as InstalledCardRow);
      // The per-skill slug and the PRIVATE per-owner catalog text the facet's own
      // recorded reason (`extension-handler.ts:88-98`) keeps off a package-name
      // join must appear nowhere on the card.
      expect(html).not.toContain(CATALOG_PRIVATE_DESCRIPTION);
      expect(html).not.toContain(`${packageName.split("/")[1]}-slug`);
    }
  });

  it("the skill kind: a package the actor's scope does not admit draws NO card on any view", async () => {
    setInstalledFixture();
    const rows = await load();

    for (const view of [activeView(rows), lockedView(rows), archivedView(rows), allView(rows)]) {
      expect(view.filter((row) => row.packageName === "@acme/private-skill")).toHaveLength(0);
      expect(view.map((row) => row.displayName)).not.toContain("Private Skill");
    }
  });

  it("no view ever draws the virtual namespace as a package of its own", async () => {
    setInstalledFixture();
    const rows = await load();

    expect(allView(rows).map((row) => row.packageName)).not.toContain(VIRTUAL_SKILL_NAME);
  });

  it("the whole list: every scope-visible installed row is drawn exactly once on the All view", async () => {
    setInstalledFixture();
    const rows = await load();

    const drawn = allView(rows)
      .map((row) => `${row.kind}::${row.packageName}`)
      .sort();
    const installed = INSTALLED.filter((pkg) => pkg.visible)
      .map((pkg) => `${pkg.kind}::${pkg.packageName}`)
      .sort();

    expect(drawn).toEqual(installed);
  });

  /**
   * The identity cases. `readActiveManifestsFromStore` /
   * `readArchivedManifestsFromStore` de-dupe by DISTINCT INSTALL IDENTITY
   * `(kind, packageName, ownerLevel, ownerId, organizationId)`, never by
   * package, so the fallback is handed one manifest per identity and must still
   * put ONE card on the view — exactly as the facet-resolved road does.
   */
  function setSkillIdentityFixture(rows: Array<Record<string, unknown>>): void {
    fixture.canonicalRows = rows;
    fixture.activeByKind = {};
    fixture.archivedByKind = {};
    // No catalog rows at all: the facet resolves nothing, so every card below is
    // the fallback's own.
    fixture.skillCatalog = [];
    fixture.registryPackages = [registryEntry("@acme/twin-skill", "Twin Skill", "skill")];
  }

  it("the skill kind: TWO visible owner identities of one package collapse to a SINGLE card", async () => {
    setSkillIdentityFixture([
      installRow({
        id: "iext_twin_workspace",
        packageName: "@acme/twin-skill",
        kind: "skill",
        status: "active",
      } as Partial<InstalledExtension> & { packageName: string; kind: string }),
      installRow({
        id: "iext_twin_user",
        packageName: "@acme/twin-skill",
        kind: "skill",
        status: "active",
        ownerLevel: "user",
        ownerId: "user_admin",
      } as Partial<InstalledExtension> & { packageName: string; kind: string }),
    ]);
    const rows = await load();

    expect(drawnNames(activeView(rows), "skill")).toEqual(["Twin Skill"]);
    expect(drawnNames(allView(rows), "skill")).toEqual(["Twin Skill"]);
  });

  it("the skill kind: an identity that is live AND archived is drawn on the live side only", async () => {
    setSkillIdentityFixture([
      installRow({
        id: "iext_twin_live",
        packageName: "@acme/twin-skill",
        kind: "skill",
        status: "active",
      } as Partial<InstalledExtension> & { packageName: string; kind: string }),
      installRow({
        id: "iext_twin_archived",
        packageName: "@acme/twin-skill",
        kind: "skill",
        status: "archived",
      } as Partial<InstalledExtension> & { packageName: string; kind: string }),
    ]);
    const rows = await load();

    expect(drawnNames(activeView(rows), "skill")).toEqual(["Twin Skill"]);
    expect(drawnNames(archivedView(rows), "skill")).toEqual([]);
    expect(drawnNames(allView(rows), "skill")).toEqual(["Twin Skill"]);
  });

  it("the skill kind: the fallback's visibility is the shared gate's, under a PLATFORM-ADMIN actor too", async () => {
    setInstalledFixture();
    // The same gate (`visibleManifestPackageNames`) admits a platform admin to
    // every package, so the package the default actor is refused is drawn here —
    // the fallback is never narrower and never wider than the gate.
    fixture.scope = { ...DEFAULT_SCOPE, platformRole: "platform_admin" };
    const rows = await load();

    expect(allView(rows).map((row) => row.packageName)).toContain("@acme/private-skill");
    expect(
      allView(rows).filter((row) => row.packageName === "@acme/private-skill"),
    ).toHaveLength(1);
    expect(allView(rows).map((row) => row.packageName)).not.toContain(VIRTUAL_SKILL_NAME);
  });
});
