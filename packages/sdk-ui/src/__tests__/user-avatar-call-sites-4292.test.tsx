// @vitest-environment jsdom
//
// User avatars in the shared UI package draw the person's initials on a
// categorical accent (cinatra#4292): the permissions panel's member list and
// the prompt field's mention list.
//
// The drawing (specs/app-components.html, Avatar): "User avatars carry the
// user's initials in Archivo italic 800 on a random categorical accent (never
// indigo or navy)". Before this change the member list drew a grey ground and,
// for a person with no name, an icon instead of initials; the mention list drew
// a grey ground and only the first letter. These tests render the real
// components with a named and a nameless person and read the drawn fallback:
// an accent ground, initials, no icon and no blank.

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { ACCENT_PALETTE, EXTENSION_ACCENTS, type ExtensionAccent } from "../lib/extension-accent";
import { PermissionsPanel, type PermissionsPanelProps, type OwnerView } from "../permissions-panel";
import { PromptField, type Mentionable } from "../prompt-field";

// These renders drive React through `act` directly.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The composer reads `window.localStorage` on mount; installed only when the
// environment lacks a working one.
if (typeof window !== "undefined" && typeof window.localStorage?.getItem !== "function") {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}
// The mention list opens in a positioned popover, which observes its size.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(node: React.ReactElement) {
  await act(async () => {
    root.render(node);
  });
}

/** Hex "#a6384f" as the rgb() text jsdom reports for an inline background. */
function rgbOf(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** The drawn fallback carries a palette accent, its ground, initials, and no icon. */
function expectInitialsOnAccent(fallback: Element | null | undefined, initials: string) {
  expect(fallback).toBeTruthy();
  const el = fallback as HTMLElement;
  const accent = el.getAttribute("data-accent");
  expect(EXTENSION_ACCENTS as readonly (string | null)[]).toContain(accent);
  expect(el.style.background).toBe(rgbOf(ACCENT_PALETTE[accent as ExtensionAccent].bg));
  expect(el.className).not.toMatch(/\bbg-muted\b/);
  expect(el.querySelector("svg")).toBeNull();
  expect(el.textContent).toBe(initials);
}

const OK = { ok: true } as const;

function panelProps(owner: OwnerView, coOwners: OwnerView[]): PermissionsPanelProps {
  return {
    canEdit: true,
    initialPolicy: {
      runListVisibility: ["owner"],
      runDataVisibility: ["owner"],
      runExecuteVisibility: ["owner"],
      allowRunSharing: true,
    },
    owner,
    coOwners,
    availableScopes: { orgs: [], projects: [], canGrantWorkspace: true },
    currentUserId: owner.userId,
    allowSharing: true,
    selfRemoveRedirect: "/connectors",
    actions: {
      savePolicy: async () => OK,
      searchCandidates: async () => ({ ok: true as const, results: [], hasMore: false }),
      addCoOwner: async () => OK,
      removeCoOwner: async () => OK,
    },
  };
}

/** The member row's avatar fallback, found by the row's e-mail line. */
function memberFallback(email: string): Element | null {
  const row = [...container.querySelectorAll("li")].find((li) =>
    li.textContent?.includes(email),
  );
  return row?.querySelector('[data-slot="avatar-fallback"]') ?? null;
}

describe("PermissionsPanel member list (cinatra#4292)", () => {
  it("draws a named person's initials on an accent", async () => {
    await render(
      <PermissionsPanel
        {...panelProps(
          { userId: "user-grace", name: "Grace Hopper", email: "grace@example.com", image: null },
          [],
        )}
      />,
    );
    expectInitialsOnAccent(memberFallback("grace@example.com"), "GH");
  });

  it("draws a nameless person's initials from the e-mail on an accent, never an icon", async () => {
    await render(
      <PermissionsPanel
        {...panelProps(
          { userId: "user-grace", name: "Grace Hopper", email: "grace@example.com", image: null },
          [{ userId: "user-ada", name: "", email: "ada.lovelace@example.com", image: null }],
        )}
      />,
    );
    expectInitialsOnAccent(memberFallback("ada.lovelace@example.com"), "AL");
  });

  it("keeps a valid persisted accent", async () => {
    await render(
      <PermissionsPanel
        {...panelProps(
          {
            userId: "user-grace",
            name: "Grace Hopper",
            email: "grace@example.com",
            image: null,
            accentColor: "plum",
          },
          [],
        )}
      />,
    );
    const fallback = memberFallback("grace@example.com");
    expectInitialsOnAccent(fallback, "GH");
    expect(fallback?.getAttribute("data-accent")).toBe("plum");
  });
});

const MENTIONABLES: Mentionable[] = [
  { id: "user-grace", handle: "grace_hopper", displayName: "Grace Hopper", type: "user", image: null },
  { id: "user-ada", handle: "ada_lovelace", displayName: "", type: "user", image: null },
  { id: "asst-1", handle: "cinatra", displayName: "Cinatra", type: "assistant", image: null },
];

/** Type "@" into the editor with the caret after it, which opens the mention list. */
async function openMentionList() {
  const editor = container.querySelector('[role="textbox"]') as HTMLElement;
  expect(editor).toBeTruthy();
  await act(async () => {
    editor.focus();
    editor.textContent = "@";
    const range = document.createRange();
    range.setStart(editor.firstChild as Text, 1);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The mention row's avatar fallback, found by its handle's display text. */
function mentionFallback(index: number): Element | null {
  const rows = document.body.querySelectorAll('[role="listbox"] > li');
  return rows[index]?.querySelector('[data-slot="avatar-fallback"]') ?? null;
}

describe("PromptField mention list (cinatra#4292)", () => {
  it("draws a person's initials on an accent, a nameless one's from the handle, and leaves assistants as they were", async () => {
    await render(
      <PromptField storageKey="prompt-4292" onSubmit={() => {}} mentionables={MENTIONABLES} />,
    );
    await openMentionList();
    expect(document.body.querySelectorAll('[role="listbox"] > li').length).toBe(3);

    expectInitialsOnAccent(mentionFallback(0), "GH");
    expectInitialsOnAccent(mentionFallback(1), "AL");

    const assistant = mentionFallback(2) as HTMLElement;
    expect(assistant).toBeTruthy();
    expect(assistant.getAttribute("data-accent")).toBeNull();
    expect(assistant.textContent).toBe("C");
  });

  it("draws a person's persisted accent from the row's accentColor", async () => {
    await render(
      <PromptField
        storageKey="prompt-4292-persisted"
        onSubmit={() => {}}
        mentionables={[
          {
            id: "user-grace",
            handle: "grace_hopper",
            displayName: "Grace Hopper",
            type: "user",
            image: null,
            accentColor: "rust",
          },
        ]}
      />,
    );
    await openMentionList();
    const fallback = mentionFallback(0);
    expectInitialsOnAccent(fallback, "GH");
    expect(fallback?.getAttribute("data-accent")).toBe("rust");
  });

  it("draws the fallback mark, never a blank, for a person with no display name and no handle", async () => {
    await render(
      <PromptField
        storageKey="prompt-4292-blank"
        onSubmit={() => {}}
        mentionables={[{ id: "user-blank", handle: "", displayName: "", type: "user", image: null }]}
      />,
    );
    await openMentionList();
    expectInitialsOnAccent(mentionFallback(0), "?");
  });

  it("keeps the old first-letter fallback, without an accent, for a row with no type or an assistant row, even when an accent is set", async () => {
    await render(
      <PromptField
        storageKey="prompt-4292-nonuser"
        onSubmit={() => {}}
        mentionables={[
          { id: "row-untyped", handle: "zed", displayName: "zed bot", image: null, accentColor: "rust" },
          {
            id: "asst-2",
            handle: "cinatra",
            displayName: "Cinatra",
            type: "assistant",
            image: null,
            accentColor: "plum",
          },
        ]}
      />,
    );
    await openMentionList();
    for (const [index, letter] of [[0, "Z"], [1, "C"]] as const) {
      const el = mentionFallback(index) as HTMLElement;
      expect(el).toBeTruthy();
      expect(el.getAttribute("data-accent")).toBeNull();
      expect(el.className).toMatch(/\bbg-muted\b/);
      expect(el.textContent).toBe(letter);
    }
  });
});
