/**
 * cinatra#2653 — uploaded-draft rows on the admin extensions page.
 *
 * Direct unit coverage of `buildUploadedDraftRows` (the pure assembly seam):
 *   • a surfaceable draft maps to a kind=agent row with status "draft" and
 *     the backing `draftTemplateId` the Publish action needs;
 *   • a draft whose packageName already has a canonical identity is skipped
 *     (the installed row wins — no duplicate card);
 *   • a packageName-less draft never renders (no card identity);
 *   • rows sort by the shared name order.
 *
 * Plus file-grep pins on the wiring a later change must not weaken:
 *   • the loader gates drafts on `isPlatformAdmin` and filters through
 *     `isSurfaceableDraftTemplate`;
 *   • the screen renders draft rows with the Publish server-action form and
 *     prepends them to the default Active view and to All.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

// installed-rows.ts pulls the full discovery/host graph; every runtime import
// is stubbed — the function under test is pure.
vi.mock("@/lib/extensions", () => ({}));
vi.mock("@/lib/instance-identity-store", () => ({ readInstanceIdentity: () => null }));
vi.mock("@/lib/marketplace-credentials", () => ({ getEffectiveViewerScope: () => null }));
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: () => {} }));
vi.mock("@/lib/extension-discovery-scope", () => ({ resolveExtensionDiscoveryContext: vi.fn() }));
vi.mock("@/lib/verdaccio-config", () => ({ loadVerdaccioConfigForReads: vi.fn() }));
vi.mock("@/lib/generated/extensions.server", () => ({ STATIC_EXTENSION_MANIFEST: {} }));
vi.mock("@/lib/auth-session", () => ({ isPlatformAdmin: vi.fn(() => false) }));
vi.mock("@cinatra-ai/agents/store", () => ({ readInstalledAgentTemplates: vi.fn() }));
vi.mock("@cinatra-ai/agents/draft-visibility", () => ({ isSurfaceableDraftTemplate: vi.fn() }));
vi.mock("@cinatra-ai/registries", () => ({
  listExtensionPackages: vi.fn(),
  CATALOG_PACKUMENT_TIMEOUT_MS: 1,
  CATALOG_HYDRATION_BUDGET_MS: 1,
}));
vi.mock("../runtime-discovery-host", () => ({
  discoverActiveExtensionCapabilities: vi.fn(),
  discoverArchivedExtensionCapabilities: vi.fn(),
  readActiveManifestsFromStore: vi.fn(),
  readArchivedManifestsFromStore: vi.fn(),
}));
vi.mock("../canonical-store", () => ({ listInstalledExtensions: vi.fn() }));
vi.mock("../lifecycle-ui", () => ({ sourceVersion: () => null }));

import { buildUploadedDraftRows, rowKey } from "../screens/installed-rows";
import type { AgentTemplateRecord } from "@cinatra-ai/agents";

function draftTemplate(overrides: Partial<AgentTemplateRecord> = {}): AgentTemplateRecord {
  return {
    id: "tpl-1",
    name: "Everyday AI Blog Drafter",
    description: "Drafts a blog post.",
    status: "draft",
    sourceType: "internal",
    agentKind: "executor",
    packageName: "@e2e/blog-drafter-agent",
    packageVersion: "1.0.0",
    origin: null,
    ...overrides,
  } as unknown as AgentTemplateRecord;
}

describe("buildUploadedDraftRows (cinatra#2653)", () => {
  it("maps a surfaceable draft to a draft agent row carrying its templateId", () => {
    const rows = buildUploadedDraftRows([draftTemplate()], new Map());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "agent",
      packageName: "@e2e/blog-drafter-agent",
      displayName: "Everyday AI Blog Drafter",
      versionLabel: "v1.0.0",
      status: "draft",
      canonical: null,
      requiredInProd: false,
      draftTemplateId: "tpl-1",
    });
  });

  it("skips a draft whose packageName already has a canonical identity (installed row wins)", () => {
    const canonical = new Map([[rowKey("agent", "@e2e/blog-drafter-agent"), {}]]);
    expect(buildUploadedDraftRows([draftTemplate()], canonical)).toHaveLength(0);
  });

  it("skips a packageName-less draft (no card identity)", () => {
    expect(
      buildUploadedDraftRows([draftTemplate({ packageName: null })], new Map()),
    ).toHaveLength(0);
  });

  it("sorts rows by display name", () => {
    const rows = buildUploadedDraftRows(
      [
        draftTemplate({ id: "b", name: "Zeta Agent", packageName: "@e2e/z" }),
        draftTemplate({ id: "a", name: "Alpha Agent", packageName: "@e2e/a" }),
      ],
      new Map(),
    );
    expect(rows.map((r) => r.displayName)).toEqual(["Alpha Agent", "Zeta Agent"]);
  });
});

describe("draft wiring pins (cinatra#2653)", () => {
  const rowsSource = readFileSync(
    path.resolve(__dirname, "..", "screens", "installed-rows.ts"),
    "utf8",
  );
  const screenSource = readFileSync(
    path.resolve(__dirname, "..", "screens", "registry-catalog-screen.tsx"),
    "utf8",
  );

  it("the loader gates drafts on isPlatformAdmin and the surfaceable predicate", () => {
    expect(rowsSource).toMatch(/isPlatformAdmin\(/);
    expect(rowsSource).toMatch(/statuses:\s*\["draft"\]/);
    expect(rowsSource).toMatch(/isSurfaceableDraftTemplate/);
    expect(rowsSource).toMatch(/buildUploadedDraftRows\(draftTemplates, canonicalByKey\)/);
  });

  it("the screen renders a draft row with the Publish server-action form", () => {
    expect(screenSource).toMatch(/publishAgentTemplateFormAction/);
    expect(screenSource).toMatch(/renderDraftActions/);
    expect(screenSource).toMatch(/data-slot="draft-extension-publish"/);
    // Draft rows never get the Settings/More-details pair.
    expect(screenSource).toMatch(
      /row\.status === "draft" \? renderDraftActions\(row\) : renderCardActions\(row, isArchived\)/,
    );
  });

  it("drafts prepend to the default Active view and to All", () => {
    expect(screenSource).toMatch(/\[\.\.\.draftRows, \.\.\.activeRows\.filter/);
    expect(screenSource).toMatch(/\.\.\.draftRows,\s*\n\s*\.\.\.\[\.\.\.activeRows, \.\.\.archivedRows\]/);
  });
});
