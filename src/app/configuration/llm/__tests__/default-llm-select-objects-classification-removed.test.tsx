// @vitest-environment jsdom
/**
 * REMOVAL PIN (cinatra#2335 AC2): `/configuration/llm` no longer renders the
 * "Objects classification" model row.
 *
 * That row let an admin store a BARE model string (a hardcoded `gpt-4*` option
 * list, fallback `gpt-4o-mini`) which was forwarded verbatim to whichever LLM
 * adapter the runtime resolved — a per-call provider failure on an
 * Anthropic-default instance. The object classifier now rides the resolved
 * provider runtime's configured default model, so there is nothing to configure
 * here.
 *
 * Pinned (following the #1104 removal-pin template in the sibling file):
 *   1. the row label, its select, and every `gpt-4*` option are ABSENT;
 *   2. `DefaultProvidersCard` no longer accepts `classificationModel` /
 *      `availableModels` props (dropped from `renderCard` — TS fails the build
 *      if they came back);
 *   3. the two REMAINING rows (Standard provider, Image generation) still
 *      render unchanged;
 *   4. the save button's lock semantics were RECOMPUTED with the row gone: it
 *      is hidden when both provider selects are locked and the agent-creation
 *      row is inert, and shown as soon as any control is genuinely editable.
 *      (The old `bothLocked = false` existed ONLY because the classification
 *      row was always editable.)
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) =>
    React.createElement("a", { href, ...rest }, children),
}));

vi.mock("@/app/campaigns/actions", () => ({
  setDefaultProvidersAction: vi.fn(),
}));

import { DefaultProvidersCard } from "../_default-llm-select";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mountedRoots: Root[] = [];

function renderCard(
  overrides: {
    openaiConnected?: boolean;
    anthropicConnected?: boolean;
    geminiConnected?: boolean;
    agentCreationPinActive?: boolean;
  } = {},
): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  act(() => {
    root.render(
      <DefaultProvidersCard
        defaultLlmProvider="openai"
        defaultImageProvider="openai"
        openaiConnected={overrides.openaiConnected ?? true}
        anthropicConnected={overrides.anthropicConnected ?? false}
        geminiConnected={overrides.geminiConnected ?? false}
        anthropicModels={["claude-opus-4-8", "claude-sonnet-4-5"]}
        agentCreationOpenaiModels={["gpt-5.5", "gpt-5"]}
        agentCreationProvider={null}
        agentCreationModel={null}
        agentCreationPinActive={overrides.agentCreationPinActive ?? false}
      />,
    );
  });
  return container;
}

/** The single "Save defaults" button (the select triggers are buttons too). */
function saveButton(container: HTMLElement): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Save defaults"),
    ) ?? null
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
  document.body.innerHTML = "";
});

describe("DefaultProvidersCard — Objects classification row removed (#2335)", () => {
  it("renders no 'Objects classification' row", () => {
    const container = renderCard();
    expect(container.textContent ?? "").not.toContain("Objects classification");
  });

  it("offers no bare gpt-4* classification model option", () => {
    // The retired row was the ONLY place this card offered gpt-4* ids; the
    // agent-creation option set is the gpt-5 family.
    const container = renderCard({ agentCreationPinActive: true });
    expect(container.textContent ?? "").not.toMatch(/gpt-4/);
  });

  it("still renders the two remaining rows unchanged", () => {
    const text = renderCard({ geminiConnected: true }).textContent ?? "";
    expect(text).toContain("Standard");
    expect(text).toContain("Image generation");
  });

  it("hides the save button when nothing on the card is editable", () => {
    // One LLM provider + one image provider ⇒ both selects locked; the
    // agent-creation row is inert. Previously the always-editable
    // classification row forced the button to render.
    const container = renderCard();
    expect(saveButton(container)).toBeNull();
  });

  it("shows the save button whenever a control is genuinely editable", () => {
    // Two image providers ⇒ the image select is editable again.
    expect(saveButton(renderCard({ geminiConnected: true }))).not.toBeNull();

    // …and the agent-creation row lighting up also un-locks the card.
    expect(saveButton(renderCard({ agentCreationPinActive: true }))).not.toBeNull();
  });
});
