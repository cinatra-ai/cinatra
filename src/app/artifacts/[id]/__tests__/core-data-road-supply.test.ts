/**
 * THE CORE DATA ROAD IS SUPPLIED (cinatra#4311, the core slice).
 *
 * Props version 3 gave the snapshot a DATA ROAD — "the application's own route,
 * reached with the reader's session. An address, never a credential" — and the
 * builder writes it whenever its caller supplies one. No production caller did:
 * the artifact page's call and the review target's call both passed none, so a
 * display that draws live series (a dashboard through the shared read-only
 * composition) could only ever draw its no-series reading.
 *
 * THE CONTRACT this suite pins:
 *
 *   1. ONE named road in the host contract: `{ road: "session", apiUrl }`, where
 *      `apiUrl` is the application's own cube route — the address the dashboards
 *      shell already uses, served by a route that exists.
 *   2. The SURFACE chooses it, as it chooses its byte and content roads: the
 *      artifact page passes it; the first-party review roads name it and the
 *      shared preparation path hands it to the builder; the ISLAND names none,
 *      because its reader holds no cookie and the sealed road is a later leg.
 *   3. At version 3 and up only, and absent (no key) wherever a surface names
 *      none — the display's own no-series reading, never a core one.
 *   4. Core never DRAWS it: the never-blank floor shows no backend address.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActorContext } from "@/lib/authz/actor-context";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";

const { readPinnedSubstance } = vi.hoisted(() => ({ readPinnedSubstance: vi.fn() }));

vi.mock("@/lib/artifacts/artifact-content-substance-reader", () => ({
  createPinnedSubstanceReader: () => ({ readPinnedSubstance }),
}));
// The island's two capability minters are not what this suite reads: only
// WHICH roads each surface names. Stubbed so the module loads without a store.
vi.mock("@/lib/lifecycle/review-island-byte-road", () => ({
  buildIslandArtifactByteMinter: () => () => null,
}));
vi.mock("@/lib/lifecycle/widget-capture-egress", () => ({
  buildBrokerCapturePair: () => null,
}));

import * as hostProps from "@/lib/artifacts/artifact-renderer-props";
import { ArtifactStructuredDataView } from "@/components/artifacts/artifact-structured-data-view";
import { bindArtifactReviewPorts } from "../review-target-prepare";
import * as surfaceRoads from "../review-surface-roads";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..", "..");
const CUBE_ROUTE = "/api/dashboards/cubejs-api/v1";
const ROAD = { road: "session", apiUrl: CUBE_ROUTE } as const;

const ORG = "org_4311_road";
const ARTIFACT = "art_4311_road";
const REVISION = "rev_4311_road";
const MARKDOWN = "text/markdown";
const actor = { actorType: "human", userId: "u" } as unknown as ActorContext;
const identity = { kind: "no-primary" } as const;
const artifact = {
  artifactId: ARTIFACT,
  title: "Pipeline health",
  objectType: "document",
  mime: MARKDOWN,
  size: 10,
  createdAt: "2026-10-24T00:00:00.000Z",
  updatedAt: "2026-10-24T00:00:00.000Z",
  ownerLevel: "team",
  visibility: "private",
  sourceUrl: null,
  effectiveIdentity: identity,
  presentationIdentity: identity,
} as unknown as ArtifactSummary;

/** The named road the host contract exports, read loosely so a red is the code's answer. */
function namedRoad(): unknown {
  return (hostProps as Record<string, unknown>).ARTIFACT_RENDERER_SESSION_DATA_ROAD;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function source(rel: string): string {
  return stripComments(readFileSync(join(REPO_ROOT, rel), "utf8"));
}

beforeEach(() => {
  readPinnedSubstance.mockReset();
  readPinnedSubstance.mockResolvedValue({ class: "text", text: "ok" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("(1) the host contract names one session data road", () => {
  it("is the application's own cube route on the session road, and frozen", () => {
    expect(namedRoad()).toEqual(ROAD);
    expect(Object.isFrozen(namedRoad())).toBe(true);
  });

  it("addresses a route that exists, the same address the dashboards shell uses", () => {
    const road = namedRoad() as { apiUrl?: string } | undefined;
    expect(road?.apiUrl).toBe(CUBE_ROUTE);
    expect(existsSync(join(REPO_ROOT, "src/app", CUBE_ROUTE, "[...endpoint]/route.ts"))).toBe(true);
    const shell = readFileSync(
      join(REPO_ROOT, "packages/dashboards/src/components/dashboards-client-shell.tsx"),
      "utf8",
    );
    expect(shell).toMatch(new RegExp(`DASHBOARDS_API_URL = "${CUBE_ROUTE.replace(/\//g, "\\/")}"`));
  });

  it("is an address and nothing else: two keys, no credential-shaped field", () => {
    expect(Object.keys((namedRoad() ?? {}) as object).sort()).toEqual(["apiUrl", "road"]);
  });
});

describe("(2) the review binder hands the surface's data road to the display", () => {
  function build(ctx: { dataRoad?: unknown }, propsApiVersion: number) {
    const { buildProps } = bindArtifactReviewPorts({
      orgId: ORG,
      actor,
      ...ctx,
    } as Parameters<typeof bindArtifactReviewPorts>[0]);
    return buildProps({
      artifact,
      representationRevisionId: REVISION,
      mime: MARKDOWN,
      propsApiVersion,
      member: { mime: MARKDOWN, form: "file" },
    });
  }

  it("writes the road at version 3 and up", async () => {
    for (const version of [3, 4, 5]) {
      const props = await build({ dataRoad: ROAD }, version);
      expect(props.data, `data at ${version}`).toEqual(ROAD);
    }
  });

  it("writes NO key below version 3, whatever the surface named", async () => {
    for (const version of [1, 2]) {
      const props = await build({ dataRoad: ROAD }, version);
      expect(Object.prototype.hasOwnProperty.call(props, "data"), `data at ${version}`).toBe(false);
    }
  });

  it("writes NO key where the surface names no data road (the display's no-series reading)", async () => {
    const props = await build({}, 5);
    expect(Object.prototype.hasOwnProperty.call(props, "data")).toBe(false);
  });

  it("keeps the card read-only whichever road it carries", async () => {
    const props = await build({ dataRoad: ROAD }, 5);
    expect(props.edit).toMatchObject({ kind: "read-only", reason: "read-only-surface" });
  });
});

describe("(2) the surface chooses the road", () => {
  it("the first-party review roads name the session data road", () => {
    const roads = surfaceRoads.firstPartyReviewSurfaceRoads() as Record<string, unknown>;
    expect(roads.dataRoad).toEqual(ROAD);
    expect(roads.dataRoad).toBe(namedRoad());
  });

  it("the island names NONE: its reader holds no cookie, so the session road cannot work there", () => {
    const roads = surfaceRoads.islandReviewSurfaceRoads({
      principal: {} as never,
      runId: "run_4311",
      reviewTaskId: "task_4311",
    }) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(roads, "dataRoad")).toBe(false);
  });

  it("the shared preparation path carries the named road from the surface to the binder", () => {
    // Both arms of the preparation entry and the bound surface loader: a road a
    // surface named and the path dropped would read exactly like no road at all.
    const prepare = source("src/app/artifacts/[id]/review-target-prepare.ts");
    expect(prepare.match(/dataRoad: args\.dataRoad/g)?.length).toBe(2);
    expect(prepare).toMatch(/data: ctx\.dataRoad/);
    const ports = source("src/app/artifacts/[id]/review-gate-ports.ts");
    expect(ports).toMatch(/dataRoad: args\.roads\?\.dataRoad/);
  });

  it("the artifact page passes the named road on its props call", () => {
    const page = source("src/app/artifacts/[id]/page.tsx");
    const call = page.match(/buildArtifactRendererProps\(\{[\s\S]*?\}\);/)?.[0] ?? "";
    expect(call).toMatch(/data: ARTIFACT_RENDERER_SESSION_DATA_ROAD/);
  });
});

describe("(4) core never draws the road", () => {
  it("the never-blank floor shows no backend address, even when the snapshot carries one", () => {
    const props = hostProps.buildArtifactRendererProps({
      artifact,
      representation: { revisionId: REVISION, mime: MARKDOWN },
      previewHref: null,
      downloadHref: null,
      content: hostProps.absentArtifactContent(REVISION, "absent"),
      edit: hostProps.readOnlyArtifactEdit("read-only-surface"),
      propsApiVersion: 5,
      data: ROAD,
    });
    expect(props.data).toEqual(ROAD);
    const html = renderToStaticMarkup(createElement(ArtifactStructuredDataView, { props }));
    expect(html).not.toContain(CUBE_ROUTE);
    expect(html).not.toContain("cubejs");
  });
});
