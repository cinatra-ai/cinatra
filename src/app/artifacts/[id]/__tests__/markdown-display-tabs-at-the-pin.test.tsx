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
import { StrictMode, type ComponentType } from "react";
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
