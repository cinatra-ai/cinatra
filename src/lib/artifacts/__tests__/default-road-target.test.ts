import { describe, expect, it } from "vitest";
import {
  BINARY_BASE_FORM,
  resolveDefaultRoadTarget,
  type DefaultRoadTargetCandidate,
} from "../default-road-target";

// ---------------------------------------------------------------------------
// The PER-OUTPUT ladder (Agents Lifecycle (C) item 0.17): "binding, then the
// agent's declared kind, then the form's base, then the binary base".
//
// The binding rung is proved where it lives — a bound output never reaches this
// function, because the capture excludes it by name (see
// packages/agents/src/__tests__/end-node-output-pickup.test.ts, "a bound output
// takes the DECLARED road, never the default one").
// ---------------------------------------------------------------------------

/** The REQUIRED bases as this repository actually installs them today. Read off
 *  the four extension manifests in the required set that declare text, image,
 *  pdf and structured-data accepts. */
const INSTALLED_BASES: DefaultRoadTargetCandidate[] = [
  { objectTypeId: "@cinatra-ai/text:document", extension: "@cinatra-ai/text-artifact", acceptMimes: ["text/plain", "text/markdown", "text/csv"] },
  { objectTypeId: "@cinatra-ai/json:document", extension: "@cinatra-ai/json-artifact", acceptMimes: ["application/json"] },
  { objectTypeId: "@cinatra-ai/image:image", extension: "@cinatra-ai/image-artifact", acceptMimes: ["image/*"] },
  { objectTypeId: "@cinatra-ai/pdf:document", extension: "@cinatra-ai/pdf-artifact", acceptMimes: ["application/pdf"] },
  { objectTypeId: "@cinatra-ai/zip:archive", extension: "@cinatra-ai/zip-artifact", acceptMimes: ["application/zip", "application/x-zip-compressed"] },
];

/** The binary base, as it WILL be once #3025's blocked half lands. Held here as
 *  a fixture so acceptance 4's contract is proved today and turns green on the
 *  real fleet the moment the base enters the required set. */
const BINARY_BASE: DefaultRoadTargetCandidate = {
  objectTypeId: "@cinatra-ai/binary:file",
  extension: "@cinatra-ai/binary-artifact",
  acceptMimes: [BINARY_BASE_FORM],
};

const BLOG_POST: DefaultRoadTargetCandidate = {
  objectTypeId: "@cinatra-ai/blog:post",
  extension: "@cinatra-ai/blog-post-artifact",
  acceptMimes: ["text/markdown"],
};
const BLOG_IDEA: DefaultRoadTargetCandidate = {
  objectTypeId: "@cinatra-ai/blog:idea",
  extension: "@cinatra-ai/blog-idea-artifact",
  acceptMimes: ["text/markdown", "text/plain"],
};

describe("rung 2 — the agent's declared kind, PER OUTPUT", () => {
  it("claims the output when exactly one declared kind accepts the detected form", () => {
    const out = resolveDefaultRoadTarget({
      form: "text/markdown",
      declaredKinds: [BLOG_POST],
      bases: INSTALLED_BASES,
    });
    expect(out).toMatchObject({
      ok: true,
      rung: "declared_kind",
      objectTypeId: "@cinatra-ai/blog:post",
      extension: "@cinatra-ai/blog-post-artifact",
    });
  });

  it("is decided PER OUTPUT, never as a switch over the whole agent", () => {
    // The SAME agent, two outputs, two forms: markdown reaches the declared
    // kind; a png does not — and falls through to the form's base rather than
    // turning the declared road off for the whole run.
    const declaredKinds = [BLOG_POST];
    expect(resolveDefaultRoadTarget({ form: "text/markdown", declaredKinds, bases: INSTALLED_BASES }))
      .toMatchObject({ ok: true, rung: "declared_kind" });
    expect(resolveDefaultRoadTarget({ form: "image/png", declaredKinds, bases: INSTALLED_BASES }))
      .toMatchObject({ ok: true, rung: "form_base", objectTypeId: "@cinatra-ai/image:image" });
  });

  it("two accepting declared kinds is not EXACTLY ONE — the ladder falls through to the base", () => {
    const out = resolveDefaultRoadTarget({
      form: "text/markdown",
      declaredKinds: [BLOG_POST, BLOG_IDEA],
      bases: INSTALLED_BASES,
    });
    expect(out).toMatchObject({ ok: true, rung: "form_base", objectTypeId: "@cinatra-ai/text:document" });
  });

  it("a declared kind that does NOT accept the form does not claim the output", () => {
    const out = resolveDefaultRoadTarget({
      form: "application/json",
      declaredKinds: [BLOG_POST],
      bases: INSTALLED_BASES,
    });
    expect(out).toMatchObject({ ok: true, rung: "form_base", objectTypeId: "@cinatra-ai/json:document" });
  });
});

describe("rung 3 — the form's base, by the UPLOAD's exactly-one rule", () => {
  it.each([
    ["text/markdown", "@cinatra-ai/text:document"],
    ["text/plain", "@cinatra-ai/text:document"],
    ["text/csv", "@cinatra-ai/text:document"],
    ["application/json", "@cinatra-ai/json:document"],
    ["image/png", "@cinatra-ai/image:image"],
    ["application/pdf", "@cinatra-ai/pdf:document"],
    ["application/zip", "@cinatra-ai/zip:archive"],
  ])("%s lands on %s", (form, objectTypeId) => {
    const out = resolveDefaultRoadTarget({ form, declaredKinds: [], bases: INSTALLED_BASES });
    expect(out).toMatchObject({ ok: true, rung: "form_base", objectTypeId });
  });

  it("canonicalises the form before matching (parameters dropped)", () => {
    const out = resolveDefaultRoadTarget({
      form: "text/markdown; charset=utf-8",
      declaredKinds: [],
      bases: INSTALLED_BASES,
    });
    expect(out).toMatchObject({ ok: true, objectTypeId: "@cinatra-ai/text:document" });
  });

  it("two bases claiming one form is a PACKAGING DEFECT, refused — never a run-time guess", () => {
    const out = resolveDefaultRoadTarget({
      form: "text/markdown",
      declaredKinds: [],
      bases: [
        ...INSTALLED_BASES,
        { objectTypeId: "@cinatra-ai/markdown:document", extension: "@cinatra-ai/markdown-artifact", acceptMimes: ["text/markdown"] },
      ],
    });
    expect(out).toMatchObject({ ok: false, reason: "ambiguous" });
    if (out.ok === false) expect(out.matched).toHaveLength(2);
  });
});

describe("rung 4 — the binary base, when no rung can name the form", () => {
  it("ACCEPTANCE 4 — undetectable bytes land under the binary base", () => {
    const out = resolveDefaultRoadTarget({
      form: BINARY_BASE_FORM,
      declaredKinds: [],
      bases: [...INSTALLED_BASES, BINARY_BASE],
    });
    expect(out).toMatchObject({
      ok: true,
      rung: "binary_base",
      objectTypeId: "@cinatra-ai/binary:file",
      extension: "@cinatra-ai/binary-artifact",
    });
  });

  it("refuses HONESTLY while the binary base is not installed — no artifact under a type nothing owns", () => {
    // The state of the required set on this branch: #3025's two base extension
    // repositories do not exist in the organisation yet, so nothing accepts
    // application/octet-stream. The ladder RECORDS that rather than minting an
    // artifact under an unowned type. See the named deviation on the PR.
    const out = resolveDefaultRoadTarget({
      form: BINARY_BASE_FORM,
      declaredKinds: [],
      bases: INSTALLED_BASES,
    });
    expect(out).toMatchObject({ ok: false, reason: "no_base_installed", rung: "binary_base" });
    if (out.ok === false) expect(out.detail).toContain("binary base is not in the required set");
  });

  it("a declared kind that accepts octet-stream still wins the output", () => {
    const out = resolveDefaultRoadTarget({
      form: BINARY_BASE_FORM,
      declaredKinds: [
        { objectTypeId: "@acme/blob:file", extension: "@acme/blob-artifact", acceptMimes: [BINARY_BASE_FORM] },
      ],
      bases: INSTALLED_BASES,
    });
    expect(out).toMatchObject({ ok: true, rung: "declared_kind", objectTypeId: "@acme/blob:file" });
  });

  it("a form no base accepts and no kind declares is refused, not guessed", () => {
    const out = resolveDefaultRoadTarget({
      form: "application/vnd.acme.thing+xml",
      declaredKinds: [],
      bases: INSTALLED_BASES,
    });
    expect(out).toMatchObject({ ok: false, reason: "no_base_installed", rung: "form_base" });
  });
});
