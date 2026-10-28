// @vitest-environment jsdom
//
// The artifacts library's type picker (the "What is this?" dialog of the
// upload road) offers its types by role (cinatra#3783).
//
// The issue's reading: "None of them carries an option, radio or button role,
// and the list carries no listbox or radiogroup role, so assistive technology
// reads a list of text and offers nothing to pick, and a driver that selects by
// role cannot select an entry." Expected: "the picker's entries are selectable
// by role — a radio group with one radio per type, or a listbox with options —
// with the chosen entry readable as checked or selected, like the product's
// other pickers."
//
// The test drives the product's own road: upload a file through the provider's
// input, press "Set meaning", and read the dialog by role.
//
// cinatra#4265 rebuilt the picker on the Command menu primitives (spec
// `specs/app-components.html` §Command menu), so the issue's second road holds:
// the list is a listbox with one option per type (cmdk's own roles), and the
// chosen entry reads checked (aria-checked) and selected (aria-selected). The
// last case pins the drawn markup of that build.
//
//   pnpm exec vitest run src/components/artifacts/__tests__/library-upload-type-picker-roles.test.tsx
import "../../__tests__/access-picker-jsdom-shims";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: () => undefined,
    push: () => undefined,
    replace: () => undefined,
  }),
}));

vi.mock("@/lib/cinatra-toast", () => ({
  toast: {
    success: () => undefined,
    error: () => undefined,
    warning: () => undefined,
  },
}));

vi.mock("@/app/artifacts/upload-typing-actions", () => ({
  listInstalledTypesForArtifact: async () => ({
    ok: true,
    mime: "text/markdown",
    types: [
      {
        objectTypeId: "@cinatra-ai/blog-idea-artifact:blog-idea",
        extension: "@cinatra-ai/blog-idea-artifact",
        displayName: "Blog idea",
        extensionLabel: "Blog Idea Artifact",
      },
      {
        objectTypeId: "@cinatra-ai/blog-post-artifact:post",
        extension: "@cinatra-ai/blog-post-artifact",
        displayName: "Post",
        extensionLabel: "Blog Post Artifact",
      },
    ],
  }),
  assertUploadMeaning: async () => undefined,
  listArtifactMarketplacePacks: async () => undefined,
  requestTypeInstall: async () => undefined,
  installArtifactPackInline: async () => undefined,
}));

import {
  LibraryUploadDropZone,
  LibraryUploadProvider,
} from "@/components/artifacts/library-upload";

/** The upload answer the real route gives a filed file: 201 with its id. */
class FiledUploadRequest {
  status = 0;
  responseText = "";
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  open(): void {}
  setRequestHeader(): void {}
  send(): void {
    this.status = 201;
    this.responseText = '{"ok":true,"artifactId":"a-3783","ref":{"mime":"text/markdown"}}';
    this.onload?.();
  }
}

const IDEA_NAME = "Blog idea @cinatra-ai/blog-idea-artifact:blog-idea Blog Idea Artifact";
const POST_NAME = "Post @cinatra-ai/blog-post-artifact:post Blog Post Artifact";

async function openPicker(): Promise<HTMLElement> {
  render(
    <LibraryUploadProvider>
      <LibraryUploadDropZone>
        <div />
      </LibraryUploadDropZone>
    </LibraryUploadProvider>,
  );
  const input = document.querySelector<HTMLInputElement>(
    '[data-testid="artifacts-upload-input"]',
  );
  expect(input).not.toBeNull();
  fireEvent.change(input as HTMLInputElement, {
    target: { files: [new File(["# Idea"], "idea-3783.md", { type: "text/markdown" })] },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Set meaning" }));
  const dialog = await screen.findByRole("dialog", { name: "What is this?" });
  // The offer loads after the dialog mounts; wait for its entries.
  await within(dialog).findAllByTestId("artifacts-picker-type");
  return dialog;
}

beforeEach(() => {
  vi.stubGlobal("XMLHttpRequest", FiledUploadRequest);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

afterAll(() => {
  vi.doUnmock("next/navigation");
  vi.doUnmock("@/lib/cinatra-toast");
  vi.doUnmock("@/app/artifacts/upload-typing-actions");
  vi.resetModules();
});

describe("cinatra#3783 — the type picker's entries are selectable by role", () => {
  it("T-a: the list is one listbox named by the dialog's own question", async () => {
    const dialog = await openPicker();
    const lists = within(dialog).getAllByRole("listbox");
    expect(lists).toHaveLength(1);
    // Named exactly as the dialog itself is named ("What is this?").
    expect(within(dialog).getByRole("listbox", { name: "What is this?" })).toBe(lists[0]);
  });

  it("T-b: one option per offered type, named by its visible texts, none checked yet", async () => {
    const dialog = await openPicker();
    const list = within(dialog).getByRole("listbox");
    const options = within(list).getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(within(list).getByRole("option", { name: IDEA_NAME })).toBe(options[0]);
    expect(within(list).getByRole("option", { name: POST_NAME })).toBe(options[1]);
    expect(options.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "false"]);
    expect(options.map((r) => r.getAttribute("aria-selected"))).toEqual(["false", "false"]);
  });

  it("T-c: the chosen entry reads checked and selected, and Confirm becomes available", async () => {
    const dialog = await openPicker();
    const post = within(dialog).getByRole("option", { name: POST_NAME });
    fireEvent.click(post);
    expect(post.getAttribute("aria-checked")).toBe("true");
    expect(post.getAttribute("aria-selected")).toBe("true");
    const idea = within(dialog).getByRole("option", { name: IDEA_NAME });
    expect(idea.getAttribute("aria-checked")).toBe("false");
    expect(idea.getAttribute("aria-selected")).toBe("false");
    const confirm = within(dialog).getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
  });

  it("T-d: the drawn list, entries and heading of the Command build", async () => {
    const dialog = await openPicker();
    const entries = within(dialog).getAllByTestId("artifacts-picker-type");
    expect(entries).toHaveLength(2);
    const list = within(dialog).getByRole("listbox");
    expect(list.getAttribute("data-slot")).toBe("command-list");
    expect(list.closest('[data-slot="command"]')).not.toBeNull();
    expect(entries.map((e) => e.getAttribute("data-slot"))).toEqual(["command-item", "command-item"]);
    expect(entries.every((e) => list.contains(e))).toBe(true);
    expect(entries.map((e) => e.textContent)).toEqual([
      "Blog idea @cinatra-ai/blog-idea-artifact:blog-ideaBlog Idea Artifact",
      "Post @cinatra-ai/blog-post-artifact:postBlog Post Artifact",
    ]);
    // The dialog is named by its own title, a heading (CommandDialog draws it
    // for screen readers; the drawn header repeats it for the eye).
    const titleId = dialog.getAttribute("aria-labelledby");
    const title = titleId ? document.getElementById(titleId) : null;
    expect(title?.tagName).toBe("H2");
    expect(title?.textContent).toBe("What is this?");
  });
});
