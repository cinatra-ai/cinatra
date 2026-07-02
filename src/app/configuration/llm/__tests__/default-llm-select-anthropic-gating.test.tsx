// @vitest-environment jsdom
/**
 * DefaultProvidersCard end-of-page Anthropic section gating (cinatra#613).
 *
 * The Anthropic skill-upload governance block (the "Upload skill content to
 * Anthropic" toggle + its non-ZDR data-residency warning) is the last section
 * on `/configuration/llm`. It must NOT render when the Anthropic connector
 * isn't set up — showing Anthropic-specific config for a provider that isn't
 * connected makes no sense. When hidden, a discoverable "Connect Anthropic"
 * affordance must remain, pointing at the connector setup page.
 *
 * Gating is on `anthropicConnected`, which the server page derives from durable
 * connector setup state (a saved Nango connection — see
 * `getAnthropicAPIStatus`), NOT a live healthcheck, so a momentary Anthropic
 * outage does not make the section vanish.
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// next/link → a plain anchor so the rendered href is assertable in jsdom.
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

// The save button posts a server action; it is irrelevant to the gating contract.
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
        anthropicSkillSyncEnabled={false}
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

describe("DefaultProvidersCard Anthropic section gating (#613)", () => {
  it("renders the Anthropic skill-upload section when the connector is set up", () => {
    const container = renderCard({ anthropicConnected: true });
    const text = container.textContent ?? "";
    expect(text).toContain("Upload skill content to Anthropic");
    // The always-visible non-ZDR data-residency warning is part of the section.
    expect(text).toMatch(/not ZDR-eligible/i);
    // The opt-in toggle is present.
    expect(
      container.querySelector("#anthropic-skill-sync-enabled"),
    ).not.toBeNull();
  });

  it("hides the Anthropic skill-upload section when the connector is NOT set up", () => {
    const container = renderCard({ anthropicConnected: false });
    const text = container.textContent ?? "";
    expect(text).not.toContain("Upload skill content to Anthropic");
    expect(text).not.toMatch(/not ZDR-eligible/i);
    expect(
      container.querySelector("#anthropic-skill-sync-enabled"),
    ).toBeNull();
  });

  it("keeps a discoverable Connect Anthropic affordance when the connector is NOT set up", () => {
    const container = renderCard({ anthropicConnected: false });
    const connectLink = container.querySelector(
      'a[href="/connectors/cinatra-ai/anthropic-connector/setup"]',
    );
    expect(connectLink).not.toBeNull();
    expect(connectLink?.textContent ?? "").toMatch(/connect anthropic/i);
  });
});
