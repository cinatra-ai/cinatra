// Field-renderer component map emitter (cinatra#1625, epic #1620 S8 — M3).
// Pins the committed generated file byte-for-byte against the emitter output for
// the CURRENT presence universe (a local proxy for the fail-closed `--check`
// staleness gate) and the per-claimant emission mechanics (the literal-import
// loader shape). The first claimant migration (list-curator-agent) populated the
// map, so the byte-proxy now reflects those two entries; the empty-input unit
// case below still holds independently.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { emitFieldRendererComponents } from "../generate-extension-manifest.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const COMMITTED = join(REPO_ROOT, "src/lib/generated/field-renderer-components.ts");

// The migrated S8/M3 claimant entries (cinatra#1625) — blog-linkedin-publish-agent
// + blog-wordpress-publish-agent + list-curator-agent + skill-recommender-agent —
// in the generator's bindingId-sorted order. This mirrors what
// generate-extension-manifest derives from the extensions'
// cinatra.fieldRenderers[].component declarations. Append the next claimant here.
const MIGRATED_ENTRIES = [
  {
    bindingId: "@cinatra-ai/blog-linkedin-publish-agent:draft-review",
    packageName: "@cinatra-ai/blog-linkedin-publish-agent",
    specifier: "@cinatra-ai/blog-linkedin-publish-agent/src/renderers/draft-review",
    resolution: "guardedOptional",
    propsApiVersion: 1,
  },
  {
    bindingId: "@cinatra-ai/blog-wordpress-publish-agent:draft-confirm",
    packageName: "@cinatra-ai/blog-wordpress-publish-agent",
    specifier: "@cinatra-ai/blog-wordpress-publish-agent/src/renderers/draft-confirm",
    resolution: "guardedOptional",
    propsApiVersion: 1,
  },
  {
    bindingId: "@cinatra-ai/list-curator-agent:final-list-review",
    packageName: "@cinatra-ai/list-curator-agent",
    specifier: "@cinatra-ai/list-curator-agent/src/list-curator-final-list-renderer",
    resolution: "guardedOptional",
    propsApiVersion: 1,
  },
  {
    bindingId: "@cinatra-ai/list-curator-agent:scrape-schema-review",
    packageName: "@cinatra-ai/list-curator-agent",
    specifier: "@cinatra-ai/list-curator-agent/src/list-curator-scrape-schema-renderer",
    resolution: "guardedOptional",
    propsApiVersion: 1,
  },
  {
    bindingId: "@cinatra-ai/skill-recommender-agent:recommend",
    packageName: "@cinatra-ai/skill-recommender-agent",
    specifier: "@cinatra-ai/skill-recommender-agent/src/skill-recommender-renderer",
    resolution: "guardedOptional",
    propsApiVersion: 1,
  },
];

describe("emitFieldRendererComponents", () => {
  it("emits the current presence universe byte-identical to the committed generated file (--check proxy)", () => {
    expect(emitFieldRendererComponents(MIGRATED_ENTRIES)).toBe(readFileSync(COMMITTED, "utf8"));
  });

  it("emits an empty object literal (no entries) for the empty presence universe", () => {
    const out = emitFieldRendererComponents([]);
    expect(out).toContain(
      "export const GENERATED_FIELD_RENDERER_COMPONENTS: Record<string, GeneratedFieldRendererComponentEntry> = {\n};",
    );
  });

  it("emits a client-safe literal-import loader keyed by binding id for a declared component", () => {
    const out = emitFieldRendererComponents([
      {
        bindingId: "@cinatra-ai/email-drafting-agent:email-drafts-review",
        packageName: "@cinatra-ai/email-drafting-agent",
        specifier: "@cinatra-ai/email-drafting-agent/field-renderer",
        resolution: "guardedOptional",
        propsApiVersion: 1,
      },
    ]);
    expect(out).toContain(
      '"@cinatra-ai/email-drafting-agent:email-drafts-review": { resolution: "guardedOptional", packageName: "@cinatra-ai/email-drafting-agent", propsApiVersion: 1, load: () => import("@cinatra-ai/email-drafting-agent/field-renderer") },',
    );
    // CLIENT-safe: the server-only guardedExtensionImport is never emitted as a
    // loader wrapper or import here (the doc comment names it, but no call/import).
    expect(out).not.toContain("guardedExtensionImport(");
    expect(out).not.toContain('import { guardedExtensionImport }');
    expect(out).not.toContain('import "server-only"');
  });

  it("emits one loader per declared component, in the given order", () => {
    const out = emitFieldRendererComponents([
      { bindingId: "@x/a:one", packageName: "@x/a", specifier: "@x/a/r", resolution: "required", propsApiVersion: 3 },
      { bindingId: "@x/b:two", packageName: "@x/b", specifier: "@x/b/r", resolution: "guardedOptional", propsApiVersion: 1 },
    ]);
    expect(out).toContain('"@x/a:one": { resolution: "required", packageName: "@x/a", propsApiVersion: 3, load: () => import("@x/a/r") },');
    expect(out).toContain('"@x/b:two": { resolution: "guardedOptional", packageName: "@x/b", propsApiVersion: 1, load: () => import("@x/b/r") },');
  });
});
