// @vitest-environment jsdom
//
// The artifacts library's type picker draws the row's DERIVED MEANING
// (cinatra#3319; spec `specs/app-artifacts.html` §VI.1 "Derived meaning &
// suggestion chips"):
//
//   "When its confidence is at or above the pack's threshold, that meaning
//    auto-surfaces as the row's presented identity [...] and the picker opens
//    pre-selected on it. When confidence is below threshold, the candidate never
//    auto-applies; it appears as a suggestion chip the user may confirm.
//    Confirming a suggestion records the user's choice as a user-sourced
//    meaning [...]"
//
// The server action answers the reading as `meaning` (the extension to
// pre-select, and the chips); the threshold itself is decided server-side by
// the presentation tiers (see presentation-identity-meaning-offer-3319.test.ts).
// These cases drive the product's own road: upload through the provider's input,
// press "Set meaning", read the dialog by role.
//
//   pnpm exec vitest run src/components/artifacts/__tests__/library-upload-picker-derived-meaning-3319.test.tsx
import "../../__tests__/access-picker-jsdom-shims";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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

import {
  LibraryUploadDropZone,
  LibraryUploadProvider,
} from "@/components/artifacts/library-upload";

const ARTIFACT_ID = "a-3319";
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
    target: { files: [new File(["# Idea"], "item9-idea.md", { type: "text/markdown" })] },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Set meaning" }));
  const dialog = await screen.findByRole("dialog", { name: "What is this?" });
  // The offer loads after the dialog mounts; wait for its entries.
  await within(dialog).findAllByTestId("artifacts-picker-type");
  return dialog;
}

function checkedStates(dialog: HTMLElement): Array<string | null> {
  return within(within(dialog).getByRole("radiogroup"))
    .getAllByRole("radio")
    .map((r) => r.getAttribute("aria-checked"));
}

function confirmButton(dialog: HTMLElement): HTMLButtonElement {
  return within(dialog).getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
}

beforeEach(() => {
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
  vi.resetModules();
});

describe("cinatra#3319 — the picker draws the derived meaning (§VI.1)", () => {
  it("R1: a meaning at or above threshold opens the picker pre-selected on it, before any press", async () => {
    answer({ preselect: IDEA_EXT, suggestions: [] });
    const dialog = await openPicker();
    expect(within(dialog).getByRole("radio", { name: IDEA_NAME }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(checkedStates(dialog)).toEqual(["true", "false"]);
    expect(confirmButton(dialog).disabled).toBe(false);
  });

  it("R2: Confirm on the pre-selected meaning asserts it, with no press on the list", async () => {
    answer({ preselect: IDEA_EXT, suggestions: [] });
    const dialog = await openPicker();
    fireEvent.click(confirmButton(dialog));
    await waitFor(() => expect(actions.assertUploadMeaning).toHaveBeenCalledTimes(1));
    expect(actions.assertUploadMeaning).toHaveBeenCalledWith({
      artifactId: ARTIFACT_ID,
      extension: IDEA_EXT,
    });
  });

  it("R3: a meaning below threshold is a suggestion chip with its confidence, and nothing is pre-selected", async () => {
    answer({
      preselect: null,
      suggestions: [{ extension: POST_EXT, label: "Post · Blog Post", confidence: 0.61 }],
    });
    const dialog = await openPicker();
    expect(within(dialog).getByText("Suggested")).toBeTruthy();
    const chip = within(dialog).getByRole("button", { name: /^Post · Blog Post\s+0\.61$/ });
    expect(chip.getAttribute("data-action")).toBe("confirm-suggestion -> meaning-asserted");
    expect(checkedStates(dialog)).toEqual(["false", "false"]);
    expect(confirmButton(dialog).disabled).toBe(true);
  });

  it("R4: confirming a chip records a user-sourced meaning for the chip's own extension", async () => {
    answer({
      preselect: null,
      suggestions: [{ extension: POST_EXT, label: "Post · Blog Post", confidence: 0.61 }],
    });
    const dialog = await openPicker();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Post · Blog Post\s+0\.61$/ }));
    await waitFor(() => expect(actions.assertUploadMeaning).toHaveBeenCalledTimes(1));
    expect(actions.assertUploadMeaning).toHaveBeenCalledWith({
      artifactId: ARTIFACT_ID,
      extension: POST_EXT,
    });
  });

  it("R5: with a pre-selection standing, pressing a chip asserts the CHIP's extension, not the pre-selection", async () => {
    answer({
      preselect: IDEA_EXT,
      suggestions: [{ extension: POST_EXT, label: "Post · Blog Post", confidence: 0.55 }],
    });
    const dialog = await openPicker();
    // Both draw together: the pre-selection checked, the other draft a chip.
    expect(checkedStates(dialog)).toEqual(["true", "false"]);
    expect(within(dialog).getAllByTestId("artifacts-picker-suggestion")).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("button", { name: /^Post · Blog Post\s+0\.55$/ }));
    await waitFor(() => expect(actions.assertUploadMeaning).toHaveBeenCalledTimes(1));
    expect(actions.assertUploadMeaning).toHaveBeenCalledWith({
      artifactId: ARTIFACT_ID,
      extension: POST_EXT,
    });
  });

  it("R6: while the first assertion is pending, a second chip or Confirm press writes nothing more, and both are disabled", async () => {
    let settle: (r: { ok: true }) => void = () => undefined;
    actions.assertUploadMeaning.mockImplementation(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          settle = resolve;
        }),
    );
    answer({
      preselect: IDEA_EXT,
      suggestions: [{ extension: POST_EXT, label: "Post · Blog Post", confidence: 0.55 }],
    });
    const dialog = await openPicker();
    const chip = within(dialog).getByRole("button", {
      name: /^Post · Blog Post\s+0\.55$/,
    }) as HTMLButtonElement;
    expect(confirmButton(dialog).disabled).toBe(false);
    fireEvent.click(chip);
    await waitFor(() => expect(actions.assertUploadMeaning).toHaveBeenCalledTimes(1));
    // Pending: the chip and Confirm are disabled while the write is in flight.
    await waitFor(() => expect(chip.disabled).toBe(true));
    expect(confirmButton(dialog).disabled).toBe(true);
    fireEvent.click(chip);
    fireEvent.click(confirmButton(dialog));
    expect(actions.assertUploadMeaning).toHaveBeenCalledTimes(1);
    await act(async () => {
      settle({ ok: true });
    });
    expect(actions.assertUploadMeaning).toHaveBeenCalledTimes(1);
    expect(actions.assertUploadMeaning).toHaveBeenCalledWith({
      artifactId: ARTIFACT_ID,
      extension: POST_EXT,
    });
  });

  // Revision 3 (Codex spec review 2, finding 3): "dismissing it leaves the
  // base-only row". With a below-threshold chip drawn, leaving the picker writes
  // nothing — neither through "Keep as file" nor by closing the dialog.
  it("R7: with a below-threshold chip drawn, \"Keep as file\" closes the picker and writes no meaning", async () => {
    answer({
      preselect: null,
      suggestions: [{ extension: POST_EXT, label: "Post · Blog Post", confidence: 0.61 }],
    });
    const dialog = await openPicker();
    expect(within(dialog).getByRole("button", { name: /^Post · Blog Post\s+0\.61$/ })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep as file" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "What is this?" })).toBeNull(),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(actions.assertUploadMeaning).toHaveBeenCalledTimes(0);
  });

  it("R8: with a below-threshold chip drawn, closing the dialog (Escape) writes no meaning", async () => {
    answer({
      preselect: null,
      suggestions: [{ extension: POST_EXT, label: "Post · Blog Post", confidence: 0.61 }],
    });
    const dialog = await openPicker();
    expect(within(dialog).getByRole("button", { name: /^Post · Blog Post\s+0\.61$/ })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape", code: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "What is this?" })).toBeNull(),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(actions.assertUploadMeaning).toHaveBeenCalledTimes(0);
  });

  // GUARDS — green at the base by design (the base never pre-selects and never
  // draws a chip); they hold the fix's limits, each with its own mutation.
  it("G1: no meaning in the answer (today's server) leaves the picker as it was", async () => {
    answer(undefined);
    const dialog = await openPicker();
    expect(checkedStates(dialog)).toEqual(["false", "false"]);
    expect(within(dialog).queryByText("Suggested")).toBeNull();
    expect(confirmButton(dialog).disabled).toBe(true);
  });

  it("G2: a meaning the picker does not offer is neither pre-selected nor a chip", async () => {
    answer({
      preselect: "@acme/not-offered-artifact",
      suggestions: [
        { extension: "@acme/not-offered-artifact", label: "Other · Acme", confidence: 0.4 },
      ],
    });
    const dialog = await openPicker();
    expect(checkedStates(dialog)).toEqual(["false", "false"]);
    expect(within(dialog).queryByText("Suggested")).toBeNull();
    expect(confirmButton(dialog).disabled).toBe(true);
  });

  it("G3: the person's own press replaces the pre-selection", async () => {
    answer({ preselect: IDEA_EXT, suggestions: [] });
    const dialog = await openPicker();
    fireEvent.click(within(dialog).getByRole("radio", { name: POST_NAME }));
    expect(checkedStates(dialog)).toEqual(["false", "true"]);
    fireEvent.click(confirmButton(dialog));
    await waitFor(() => expect(actions.assertUploadMeaning).toHaveBeenCalledTimes(1));
    expect(actions.assertUploadMeaning).toHaveBeenCalledWith({
      artifactId: ARTIFACT_ID,
      extension: POST_EXT,
    });
  });
});
