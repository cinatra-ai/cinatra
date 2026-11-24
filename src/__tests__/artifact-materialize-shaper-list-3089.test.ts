/**
 * cinatra#3089 — the LIST MODE of the generic `artifact_materialize` shaper:
 * `content` is a JSON array, `memberContentField` and `memberTitleField` name
 * each member's content and title. Every refusal comes before anything is
 * filed.
 *
 *   npx vitest run src/__tests__/artifact-materialize-shaper-list-3089.test.ts
 */
import { describe, expect, it } from "vitest";

import { shapeArtifactMaterializeInput } from "../app/api/agents/passthrough/artifact-materialize-shaper";

const EXT = "@cinatra-ai/email-artifacts";
const DRAFTS = [
  { subject: "Hello Ada", body: "Dear Ada" },
  { subject: " Hello Bob ", body: "  Dear Bob  " },
];

function listRaw(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    extension: EXT,
    content: JSON.stringify(DRAFTS),
    memberContentField: "body",
    memberTitleField: "subject",
    declaredMime: "text/markdown",
    node_id: "file_drafts",
    ...overrides,
  };
}

const membersOf = (list: unknown[]) => listRaw({ content: JSON.stringify(list) });

describe("shapeArtifactMaterializeInput — list mode (cinatra#3089)", () => {
  // red-first-expect: input.title must be a non-empty string
  it("shapes one member per list entry, in order, trimming titles but never content", () => {
    const shaped = shapeArtifactMaterializeInput(listRaw({ objectTypeId: "@cinatra-ai/email:body" }));
    expect(shaped).toEqual({
      extension: EXT,
      content: JSON.stringify(DRAFTS),
      declaredMime: "text/markdown",
      title: "",
      nodeId: "file_drafts",
      objectTypeId: "@cinatra-ai/email:body",
      members: [
        { title: "Hello Ada", content: "Dear Ada" },
        { title: "Hello Bob", content: "  Dear Bob  " },
      ],
    });
  });

  it("leaves a single call without members", () => {
    const shaped = shapeArtifactMaterializeInput({
      extension: EXT, content: "x", declaredMime: "text/markdown", title: "T", node_id: "n",
    });
    expect(shaped).not.toHaveProperty("members");
  });

  // red-first-expect: but got 'artifact_materialize input.title must
  it.each(["memberContentField", "memberTitleField"])("refuses %s given alone", (field) => {
    const raw = listRaw();
    delete raw[field === "memberContentField" ? "memberTitleField" : "memberContentField"];
    expect(() => shapeArtifactMaterializeInput(raw)).toThrow("given together");
  });

  // red-first-expect: expected [Function] to throw
  it.each([
    ["artifactId", { artifactId: "a", baseRepresentationRevisionId: "r" }],
    ["contentJsonField", { contentJsonField: "body" }],
    ["title", { title: "One title" }],
  ])("refuses a list combined with %s", (_name, extra) => {
    expect(() => shapeArtifactMaterializeInput(listRaw(extra))).toThrow("cannot be combined with a list call");
  });

  // red-first-expect: but got 'artifact_materialize input.title must
  it.each([
    ["an empty list", [], "empty list"],
    ["a list over 50 members", Array.from({ length: 51 }, (_, i) => ({ subject: `s${i}`, body: `b${i}` })), "at most 50"],
    ["a member that is not an object", ["text"], "member 1 must be a JSON object"],
    ["a member without the content field", [{ subject: "s" }], 'member 1 field "body" must be a string (field missing'],
    ["a member with non-string content", [{ subject: "s", body: { html: "x" } }], 'member 1 field "body" must be a string (got object'],
    ["a member with a blank title", [{ subject: "  ", body: "b" }], 'member 1 field "subject" must be a non-empty string'],
    ["two members with the same bytes", [{ subject: "a", body: "same" }, { subject: "b", body: "same" }], "member 2 has the same content bytes as member 1"],
  ])("refuses %s", (_name, list, message) => {
    expect(() => shapeArtifactMaterializeInput(membersOf(list as unknown[]))).toThrow(message);
  });

  // red-first-expect: but got 'artifact_materialize input.title must
  it.each([
    ["not JSON", "not json"],
    ["a JSON object", JSON.stringify({ body: "x" })],
  ])("refuses a content that is %s", (_name, content) => {
    expect(() => shapeArtifactMaterializeInput(listRaw({ content }))).toThrow(/JSON-array|JSON array/);
  });

  // red-first-expect: input.title must be a non-empty string
  it("accepts exactly 50 members", () => {
    const list = Array.from({ length: 50 }, (_, i) => ({ subject: `s${i}`, body: `b${i}` }));
    expect(shapeArtifactMaterializeInput(membersOf(list)).members).toHaveLength(50);
  });
});
