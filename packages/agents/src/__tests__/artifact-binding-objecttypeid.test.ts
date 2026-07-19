import { describe, expect, it } from "vitest";
import {
  artifactOutputBindingSchema,
  collectArtifactBindingsFromOasDocument,
  collectArtifactMaterializeNodesFromOasDocument,
  producesObjectTypeIdForExtension,
  resolveArtifactBindingObjectType,
} from "../artifact-binding";

// ---------------------------------------------------------------------------
// Binding `objectTypeId` grammar + declared-type resolution (cinatra#1454).
//
// The umbrella `${extension}:artifact` (#1824) is retired; a binding names the
// EXACT declared type it materializes into (symmetric with cinatra.produces).
// email-artifacts is the canonical MULTI-claim pack:
//   artifact-safe: email:body, email:sent-email, email:received-reply
//   projection:none (NOT artifact-safe): email:recipient
// ---------------------------------------------------------------------------

const EMAIL_EXT = "@cinatra-ai/email-artifacts";
const EMAIL_ARTIFACT_SAFE = [
  "@cinatra-ai/email:body",
  "@cinatra-ai/email:sent-email",
  "@cinatra-ai/email:received-reply",
];

function endNodeDoc(outputs: unknown[]): Record<string, unknown> {
  return {
    component_type: "Flow",
    $referenced_components: {
      end: { component_type: "EndNode", id: "end", name: "End", outputs },
    },
  };
}

describe("artifactOutputBindingSchema — objectTypeId field", () => {
  const base = {
    extension: EMAIL_EXT,
    contentFrom: "draft",
    declaredMime: "text/markdown",
    titleFrom: "title",
  };

  it("accepts a valid namespaced objectTypeId", () => {
    const parsed = artifactOutputBindingSchema.safeParse({
      ...base,
      objectTypeId: "@cinatra-ai/email:body",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a binding with NO objectTypeId (optional)", () => {
    expect(artifactOutputBindingSchema.safeParse(base).success).toBe(true);
  });

  it("rejects a non-namespaced objectTypeId", () => {
    const parsed = artifactOutputBindingSchema.safeParse({ ...base, objectTypeId: "email-body" });
    expect(parsed.success).toBe(false);
  });

  it("still strict — an unknown field is rejected", () => {
    const parsed = artifactOutputBindingSchema.safeParse({ ...base, bogus: 1 });
    expect(parsed.success).toBe(false);
  });
});

describe("producesObjectTypeIdForExtension", () => {
  it("returns the typed entry's id", () => {
    expect(
      producesObjectTypeIdForExtension(
        [{ extension: EMAIL_EXT, objectTypeId: "@cinatra-ai/email:body" }],
        EMAIL_EXT,
      ),
    ).toBe("@cinatra-ai/email:body");
  });
  it("returns null for a coarse entry", () => {
    expect(producesObjectTypeIdForExtension([{ extension: EMAIL_EXT }], EMAIL_EXT)).toBeNull();
  });
  it("returns null when produces is absent", () => {
    expect(producesObjectTypeIdForExtension(null, EMAIL_EXT)).toBeNull();
  });
});

describe("collectArtifactBindingsFromOasDocument — objectTypeId × produces agreement", () => {
  const binding = (objectTypeId?: string) => ({
    title: "draft",
    type: "string",
    cinatra: {
      artifact: {
        extension: EMAIL_EXT,
        ...(objectTypeId ? { objectTypeId } : {}),
        contentFrom: "draft",
        declaredMime: "text/markdown",
        titleFrom: "title",
      },
    },
  });
  const titleOut = { title: "title", type: "string" };

  it("accepts a binding objectTypeId that AGREES with a typed produces entry", () => {
    const res = collectArtifactBindingsFromOasDocument(
      endNodeDoc([binding("@cinatra-ai/email:body"), titleOut]),
      { producesRefs: [{ extension: EMAIL_EXT, objectTypeId: "@cinatra-ai/email:body" }] },
    );
    expect(res.errors).toEqual([]);
    expect(res.bindings[0]!.binding.objectTypeId).toBe("@cinatra-ai/email:body");
  });

  it("accepts a binding that NARROWS a coarse produces entry", () => {
    const res = collectArtifactBindingsFromOasDocument(
      endNodeDoc([binding("@cinatra-ai/email:body"), titleOut]),
      { producesRefs: [{ extension: EMAIL_EXT }] },
    );
    expect(res.errors).toEqual([]);
    expect(res.bindings).toHaveLength(1);
  });

  it("REJECTS a binding objectTypeId that CONTRADICTS a typed produces entry", () => {
    const res = collectArtifactBindingsFromOasDocument(
      endNodeDoc([binding("@cinatra-ai/email:sent-email"), titleOut]),
      { producesRefs: [{ extension: EMAIL_EXT, objectTypeId: "@cinatra-ai/email:body" }] },
    );
    expect(res.bindings).toHaveLength(0);
    expect(res.errors.join("\n")).toMatch(/contradicts the typed cinatra.produces entry/);
  });

  it("keeps the extension∈produces parity (derived from producesRefs)", () => {
    const res = collectArtifactBindingsFromOasDocument(endNodeDoc([binding(), titleOut]), {
      producesRefs: [{ extension: "@cinatra-ai/other-artifacts" }],
    });
    expect(res.bindings).toHaveLength(0);
    expect(res.errors.join("\n")).toMatch(/is not declared in package.json cinatra.produces/);
  });
});

describe("resolveArtifactBindingObjectType — the email-artifacts→email:body proof", () => {
  it("resolves an explicit binding objectTypeId to that declared type", () => {
    const r = resolveArtifactBindingObjectType({
      extension: EMAIL_EXT,
      bindingObjectTypeId: "@cinatra-ai/email:body",
      declaredArtifactSafeTypeIds: EMAIL_ARTIFACT_SAFE,
    });
    expect(r).toEqual({ ok: true, objectTypeId: "@cinatra-ai/email:body", source: "explicit" });
  });

  it("resolves from the typed produces entry when the binding is coarse", () => {
    const r = resolveArtifactBindingObjectType({
      extension: EMAIL_EXT,
      producesObjectTypeId: "@cinatra-ai/email:body",
      declaredArtifactSafeTypeIds: EMAIL_ARTIFACT_SAFE,
    });
    expect(r).toEqual({ ok: true, objectTypeId: "@cinatra-ai/email:body", source: "explicit" });
  });

  it("FAILS CLOSED on an ambiguous multi-type pack with no objectTypeId", () => {
    const r = resolveArtifactBindingObjectType({
      extension: EMAIL_EXT,
      declaredArtifactSafeTypeIds: EMAIL_ARTIFACT_SAFE,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/must set an explicit objectTypeId to disambiguate/);
  });

  it("single-claim pack resolves from {extension} alone (fallback)", () => {
    const r = resolveArtifactBindingObjectType({
      extension: "@cinatra-ai/linkedin-artifacts",
      declaredArtifactSafeTypeIds: ["@cinatra-ai/linkedin:post-draft"],
    });
    expect(r).toEqual({
      ok: true,
      objectTypeId: "@cinatra-ai/linkedin:post-draft",
      source: "single-claim-fallback",
    });
  });

  it("rejects an objectTypeId that is NOT an artifact-safe declared type (e.g. email:recipient)", () => {
    const r = resolveArtifactBindingObjectType({
      extension: EMAIL_EXT,
      bindingObjectTypeId: "@cinatra-ai/email:recipient",
      declaredArtifactSafeTypeIds: EMAIL_ARTIFACT_SAFE,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/is not an artifact-safe declared type/);
  });

  it("FAILS CLOSED when the extension declares no artifact-safe type", () => {
    const r = resolveArtifactBindingObjectType({
      extension: "@cinatra-ai/blog-post-artifact",
      declaredArtifactSafeTypeIds: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/declares no artifact-safe object type/);
  });
});

describe("collectArtifactMaterializeNodesFromOasDocument — objectTypeId support", () => {
  function toolDoc(input: Record<string, unknown>): Record<string, unknown> {
    return {
      component_type: "Flow",
      $referenced_components: {
        emit: {
          component_type: "ApiNode",
          id: "emit",
          url: "{{CINATRA_BASE_URL}}/api/agents/passthrough",
          data: { tool: "artifact_materialize", input },
        },
      },
    };
  }
  const baseInput = {
    extension: EMAIL_EXT,
    content: "{{ body }}",
    title: "{{ title }}",
    declaredMime: "text/markdown",
    node_id: "emit",
  };

  it("accepts + carries a valid objectTypeId", () => {
    const res = collectArtifactMaterializeNodesFromOasDocument(
      toolDoc({ ...baseInput, objectTypeId: "@cinatra-ai/email:body" }),
      { producesRefs: [{ extension: EMAIL_EXT, objectTypeId: "@cinatra-ai/email:body" }] },
    );
    expect(res.errors).toEqual([]);
    expect(res.nodes[0]!.objectTypeId).toBe("@cinatra-ai/email:body");
  });

  it("rejects a malformed objectTypeId", () => {
    const res = collectArtifactMaterializeNodesFromOasDocument(
      toolDoc({ ...baseInput, objectTypeId: "not-namespaced" }),
      { producesRefs: [{ extension: EMAIL_EXT }] },
    );
    expect(res.nodes).toHaveLength(0);
    expect(res.errors.join("\n")).toMatch(/must be a literal namespaced object type id/);
  });

  it("rejects an objectTypeId contradicting a typed produces entry", () => {
    const res = collectArtifactMaterializeNodesFromOasDocument(
      toolDoc({ ...baseInput, objectTypeId: "@cinatra-ai/email:sent-email" }),
      { producesRefs: [{ extension: EMAIL_EXT, objectTypeId: "@cinatra-ai/email:body" }] },
    );
    expect(res.nodes).toHaveLength(0);
    expect(res.errors.join("\n")).toMatch(/contradicts the typed cinatra.produces entry/);
  });
});
