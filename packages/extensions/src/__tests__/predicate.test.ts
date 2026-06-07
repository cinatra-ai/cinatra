import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@cinatra-ai/agents", () => ({
  readAgentTemplateByPackageName: vi.fn(),
  countRunsForTemplate: vi.fn(),
}));

// Wave 2 implemented extensionHasBeenUsed; Wave 4 exported countRunsForTemplate.
// Both imports are now valid — the @ts-expect-error directives have been removed.
import { extensionHasBeenUsed } from "../index";
import { readAgentTemplateByPackageName, countRunsForTemplate } from "@cinatra-ai/agents";

describe("extensionHasBeenUsed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false when no template found", async () => {
    (readAgentTemplateByPackageName as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    expect(
      await extensionHasBeenUsed({ registryUrl: "", packageName: "@x/y", version: "1.0.0" }),
    ).toBe(false);
  });

  it("returns false when template has zero runs", async () => {
    (readAgentTemplateByPackageName as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "tpl-1" });
    (countRunsForTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    expect(
      await extensionHasBeenUsed({ registryUrl: "", packageName: "@x/y", version: "1.0.0" }),
    ).toBe(false);
  });

  it("returns true when template has one or more runs", async () => {
    (readAgentTemplateByPackageName as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "tpl-1" });
    (countRunsForTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(3);
    expect(
      await extensionHasBeenUsed({ registryUrl: "", packageName: "@x/y", version: "1.0.0" }),
    ).toBe(true);
  });
});
