import { afterEach, describe, expect, it } from "vitest";

// THE DASHBOARD COMPOSITION ROAD (cinatra#3092, epic #3087) — the host half.
//
// The issue: "The dashboard's \"Open live dashboard\" navigation belongs to the
// continued reading alone: a dashboard whose review is still pending was not
// continued and carries no live link; the continued reading carries it". And
// the plan: "the dashboard extension lives outside this repository and cannot
// import the host's composition".
//
// So the host (1) serves the one read-only composition module to extension
// bundles on the road the design primitives take, and (2) hands a display the
// review reading and a data road, as props version 3 — a display that declared
// version 2 or 1 is handed a snapshot without them.

import * as clientBundle from "@cinatra-ai/sdk-extensions/artifact-client-bundle";
import {
  PROMOTED_READ_ONLY_COMPOSITIONS,
  isCompositionAdmittedForExtension,
} from "@cinatra-ai/sdk-extensions/read-only-compositions";
import * as sdkProps from "@cinatra-ai/sdk-extensions/artifact-renderer-props";
import * as hostProps from "@/lib/artifacts/artifact-renderer-props";
import {
  _resetHostModuleRegistryForTests,
  getHostModule,
  initHostModuleRegistry,
  isAllowedSharedSpecifier,
} from "@/lib/artifacts/host-module-registry";
import * as inventory from "../../../../scripts/extensions/inventory.mjs";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";

const {
  absentArtifactContent,
  artifactRendererPropsAtVersion,
  assertSerializableRendererProps,
  buildArtifactRendererProps,
  readOnlyArtifactEdit,
} = hostProps;

// The one admitted specifier, written out so a red is the code's answer.
const COMPOSITION = "@cinatra-ai/sdk-dashboard/components";

type Pair = { specifier: string; exportName: string };

describe("the composition is a host-served module", () => {
  it("(b1) the SDK's externals allowlist holds the composition specifier", () => {
    expect(clientBundle.CLIENT_BUNDLE_EXTERNAL_ALLOWLIST).toContain(COMPOSITION);
    expect(clientBundle.isAllowedClientBundleExternal(COMPOSITION)).toBe(true);
    expect(clientBundle.isAllowedClientBundleExternal("@cinatra-ai/sdk-dashboard")).toBe(false);
  });

  it("(b1) the inventory's mirror of the admitted pairs equals the SDK register", () => {
    const mirror = (inventory as { HOST_SERVED_READ_ONLY_COMPOSITIONS?: readonly Pair[] })
      .HOST_SERVED_READ_ONLY_COMPOSITIONS;
    expect(Array.isArray(mirror)).toBe(true);
    const mirrored = (mirror ?? []).map((c) => `${c.specifier}#${c.exportName}`);
    // Every mirrored pair is one the boundary admits…
    for (const pair of mirror ?? []) {
      expect(isCompositionAdmittedForExtension(pair), `${pair.specifier}#${pair.exportName}`).toBe(true);
    }
    // …and the register holds no pair the mirror lacks.
    for (const c of PROMOTED_READ_ONLY_COMPOSITIONS) {
      expect(mirrored, `${c.specifier}#${c.exportName}`).toContain(`${c.specifier}#${c.exportName}`);
    }
    expect(mirrored).toHaveLength(PROMOTED_READ_ONLY_COMPOSITIONS.length);
  });
});

describe("the host module registry serves the composition", () => {
  afterEach(() => _resetHostModuleRegistryForTests());

  const composition = { __id: "host-dashboard-composition" };

  it("(b2) once registered, the specifier answers the host's one composition module", () => {
    initHostModuleRegistry({
      react: { __id: "react" },
      "react/jsx-runtime": { __id: "jsx" },
      "react-dom": { __id: "react-dom" },
      "react-dom/client": { __id: "react-dom-client" },
      designTokens: { __id: "tokens" },
      designPrimitives: { __id: "primitives" },
      dashboardComposition: composition,
    } as Parameters<typeof initHostModuleRegistry>[0]);
    expect(isAllowedSharedSpecifier(COMPOSITION)).toBe(true);
    expect(getHostModule(COMPOSITION)).toBe(composition);
  });

  it("(b2) the base package and a sibling subpath are never served", () => {
    initHostModuleRegistry({
      react: { __id: "react" },
      "react/jsx-runtime": { __id: "jsx" },
      "react-dom": { __id: "react-dom" },
      "react-dom/client": { __id: "react-dom-client" },
      designTokens: { __id: "tokens" },
      designPrimitives: { __id: "primitives" },
    });
    expect(isAllowedSharedSpecifier("@cinatra-ai/sdk-dashboard")).toBe(false);
    expect(isAllowedSharedSpecifier(`${COMPOSITION}/narrow-to-single-portlet`)).toBe(false);
    expect(getHostModule("@cinatra-ai/sdk-dashboard")).toBeUndefined();
  });
});

const ARTIFACT = {
  artifactId: "art_dash_1",
  title: "Weekly pipeline",
  objectType: "@fixture/dashboard-display:dashboard",
  mime: "application/json",
  size: 512,
  createdAt: "2026-09-28T10:00:00.000Z",
  updatedAt: "2026-09-28T10:00:00.000Z",
  ownerLevel: "team",
  visibility: "private",
  sourceUrl: null,
  effectiveIdentity: { kind: "extension", extension: "@fixture/dashboard-display" },
} as unknown as ArtifactSummary;

const BASE = {
  artifact: ARTIFACT,
  representation: { revisionId: "rev_dash_1", mime: "application/json" },
  previewHref: null,
  downloadHref: null,
  content: absentArtifactContent("rev_dash_1", "unsupported-form"),
  edit: readOnlyArtifactEdit("read-only-surface"),
};

const LIVE = "/dashboards/dash_1";
const ROAD = { road: "session" as const, apiUrl: "/api/dashboards/cubejs-api/v1" };

// The builder's input, typed loosely so this file reads the same before the
// contract names the two inputs.
const build = (extra: Record<string, unknown>) =>
  buildArtifactRendererProps({ ...BASE, ...extra } as Parameters<typeof buildArtifactRendererProps>[0]) as ReturnType<
    typeof buildArtifactRendererProps
  > & { review?: { reading: string; openLive: string | null }; data?: typeof ROAD };

describe("the snapshot carries the review reading and the data road at version 3", () => {
  it("(b3) a pending review carries no live link, whatever the caller passed", () => {
    const props = build({ propsApiVersion: 3, review: { reading: "pending", openLive: LIVE } });
    expect(props.review).toEqual({ reading: "pending", openLive: null });
  });

  it("(b3) the continued reading carries the live link", () => {
    const props = build({ propsApiVersion: 3, review: { reading: "continued", openLive: LIVE } });
    expect(props.review).toEqual({ reading: "continued", openLive: LIVE });
  });

  it("(b3) no review input writes no review key, and a data road is written as given", () => {
    const props = build({ propsApiVersion: 3, data: ROAD });
    expect(Object.prototype.hasOwnProperty.call(props, "review")).toBe(false);
    expect(props.data).toEqual(ROAD);
  });

  it("(b4) a display that declared version 2 or 1 is handed a snapshot without them", () => {
    const bytes = { road: "session" as const, preview: "/api/artifacts/art_dash_1/versions/rev_dash_1/preview", download: null };
    const built = build({ propsApiVersion: 3, bytes, review: { reading: "continued", openLive: LIVE }, data: ROAD });
    expect(built.review).toEqual({ reading: "continued", openLive: LIVE });
    expect(built.data).toEqual(ROAD);
    expect(() => assertSerializableRendererProps(built)).not.toThrow();
    for (const version of [2, 1]) {
      const narrowed = artifactRendererPropsAtVersion(built, version);
      expect(narrowed.propsApiVersion).toBe(version);
      expect(Object.prototype.hasOwnProperty.call(narrowed, "review"), `review at ${version}`).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(narrowed, "data"), `data at ${version}`).toBe(false);
    }
    // The byte reference keeps its own version: kept at 2, and gone at 1 exactly as before.
    expect(artifactRendererPropsAtVersion(built, 2).bytes).toEqual(bytes);
    const v1 = artifactRendererPropsAtVersion(built, 1);
    expect(Object.prototype.hasOwnProperty.call(v1, "bytes")).toBe(false);
  });

  it("(b5) the SDK leaf and the host contract both read version 3", () => {
    expect(sdkProps.ARTIFACT_RENDERER_PROPS_API_VERSION).toBe(3);
    expect(hostProps.ARTIFACT_RENDERER_PROPS_API_VERSION).toBe(3);
    expect((hostProps as { ARTIFACT_RENDERER_PROPS_REVIEW_READING_VERSION?: number })
      .ARTIFACT_RENDERER_PROPS_REVIEW_READING_VERSION).toBe(3);
    expect(hostProps.ARTIFACT_RENDERER_PROPS_BYTE_REFERENCE_VERSION).toBe(2);
  });
});
