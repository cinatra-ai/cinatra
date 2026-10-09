// @vitest-environment jsdom
//
// THE MARKDOWN DISPLAY AT THE REQUIRED PIN DRAWS ITS CODE AND PREVIEW TABS
// (cinatra#3426, review drawing V.1).
//
// cinatra#3026 named the sentence this file proves in the unit tier: "tabs
// labelled Code and Preview, exactly one panel visible at a time, Code
// containing editable markdown and Preview containing rendered markdown". The
// markdown extension's own repository draws that display; the app draws
// whatever cinatra-required-extensions.lock.json pins. So this file mounts the
// display EXACTLY as the build map loads it
// (src/lib/generated/artifact-renderers.ts: the pack's
// `src/renderers/detail` entry) with props the host itself builds
// (`buildArtifactRendererProps` over a text content projection), and asserts
// what the pinned display draws: on the artifact's own page (an edit GRANT) and
// on a review target (the `read-only-surface` refusal). It is loaded THROUGH
// that map, as every host surface loads it: core never imports an extension's
// renderer entry by name (the artifact-renderer entry ban of eslint.config.mjs).
//
// RED BEFORE THE PIN MOVES: the pin it replaced drew the read-only document
// only, with no tab at all.
//
// UNDER STRICT MODE: the case that mounts the display inside React's
// StrictMode, as the development build does (mount, cleanup, mount), pins that
// a typed change set still reaches the save road, once, at the grant's save
// address; the file's four earlier cases are unchanged.
//
// The real-boot half of the same sentence is the browser spec
// tests/e2e/artifact-markdown-editor/markdown-editor.spec.ts, which needs a dev
// server, a sign-in and an upload, and is not run in this tier.
import { act, Children, cloneElement, isValidElement, StrictMode, Suspense, type ComponentType, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { ARTIFACT_CONTENT_CHANNEL_CAPS } from "@cinatra-ai/sdk-extensions/artifact-content-channel";
import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";

import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";
import {
  ARTIFACT_CONTENT_CHANNEL_VERSION,
  buildArtifactRendererProps,
  grantArtifactEdit,
  readOnlyArtifactEdit,
  type ArtifactRendererProps,
} from "@/lib/artifacts/artifact-renderer-props";
import { GENERATED_ARTIFACT_RENDERERS } from "@/lib/generated/artifact-renderers";

// Only outward session/route/storage seams are mocked for the composition case.
// The island, panel, mount, loader and generated pinned display stay real.
const settledBoundary = vi.hoisted(() => ({ loadSurface: vi.fn() }));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: async () => ({ user: { id: "reader_md_1" } }),
  signInRedirectTarget: async () => "/sign-in",
}));
vi.mock("next/navigation", () => ({
  redirect: (href: string) => { throw new Error(`Unexpected redirect: ${href}`); },
}));
vi.mock("@/lib/embed/frame-ancestors.server", () => ({
  resolveVerifiedWidgetFrameOrigin: () => null,
}));
vi.mock("@/lib/lifecycle/review-island-serving", () => ({
  resolveIslandCredentialReader: async () => null,
}));
vi.mock("@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-actor", () => ({
  resolveReviewActorContext: async () => ({
    actor: { actorType: "human", userId: "reader_md_1", source: "route" },
    orgId: "org_1",
    roleHints: { actorOrganizationId: "org_1" },
  }),
}));
vi.mock("@/app/artifacts/[id]/review-gate-ports", () => ({
  loadReviewGateSurface: (input: unknown) => settledBoundary.loadSurface(input),
}));

const MARKDOWN_DETAIL_KEY = "@cinatra-ai/markdown-artifact::detail";

// The display as the host mounts it: the build map's loader, whose module's
// default export the host types as a component of the HOST's props
// (src/lib/artifacts/artifact-renderer-loader.ts), whatever local mirror of
// those props the pack declares for itself.
let MarkdownArtifactDetail: ComponentType<ArtifactRendererProps>;

beforeAll(async () => {
  const entry = GENERATED_ARTIFACT_RENDERERS[MARKDOWN_DETAIL_KEY];
  expect(entry?.resolution).toBe("required");
  expect(entry?.propsApiVersion).toBe(1);
  const mod = (await entry!.load()) as { default?: unknown };
  expect(typeof mod.default).toBe("function");
  MarkdownArtifactDetail = mod.default as ComponentType<ArtifactRendererProps>;
});

const DOCUMENT = "# Launch notes\n\nThe **bold claim** ships with `inline code`.\n";

const identity: EffectiveIdentity = {
  kind: "extension",
  extension: "@cinatra-ai/markdown-artifact",
};

const artifact: ArtifactSummary = {
  artifactId: "art_md_1",
  latestRepresentationRevisionId: "rev_md_1",
  objectType: "@cinatra-ai/markdown-artifact:artifact",
  artifactType: "@cinatra-ai/markdown-artifact:artifact",
  title: "launch-notes.md",
  mime: "text/markdown",
  size: new TextEncoder().encode(DOCUMENT).byteLength,
  originKind: "upload",
  createdAt: "2026-09-23T10:00:00.000Z",
  updatedAt: "2026-09-23T10:00:00.000Z",
  ownerLevel: "organization",
  ownerId: null,
  organizationId: "org_1",
  projectId: null,
  visibility: "organization",
  eligibleExtensions: ["@cinatra-ai/markdown-artifact"],
  primaryExtension: "@cinatra-ai/markdown-artifact",
  effectiveIdentity: identity,
  presentationIdentity: identity,
  presentationSuggestions: [],
  sourceUrl: null,
};

/** The props the host builds for this display: the build map declares it at
 *  props version 1, so the snapshot is built at 1. */
function propsWith(edit: ReturnType<typeof grantArtifactEdit>) {
  const byteLength = new TextEncoder().encode(DOCUMENT).byteLength;
  return buildArtifactRendererProps({
    artifact,
    representation: { revisionId: "rev_md_1", mime: "text/markdown" },
    previewHref: null,
    downloadHref: "/api/artifacts/art_md_1/versions/rev_md_1/content",
    propsApiVersion: 1,
    content: {
      kind: "text",
      channelVersion: ARTIFACT_CONTENT_CHANNEL_VERSION,
      representationRevisionId: "rev_md_1",
      text: DOCUMENT,
      encoding: "utf-8",
      byteLength,
      projectedByteLength: byteLength,
      cap: ARTIFACT_CONTENT_CHANNEL_CAPS.text,
      truncated: false,
    },
    edit,
  });
}

// A save that never settles: leaving the Code view (or the display going away)
// sends the change set, and no outcome is wanted inside this test. The stub is
// removed after every case.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {})),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the markdown display at the required pin, on the artifact's own page (an edit grant)", () => {
  const granted = () =>
    propsWith(
      grantArtifactEdit({
        artifactId: "art_md_1",
        baseRevisionId: "rev_md_1",
        saveUrl: "/api/artifacts/art_md_1/edit",
        // Long enough that the idle pause never elapses during a case.
        idlePauseMs: 600_000,
        capBytes: 256 * 1024,
      }),
    );

  it("draws exactly two tabs, Code and Preview, opening on Code with one panel", () => {
    const { container } = render(<MarkdownArtifactDetail {...granted()} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Code", "Preview"]);
    expect(screen.getByRole("tab", { name: "Code" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(container.querySelector("[data-panel='code']")).not.toBeNull();
    expect(container.querySelector("[data-panel='preview']")).toBeNull();
  });

  it("holds the document in an editable Markdown source editor, with no indicator before an edit", () => {
    render(<MarkdownArtifactDetail {...granted()} />);
    const editor = screen.getByRole("textbox", { name: "Markdown source" }) as HTMLTextAreaElement;
    expect(editor.value).toBe(DOCUMENT);
    expect(editor.readOnly).toBe(false);
    expect(editor.disabled).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the saving indicator on an edit, then Preview renders the document alone", () => {
    const { container } = render(<MarkdownArtifactDetail {...granted()} />);
    const editor = screen.getByRole("textbox", { name: "Markdown source" });
    fireEvent.change(editor, { target: { value: `${DOCUMENT}\nOne more line.\n` } });
    const status = screen.getByRole("status");
    expect(status.getAttribute("data-saving-indicator")).toBe("saving");

    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    expect(screen.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(container.querySelector("[data-panel='code']")).toBeNull();
    const body = container.querySelector("[data-panel='preview'] [data-markdown-body]");
    expect(body).not.toBeNull();
    const rendered = within(body as HTMLElement);
    expect(rendered.getByRole("heading", { name: "Launch notes" })).toBeTruthy();
    expect((body as HTMLElement).querySelector("strong")?.textContent).toBe("bold claim");
    expect((body as HTMLElement).querySelector("code")?.textContent).toBe("inline code");
    expect((body as HTMLElement).textContent).not.toContain("**");
    // Preview renders the EDITED document, not the one the display opened with.
    expect((body as HTMLElement).textContent).toContain("One more line.");
    expect(screen.queryByRole("textbox", { name: "Markdown source" })).toBeNull();
  });

  it("sends a typed change to the save address once under StrictMode, when the editor is left", () => {
    render(
      <StrictMode>
        <MarkdownArtifactDetail {...granted()} />
      </StrictMode>,
    );
    const editor = screen.getByRole("textbox", { name: "Markdown source" });
    fireEvent.change(editor, { target: { value: `${DOCUMENT}\nStored under strict mode.\n` } });
    fireEvent.blur(editor);
    const save = vi.mocked(fetch);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toBe("/api/artifacts/art_md_1/edit");
  });
});

describe("the markdown display at the required pin, on a review target (read-only-surface)", () => {
  const readOnly = () => propsWith(readOnlyArtifactEdit("read-only-surface"));

  it("draws the same two tabs, opening on Preview, with nothing editable and no indicator", () => {
    const { container } = render(<MarkdownArtifactDetail {...readOnly()} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Code", "Preview"]);
    expect(screen.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector("[data-artifact-renderer='markdown']")?.getAttribute("data-editable")).toBe(
      "false",
    );
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(container.querySelector("[data-panel='preview']")).not.toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(container.querySelector("[data-panel='preview']")).toBeNull();
    const code = container.querySelector("[data-panel='code'] pre[data-code-readonly]");
    expect(code?.textContent).toBe(DOCUMENT);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as { then?: unknown } | null | undefined)?.then === "function";

// The decided island streams each review target under its own Suspense
// boundary: the element inside the boundary carries the PROMISE of the
// target's prepared display and of its pinned pair, and its component unwraps
// both with React's `use`. Only a React render can run `use`, so this renders
// that element's OWN component, under a boundary, in a throwaway root, captures
// what it returns, and unmounts the root at once.
async function evaluateStreamedBody(
  component: (props: Record<string, unknown>) => ReactNode,
  props: Record<string, unknown>,
): Promise<ReactNode> {
  const capture: { done: boolean; body: ReactNode } = { done: false, body: null };
  function StreamedBodyProbe(): null {
    capture.body = component(props);
    capture.done = true;
    return null;
  }
  // React's `act` asks for the act environment flag; it is set for this
  // evaluation alone and put back as it was.
  const scope = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = scope.IS_REACT_ACT_ENVIRONMENT;
  scope.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => {
      root.render(
        <Suspense fallback={null}>
          <StreamedBodyProbe />
        </Suspense>,
      );
    });
  } finally {
    act(() => root.unmount());
    if (previousActEnvironment === undefined) delete scope.IS_REACT_ACT_ENVIRONMENT;
    else scope.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
  if (!capture.done) throw new Error("the streamed review target never rendered its body");
  return capture.body;
}

// Native RSC apparatus: evaluate the actual pure panel and actual async server
// components, and the island's actual streamed target body under React, then
// give the resulting client tree to React. Hooks/client display components
// remain React's work. Nothing replaces a production component. Every panel
// evaluated is recorded with the props it was given.
async function resolveSettledServerTree(
  node: ReactNode,
  panel: typeof import("@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-target-panel").ReviewTargetPanel,
  seen: string[],
  panelCalls: Array<Record<string, unknown>>,
): Promise<ReactNode> {
  if (Array.isArray(node)) {
    return Promise.all(node.map((child) => resolveSettledServerTree(child, panel, seen, panelCalls)));
  }
  if (!isValidElement<Record<string, unknown>>(node)) return node;
  const streamedBody = typeof node.type === "function" && isThenable(node.props.prepared);
  if (typeof node.type === "function" && (streamedBody ||
      node.type === panel || node.type.constructor.name === "AsyncFunction")) {
    seen.push(node.type.name);
    if (node.type === panel) panelCalls.push(node.props);
    const server = node.type as (props: Record<string, unknown>) => ReactNode | Promise<ReactNode>;
    const result = streamedBody
      ? await evaluateStreamedBody(server as (props: Record<string, unknown>) => ReactNode, node.props)
      : await server(node.props);
    // Retain the server element's sibling identity while resolving its body.
    return resolveSettledServerTree(
      isValidElement(result) && node.key !== null ? cloneElement(result, { key: node.key }) : result,
      panel, seen, panelCalls,
    );
  }
  if (!("children" in node.props)) return node;
  return cloneElement(node as ReactElement<Record<string, unknown>>, {
    children: await resolveSettledServerTree(Children.toArray(node.props.children as ReactNode), panel, seen, panelCalls),
  });
}

// The decided island streams each target under its own boundary, so this case
// finds the target inside its boundary and reads the panel through it.
describe("the settled review island composes the actual pinned markdown display", () => {
  it("keeps Preview and Code on one frozen read-only target, with one panel and no save", async () => {
    process.env.BETTER_AUTH_SECRET ??= "native-settled-markdown-ref-secret";
    const { encodeLifecycleGateRef } = await import("@/lib/lifecycle/lifecycle-card-ref");
    const { default: ReviewTargetIslandPage } = await import("@/app/lifecycle/review-island/page");
    const { ReviewTargetPanel } = await import("@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-target-panel");
    const frozenRevision = "rev_md_frozen";
    const byteLength = new TextEncoder().encode(DOCUMENT).byteLength;
    // The row has advanced, but the host snapshot and substance remain the
    // gate's exact frozen revision. Use the production builder and refusal.
    const props = buildArtifactRendererProps({
      artifact: { ...artifact, latestRepresentationRevisionId: "rev_md_latest" },
      representation: { revisionId: frozenRevision, mime: "text/markdown" },
      previewHref: null,
      downloadHref: `/api/artifacts/art_md_1/versions/${frozenRevision}/content`,
      propsApiVersion: 1,
      content: {
        kind: "text",
        channelVersion: ARTIFACT_CONTENT_CHANNEL_VERSION,
        representationRevisionId: frozenRevision,
        text: DOCUMENT,
        encoding: "utf-8",
        byteLength,
        projectedByteLength: byteLength,
        cap: ARTIFACT_CONTENT_CHANNEL_CAPS.text,
        truncated: false,
      },
      edit: readOnlyArtifactEdit("read-only-surface"),
    });
    const target = { artifactId: artifact.artifactId, representationRevisionId: frozenRevision };
    // The settled surface streams: each target carries the promise of its
    // prepared display and of its pinned pair, as the loader hands them over.
    settledBoundary.loadSurface.mockResolvedValue({
      kind: "settled",
      agentSummary: null,
      targets: [{
        target,
        prepared: Promise.resolve({ target, props, mount: {
          kind: "build-map", slot: "detail", packageName: "@cinatra-ai/markdown-artifact",
          generatedKey: MARKDOWN_DETAIL_KEY,
        } }),
        capturePair: Promise.resolve(null),
      }],
    });
    const ref = encodeLifecycleGateRef({ runId: "run_md_1", reviewTaskId: "review_md_decided" });
    expect(ref).not.toBeNull();
    const island = await ReviewTargetIslandPage({ searchParams: Promise.resolve({ ref: ref! }) });
    // The island puts one streamed target per boundary in its tree: the element
    // whose props hold the `prepared` promise. The panel is read through it.
    const streamed: Array<ReactElement<{
      prepared: Promise<{ target: typeof target; props: ArtifactRendererProps }>;
      capturePair: Promise<unknown>;
      orgId: string;
    }>> = [];
    const collect = (node: ReactNode): void => {
      if (Array.isArray(node)) { node.forEach(collect); return; }
      if (!isValidElement<Record<string, unknown>>(node)) return;
      if (isThenable(node.props.prepared)) streamed.push(node as unknown as typeof streamed[number]);
      collect(node.props.children as ReactNode);
    };
    collect(island);
    expect(streamed).toHaveLength(1);
    expect(streamed[0].props.orgId).toBe("org_1");
    const prepared = await streamed[0].props.prepared;
    expect(prepared.target).toEqual(target);
    expect(prepared.props.representation?.revisionId).toBe(frozenRevision);
    expect(prepared.props.content).toMatchObject({
      kind: "text", representationRevisionId: frozenRevision, text: DOCUMENT,
    });
    // The production builder narrows its current v2 refusal to the display's
    // negotiated v1 edit-channel shape; the refusal semantics stay exact.
    expect(prepared.props.edit).toMatchObject({
      channelVersion: 1, kind: "read-only", reason: "read-only-surface",
    });
    expect(await streamed[0].props.capturePair).toBeNull();
    const seen: string[] = [];
    const panelCalls: Array<Record<string, unknown>> = [];
    const { container } = render(await resolveSettledServerTree(island, ReviewTargetPanel, seen, panelCalls));
    expect(seen).toEqual(expect.arrayContaining([
      "StreamedReviewTarget", "ReviewTargetPanel", "ReviewTargetMount", "ExtensionRendererSlot",
    ]));
    // The streamed body composed exactly one panel, fed the very value the
    // boundary's promise carried, the trusted organization and no pinned pair.
    expect(panelCalls).toHaveLength(1);
    expect(panelCalls[0].orgId).toBe("org_1");
    expect(panelCalls[0].prepared).toBe(prepared);
    expect(panelCalls[0].capturePair).toBeNull();
    expect(settledBoundary.loadSurface).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run_md_1", reviewTaskId: "review_md_decided",
    }));
    expect(container.querySelector('[data-review-reading="decided"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-conformance-id="review-target"]')).toHaveLength(1);
    const assertReadOnly = () => {
      expect(container.querySelector('[data-artifact-renderer="markdown"]')?.getAttribute("data-editable")).toBe("false");
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(container.querySelector('[contenteditable="true"]')).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    };
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Code", "Preview"]);
    expect(screen.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(container.querySelector("[data-panel='code']")).toBeNull();
    expect(within(screen.getByRole("tabpanel")).getByRole("heading", { name: "Launch notes" })).toBeTruthy();
    assertReadOnly();
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    expect(screen.getByRole("tab", { name: "Code" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(container.querySelector("[data-panel='preview']")).toBeNull();
    const code = container.querySelector("[data-panel='code'] pre[data-code-readonly]");
    expect(code?.textContent).toBe(DOCUMENT);
    fireEvent.blur(code!);
    assertReadOnly();
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(container.querySelector("[data-panel='code']")).toBeNull();
    assertReadOnly();
    cleanup();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
