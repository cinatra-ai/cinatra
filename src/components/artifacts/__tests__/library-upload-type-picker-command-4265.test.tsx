// @vitest-environment jsdom
//
// The artifacts library's type picker ("What is this?", spec
// `specs/app-artifacts.html` §VI.1) is an inline picker of the Command menu
// family, so it is built from the Command menu primitives and drawn at their
// sizes (spec `specs/app-components.html` §Command menu):
//
//   "<Command />, <CommandDialog /> · @/components/ui/command"
//   "Global cmd+K palette and inline pickers. Section labels in 10px mono; rows
//    at 13px; the selected row uses the indigo soft-tint background, not a
//    border."
//
// The graded walk 4265-walk2 found the picker drawn as its own Dialog with a
// role=radiogroup <ul>, rows at 12px and section labels at 9.5px. These cases
// read the picker the product's own road opens: upload a file through the
// provider's input, press "Set meaning", read the dialog.
//
//   pnpm exec vitest run src/components/artifacts/__tests__/library-upload-type-picker-command-4265.test.tsx
import "../../__tests__/access-picker-jsdom-shims";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ComponentType } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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

const actions = vi.hoisted(() => ({
  listInstalledTypesForArtifact: vi.fn(),
  assertUploadMeaning: vi.fn(),
}));

vi.mock("@/app/artifacts/upload-typing-actions", () => ({
  listInstalledTypesForArtifact: (...a: unknown[]) => actions.listInstalledTypesForArtifact(...a),
  assertUploadMeaning: (...a: unknown[]) => actions.assertUploadMeaning(...a),
  listArtifactMarketplacePacks: async () => undefined,
  requestTypeInstall: async () => undefined,
  installArtifactPackInline: async () => undefined,
}));

// Which Command menu primitives the picker is built from: each export of the
// real module is passed through unchanged, and its name is recorded when it
// renders.
const rendered = vi.hoisted(() => new Set<string>());
vi.mock("@/components/ui/command", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const wrapped: Record<string, unknown> = {};
  for (const [name, component] of Object.entries(real)) {
    wrapped[name] = (props: Record<string, unknown>) => {
      rendered.add(name);
      return createElement(component as ComponentType<Record<string, unknown>>, props);
    };
  }
  return wrapped;
});

import {
  LibraryUploadDropZone,
  LibraryUploadProvider,
} from "@/components/artifacts/library-upload";

const ARTIFACT_ID = "a-4265";
const IDEA_EXT = "@cinatra-ai/blog-idea-artifact";
const POST_EXT = "@cinatra-ai/blog-post-artifact";
const TYPES = [
  {
    objectTypeId: "@cinatra-ai/blog-idea-artifact:blog-idea",
    extension: IDEA_EXT,
    displayName: "Blog idea",
    extensionLabel: "Blog Idea",
  },
  {
    objectTypeId: "@cinatra-ai/blog-post-artifact:post",
    extension: POST_EXT,
    displayName: "Post",
    extensionLabel: "Blog Post",
  },
];
const IDEA_NAME = "Blog idea @cinatra-ai/blog-idea-artifact:blog-idea Blog Idea";
const POST_NAME = "Post @cinatra-ai/blog-post-artifact:post Blog Post";

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
    this.responseText = `{"ok":true,"artifactId":"${ARTIFACT_ID}","ref":{"mime":"text/markdown"}}`;
    this.onload?.();
  }
}

function answer(meaning?: unknown): void {
  actions.listInstalledTypesForArtifact.mockResolvedValue({
    ok: true,
    mime: "text/markdown",
    types: TYPES,
    ...(meaning === undefined ? {} : { meaning }),
  });
}

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
    target: { files: [new File(["# Idea"], "notes-4265.md", { type: "text/markdown" })] },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Set meaning" }));
  const dialog = await screen.findByRole("dialog", { name: "What is this?" });
  // The offer loads after the dialog mounts; wait for its entries.
  await within(dialog).findAllByTestId("artifacts-picker-type");
  return dialog;
}

function picker(dialog: HTMLElement): HTMLElement {
  const found = dialog.querySelectorAll<HTMLElement>(
    '[data-conformance-id="artifacts-type-picker"]',
  );
  expect(found).toHaveLength(1);
  return found[0];
}

function rows(dialog: HTMLElement): HTMLElement[] {
  return within(dialog).getAllByTestId("artifacts-picker-type");
}

function commandRoot(dialog: HTMLElement): HTMLElement {
  const roots = picker(dialog).querySelectorAll<HTMLElement>('[data-slot="command"]');
  expect(roots).toHaveLength(1);
  return roots[0];
}

function confirmButton(dialog: HTMLElement): HTMLButtonElement {
  return within(dialog).getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
}

/** The value a CSS custom property is given in the app's global stylesheet. */
function cssToken(name: string): string {
  const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
  // The first declaration of the property, read as text (no pattern is built
  // from the name).
  const line = css
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith(`${name}:`));
  expect(line, `${name} in src/app/globals.css`).toBeTruthy();
  return (line as string).slice(name.length + 1).split(";")[0].trim();
}

/** The section label whose text starts with `text`, read inside the picker. */
function sectionLabel(dialog: HTMLElement, text: string): HTMLElement {
  const label = Array.from(picker(dialog).querySelectorAll<HTMLElement>("div")).find(
    (el) => el.children.length === 0 && (el.textContent ?? "").startsWith(text),
  );
  expect(label, `the "${text}" section label`).toBeTruthy();
  return label as HTMLElement;
}

beforeEach(() => {
  rendered.clear();
  vi.stubGlobal("XMLHttpRequest", FiledUploadRequest);
  actions.assertUploadMeaning.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

afterAll(() => {
  vi.doUnmock("next/navigation");
  vi.doUnmock("@/lib/cinatra-toast");
  vi.doUnmock("@/app/artifacts/upload-typing-actions");
  vi.doUnmock("@/components/ui/command");
  vi.resetModules();
});

describe("cinatra#4265 — the type picker is built from the Command menu primitives (§Command menu)", () => {
  it("S1: the picker is a CommandDialog whose list is a Command, a CommandList and one CommandItem per type", async () => {
    answer({ preselect: IDEA_EXT, suggestions: [] });
    const dialog = await openPicker();
    for (const name of ["CommandDialog", "Command", "CommandList", "CommandItem"]) {
      expect(rendered.has(name), `${name} rendered`).toBe(true);
    }
    const root = commandRoot(dialog);
    const list = root.querySelector<HTMLElement>('[data-slot="command-list"]');
    expect(list).not.toBeNull();
    expect(list?.getAttribute("role")).toBe("listbox");
    expect(list?.getAttribute("aria-label")).toBe("What is this?");
    const items = rows(dialog);
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.getAttribute("data-slot")).toBe("command-item");
      expect(item.getAttribute("role")).toBe("option");
      expect(list?.contains(item)).toBe(true);
    }
    expect(items.map((i) => i.getAttribute("aria-label"))).toEqual([IDEA_NAME, POST_NAME]);
  });

  it("S2: no radio group and no <ul> list remain in the picker", async () => {
    answer({ preselect: IDEA_EXT, suggestions: [] });
    const dialog = await openPicker();
    expect(within(dialog).queryAllByRole("radiogroup")).toHaveLength(0);
    expect(within(dialog).queryAllByRole("radio")).toHaveLength(0);
    expect(picker(dialog).querySelectorAll("ul")).toHaveLength(0);
  });

  it("S3: the foot (None of these, Keep as file, Confirm) and the chips stand outside the Command root", async () => {
    answer({
      preselect: IDEA_EXT,
      suggestions: [{ extension: POST_EXT, label: "Post · Blog Post", confidence: 0.55 }],
    });
    const dialog = await openPicker();
    const root = commandRoot(dialog);
    // cmdk's root handles Enter for the whole subtree (it prevents the key's
    // default), so a button inside it would not press on Enter.
    expect(root.contains(confirmButton(dialog))).toBe(false);
    expect(root.contains(within(dialog).getByRole("button", { name: "Keep as file" }))).toBe(false);
    expect(
      root.contains(within(dialog).getByRole("button", { name: /None of these/ })),
    ).toBe(false);
    expect(root.contains(within(dialog).getByTestId("artifacts-picker-suggestion"))).toBe(false);
  });
});

describe("cinatra#4265 — the picker's rows at 13px and section labels in 10px mono (§Command menu)", () => {
  it("Z1: the size tokens read 13px (row title) and 10px (badge-xs) in the stylesheet", () => {
    expect(cssToken("--text-row-title")).toBe("13px");
    expect(cssToken("--badge-text-xs")).toBe("10px");
    expect(cssToken("--text-badge-xs")).toBe("var(--badge-text-xs)");
  });

  it("Z2: each row's title is drawn at 13px (text-row-title), not 12px (text-xs)", async () => {
    answer({ preselect: IDEA_EXT, suggestions: [] });
    const dialog = await openPicker();
    for (const row of rows(dialog)) {
      const title = row.firstElementChild as HTMLElement;
      expect(title.classList.contains("text-row-title")).toBe(true);
      expect(title.classList.contains("text-xs")).toBe(false);
    }
  });

  it("Z3: the section labels 'Installed types that accept' and 'Suggested' are 10px mono (text-badge-xs), not 9.5px", async () => {
    answer({
      preselect: null,
      suggestions: [{ extension: POST_EXT, label: "Post · Blog Post", confidence: 0.61 }],
    });
    const dialog = await openPicker();
    for (const text of ["Installed types that accept", "Suggested"]) {
      const label = sectionLabel(dialog, text);
      expect(label.classList.contains("font-mono")).toBe(true);
      expect(label.classList.contains("text-badge-xs")).toBe(true);
      expect(label.classList.contains("text-badge-2xs")).toBe(false);
    }
  });

  it("Z4: only the chosen row is tinted: the base's every-row tint is cleared and the soft tint keys on the chosen row", async () => {
    answer({ preselect: IDEA_EXT, suggestions: [] });
    const dialog = await openPicker();
    for (const row of rows(dialog)) {
      // cmdk stamps data-selected="false" on every other row; the shared
      // CommandItem tints on the attribute's presence, so the row clears it.
      expect(row.classList.contains("data-selected:bg-transparent")).toBe(true);
      expect(row.classList.contains("data-[selected=true]:bg-primary/5!")).toBe(true);
    }
  });
});

describe("cinatra#4265 — the Command picker keeps the walk's readings and adds the keyboard", () => {
  it("K1: pre-selected on the matcher's draft: one row data-selected=true and aria-checked=true, Confirm live", async () => {
    answer({ preselect: POST_EXT, suggestions: [] });
    const dialog = await openPicker();
    const chosen = dialog.querySelectorAll('[data-testid="artifacts-picker-type"][data-selected="true"]');
    expect(chosen).toHaveLength(1);
    expect(chosen[0].getAttribute("aria-checked")).toBe("true");
    expect(chosen[0].getAttribute("aria-selected")).toBe("true");
    expect(chosen[0].getAttribute("aria-label")).toBe(POST_NAME);
    expect(dialog.querySelectorAll('[data-testid="artifacts-picker-confirm"]:not([disabled])')).toHaveLength(1);
    expect(within(dialog).queryAllByTestId("artifacts-picker-suggestion")).toHaveLength(0);
  });

  it("K2: with no pre-selection the list opens with no row chosen (cmdk does not choose the first row)", async () => {
    answer(undefined);
    const dialog = await openPicker();
    await waitFor(() => expect(rows(dialog)).toHaveLength(2));
    expect(rows(dialog).map((r) => r.getAttribute("data-selected"))).toEqual(["false", "false"]);
    expect(rows(dialog).map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "false"]);
    expect(confirmButton(dialog).disabled).toBe(true);
  });

  it("K3: the arrow keys move the choice; Confirm asserts the row the keyboard chose", async () => {
    answer({ preselect: IDEA_EXT, suggestions: [] });
    const dialog = await openPicker();
    const root = commandRoot(dialog);
    expect(root.tabIndex).toBe(0);
    root.focus();
    fireEvent.keyDown(root, { key: "ArrowDown", code: "ArrowDown" });
    await waitFor(() =>
      expect(rows(dialog).map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true"]),
    );
    expect(rows(dialog).map((r) => r.getAttribute("data-selected"))).toEqual(["false", "true"]);
    fireEvent.keyDown(root, { key: "ArrowUp", code: "ArrowUp" });
    await waitFor(() =>
      expect(rows(dialog).map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"]),
    );
    fireEvent.keyDown(root, { key: "ArrowDown", code: "ArrowDown" });
    await waitFor(() =>
      expect(rows(dialog).map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true"]),
    );
    fireEvent.click(confirmButton(dialog));
    await waitFor(() => expect(actions.assertUploadMeaning).toHaveBeenCalledTimes(1));
    expect(actions.assertUploadMeaning).toHaveBeenCalledWith({
      artifactId: ARTIFACT_ID,
      extension: POST_EXT,
    });
  });

  it("K4: with nothing chosen, ArrowDown chooses the first row", async () => {
    answer(undefined);
    const dialog = await openPicker();
    const root = commandRoot(dialog);
    root.focus();
    fireEvent.keyDown(root, { key: "ArrowDown", code: "ArrowDown" });
    await waitFor(() =>
      expect(rows(dialog).map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"]),
    );
    expect(confirmButton(dialog).disabled).toBe(false);
  });

  it("K5: a pointer passing over a row does not change the choice", async () => {
    answer({ preselect: IDEA_EXT, suggestions: [] });
    const dialog = await openPicker();
    fireEvent.pointerMove(rows(dialog)[1]);
    expect(rows(dialog).map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(rows(dialog).map((r) => r.getAttribute("data-selected"))).toEqual(["true", "false"]);
  });
});
