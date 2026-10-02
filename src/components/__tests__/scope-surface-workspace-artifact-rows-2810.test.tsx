// @vitest-environment jsdom
/**
 * THE WORKSPACE ARTIFACTS TAB DRAWS A ROW THE WAY ITS ORGANIZATION DRAWS IT
 * (cinatra#2810, per-scope surfaces S4).
 *
 * The first picture round counted three defects on the workspace Artifacts tab,
 * in both palettes, and used the organization Artifacts tab as the control:
 *
 *   1. Every row's label falls to a generic fallback instead of naming the
 *      type's own defining extension, although the identical rows resolve
 *      correctly on the organization surface in the same round.
 *   2. The generic fallback renders even though a renderer for that type exists
 *      and draws elsewhere in this round.
 *   3. Every row carries a type-format chip it is not entitled to.
 *
 * The drawing (`specs/app-artifacts.html`, §II row anatomy) gives the title line
 * a renderer glyph, the artifact name, and a muted label naming the type's
 * DEFINING extension; "a file-form artifact (an upload) shows its MIME type in a
 * mono label".
 *
 * Each case mounts the REAL tab body for both scopes, over the REAL library and
 * the REAL artifact service, with one stored set of agent-produced rows, and
 * reads the rendered rows. Stood in: the stores, the authorization decision,
 * the two identity services (by fakes that keep their live contract), the
 * renderer build map, and the page chrome around the list. The organization
 * tab is asserted in every case as well: it is the control that makes the
 * workspace reading a defect.
 *
 * Defects 1 and 2 are pinned here. Of defect 3, what this file pins is the part
 * the identity read decides: the workspace row is no longer drawn as the
 * file-form floor. The mono MIME label itself is drawn by the shared library
 * row from the stored MIME alone, on the organization tab and the global
 * library alike, so whether an agent-produced typed row carries it is that
 * row's rule and is not decided here.
 */
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import {
  semanticRendererRegistry,
  representationProviderRegistry,
} from "@cinatra-ai/objects/artifact-renderer-registry";

const IDEA_TYPE = "@fixture/idea-artifact:idea";
const IDEA_EXT = "@fixture/idea-artifact";
const TEXT_TYPE = "@fixture/text-artifact:text";
const TEXT_EXT = "@fixture/text-artifact";
const GENERIC_TYPE = "@cinatra-ai/artifact:object";
const ORG_A = "org-a";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement("a", { href, ...rest }, children),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  notFound: vi.fn(),
  usePathname: () => "/workspace/artifacts",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// The type's own `listRow` renderer, in the build map, as a built pack ships it.
vi.mock("@/lib/generated/artifact-renderers", () => ({
  GENERATED_ARTIFACT_RENDERERS: {
    "@fixture/idea-artifact::listRow": {
      resolution: "guardedOptional",
      packageName: "@fixture/idea-artifact",
      slot: "listRow",
      representations: [],
      propsApiVersion: 1,
      load: async () => ({
        default: (props: { artifact: { objectType: string } }) =>
          createElement("span", { "data-type-glyph": props.artifact.objectType }),
      }),
    },
  },
}));

// The page chrome around the list; the ROWS are the subject.
vi.mock("@/app/artifacts/[id]/renderer-dispatch", () => ({
  isSelectionPreparing: () => false,
}));
vi.mock("@/components/artifacts/library-toolbar", () => ({
  LibraryToolbar: () => null,
}));
vi.mock("@/components/artifacts/library-upload", () => ({
  LibraryUploadProvider: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
  LibraryUploadDropZone: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
  LibraryUploadButton: () => null,
}));
vi.mock("@/components/artifacts/dashboard-library-row", () => ({
  DashboardLibraryRow: () => null,
}));
vi.mock("@/lib/dashboards/dashboard-artifact-pointer-resolvers", () => ({
  resolveLibraryDashboardPointers: vi.fn(async () => new Map()),
}));
vi.mock("@/components/scope-surface-page", () => ({
  ScopeSurfaceTabEmpty: () => createElement("p", { "data-testid": "tab-empty" }),
}));

// The session: one member of one organization, which is also the active one.
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => ({
    user: { id: "user-1" },
    session: { activeOrganizationId: "org-a" },
  })),
  requireActorContext: vi.fn(async () => ({ principalType: "User", principalId: "user-1" })),
}));
vi.mock("@/lib/better-auth-db", () => ({
  readOrgsWithTeamsForUserActiveOnly: vi.fn(async () => [
    { id: "org-a", name: "Org A", teams: [] },
  ]),
  readProjectsForUser: vi.fn(async () => []),
}));

// The artifact service runs for real; its stores are stood in.
const world = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  /** Meaning assertions, per organization, as `semantic_assertion` keys them. */
  assertions: {} as Record<string, Record<string, string>>,
}));
vi.mock("@/lib/objects-store", () => ({
  listObjectsByFilter: (f: { orgId: string | null; type: string }) =>
    world.rows.filter(
      (r) => r.type === f.type && (f.orgId === null || r.orgId === f.orgId),
    ),
  getObjectById: vi.fn(),
}));
vi.mock("@/lib/authz/enforce-resource-access", () => ({
  decideResourceAccessForActorContext: () => null,
}));
vi.mock("@/lib/artifacts/artifact-retention", () => ({ tombstoneArtifact: vi.fn() }));
vi.mock("@/lib/artifacts/artifact-creation", () => ({
  createSemanticArtifact: vi.fn(),
  ObjectsTypeNotRegisteredError: class extends Error {},
}));
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: vi.fn() }));
vi.mock("@/lib/artifacts/semantic-assertion-store", () => ({
  listArtifactIdsForExtension: vi.fn(() => new Set<string>()),
}));
// The identity services keep their live contract: effective identity is
// type-driven, the presented identity layers ONE organization's assertions.
vi.mock("@/lib/objects/effective-identity", async () => {
  const { resolveEffectiveIdentity } = await import("@cinatra-ai/objects/effective-identity");
  return {
    resolveArtifactEffectiveIdentities: (input: {
      orgId: string;
      rows: ReadonlyArray<{ id: string; type: string }>;
    }) =>
      new Map(
        input.rows.map((r) => [
          r.id,
          { identity: resolveEffectiveIdentity(r.type), eligibleExtensions: [] },
        ]),
      ),
    resolveArtifactEffectiveIdentity: vi.fn(),
  };
});
vi.mock("@/lib/objects/presentation-identity", async () => {
  const { resolveEffectiveIdentity } = await import("@cinatra-ai/objects/effective-identity");
  return {
    resolveArtifactPresentationIdentities: (input: {
      orgId: string;
      rows: ReadonlyArray<{ id: string; type: string }>;
    }) =>
      new Map(
        input.rows.map((r) => {
          const asserted = world.assertions[input.orgId]?.[r.id];
          return [
            r.id,
            {
              identity: asserted
                ? { kind: "extension" as const, extension: asserted }
                : resolveEffectiveIdentity(r.type),
              tier: asserted ? "classic" : "claim-backed",
              suggestions: [],
            },
          ];
        }),
      ),
    resolveArtifactPresentationIdentity: vi.fn(),
  };
});

import { ScopeSurfaceArtifactsTab } from "@/components/scope-surfaces/scope-surface-artifacts-tab";
import { artifactKindLabelFor } from "@/lib/artifacts/artifact-kind-label";
import { _resetFirstPartySeedForTests } from "@/app/artifacts/[id]/renderer-resolution";
import { _resetArtifactRendererQuarantineForTests } from "@/lib/artifacts/artifact-renderer-loader";
import type { ScopeSurfaceRef } from "@/lib/scope-surfaces";

function registerArtifactType(type: string, pkg: string, mime: string): void {
  objectTypeRegistry.register(
    {
      type,
      category: "content",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent"], mutableBy: ["agent"] },
      renderers: { listRow: null, card: null, detail: null },
      isArtifact: { accepts: { file: { mimeTypes: [mime] } } },
      dispositions: { projection: "artifact-safe" },
    } as never,
    pkg,
  );
}

/** One stored, organization-owned row as the object store returns it. */
function stored(
  id: string,
  type: string,
  data: { title: string; mime: string; originKind: string },
) {
  return {
    id,
    type,
    data: { artifactType: "file", size: 12, latestRepresentationRevisionId: `${id}-v1`, ...data },
    createdAt: "2026-09-17T10:00:00.000Z",
    updatedAt: "2026-09-17T10:00:00.000Z",
    ownerLevel: "organization",
    ownerId: ORG_A,
    visibility: "organization",
    orgId: ORG_A,
    projectId: null,
  };
}

/** The agent run's rows: a typed idea, and a text file an agent asserted to BE
 *  an idea — the two roads an agent-produced row reaches the library by. */
const AGENT_ROWS = ["art-typed", "art-meaning"];

beforeEach(() => {
  objectTypeRegistry._clearForTests();
  registerArtifactType(IDEA_TYPE, IDEA_EXT, "text/plain");
  registerArtifactType(TEXT_TYPE, TEXT_EXT, "text/plain");
  semanticRendererRegistry.register({
    objectTypeId: `${IDEA_EXT}:artifact`,
    packageName: IDEA_EXT,
    slot: "listRow",
  });
  world.assertions = { [ORG_A]: { "art-meaning": IDEA_EXT } };
  world.rows = [
    stored("art-typed", IDEA_TYPE, { title: "Idea one", mime: "text/plain", originKind: "agent_generated" }),
    stored("art-meaning", TEXT_TYPE, { title: "Idea two", mime: "text/plain", originKind: "agent_generated" }),
  ];
});

afterEach(() => {
  objectTypeRegistry._clearForTests();
  semanticRendererRegistry._clearForTests();
  representationProviderRegistry._clearForTests(true);
  _resetFirstPartySeedForTests();
  _resetArtifactRendererQuarantineForTests();
  document.body.innerHTML = "";
});

/**
 * Resolve a server tree the way the server renders it: every function component
 * is called with its props, an async one is awaited. The library's row glyph is
 * an async server component, so a plain static render cannot draw it.
 */
async function resolveTree(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map((child) => resolveTree(child)));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<Record<string, unknown>>;
  if (typeof element.type === "function") {
    const component = element.type as (props: unknown) => ReactNode | Promise<ReactNode>;
    return resolveTree(await component(element.props));
  }
  if (element.props.children === undefined) return element;
  const children = await resolveTree(element.props.children as ReactNode);
  return createElement(element.type, { ...element.props, key: element.key, children } as never);
}

type DrawnRow = {
  title: string;
  /** The muted label beside the name. */
  label: string | null;
  /** The mono MIME label, when the row draws one. */
  mime: string | null;
  glyphSource: string | null;
  /** The glyph cell's tier classes (the file-form floor is the warning tint). */
  glyphTier: string;
  /** The type's own `listRow` renderer drew inside the glyph cell. */
  typeRendererDrew: boolean;
};

async function drawTab(scope: ScopeSurfaceRef): Promise<Map<string, DrawnRow>> {
  const tree = await ScopeSurfaceArtifactsTab({ scope });
  document.body.innerHTML = renderToStaticMarkup(<>{await resolveTree(tree)}</>);
  const rows = new Map<string, DrawnRow>();
  for (const li of document.querySelectorAll('li[data-state="kind:artifact"]')) {
    const href = li.querySelector("a[href^='/artifacts/']")?.getAttribute("href") ?? "";
    const titleLine = li.querySelector("div.flex.flex-wrap");
    const spans = titleLine ? [...titleLine.children] : [];
    const glyph = li.querySelector('[data-testid="artifacts-library-glyph"]');
    rows.set(href.replace("/artifacts/", ""), {
      title: spans[0]?.textContent ?? "",
      label: spans.find((s, i) => i > 0 && !s.className.includes("font-mono"))?.textContent ?? null,
      mime: titleLine?.querySelector(".font-mono")?.textContent ?? null,
      glyphSource: glyph?.getAttribute("data-glyph-source") ?? null,
      glyphTier: glyph?.className ?? "",
      typeRendererDrew: Boolean(li.querySelector("[data-type-glyph]")),
    });
  }
  return rows;
}

const ORGANIZATION: ScopeSurfaceRef = { kind: "organization", id: ORG_A };
const WORKSPACE: ScopeSurfaceRef = { kind: "workspace" };

describe("defect 1: the workspace row names the type's own defining extension", () => {
  it("draws the same extension label the organization tab draws for the same stored row", async () => {
    const control = await drawTab(ORGANIZATION);
    const workspace = await drawTab(WORKSPACE);
    const kind = artifactKindLabelFor(IDEA_EXT);

    for (const id of AGENT_ROWS) {
      // The control: the organization tab names the defining extension.
      expect(control.get(id)?.label).toBe(kind);
      // The workspace tab lists the row and names it the same way.
      expect(workspace.get(id)?.label).toBe(kind);
      expect(workspace.get(id)?.label).not.toBe("Default artifact");
    }
  });
});

describe("defect 2: the workspace row draws the type's own renderer glyph, not the generic fallback", () => {
  it("draws the glyph the type's own listRow renderer draws on the organization tab", async () => {
    const control = await drawTab(ORGANIZATION);
    const workspace = await drawTab(WORKSPACE);

    for (const id of AGENT_ROWS) {
      expect(control.get(id)?.glyphSource).toBe("extension");
      expect(control.get(id)?.typeRendererDrew).toBe(true);
      expect(workspace.get(id)?.glyphSource).toBe("extension");
      expect(workspace.get(id)?.typeRendererDrew).toBe(true);
    }
  });
});

describe("the workspace row is no longer drawn as the file-form floor", () => {
  it("draws the organization tab's title line for the same stored row", async () => {
    const control = await drawTab(ORGANIZATION);
    const workspace = await drawTab(WORKSPACE);

    for (const id of AGENT_ROWS) {
      const row = workspace.get(id);
      // The file-form floor is the warning-tinted file glyph over a Default
      // artifact label: the tier a row with no defining extension and a
      // concrete MIME falls to.
      expect(row?.glyphTier).not.toContain("bg-warning/10");
      expect(row?.label).not.toBe("Default artifact");
      // Title line for title line, the row reads as the organization draws it.
      expect({ label: row?.label, mime: row?.mime, glyphTier: row?.glyphTier }).toEqual({
        label: control.get(id)?.label,
        mime: control.get(id)?.mime,
        glyphTier: control.get(id)?.glyphTier,
      });
    }
  });

  it("keeps the MIME label on a real file-form row, on both tabs", async () => {
    // An upload whose type names no defining extension: the drawing's
    // file-form row, which the MIME label belongs to.
    world.rows.push(
      stored("art-upload", GENERIC_TYPE, {
        title: "2026 pricing sheet.pdf",
        mime: "application/pdf",
        originKind: "upload",
      }),
    );
    for (const scope of [ORGANIZATION, WORKSPACE]) {
      const upload = (await drawTab(scope)).get("art-upload");
      expect(upload?.mime).toBe("application/pdf");
      expect(upload?.label).toBe("Default artifact");
      expect(upload?.glyphTier).toContain("bg-warning/10");
    }
  });
});
