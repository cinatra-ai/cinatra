// @vitest-environment jsdom
/**
 * WebhooksTable presentational contract (cinatra#342).
 *
 * The Configuration → Webhooks list renders the inbound-webhook registry from the
 * import-free GENERATED_WEBHOOK_REGISTRY_META pure data:
 *   - empty (the default state today, pre-#343) → crash-free empty-state copy.
 *   - non-empty → a row per hook showing vendor, scope, hook (+label) and the
 *     derived public path `/webhook/<vendor>/<slug>/<hook>`.
 *
 * Tests the presentational component directly (the server page wraps it with
 * requireAdminSession, covered by the page's admin enforcement, not here).
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  WebhooksTable,
  webhookPublicPath,
} from "../_components/webhooks-table";
import type { GeneratedWebhookRegistryMeta } from "@/lib/generated/webhook-registry-meta";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mountedRoots: Root[] = [];

function render(rows: readonly GeneratedWebhookRegistryMeta[]): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  act(() => {
    root.render(<WebhooksTable rows={rows} />);
  });
  return container;
}

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.innerHTML = "";
});

const sampleRow: GeneratedWebhookRegistryMeta = {
  scope: "@cinatra-ai/wordpress-mcp-connector",
  vendor: "cinatra-ai",
  slug: "wordpress-mcp-connector",
  hook: "post-published",
  label: "Post published",
};

describe("webhookPublicPath", () => {
  it("derives /webhook/<vendor>/<slug>/<hook>", () => {
    expect(webhookPublicPath(sampleRow)).toBe(
      "/webhook/cinatra-ai/wordpress-mcp-connector/post-published",
    );
  });
});

describe("WebhooksTable", () => {
  it("renders the empty-state when no webhooks are registered", () => {
    const container = render([]);
    expect(container.textContent).toContain("No webhooks registered yet");
    // No table rows rendered.
    expect(container.querySelectorAll("tbody tr")).toHaveLength(0);
  });

  it("gives actionable empty-state guidance (issue 615)", () => {
    const container = render([]);
    const text = container.textContent ?? "";
    // (1) make clear webhooks are extension-authored, not registered here.
    expect(text).toContain("provided by installed extensions");
    expect(text).toContain("cinatra.webhooks");
    expect(text).toMatch(/can.?t register one from this page/);
    // (2) a concrete example of how a webhook is served once declared.
    expect(text).toContain("post-published");
    // (3) a docs link to the webhook-authoring guide + a marketplace link.
    const hrefs = Array.from(
      container.querySelectorAll("a"),
      (a) => a.getAttribute("href"),
    );
    expect(
      hrefs.some((h) =>
        h?.includes("docs/webhooks/authoring-inbound-webhooks.md"),
      ),
    ).toBe(true);
    expect(hrefs).toContain("/configuration/marketplace");
  });

  it("renders a row per registered webhook with the derived public path", () => {
    const container = render([sampleRow]);
    const text = container.textContent ?? "";
    expect(text).toContain("cinatra-ai");
    expect(text).toContain("@cinatra-ai/wordpress-mcp-connector");
    expect(text).toContain("post-published");
    expect(text).toContain("Post published");
    expect(text).toContain(
      "/webhook/cinatra-ai/wordpress-mcp-connector/post-published",
    );
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(text).not.toContain("No webhooks registered yet");
  });
});
