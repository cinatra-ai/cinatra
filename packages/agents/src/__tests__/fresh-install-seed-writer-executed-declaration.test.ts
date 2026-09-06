/**
 * cinatra#3208, hop 3 of 3 — the FRESH-install SEED WRITER must carry the
 * executed artifact-binding declaration all the way onto the template ROW.
 *
 * The negative proof this file pins: `installAgentFromPackage` builds its
 * fresh-install seed with `artifactBindings: seed.artifactBindings` and hands
 * that seed to `createLocalAgentTemplateVersion` (the shared creation path for
 * ZIP imports AND registry installs). That function does NOT spread its seed —
 * it threads an explicit field list into `createAgentTemplate` — so a field
 * missing from the list is dropped SILENTLY, with no type error, because the
 * seed reaches it as a variable rather than a fresh object literal.
 *
 * With `artifactBindings` absent from that list, every FIRST install of a
 * package landed `agent_templates.artifact_bindings = NULL`. NULL reads as
 * "unknown", so the run-completion materializer fell straight back to its
 * pre-#3208 registry re-read — which is the entire defect #3208 reports, still
 * live on the single most common path a package arrives by. The install-time
 * suite could not see it: its FRESH cases assert the SEED, and the seed is
 * correct; the value dies one hop later.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/fresh-install-seed-writer-executed-declaration.test.ts
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const createTemplate = vi.fn(async (..._a: unknown[]) => ({ id: "tmpl-1" }));
vi.mock("../store", () => ({
  createAgentTemplate: (...a: unknown[]) => createTemplate(...(a as [])),
  createAgentVersion: vi.fn(async () => {}),
  readAgentTemplateById: vi.fn(async () => null),
}));
vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: vi.fn(async () => ({ user: { id: "u" } })),
}));
vi.mock("@/lib/authz", () => ({ logAuditEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/authz/actor-context", () => ({ POLICY_VERSION: "test" }));
vi.mock("../import-agent-core", () => ({
  importAgentTemplateCore: vi.fn(async () => ({})),
}));
vi.mock("../publish-template", () => ({
  publishAgentTemplateAndBindVersion: vi.fn(async () => {}),
}));
vi.mock("../agent-template-identity", () => ({
  deriveAgentTemplateIdentityClaim: vi.fn(() => null),
}));

import { createLocalAgentTemplateVersion } from "../import-export-actions";

/** The serialized fan-out declaration a real blog-idea-generator compile produces. */
const DECLARATION = JSON.stringify({
  v: 1,
  bindings: [
    {
      nodeId: "endNode",
      outputId: "ideas",
      binding: {
        extension: "@cinatra-ai/blog-idea-artifact",
        contentFrom: "ideas",
        declaredMime: "text/plain",
        fanOut: { mode: "member", titleFrom: "first-line", titlePrefix: "Title:" },
      },
    },
  ],
  producesRefs: [{ extension: "@cinatra-ai/blog-idea-artifact" }],
});

const rowInput = () => createTemplate.mock.calls[0]?.[0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cinatra#3208 — createLocalAgentTemplateVersion carries the executed declaration onto the row", () => {
  it("FRESH install: the seed's artifactBindings reaches createAgentTemplate (never dropped in the field list)", async () => {
    await createLocalAgentTemplateVersion({
      seed: {
        name: "Blog Idea Generator",
        packageName: "@cinatra-ai/blog-idea-generator-agent",
        packageVersion: "0.1.0",
        hasArtifactBindings: true,
        artifactBindings: DECLARATION,
      },
    });
    expect(rowInput().artifactBindings).toBe(DECLARATION);
  });

  it("FRESH install: artifactBindings and packageVersion land in the SAME create input (one write, so the version pin can trust the pair)", async () => {
    await createLocalAgentTemplateVersion({
      seed: {
        packageName: "@cinatra-ai/blog-idea-generator-agent",
        packageVersion: "0.1.0",
        hasArtifactBindings: true,
        artifactBindings: DECLARATION,
      },
    });
    expect(createTemplate).toHaveBeenCalledTimes(1);
    const row = rowInput();
    expect(row.packageVersion).toBe("0.1.0");
    expect(row.artifactBindings).toBe(DECLARATION);
  });

  it("a seed with no declaration lands null (unknown), never undefined-and-forgotten", async () => {
    await createLocalAgentTemplateVersion({
      seed: {
        packageName: "@cinatra-ai/x",
        packageVersion: "1.0.0",
        hasArtifactBindings: false,
      },
    });
    expect(rowInput().artifactBindings).toBeNull();
  });
});
