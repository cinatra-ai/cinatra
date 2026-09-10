// @vitest-environment jsdom
/**
 * The artifacts library's scope control reads "Scope: {value}" (cinatra#3229).
 *
 *   pnpm exec vitest run src/components/artifacts/__tests__/library-toolbar-scope-reading-3229.test.tsx
 *
 * The ratified drawing (specs/app-artifacts.html §I) draws the library toolbar
 * as "Search artifacts", then "Type: All", then "Scope: Workspace" — the scope
 * control naming the field first and its value second, exactly as the Type
 * control beside it does. The shared control's trigger read "Workspace: All"
 * (the shared summary helper's default). The elected strings, on this mount
 * only: cleared → `Scope: Workspace`; one scope → `Scope: {its own label}`;
 * more than one → `Scope: {n} selected`. Rows and selection semantics do not
 * change; every other mount keeps the reading it has today.
 */
import "../../__tests__/access-picker-jsdom-shims";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const nav = vi.hoisted(() => ({
  pushes: [] as string[],
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (href: string) => nav.pushes.push(href) }),
  usePathname: () => "/artifacts",
  useSearchParams: () => new URLSearchParams(""),
}));

import { LibraryToolbar } from "@/components/artifacts/library-toolbar";
import { ScopeFilterCombobox } from "@/components/scope-filter-combobox";
import { resolveAccessSummary, type AvailableScopes } from "@/components/access-scope";
import type { ScopeToken } from "@/lib/scope-filter";

afterEach(cleanup);
beforeEach(() => {
  nav.pushes.length = 0;
});

const SCOPES: AvailableScopes = {
  orgs: [{ id: "o1", name: "Acme", teams: [{ id: "t1", name: "Eng" }] }],
  projects: [{ id: "p1", name: "Alpha" }],
  canGrantWorkspace: true,
};

function renderLibrary(scopeValue: ScopeToken[]) {
  const { container } = render(
    <LibraryToolbar
      query=""
      facetOptions={[]}
      scopeValue={scopeValue}
      scopes={SCOPES}
      uploadAction={null}
    />,
  );
  const trigger = container.querySelector<HTMLButtonElement>("#artifacts-scope-filter");
  if (!trigger) throw new Error("the library toolbar mounted no scope control");
  return { container, trigger, text: () => trigger.textContent?.trim() ?? "" };
}

function renderPlain(scopeValue: ScopeToken[]) {
  const { container } = render(
    <ScopeFilterCombobox id="plain-scope-filter" value={scopeValue} scopes={SCOPES} showAdmin={false} />,
  );
  const trigger = container.querySelector<HTMLButtonElement>("#plain-scope-filter")!;
  return { container, trigger, text: () => trigger.textContent?.trim() ?? "" };
}

function openRows(trigger: HTMLButtonElement): string[] {
  fireEvent.click(trigger);
  return screen.getAllByRole("option").map((o) => (o.textContent ?? "").replace(/\s+/g, " ").trim());
}

describe("artifacts library toolbar — the scope control reads Scope: {value} (cinatra#3229)", () => {
  it("1. cleared (the default) reads exactly `Scope: Workspace`", () => {
    expect(renderLibrary(["workspace"]).text()).toBe("Scope: Workspace");
    cleanup();
    expect(renderLibrary([]).text()).toBe("Scope: Workspace");
  });

  it("2. one chosen scope reads `Scope: {label}`; more than one reads `Scope: {n} selected`", () => {
    expect(renderLibrary(["team:t1"]).text()).toBe("Scope: Acme - Eng");
    cleanup();
    expect(renderLibrary(["project:p1"]).text()).toBe("Scope: Alpha");
    cleanup();
    expect(renderLibrary(["personal"]).text()).toBe("Scope: Only me");
    cleanup();
    expect(renderLibrary(["team:t1", "project:p1"]).text()).toBe("Scope: 2 selected");
    cleanup();
    expect(renderLibrary(["team:t1", "project:p1", "org:o1"]).text()).toBe("Scope: 3 selected");
  });

  it("3. the rows and the resulting scope tokens are identical to the shared control's — only the trigger's reading differs", () => {
    // Rows: the elected mount vs the plain shared control, same selection.
    const library = renderLibrary(["workspace"]);
    const libraryRows = openRows(library.trigger);
    cleanup();
    const plain = renderPlain(["workspace"]);
    const plainRows = openRows(plain.trigger);
    expect(libraryRows).toEqual(plainRows);
    expect(libraryRows.length).toBeGreaterThan(1);
    cleanup();

    // Tokens: the same sequence of toggles writes the same `?scope=` on both.
    const sequence = ["Team: Acme - Eng", "Project: Alpha", "Team: Acme - Eng"];
    const drive = (make: (v: ScopeToken[]) => { trigger: HTMLButtonElement }) => {
      nav.pushes.length = 0;
      const { trigger } = make(["workspace"]);
      fireEvent.click(trigger);
      for (const label of sequence) {
        const squash = (t: string) => t.replace(/\s+/g, "");
        const row = screen.getAllByRole("option").find((o) => squash(o.textContent ?? "") === squash(label));
        if (!row) throw new Error(`no row reads ${label}`);
        fireEvent.click(row);
      }
      const written = nav.pushes.map((href) => new URL(href, "http://x").searchParams.get("scope"));
      cleanup();
      return written;
    };
    const libraryTokens = drive(renderLibrary);
    const plainTokens = drive(renderPlain);
    expect(libraryTokens).toEqual(plainTokens);
    expect(libraryTokens).toEqual(["team:t1", "team:t1,project:p1", "project:p1"]);
  });

  it("4. every other mount keeps today's reading — the shared control and the shared summary helper are unchanged", () => {
    // The shared control, as /connectors and /assistants mount it, still reads
    // the helper's own composition.
    expect(renderPlain(["workspace"]).text()).toBe("Workspace: All");
    cleanup();
    expect(renderPlain(["team:t1"]).text()).toBe("Team: Acme - Eng");
    cleanup();
    expect(renderPlain(["team:t1", "project:p1"]).text()).toBe("1 project, 1 team");
    // The shared helper's pinned output holds.
    expect(resolveAccessSummary(["workspace"], SCOPES)).toBe("Workspace: All");

    // Source: the elected reading is passed at the artifacts mount and nowhere else.
    const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
    const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
    const mounts = [
      "src/components/artifacts/library-toolbar.tsx",
      "src/components/assistants/assistants-directory-client.tsx",
      "packages/connectors/src/connectors-client.tsx",
      "packages/skills/src/skills-toolbar.tsx",
    ];
    const electing = mounts.filter((rel) => /summarizeSelection=/.test(read(rel)));
    expect(electing).toEqual(["src/components/artifacts/library-toolbar.tsx"]);
  });
});
