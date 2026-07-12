// @vitest-environment jsdom
/**
 * DefaultProvidersCard — the Anthropic skill-upload governance section is GONE
 * from core (cinatra#1104 / S3b).
 *
 * The "Upload skill content to Anthropic" opt-in, its always-visible non-ZDR
 * data-residency warning, and the not-connected "Connect Anthropic" affordance
 * that used to be the last section on `/configuration/llm` were moved OUT of
 * core into the anthropic-connector's own Skills tab. The connector now renders
 * + writes the setting (via the `@cinatra-ai/host:anthropic-skill-config`
 * capability); core retains the canonical reader + that host-capability writer.
 *
 * This is the removal-side regression guard: the section must NOT render for
 * either connector state, and the card no longer accepts an
 * `anthropicSkillSyncEnabled` prop.
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

// The save button posts a server action; it is irrelevant to this contract.
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

describe("DefaultProvidersCard: Anthropic skill-upload section removed from core (#1104)", () => {
  it("does NOT render the skill-upload section when the Anthropic connector is set up", () => {
    const container = renderCard({ anthropicConnected: true });
    const text = container.textContent ?? "";
    expect(text).not.toContain("Upload skill content to Anthropic");
    expect(text).not.toMatch(/not ZDR-eligible/i);
    expect(container.querySelector("#anthropic-skill-sync-enabled")).toBeNull();
  });

  it("does NOT render the skill-upload section when the Anthropic connector is NOT set up", () => {
    const container = renderCard({ anthropicConnected: false });
    const text = container.textContent ?? "";
    expect(text).not.toContain("Upload skill content to Anthropic");
    expect(text).not.toMatch(/not ZDR-eligible/i);
    expect(container.querySelector("#anthropic-skill-sync-enabled")).toBeNull();
  });

  it("no longer renders the core Connect-Anthropic skill affordance in either state", () => {
    for (const anthropicConnected of [true, false]) {
      const container = renderCard({ anthropicConnected });
      expect(
        container.querySelector(
          'a[href="/connectors/cinatra-ai/anthropic-connector/setup"]',
        ),
      ).toBeNull();
    }
  });
});
