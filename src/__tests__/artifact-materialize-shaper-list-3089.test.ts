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
import { isArtifactMaterializeListInput } from "../../packages/agents/src/artifact-binding";

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
    expect(shaped).toStrictEqual({
      extension: EXT,
      // The raw list is not kept beside its members: the shaped call is frozen
      // and size-checked whole, and the list twice over would double its size.
      content: "",
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
    ["a lone surrogate and U+FFFD", "a\uD800b", "a\uFFFDb"],
    ["two different lone surrogates", "\uDC00", "\uD801"],
  ])("refuses two members whose strings differ but encode to the same UTF-8 bytes: %s", (_name, first, second) => {
    expect(new TextEncoder().encode(first)).toEqual(new TextEncoder().encode(second));
    const list = [{ subject: "a", body: first }, { subject: "b", body: second }];
    expect(() => shapeArtifactMaterializeInput(membersOf(list))).toThrow("member 2 has the same content bytes as member 1");
  });

  // red-first-expect: to not throw an error but 'Error: artifact_materialize input.tit
  it("takes two members that differ only in a leading byte order mark: their bytes differ", () => {
    const first = "draft";
    const second = "\uFEFFdraft";
    expect(new TextEncoder().encode(first)).not.toEqual(new TextEncoder().encode(second));
    const list = [{ subject: "a", body: first }, { subject: "b", body: second }];
    expect(() => shapeArtifactMaterializeInput(membersOf(list))).not.toThrow();
  });

  // red-first-expect: but got 'artifact_materialize input.title must
  it.each([
    ["memberContentField", " "],
    ["memberContentField", " body "],
    ["memberTitleField", " "],
    ["memberTitleField", "subject "],
  ])("refuses %s %j: a blank or padded name is never read as another property", (field, name) => {
    expect(() => shapeArtifactMaterializeInput(listRaw({ [field]: name }))).toThrow(
      `input.${field} must be a field name with no surrounding whitespace`,
    );
  });

  // red-first-expect: input.title must be a non-empty string
  it("reads a member property whose name has inner spaces exactly as named", () => {
    const shaped = shapeArtifactMaterializeInput(
      listRaw({ memberContentField: "mail body", content: JSON.stringify([{ subject: "s", "mail body": "b" }]) }),
    );
    expect(shaped.members).toEqual([{ title: "s", content: "b" }]);
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

// The shaper is a zero-dependency module, so it keeps its own reading of "is a
// list call"; the compile check and the route read it from the package. The
// three readings must not drift: the same raw input is a list call for the
// package's predicate exactly when the shaper takes the list road (a half list
// is refused by the shaper and is a list call for the predicate, never a
// single call).
describe("the shaper and the package read 'a list call' alike (cinatra#3089)", () => {
  const single = (): Record<string, unknown> => {
    const raw = listRaw({ title: "T" });
    delete raw.memberContentField;
    delete raw.memberTitleField;
    return raw;
  };
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ["a single call", single(), false],
    ["a list call", listRaw(), true],
    ["a member content field alone", { ...single(), memberContentField: "body" }, true],
    ["a member title field alone", { ...single(), memberTitleField: "subject" }, true],
    ["a null member content field", { ...single(), memberContentField: null }, true],
  ];

  // red-first-expect: ListInput) is not a function
  it.each(cases)("%s", (_name, raw, isList) => {
    expect(isArtifactMaterializeListInput(raw)).toBe(isList);
    let members: unknown;
    try {
      members = shapeArtifactMaterializeInput(raw).members;
    } catch {
      members = "refused";
    }
    expect(members === undefined).toBe(!isList);
  });
});
