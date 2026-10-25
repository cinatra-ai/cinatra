// @vitest-environment jsdom
//
// A person's mention avatar draws the initials of their directory name
// (cinatra#4292), on the production path: the real `GET /api/assistants/list`
// handler builds the JSON, the real `fetchMentionables` reads it (as /chat and
// the widget do), and the real `PromptField` draws the mention list.
//
// The route returns a person's display name ("Grace Hopper"); the chat labels
// every row by its handle. Before this fix `fetchMentionables` dropped the
// display name, so the avatar took its initials from the handle and drew one
// letter ("grace_hopper" drew "G"). The database and auth are mocked as in
// `route.test.ts`; nothing between the handler's response and the drawn
// avatar is handcrafted.

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const betterAuthUsers = {
    id: "users.id",
    name: "users.name",
    username: "users.username",
    email: "users.email",
    image: "users.image",
    userType: "users.userType",
  };
  const betterAuthMembers = { userId: "members.userId", organizationId: "members.organizationId" };
  const state: { rows: unknown[]; callerMembership: unknown[]; handles: Record<string, string> } = {
    rows: [],
    callerMembership: [],
    handles: {},
  };
  const lookupAssistantHandlesByIds = (ids: string[]) =>
    Promise.resolve(new Map(ids.filter((id) => id in state.handles).map((id) => [id, state.handles[id]])));
  const betterAuthDb = {
    select: () => ({
      from: (table: unknown) => ({
        where: (filter: unknown) => {
          if (table === betterAuthMembers) {
            if (filter && (filter as { __op?: string }).__op === "and") {
              return { limit: () => Promise.resolve(state.callerMembership) };
            }
            return { __subquery: filter };
          }
          return Promise.resolve(state.rows);
        },
      }),
    }),
  };
  const getSession = vi.fn();
  return { betterAuthUsers, betterAuthMembers, betterAuthDb, lookupAssistantHandlesByIds, state, getSession };
});

vi.mock("next/headers", () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: (...a: unknown[]) => h.getSession(...a) } } }));
vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: h.betterAuthDb,
  betterAuthMembers: h.betterAuthMembers,
  betterAuthUsers: h.betterAuthUsers,
  lookupAssistantHandlesByIds: (ids: string[]) => h.lookupAssistantHandlesByIds(ids),
}));
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ __op: "and", args }),
  eq: (col: unknown, val: unknown) => ({ __op: "eq", col, val }),
  inArray: (col: unknown, sub: unknown) => ({ __op: "inArray", col, sub }),
  or: (...args: unknown[]) => ({ __op: "or", args }),
}));

import { GET } from "../route";
import { fetchMentionables } from "@cinatra-ai/chat/conversation-services";
import { PromptField, type Mentionable } from "@cinatra-ai/sdk-ui/prompt-field";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

let container: HTMLDivElement;
let root: Root;
const realFetch = globalThis.fetch;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  h.state.rows = [];
  h.state.callerMembership = [];
  h.state.handles = {};
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

/** The mention list's rows as the directory route and the chat's reader give them. */
async function mentionablesFromTheRoute(): Promise<Mentionable[]> {
  h.getSession.mockResolvedValue({
    user: { id: "u-self" },
    session: { activeOrganizationId: "org-1" },
  });
  h.state.callerMembership = [{ userId: "u-self" }];
  h.state.rows = [
    { id: "u-self", name: "Me", userType: null },
    // No username: the handle derives from the name.
    { id: "u-grace", name: "Grace Hopper", username: null, email: "grace@example.com", userType: null },
    // A username unlike the name: the handle is "ghopper", the name "Ada Lovelace".
    { id: "u-ada", name: "Ada Lovelace", username: "ghopper", email: "ada@example.com", userType: null },
    { id: "asst", username: "cinatra", userType: "assistant" },
  ];
  h.state.handles = { asst: "cinatra" };

  const res = await GET(new Request("https://app.test/api/assistants/list"));
  expect(res.status).toBe(200);
  const fetched: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return res;
  }) as typeof fetch;
  const list = await fetchMentionables();
  expect(fetched).toEqual(["/api/assistants/list"]);
  return list;
}

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

/** The drawn avatar fallback of the mention row whose label is `label`. */
function fallbackOfRow(label: string): HTMLElement {
  const rows = [...document.body.querySelectorAll('[role="listbox"] > li')];
  const row = rows.find((li) => li.querySelector("span.truncate")?.textContent === label);
  expect(row, `a mention row labelled ${label}`).toBeTruthy();
  const fallback = row!.querySelector('[data-slot="avatar-fallback"]') as HTMLElement | null;
  expect(fallback).toBeTruthy();
  return fallback!;
}

describe("mention avatars on the directory route's path (cinatra#4292)", () => {
  it("keeps each person's directory name for the avatar and labels the row by its handle", async () => {
    const list = await mentionablesFromTheRoute();
    const grace = list.find((m) => m.id === "u-grace");
    const ada = list.find((m) => m.id === "u-ada");
    expect(grace).toMatchObject({ type: "user", name: "Grace Hopper", displayName: grace?.handle });
    expect(ada).toMatchObject({ type: "user", handle: "ghopper", name: "Ada Lovelace", displayName: "ghopper" });
  });

  it("draws two initials from the person's name, not one from the handle", async () => {
    const list = await mentionablesFromTheRoute();
    const graceHandle = list.find((m) => m.id === "u-grace")!.handle;
    await act(async () => {
      root.render(<PromptField storageKey="prompt-4292-route" onSubmit={() => {}} mentionables={list} />);
    });
    await openMentionList();

    const grace = fallbackOfRow(graceHandle);
    expect(grace.textContent).toBe("GH");
    expect(grace.getAttribute("data-accent")).toBeTruthy();

    // The name, not the handle "ghopper", gives the initials.
    const ada = fallbackOfRow("ghopper");
    expect(ada.textContent).toBe("AL");
    expect(ada.getAttribute("data-accent")).toBeTruthy();

    // The assistant row keeps its first letter and no accent.
    const assistant = fallbackOfRow("cinatra");
    expect(assistant.textContent).toBe("C");
    expect(assistant.getAttribute("data-accent")).toBeNull();
  });
});
