/**
 * cinatra#3089 — the LIST MODE of the `artifact_materialize` shaper: a call that
 * names `memberContentField` + `memberTitleField` is one artifact per member of
 * the JSON array in `content`, each with its own title, bytes and typed data.
 *
 *   npx vitest run src/__tests__/artifact-materialize-shaper-list-3089.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  MATERIALIZE_LIST_NODE_ID_PREFIX,
  MAX_MATERIALIZE_LIST_MEMBERS,
  shapeArtifactMaterializeInput,
} from "../app/api/agents/passthrough/artifact-materialize-shaper";

const drafts = [
  { body: "Hi Ann", subject: "For Ann", contactId: "c-1" },
  { body: "Hi Bob", subject: "For Bob", contactId: "c-2" },
];

function listCall(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    extension: "@cinatra-ai/email-artifacts",
    declaredMime: "text/markdown",
    node_id: "file_bodies",
    objectTypeId: "@cinatra-ai/email:body",
    content: JSON.stringify(drafts),
    memberContentField: "body",
    memberTitleField: "subject",
    ...extra,
  };
}

describe("artifact_materialize list mode (cinatra#3089)", () => {
  it("shapes one member per array entry, in order, with its own title and bytes", () => {
    const shaped = shapeArtifactMaterializeInput(listCall());
    expect(shaped.members).toEqual([
      { title: "For Ann", content: "Hi Ann" },
      { title: "For Bob", content: "Hi Bob" },
    ]);
    expect(shaped).toMatchObject({ content: "", title: "", nodeId: "file_bodies", objectTypeId: "@cinatra-ai/email:body" });
  });

  it("files the named member fields and the call-wide values as each member's typed data", () => {
    const shaped = shapeArtifactMaterializeInput(
      listCall({ memberDataFields: ["contactId", "subject"], memberData: { campaignId: "camp-1" } }),
    );
    expect(shaped.members).toEqual([
      { title: "For Ann", content: "Hi Ann", data: { contactId: "c-1", subject: "For Ann", campaignId: "camp-1" } },
      { title: "For Bob", content: "Hi Bob", data: { contactId: "c-2", subject: "For Bob", campaignId: "camp-1" } },
    ]);
  });

  it("refuses a member that carries a call-wide field, and the host's run id as a field", () => {
    const own = JSON.stringify([{ ...drafts[0], campaignId: "other" }]);
    expect(() => shapeArtifactMaterializeInput(listCall({ content: own, memberData: { campaignId: "camp-1" } }))).toThrow(
      /must not carry the field "campaignId"/,
    );
    expect(() => shapeArtifactMaterializeInput(listCall({ memberDataFields: ["runId"] }))).toThrow(/runId/);
    expect(() => shapeArtifactMaterializeInput(listCall({ memberData: { runId: "run-x" } }))).toThrow(/runId/);
  });

  it("refuses every malformed list before anything is filed", () => {
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ memberTitleField: undefined }, /given together/],
      [{ memberContentField: " body" }, /surrounding whitespace/],
      [{ title: "x" }, /cannot be combined/],
      [{ contentJsonField: "body" }, /cannot be combined/],
      [{ artifactId: "a", baseRepresentationRevisionId: "r" }, /cannot be combined/],
      [{ content: "{}" }, /JSON array/],
      [{ content: "not json" }, /not parseable JSON/],
      [{ content: "[]" }, /empty list/],
      [{ content: JSON.stringify(Array.from({ length: MAX_MATERIALIZE_LIST_MEMBERS + 1 }, () => drafts[0])) }, /at most/],
      [{ content: JSON.stringify(["x"]) }, /member 1 must be a JSON object/],
      [{ content: JSON.stringify([{ subject: "s" }]) }, /member 1 field "body" must be a string/],
      [{ content: JSON.stringify([drafts[0], { body: "b", subject: " " }]) }, /member 2 field "subject"/],
      [{ memberDataFields: ["contactId"], content: JSON.stringify([{ body: "b", subject: "s" }]) }, /field "contactId"/],
      [{ memberDataFields: "contactId" }, /array of field names/],
      [{ memberData: { campaignId: 7 } }, /memberData.campaignId/],
      [{ memberDataFields: ["campaignId"], memberData: { campaignId: "c" } }, /both a member field and a call-wide value/],
    ];
    for (const [extra, message] of bad) {
      expect(() => shapeArtifactMaterializeInput(listCall(extra)), JSON.stringify(extra)).toThrow(message);
    }
  });

  it("refuses list-only fields on a single call, and a node id in the members' reserved ledger namespace", () => {
    const single = { extension: "@x/y", declaredMime: "text/markdown", node_id: "n", title: "t", content: "c" };
    expect(() => shapeArtifactMaterializeInput({ ...single, memberData: { a: "b" } })).toThrow(/belong to a list call/);
    expect(() => shapeArtifactMaterializeInput({ ...single, node_id: `${MATERIALIZE_LIST_NODE_ID_PREFIX}"n"/0` })).toThrow(
      /reserved ledger namespace/,
    );
    expect(() => shapeArtifactMaterializeInput(listCall({ node_id: `${MATERIALIZE_LIST_NODE_ID_PREFIX}x` }))).toThrow(
      /reserved ledger namespace/,
    );
    expect(shapeArtifactMaterializeInput(single).members).toBeUndefined();
  });
});
