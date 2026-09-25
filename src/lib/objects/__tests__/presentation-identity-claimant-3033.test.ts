// cinatra#3033 (CELL4, the library row's extension label). app-artifacts §II
// draws "a muted extension label naming the type's defining extension", and
// app-artifact-review §XI.10 says a re-typed row "reads as the claiming
// extension's row — its type on the mono line, its extension on the tag".
//
// A person typed a markdown upload as the LinkedIn post draft through the
// library's own picker. The row's type is the host-registered
// `@cinatra-ai/linkedin:post-draft`; the pack the person chose,
// `@cinatra-ai/linkedin-artifacts`, owns that type only through a
// cross-namespace CLAIM. Presentation liveness came from type-id namespaces
// alone, so the claiming pack was never live, the person's own assertion could
// not win tier 1, and the row presented under the markdown base's binding.
//
// The shared effective identity is NOT this seam's business and stays the
// type's namespace owner.

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// The three mocks of presentation-identity.host.test.ts, copied (never
// imported across files).
const runPostgresQueriesSync = vi.fn();
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...a: unknown[]) => runPostgresQueriesSync(...a),
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));
vi.mock("@/lib/postgres-config", () => ({
  postgresSchema: "cinatra",
  getPostgresConnectionString: () => "postgres://test",
}));

import { matcherManifestRegistry, objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { semanticRendererRegistry } from "@cinatra-ai/objects/artifact-renderer-registry";
import { registerAllObjectTypes as registerObjectsPackageObjectTypes } from "@cinatra-ai/objects/register-object-types";
import {
  forgetCrossNamespaceClaimsOf,
  registerParsedArtifactManifest,
} from "@cinatra-ai/objects/register-artifact-extensions";
import { parseSemanticArtifactManifest } from "@cinatra-ai/objects/semantic-manifest";
import { resolveEffectiveIdentity } from "@cinatra-ai/objects/effective-identity";
import type { SemanticArtifactManifest } from "@cinatra-ai/objects";

import {
  resolveArtifactPresentationIdentities,
  selectLiveExtensions,
} from "@/lib/objects/presentation-identity";
import { _resetArtifactAutoSurfaceToggleForTests } from "@/lib/objects/artifact-autosurface-toggle";

const ORG = "org-1";
const LINKEDIN_PACK = "@cinatra-ai/linkedin-artifacts";
const LINKEDIN_TYPE = "@cinatra-ai/linkedin:post-draft";
const MARKDOWN_PACK = "@cinatra-ai/markdown-artifact";
const IDEA_PACK = "@cinatra-ai/blog-idea-artifact";
const IDEA_TYPE = "@cinatra-ai/blog-idea-artifact:blog-idea";

const PINNED_LINKEDIN_MANIFEST = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "extensions",
  "cinatra-ai",
  "linkedin-artifacts",
  "package.json",
);

type Row = Record<string, unknown>;

function pinnedLinkedinManifest(): { name: string; manifest: SemanticArtifactManifest } {
  const pkg = JSON.parse(readFileSync(PINNED_LINKEDIN_MANIFEST, "utf8")) as {
    name: string;
    cinatra: { artifact: unknown };
  };
  const parsed = parseSemanticArtifactManifest(pkg.cinatra.artifact);
  if (!parsed.ok) throw new Error(`pinned manifest does not parse: ${parsed.errors.join("; ")}`);
  return { name: pkg.name, manifest: parsed.manifest };
}

/** An own-namespace object type, registered as its pack — the pack is live
 * through the type it owns. */
function registerOwnType(typeId: string, pkg: string): void {
  objectTypeRegistry.register(
    {
      type: typeId,
      category: "report",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent"], mutableBy: ["agent"] },
      renderers: { listRow: null, card: null, detail: null },
    },
    pkg,
  );
}

function prime(rows: Row[], installRows: Row[] = []): void {
  runPostgresQueriesSync.mockImplementation((input: { queries: Array<{ text: string }> }) => {
    const text = input.queries[0]?.text ?? "";
    if (text.includes("semantic_assertion")) return [{ rows, rowCount: rows.length }];
    if (text.includes("installed_extension")) {
      return [{ rows: installRows, rowCount: installRows.length }];
    }
    throw new Error(`unexpected query: ${text}`);
  });
}

function sa(part: Partial<Row> & { artifact_id: string; extension: string }): Row {
  return {
    asserted_by: "user",
    eligibility: "eligible",
    assertion_basis: "classic",
    confidence: null,
    asserted_at: "2026-09-24T00:00:00.000Z",
    ...part,
  };
}

function clearAll(): void {
  forgetCrossNamespaceClaimsOf(LINKEDIN_PACK);
  objectTypeRegistry._clearForTests();
  matcherManifestRegistry._clearForTests();
  semanticRendererRegistry._clearForTests();
}

afterAll(() => {
  vi.doUnmock("@/lib/postgres-sync");
  vi.doUnmock("@/lib/postgres-schema-init");
  vi.doUnmock("@/lib/postgres-config");
  vi.resetModules();
});

describe("selectLiveExtensions — a pack is presentation-live through the type it CLAIMS (cinatra#3033)", () => {
  it("makes the id's namespace owner live", () => {
    const live = selectLiveExtensions([{ typeId: "@acme/legal:contract", claimants: [] }]);
    expect(live.has("@acme/legal")).toBe(true);
  });

  it("makes the claimant of a registered type live, and keeps its namespace owner live", () => {
    const live = selectLiveExtensions([{ typeId: LINKEDIN_TYPE, claimants: [LINKEDIN_PACK] }]);
    expect(live.has(LINKEDIN_PACK)).toBe(true);
    expect(live.has("@cinatra-ai/linkedin")).toBe(true);
  });

  it("makes nothing live from an empty entry list", () => {
    expect(selectLiveExtensions([]).size).toBe(0);
  });

  it("keeps every claimant of a doubly-claimed type live", () => {
    const live = selectLiveExtensions([
      { typeId: LINKEDIN_TYPE, claimants: ["@a/one", "@b/two"] },
    ]);
    expect(live.has("@a/one")).toBe(true);
    expect(live.has("@b/two")).toBe(true);
  });
});

describe("the typed LinkedIn post draft's row presents under the claiming pack (cinatra#3033 CELL4)", () => {
  beforeEach(() => {
    runPostgresQueriesSync.mockReset();
    clearAll();
    _resetArtifactAutoSurfaceToggleForTests();
    // The host registrations (the objects package's own registration entry),
    // then the PINNED LinkedIn pack's claim, then the own-namespace types.
    registerObjectsPackageObjectTypes();
    const { name, manifest } = pinnedLinkedinManifest();
    registerParsedArtifactManifest(manifest, name);
    registerOwnType(`${MARKDOWN_PACK}:artifact`, MARKDOWN_PACK);
    registerOwnType(IDEA_TYPE, IDEA_PACK);
  });

  afterEach(() => {
    clearAll();
    _resetArtifactAutoSurfaceToggleForTests();
    runPostgresQueriesSync.mockReset();
  });

  it("the person's own assertion of the claiming pack wins tier 1 over the markdown binding", () => {
    prime([
      sa({ artifact_id: "li1", extension: LINKEDIN_PACK, asserted_by: "user" }),
      sa({
        artifact_id: "li1",
        extension: MARKDOWN_PACK,
        asserted_by: "system",
        assertion_basis: "binding",
      }),
    ]);
    const out = resolveArtifactPresentationIdentities({
      orgId: ORG,
      rows: [{ id: "li1", type: LINKEDIN_TYPE }],
    });
    expect(out.get("li1")?.identity).toEqual({ kind: "extension", extension: LINKEDIN_PACK });
    expect(out.get("li1")?.tier).toBe("classic");
  });

  it("the blog idea row keeps its own pack at tier 1", () => {
    prime([sa({ artifact_id: "idea1", extension: IDEA_PACK, asserted_by: "user" })]);
    const out = resolveArtifactPresentationIdentities({
      orgId: ORG,
      rows: [{ id: "idea1", type: IDEA_TYPE }],
    });
    expect(out.get("idea1")?.identity).toEqual({ kind: "extension", extension: IDEA_PACK });
    expect(out.get("idea1")?.tier).toBe("classic");
  });

  it("the shared effective identity of the LinkedIn type stays its namespace owner", () => {
    expect(resolveEffectiveIdentity(LINKEDIN_TYPE)).toEqual({
      kind: "extension",
      extension: "@cinatra-ai/linkedin",
    });
  });
});
