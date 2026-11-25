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
import {
  isArtifactMaterializeListInput,
  readMaterializeListDataDeclaration,
} from "../../packages/agents/src/artifact-binding";

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
  ])("refuses %s", (_name, list, message) => {
    expect(() => shapeArtifactMaterializeInput(membersOf(list as unknown[]))).toThrow(message);
  });

  // red-first-expect: input.title must be a non-empty string
  it.each([
    ["the same bytes and different titles", [{ subject: "a", body: "same" }, { subject: "b", body: "same" }]],
    ["the same bytes, titles and fields (a fully identical member)", [{ subject: "a", body: "same" }, { subject: "a", body: "same" }]],
    ["strings that differ but encode to the same UTF-8 bytes", [{ subject: "a", body: "a\uD800b" }, { subject: "b", body: "a\uFFFDb" }]],
  ])("takes two members with %s: a member is an artifact of its own by its position", (_name, list) => {
    const shaped = shapeArtifactMaterializeInput(membersOf(list));
    expect(shaped.members).toHaveLength(2);
    expect(shaped.members!.map((m) => m.title)).toEqual([list[0]!.subject, list[1]!.subject]);
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

// ---------------------------------------------------------------------------
// cinatra#3089 — typed data on list-filed members. `memberDataFields` names
// member fields stored as the member's typed data; `memberData` stamps
// call-wide values on every member; `memberRunIdField` names the field the host
// fills with the calling run's id. The declaration is read by ONE function
// (the package's, also used by the route and the compile check) and handed to
// the shaper, which keeps no project imports.
// ---------------------------------------------------------------------------

const TYPED = [
  { subject: "Hello Ada", body: "Dear Ada", recipientId: "c-1" },
  { subject: "Hello Bob", body: "Dear Bob", recipientId: "c-2" },
];

/** The shaper as the route drives it: the declaration is read by the package's reader first. */
function shapeTyped(raw: Record<string, unknown>) {
  const declaration = readMaterializeListDataDeclaration(raw);
  if (!declaration.ok) throw new Error(declaration.message);
  return shapeArtifactMaterializeInput(raw, declaration);
}

const typedRaw = (overrides?: Record<string, unknown>) =>
  listRaw({ content: JSON.stringify(TYPED), memberDataFields: ["recipientId"], ...overrides });

describe("typed data of list members (cinatra#3089)", () => {
  // red-first-expect: readMaterializeListDataDeclaration) is not a function
  it("copies each declared member field into that member's data, and stamps the call-wide values", () => {
    const shaped = shapeTyped(
      typedRaw({ memberData: { campaignId: "camp-1", region: "eu" }, memberRunIdField: "runId" }),
    );
    expect(shaped.runIdField).toBe("runId");
    expect(shaped.members).toStrictEqual([
      { title: "Hello Ada", content: "Dear Ada", data: { recipientId: "c-1", campaignId: "camp-1", region: "eu" } },
      { title: "Hello Bob", content: "Dear Bob", data: { recipientId: "c-2", campaignId: "camp-1", region: "eu" } },
    ]);
  });

  // red-first-expect: readMaterializeListDataDeclaration) is not a function
  it("stores typed values without their surrounding whitespace, as the title is stored and as the send's own body stores its contact", () => {
    const list = TYPED.map((m, i) => ({ ...m, recipientId: ` c-${i + 1}\t` }));
    const shaped = shapeTyped(typedRaw({ content: JSON.stringify(list), memberData: { campaignId: " camp-1 " } }));
    expect(shaped.members!.map((m) => m.data)).toEqual([
      { recipientId: "c-1", campaignId: "camp-1" },
      { recipientId: "c-2", campaignId: "camp-1" },
    ]);
  });

  // red-first-expect: readMaterializeListDataDeclaration) is not a function
  it("gives a member no data property when the call declares none", () => {
    const shaped = shapeTyped(listRaw());
    expect(shaped.members!.every((m) => !("data" in m))).toBe(true);
    expect(shaped).not.toHaveProperty("runIdField");
  });

  // red-first-expect: to contain 'member 2'
  it.each([
    ["is missing", (m: Record<string, unknown>) => delete m.recipientId, 2, "recipientId"],
    ["is blank", (m: Record<string, unknown>) => { m.recipientId = "  "; }, 2, "recipientId"],
    ["is not a string", (m: Record<string, unknown>) => { m.recipientId = 7; }, 2, "recipientId"],
    ["is longer than 512 characters", (m: Record<string, unknown>) => { m.recipientId = "x".repeat(513); }, 2, "recipientId"],
  ])("refuses the whole call when a member's declared field %s, naming the member and the field only", (_n, edit, index, field) => {
    const list = TYPED.map((m) => ({ ...m }));
    edit(list[index - 1]!);
    let message = "";
    try {
      shapeTyped(typedRaw({ content: JSON.stringify(list) }));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(`member ${index}`);
    expect(message).toContain(`"${field}"`);
    // The value is never echoed.
    expect(message).not.toContain("xxxxxxxx");
  });

  // red-first-expect: to throw error including 'member 1 must not carry the field
  it.each([
    ["a stamped call-wide key", { memberData: { campaignId: "camp-1" } }, "campaignId"],
    ["the host-stamped run id field", { memberRunIdField: "runId" }, "runId"],
  ])("refuses a member that carries its own value for %s", (_n, extra, key) => {
    const list = TYPED.map((m) => ({ ...m, [key]: "member-written" }));
    expect(() => shapeTyped(typedRaw({ content: JSON.stringify(list), ...extra }))).toThrow(
      `member 1 must not carry the field "${key}"`,
    );
  });

  // red-first-expect: readMaterializeListDataDeclaration) is not a function
  it("refuses typed-data inputs on a single call, which keeps today's behaviour", () => {
    const raw = typedRaw();
    delete raw.memberContentField;
    delete raw.memberTitleField;
    const declaration = readMaterializeListDataDeclaration(raw);
    expect(declaration).toMatchObject({ ok: false, code: "materialize_list_data_declaration" });
  });

  // red-first-expect: expected [Function] to throw
  it("does not shape typed-data inputs it was not handed a declaration for", () => {
    expect(() => shapeArtifactMaterializeInput(typedRaw())).toThrow("declaration");
  });
});

describe("readMaterializeListDataDeclaration (cinatra#3089)", () => {
  const bad = (overrides: Record<string, unknown>) => readMaterializeListDataDeclaration(typedRaw(overrides));

  // red-first-expect: readMaterializeListDataDeclaration) is not a function
  it("reads a valid declaration and the absence of one", () => {
    expect(bad({ memberData: { campaignId: "c" }, memberRunIdField: "runId" })).toEqual({
      ok: true, fields: ["recipientId"], fixed: { campaignId: "c" }, runIdField: "runId", maxValueChars: 512,
    });
    expect(readMaterializeListDataDeclaration(listRaw())).toEqual({
      ok: true, fields: [], fixed: {}, runIdField: null, maxValueChars: 512,
    });
  });

  // red-first-expect: readMaterializeListDataDeclaration) is not a function
  it.each([
    ["memberDataFields that is not an array", { memberDataFields: "recipientId" }],
    ["memberDataFields that is null", { memberDataFields: null }],
    ["a member data field that is not a string", { memberDataFields: [3] }],
    ["a blank member data field", { memberDataFields: [" "] }],
    ["a padded member data field", { memberDataFields: [" recipientId "] }],
    ["a templated member data field", { memberDataFields: ["{{ f }}"] }],
    ["a member data field named __proto__", { memberDataFields: ["__proto__"] }],
    ["a duplicate member data field", { memberDataFields: ["recipientId", "recipientId"] }],
    ["a member data field equal to the title field", { memberDataFields: ["subject"] }],
    ["a member data field equal to the content field", { memberDataFields: ["body"] }],
    ["more than 8 typed fields", { memberDataFields: Array.from({ length: 9 }, (_, i) => `f${i}`) }],
    ["memberData that is an array", { memberData: ["a"] }],
    ["memberData that is null", { memberData: null }],
    ["a memberData value that is not a string", { memberData: { campaignId: 3 } }],
    ["a blank memberData value", { memberData: { campaignId: " " } }],
    ["a memberData value longer than 512 characters", { memberData: { campaignId: "x".repeat(513) } }],
    ["a memberData key that is also a member data field", { memberData: { recipientId: "c" } }],
    ["a memberData key equal to the title field", { memberData: { subject: "c" } }],
    ["a padded memberData key", { memberData: { " campaignId": "c" } }],
    ["memberRunIdField that is not a string", { memberRunIdField: 4 }],
    ["memberRunIdField that is blank", { memberRunIdField: "" }],
    ["memberRunIdField that is also a member data field", { memberRunIdField: "recipientId" }],
    ["memberRunIdField that is also a memberData key", { memberData: { runId: "r" }, memberRunIdField: "runId" }],
    ["a field named as a writer-owned envelope field", { memberDataFields: ["latestDigest"] }],
    ["a memberData key named as a writer-owned envelope field", { memberData: { originKind: "x" } }],
    ["the run id field named as a writer-owned envelope field", { memberRunIdField: "title" }],
  ])("refuses %s with the one declaration code", (_n, overrides) => {
    const result = bad(overrides);
    expect(result).toMatchObject({ ok: false, code: "materialize_list_data_declaration" });
    expect((result as { message: string }).message).toContain("nothing was filed");
  });
});
