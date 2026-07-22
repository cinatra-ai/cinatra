// @vitest-environment jsdom
/**
 * DefaultProvidersCard — Anthropic skill-upload section REMOVAL PIN
 * (cinatra#1104, following the #1972 openai honest-retirement template).
 *
 * The Anthropic skill-upload governance block (the "Upload skill content to
 * Anthropic" toggle + its non-ZDR data-residency warning) and its
 * "Connect Anthropic" affordance USED to be the last section on
 * `/configuration/llm`. It was a duplicate of the setting the
 * anthropic-connector Skills tab now owns (persisted through the
 * `@cinatra-ai/host:anthropic-skill-config` write capability), so core's copy
 * was retired.
 *
 * This test pins the ABSENCE of that section so an ungated re-introduction of a
 * second, core-side write surface for the non-ZDR skill-upload opt-in fails CI:
 *   1. the toggle + ZDR warning + Connect-Anthropic affordance render in
 *      NEITHER connector state (connected or not);
 *   2. `DefaultProvidersCard` no longer accepts an `anthropicSkillSyncEnabled`
 *      prop (dropped from `renderCard`) — TS would fail the build if it did.
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// next/link → a plain anchor so any rendered href is assertable in jsdom.
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

// The save button posts a server action; it is irrelevant to the removal contract.
vi.mock("@/app/campaigns/actions", () => ({
  setDefaultProvidersAction: vi.fn(),
}));

import { DefaultProvidersCard } from "../_default-llm-select";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mountedRoots: Root[] = [];

function renderCard(overrides: { anthropicConnected: boolean }): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  act(() => {
    root.render(
      <DefaultProvidersCard
        defaultLlmProvider="openai"
        defaultImageProvider="openai"
        openaiConnected
        anthropicConnected={overrides.anthropicConnected}
        geminiConnected={false}
        classificationModel="gpt-4o-mini"
        availableModels={["gpt-4o-mini", "gpt-4o"]}
        anthropicModels={["claude-opus-4-8", "claude-sonnet-4-5"]}
        agentCreationOpenaiModels={["gpt-5.5", "gpt-5"]}
        agentCreationProvider={null}
        agentCreationModel={null}
      />,
    );
  });
  return container;
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

describe("DefaultProvidersCard — Anthropic skill-upload section removed (#1104)", () => {
  for (const anthropicConnected of [true, false]) {
    it(`renders no skill-upload toggle or ZDR warning (anthropicConnected=${anthropicConnected})`, () => {
      const container = renderCard({ anthropicConnected });
      const text = container.textContent ?? "";
      expect(text).not.toContain("Upload skill content to Anthropic");
      expect(text).not.toMatch(/not ZDR-eligible/i);
      expect(
        container.querySelector("#anthropic-skill-sync-enabled"),
      ).toBeNull();
    });

    it(`renders no Connect-Anthropic setup affordance (anthropicConnected=${anthropicConnected})`, () => {
      const container = renderCard({ anthropicConnected });
      expect(
        container.querySelector(
          'a[href="/connectors/cinatra-ai/anthropic-connector/setup"]',
        ),
      ).toBeNull();
    });
  }
});
