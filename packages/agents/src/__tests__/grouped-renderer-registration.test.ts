/**
 * Verifies that `ensureDefaultFieldRenderersRegistered()` registers the
 * grouped setup form renderer under the ID
 * `@cinatra-ai/agent-builder:grouped-setup-form` with priority 50, AND that the
 * existing priority ordering is preserved — higher-priority specialized
 * renderers (e.g. gmail-sender at priority 100) still win when their
 * condition matches.
 *
 *   pnpm --filter @cinatra/agent-builder exec vitest run \
 *     src/__tests__/grouped-renderer-registration.test.ts
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Specialized-renderer action modules pull in external @cinatra/* packages
// (entity-contacts/mcp-handlers, sdk-ui, email outreach internals) that the
// vitest environment does not resolve. Mock them as no-ops so the renderer
// chain imports cleanly. The registration assertions only exercise the
// registry — they never invoke these actions.
// ---------------------------------------------------------------------------
vi.mock("../cta-actions", () => ({
  fetchAppointmentSchedules: vi.fn(async () => []),
}));
vi.mock("../skill-actions", () => ({
  fetchInstalledSkillsForAgent: vi.fn(async () => []),
  fetchSkillsBySlug: vi.fn(async () => []),
  fetchPersonalSkillsForAgent: vi.fn(async () => []),
}));
vi.mock("../email-outreach-stage-actions", () => ({
  fetchCampaignRecipients: vi.fn(async () => ({ items: [], total: 0 })),
  confirmCampaignRecipients: vi.fn(async () => undefined),
  checkEmailOutreachAsyncStatus: vi.fn(async () => ({ status: "idle" })),
  fetchInitialDrafts: vi.fn(async () => []),
  updateInitialDraft: vi.fn(async () => undefined),
  getReviewCheckState: vi.fn(async () => null),
  runReviewCheck: vi.fn(async () => null),
  dismissReviewRecommendation: vi.fn(async () => undefined),
  applyReviewRecommendation: vi.fn(async () => undefined),
}));

// Some renderers import @cinatra-ai/sdk-ui for LoadingSpinner etc. Provide a
// minimal stub so the module graph resolves without pulling the real package.
vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
}));

// sonner (toast) is side-effect-free to mock — the renderers only call toast().
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}));

// @/components/ui/table isn't aliased in vitest.config.ts; provide a stub
// so campaign-recipients-review-renderer.tsx resolves.
vi.mock("@/components/ui/table", () => ({
  Table: (p: any) => p.children ?? null,
  TableBody: (p: any) => p.children ?? null,
  TableCell: (p: any) => p.children ?? null,
  TableHead: (p: any) => p.children ?? null,
  TableHeader: (p: any) => p.children ?? null,
  TableRow: (p: any) => p.children ?? null,
}));

import { fieldRendererRegistry } from "../field-renderer-registry";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";

describe("grouped renderer registration", () => {
  beforeEach(() => {
    // register() is idempotent (replace-by-id), but other tests may have
    // registered non-default entries. Clear before each test to keep the
    // registry state deterministic.
    fieldRendererRegistry.clear();
    ensureDefaultFieldRenderersRegistered();
  });

  it("resolves the grouped renderer when schema['x-renderer'] === '@cinatra-ai/agent-builder:grouped-setup-form'", () => {
    const entry = fieldRendererRegistry.resolve(
      "hitl-field",
      { "x-renderer": "@cinatra-ai/agent-builder:grouped-setup-form" },
      { connectedApps: [] },
    );

    expect(entry).not.toBeNull();
    expect(entry?.id).toBe("@cinatra-ai/agent-builder:grouped-setup-form");
    expect(entry?.priority).toBe(50);
  });

  it("gmail-sender (priority 100) still wins when its x-renderer is set, not the grouped entry (no regression)", () => {
    // gmail-sender's condition matches when the field is named `senderEmail`
    // with x-renderer `@cinatra-ai/email-outreach-agent:gmail-sender` (see
    // packages/agent-builder/src/gmail-sender-renderer.ts `isGmailSenderField`).
    // This test asserts that priority 100 wins over the priority-50
    // grouped entry so registration preserves the existing priority ladder.
    const entry = fieldRendererRegistry.resolve(
      "senderEmail",
      {
        "x-renderer": "@cinatra-ai/email-outreach-agent:gmail-sender",
      },
      {
        connectedApps: ["gmail"],
        gmailAliases: [{ sendAsEmail: "ops@example.com", isDefault: true }],
      },
    );

    expect(entry).not.toBeNull();
    expect(entry?.id).toBe("@cinatra-ai/email-outreach-agent:gmail-sender");
  });

  // Silence potential console.warn chatter emitted by register() if a future
  // renderer ID isn't fully namespaced — keeps test output focused on the
  // assertion failures that matter.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
